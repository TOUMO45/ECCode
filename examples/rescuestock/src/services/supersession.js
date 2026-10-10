// Supersession of plan versions (spec: Background Processing > Supersession) and the other way a version leaves the
// executable path before the claim (non_executable with a reason). Everything here runs INSIDE the caller's db.tx and
// applies the void rule (ctx.voidRule) in that same transaction.
//
//   supersedeForOfferChange(ctx, { changes, drops, actor, requestId })
//       changes: [{ offerId, reason }]    an offer changed (price, prep fee, ready time, withdrawal): `offerId` is the
//                                          OLD offer row the plans refer to; reason is one of the SUPERSEDE reasons
//       drops:   [{ productId, newOnHand }]  on_hand decreased: only versions whose planned quantity now exceeds the
//                                          availability (on_hand - reserved + the version's own reservation)
//     Selected: plan versions `proposed` or `approved` that use the offer/product, where the affected supplier's order
//     (if any) is not confirmed (or beyond). Other customers' reservations never select a plan.
//     Effect: each selected version -> superseded (reason); an approved one gets the void rule first; its request is
//     put in replan_queue. Returns [{ planVersionId, requestId, reason }].
//
//   markNonExecutable(ctx, { planVersionId, reason, detail, actor, requestId })
//       approved -> non_executable (reason), void rule in the same transaction. Returns false when the version is no
//       longer `approved` (another actor moved it first).
//
//   enqueueReplan(db, requestId, reason, nowIso)   the request waits for a new plan (F-TR-2: only a stored run removes it)
import { isoFromMs } from '../clock.js';
import { assertTransition } from '../domain/states.js';
import { recordAudit } from './audit.js';

const placeholders = (n) => Array.from({ length: n }, () => '?').join(',');
const CONFIRMED_OR_LATER = Object.freeze(['confirmed', 'ready', 'collected']);

export function enqueueReplan(db, requestId, reason, nowIso) {
  db.prepare(
    'INSERT INTO replan_queue (request_id, reason, enqueued_at, failed_drains, next_attempt_at) VALUES (?, ?, ?, 0, ?) ' +
      'ON CONFLICT(request_id) DO UPDATE SET reason = excluded.reason',
  ).run(requestId, reason, nowIso, nowIso);
}

// Open (proposed/approved) versions whose stored plan has a line on one of the offers.
function versionsUsingOffers(db, offerIds) {
  if (offerIds.length === 0) return [];
  return db
    .prepare(
      'SELECT DISTINCT pv.id, pv.request_id, pv.status FROM plan_versions pv, json_each(pv.plan_json, \'$.lines\') je ' +
        `WHERE pv.status IN ('proposed','approved') AND json_extract(je.value, '$.offerId') IN (${placeholders(offerIds.length)}) ORDER BY pv.id`,
    )
    .all(...offerIds);
}

function plannedBundles(db, planVersionId, offerIds) {
  const row = db
    .prepare(
      'SELECT COALESCE(SUM(json_extract(je.value, \'$.bundles\')), 0) AS n FROM plan_versions pv, json_each(pv.plan_json, \'$.lines\') je ' +
        `WHERE pv.id = ? AND json_extract(je.value, '$.offerId') IN (${placeholders(offerIds.length)})`,
    )
    .get(planVersionId, ...offerIds);
  return row.n;
}

// The affected supplier already committed (confirmed or later): the commitment stands, the plan is not superseded.
function supplierCommitted(db, planVersionId, supplierId) {
  const order = db.prepare('SELECT fulfilment_status FROM supplier_orders WHERE plan_version_id = ? AND supplier_id = ?').get(planVersionId, supplierId);
  return order !== undefined && CONFIRMED_OR_LATER.includes(order.fulfilment_status);
}

