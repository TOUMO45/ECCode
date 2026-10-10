// The void rule (spec: Background Processing > Void rule, ARCH-22).
//
// It fires in the same transaction that moves a plan version off the executable path before the execute claim
// (superseded; non_executable for SUPPLIER_REFUSED, PAYMENT_CANCELLED, AUTHORIZATION_FAILED, AUTHORIZATION_EXPIRED,
// RESERVATION_EXPIRED, OUT_OF_STOCK, REQUEST_DELETED, DEMO_RESET). For one plan version it:
//   1. releases the reservation when it is `active` (one `release` ledger row per item); an `expired` one is left alone;
//   2. cancels the supplier orders in `awaiting_supplier` or `confirmed` (a `refused` order stays refused);
//   3. marks EVERY non-terminal payment operation of the version with cancel_requested_at / cancel_reason and then
//        created                                   -> voided locally (queued create_order calls -> cancelled)
//        approved, no authorize call               -> voided locally
//        approved, authorize call queued           -> that call -> cancelled, operation voided locally
//        authorized                                -> a void is queued: provider.queueVoid(db, intent)
//        authorization_pending, approved with a started or unknown authorize call, unknown -> nothing more now
//                                                    (they resolve through the provider call protocol)
//
// Usage. The rule is a function created once per app and passed around as `ctx.voidRule`:
//
//   const voidRule = createVoidRule({ clock, provider });
//   voidRule(db, { planVersionId, reason, actor, requestId })   // call INSIDE db.tx; the caller sets the plan status
//
// The `provider` PORT is how a provider void gets queued (phase E plugs the real one in):
//   provider.queueVoid(db, intent)   called inside the transaction, once per `authorized` operation, with
//                                    intent = { operationId, supplierOrderId, kind: 'void', attempt: 1,
//                                               operationKey: 'so:<supplierOrderId>:void:1', planVersionId, reason }
//                                    It must be idempotent on operationKey (the real one is INSERT OR IGNORE into
//                                    provider_calls); it must not send anything and must not open a transaction.
// The default port is a no-op recorder (createNoopProvider): it only remembers the intents, so a test can see what
// would be queued. Sending queued voids after the commit is the caller's and the reconciler's job, not the rule's.
//
// The rule returns { planVersionId, releasedReservationId, cancelledOrderIds, voidedOperationIds, markedOperationIds,
// queuedVoids } so the caller can log and audit; it writes one audit_events row itself.
import { isoFromMs } from '../clock.js';
import { TERMINAL_PAYMENT_STATES, assertTransition } from '../domain/states.js';
import { recordAudit } from './audit.js';
import { actorOf, closeReservation } from './ledger.js';

const REASON = /^[A-Z][A-Z_]{1,63}$/;

const NOOP_RECORDER_LIMIT = 1000;

// The default port: remembers the intents (the newest 1000) and sends nothing.
export function createNoopProvider() {
  const queued = [];
  return {
    name: 'noop',
    queued,
    queueVoid(_db, intent) {
      queued.push(intent);
      if (queued.length > NOOP_RECORDER_LIMIT) queued.shift();
    },
  };
}