export function supersedeForOfferChange(ctx, { changes = [], drops = [], actor = null, requestId = null } = {}) {
  const { db, clock } = ctx;
  const now = isoFromMs(clock.now());
  const selected = new Map(); // planVersionId -> { requestId, status, reason }

  for (const change of changes) {
    const offer = db.prepare('SELECT id, supplier_id FROM offers WHERE id = ?').get(change.offerId);
    if (!offer) continue;
    for (const version of versionsUsingOffers(db, [offer.id])) {
      if (selected.has(version.id) || supplierCommitted(db, version.id, offer.supplier_id)) continue;
      selected.set(version.id, { requestId: version.request_id, status: version.status, reason: change.reason });
    }
  }

  for (const drop of drops) {
    const product = db.prepare('SELECT supplier_id FROM inventory WHERE product_id = ?').get(drop.productId);
    if (!product) continue;
    const offerIds = db.prepare('SELECT id FROM offers WHERE product_id = ?').all(drop.productId).map((o) => o.id);
    const inventory = db.prepare('SELECT on_hand, reserved FROM inventory WHERE product_id = ?').get(drop.productId);
    for (const version of versionsUsingOffers(db, offerIds)) {
      if (selected.has(version.id) || supplierCommitted(db, version.id, product.supplier_id)) continue;
      const own = db
        .prepare(
          'SELECT COALESCE(SUM(ri.qty), 0) AS n FROM reservation_items ri JOIN reservations r ON r.id = ri.reservation_id ' +
            "WHERE r.plan_version_id = ? AND r.status = 'active' AND ri.product_id = ?",
        )
        .get(version.id, drop.productId).n;
      const availability = Math.max(0, drop.newOnHand ?? inventory.on_hand) - inventory.reserved + own;
      if (plannedBundles(db, version.id, offerIds) > availability) {
        selected.set(version.id, { requestId: version.request_id, status: version.status, reason: 'AVAILABILITY_DROPPED' });
      }
    }
  }

  const superseded = [];
  for (const [planVersionId, info] of selected) {
    if (info.status === 'approved') {
      if (typeof ctx.voidRule !== 'function') throw new TypeError('supersession of an approved version needs ctx.voidRule');
      ctx.voidRule(db, { planVersionId, reason: info.reason, actor, requestId });
    }
    assertTransition('plan', info.status, 'superseded', info.reason);
    const moved = db
      .prepare("UPDATE plan_versions SET status = 'superseded', supersede_reason = ?, updated_at = ? WHERE id = ? AND status = ?")
      .run(info.reason, now, planVersionId, info.status).changes;
    if (moved !== 1) continue;
    enqueueReplan(db, info.requestId, info.reason, now);
    recordAudit(db, clock, {
      actorUserId: actor?.id ?? null, actorRole: actor?.role ?? 'system', action: 'plan.supersede', entityType: 'plan_version', entityId: planVersionId,
      outcome: 'ok', detail: { reason: info.reason, from: info.status }, requestId,
    });
    superseded.push({ planVersionId, requestId: info.requestId, reason: info.reason });
  }
  return superseded;
}

export function markNonExecutable(ctx, { planVersionId, reason, detail = {}, actor = null, requestId = null }) {
  const { db, clock } = ctx;
  const now = isoFromMs(clock.now());
  const plan = db.prepare('SELECT id, status FROM plan_versions WHERE id = ?').get(planVersionId);
  if (!plan || plan.status !== 'approved') return false;
  assertTransition('plan', 'approved', 'non_executable', reason);
  ctx.voidRule(db, { planVersionId, reason, actor, requestId });
  const moved = db
    .prepare(
      "UPDATE plan_versions SET status = 'non_executable', non_executable_reason = ?, reason_detail_json = ?, updated_at = ? WHERE id = ? AND status = 'approved'",
    )
    .run(reason, JSON.stringify(detail), now, planVersionId).changes;
  if (moved !== 1) throw new Error('plan version moved during a transaction that holds the write lock');
  recordAudit(db, clock, {
    actorUserId: actor?.id ?? null, actorRole: actor?.role ?? 'system', action: 'plan.non_executable', entityType: 'plan_version', entityId: planVersionId,
    outcome: 'ok', detail: { reason }, requestId,
  });
  return true;
}