export function createVoidRule({ clock, provider = createNoopProvider() } = {}) {
  if (!clock || typeof clock.now !== 'function') throw new TypeError('createVoidRule needs a clock');
  if (!provider || typeof provider.queueVoid !== 'function') throw new TypeError('createVoidRule needs a provider port with queueVoid(db, intent)');

  function voidRule(db, { planVersionId, reason, actor = null, requestId = null }) {
    if (!Number.isSafeInteger(planVersionId)) throw new TypeError('voidRule needs planVersionId');
    if (typeof reason !== 'string' || !REASON.test(reason)) throw new TypeError('voidRule needs a reason code');
    if (!db.inTx) throw new Error('the void rule must run inside the superseding transaction');
    const now = isoFromMs(clock.now());
    const who = actorOf(actor);
    const result = {
      planVersionId, releasedReservationId: null, cancelledOrderIds: [], voidedOperationIds: [], markedOperationIds: [], queuedVoids: [],
    };

    // 1. the reservation, if active (an expired/released one already returned its stock; consumed ones belong to the saga)
    const reservation = db.prepare("SELECT id FROM reservations WHERE plan_version_id = ? AND status = 'active'").get(planVersionId);
    if (reservation && closeReservation(db, clock, { reservationId: reservation.id, to: 'released', actor: who, requestId })) {
      result.releasedReservationId = reservation.id;
    }

    // 2. supplier orders still open
    const open = db
      .prepare("SELECT id, fulfilment_status FROM supplier_orders WHERE plan_version_id = ? AND fulfilment_status IN ('awaiting_supplier','confirmed') ORDER BY id")
      .all(planVersionId);
    for (const order of open) {
      assertTransition('fulfilment', order.fulfilment_status, 'cancelled');
      const moved = db
        .prepare("UPDATE supplier_orders SET fulfilment_status = 'cancelled' WHERE id = ? AND fulfilment_status = ?")
        .run(order.id, order.fulfilment_status).changes;
      if (moved === 1) result.cancelledOrderIds.push(order.id);
    }

    // 3. every non-terminal operation of the version
    const operations = db
      .prepare(
        'SELECT po.id, po.status, po.supplier_order_id FROM payment_operations po JOIN supplier_orders so ON so.id = po.supplier_order_id ' +
          'WHERE so.plan_version_id = ? ORDER BY po.id',
      )
      .all(planVersionId)
      .filter((op) => !TERMINAL_PAYMENT_STATES.includes(op.status));
    for (const op of operations) {
      db.prepare(
        'UPDATE payment_operations SET cancel_requested_at = COALESCE(cancel_requested_at, ?), cancel_reason = COALESCE(cancel_reason, ?), updated_at = ? WHERE id = ?',
      ).run(now, reason, now, op.id);
      result.markedOperationIds.push(op.id);

      const calls = db.prepare('SELECT id, kind, status, started_at FROM provider_calls WHERE payment_operation_id = ? ORDER BY id').all(op.id);
      const queued = (call) => call.status === 'intent' && call.started_at === null;
      const voidLocally = (cancelKind) => {
        for (const call of calls) {
          if (call.kind === cancelKind && queued(call)) {
            db.prepare("UPDATE provider_calls SET status = 'cancelled', finished_at = ? WHERE id = ? AND status = 'intent' AND started_at IS NULL").run(now, call.id);
          }
        }
        assertTransition('payment', op.status, 'voided');
        const moved = db
          .prepare('UPDATE payment_operations SET status = ?, voided_locally = 1, updated_at = ? WHERE id = ? AND status = ?')
          .run('voided', now, op.id, op.status).changes;
        if (moved === 1) result.voidedOperationIds.push(op.id);
      };

      if (op.status === 'created') {
        voidLocally('create_order');
      } else if (op.status === 'approved') {
        // No authorize call, or one that is provably unsent (queued), means no authorization can exist: void locally.
        // A started or unknown authorize call resolves through the provider call protocol instead.
        const authorize = calls.filter((c) => c.kind === 'authorize');
        const inFlight = authorize.some((c) => (c.status === 'intent' && c.started_at !== null) || c.status === 'unknown');
        if (!inFlight && (authorize.length === 0 || authorize.some(queued) || authorize.every((c) => c.status === 'cancelled'))) {
          voidLocally('authorize');
        }
      } else if (op.status === 'authorized') {
        const intent = {
          operationId: op.id, supplierOrderId: op.supplier_order_id, kind: 'void', attempt: 1,
          operationKey: `so:${op.supplier_order_id}:void:1`, planVersionId, reason,
        };
        provider.queueVoid(db, intent);
        result.queuedVoids.push(intent);
      }
    }

    recordAudit(db, clock, {
      actorUserId: actor?.id ?? null,
      actorRole: actor?.role ?? 'system',
      action: 'void_rule.apply',
      entityType: 'plan_version',
      entityId: planVersionId,
      outcome: 'ok',
      detail: {
        reason,
        released: result.releasedReservationId ?? 0,
        cancelledOrders: result.cancelledOrderIds.length,
        voidedOperations: result.voidedOperationIds.length,
        queuedVoids: result.queuedVoids.length,
      },
      requestId,
    });
    return result;
  }

  voidRule.provider = provider;
  return voidRule;
}
