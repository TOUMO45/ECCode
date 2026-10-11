// Supplier orders and supplier inventory (spec: Interface Contracts > Supplier routes; Void rule; Supersession).
// Every query is scoped to the caller's supplier (users.supplier_id): another supplier's order id is 404, and a PATCH
// that names another supplier's product is refused as a whole (403, nothing changed).
//
//   listSupplierOrders(ctx, supplierId, status)            GET  /api/supplier/orders
//   confirmSupplierOrder(ctx, user, orderId, input)        POST .../confirm  awaiting_supplier -> confirmed (COMMITMENT_INVALID)
//   refuseSupplierOrder(ctx, user, orderId, reason, opts)  POST .../refuse   -> refused, void rule (SUPPLIER_REFUSED), re-plan queued
//                                                           (also used by the admin supplier_refusal fault: opts.supplierId = null)
//   markOrderReady / recordHandover                        confirmed -> ready -> collected, only for an executed plan
//   listSupplierInventory / patchSupplierInventory         GET / PATCH /api/supplier/inventory
//
// Refused transitions write an audit_events row with outcome `denied` (code only, no free text).
import { isoFromMs } from '../clock.js';
import { assertTransition } from '../domain/states.js';
import { AppError } from '../http/envelope.js';
import { bool, int, ts } from '../http/validate.js';
import { recordAudit } from './audit.js';
import { actorOf, setOnHand } from './ledger.js';
import { enqueueReplan, markNonExecutable, supersedeForOfferChange } from './supersession.js';
import { buildOrderView, labelsOf, parseJson } from './view.js';

export const FULFILMENT_STATUSES = Object.freeze(['awaiting_supplier', 'confirmed', 'refused', 'cancelled', 'ready', 'collected']);
const MAX_LIST = 200;
const MAX_ID = 1e12;
const DENIED_CODES = new Set(['INVALID_STATE', 'COMMITMENT_INVALID', 'ORDER_EXECUTED', 'HANDOVER_BLOCKED', 'RESERVATION_EXPIRED']);
// Brief > State machines: handover is blocked while an operation of the plan is in one of these states.
const HANDOVER_BLOCKING_PAYMENT = Object.freeze(['unknown', 'capture_pending', 'refund_requested', 'refund_pending', 'refund_failed']);

// ------------------------------------------------------------------ loading and rendering

const ORDER_SELECT =
  'SELECT so.*, s.code AS supplier_code, s.demo AS supplier_demo, pv.request_id, pv.version AS plan_version_no, pv.status AS plan_status, ' +
  'pv.plan_json, pv.non_executable_reason, pr.requirements_version, rr.customer_id, u.display_name AS buyer_name, ' +
  '(SELECT q.deadline_at FROM requirements q WHERE q.request_id = pv.request_id AND q.version = pr.requirements_version) AS deadline_at, ' +
  'po.status AS payment_status, po.provider AS payment_provider ' +
  'FROM supplier_orders so JOIN suppliers s ON s.id = so.supplier_id JOIN plan_versions pv ON pv.id = so.plan_version_id ' +
  'JOIN planning_runs pr ON pr.id = pv.planning_run_id JOIN rescue_requests rr ON rr.id = pv.request_id ' +
  'JOIN users u ON u.id = rr.customer_id LEFT JOIN payment_operations po ON po.supplier_order_id = so.id ';

// supplierId null = unscoped (the admin fault path). A request archived by the reset is no longer anybody's order.
function loadOrder(db, orderId, supplierId) {
  const row =
    supplierId === null
      ? db.prepare(`${ORDER_SELECT} WHERE so.id = ? AND rr.archived_at IS NULL`).get(orderId)
      : db.prepare(`${ORDER_SELECT} WHERE so.id = ? AND so.supplier_id = ? AND rr.archived_at IS NULL`).get(orderId, supplierId);
  if (!row) throw new AppError(404, 'NOT_FOUND');
  return row;
}

// Handover and ready need an executed plan with no operation that is unsettled or being refunded (brief, state tables).
function handoverAllowed(db, order) {
  if (order.plan_status !== 'executed') return false;
  const blocking = db
    .prepare(
      'SELECT po.status FROM payment_operations po JOIN supplier_orders s ON s.id = po.supplier_order_id WHERE s.plan_version_id = ?',
    )
    .all(order.plan_version_id)
    .some((op) => HANDOVER_BLOCKING_PAYMENT.includes(op.status));
  if (blocking) return false;
  const reconciling = db.prepare("SELECT 1 AS x FROM reservations WHERE plan_version_id = ? AND status = 'reconciling'").get(order.plan_version_id);
  return reconciling === undefined;
}

function committedBundles(order) {
  const parsed = parseJson(order.committed_qty_json, null);
  if (!Array.isArray(parsed)) return null;
  return parsed.reduce((n, e) => n + (Number.isSafeInteger(e?.committedBundles) ? e.committedBundles : 0), 0);
}

function presentationOf(order) {
  if (order.fulfilment_status === 'refused') return 'refused';
  if (order.fulfilment_status === 'cancelled') return 'cancelled';
  if (order.payment_status === 'refunded') return 'refunded';
  // F-TR-11: an order of a plan that can no longer be executed reads "Cancelled — payment did not complete".
  if (order.plan_status === 'non_executable') return 'cancelled_payment_incomplete';
  return 'active';
}

// SupplierOrder of the spec. The buyer's username, payer data and other suppliers' details are never included.
export function renderSupplierOrder(db, order) {
  const body = parseJson(order.plan_json, null);
  const entry = body?.suppliers?.find((s) => s.supplierCode === order.supplier_code) ?? null;
  const live = order.plan_status !== 'non_executable' && order.plan_status !== 'superseded';
  const guard = live && (order.fulfilment_status === 'confirmed' || order.fulfilment_status === 'ready') ? handoverAllowed(db, order) : false;
  const bundles = committedBundles(order);
  return {
    id: order.id,
    ref: `R${order.request_id}-V${order.plan_version_no}`,
    buyer: { displayName: order.buyer_name },
    lines: parseJson(order.lines_json, []),
    totalCents: order.total_cents,
    catalogReadyAt: entry?.catalogReadyAt ?? body?.readyAt ?? null,
    deadlineAt: order.deadline_at ?? null,
    fulfilmentStatus: order.fulfilment_status,
    commitment:
      order.confirmed_at && bundles !== null ? { bundles, readyAt: order.committed_ready_at, confirmedAt: order.confirmed_at } : null,
    refusalReason: order.refusal_reason ?? null,
    payment: {
      status: order.payment_status ?? null,
      simulated: order.payment_provider === 'fake',
      sandbox: order.payment_provider === 'paypal-sandbox',
    },
    presentation: presentationOf(order),
    canConfirm: order.fulfilment_status === 'awaiting_supplier' && order.plan_status === 'approved',
    canMarkReady: order.fulfilment_status === 'confirmed' && guard,
    canHandover: order.fulfilment_status === 'ready' && guard,
    demo: order.supplier_demo === 1,
  };
}

export function listSupplierOrders(ctx, supplierId, status = null) {
  const { db } = ctx;
  if (status !== null && !FULFILMENT_STATUSES.includes(status)) throw new AppError(400, 'BAD_REQUEST');
  const rows =
    status === null
      ? db.prepare(`${ORDER_SELECT} WHERE so.supplier_id = ? AND rr.archived_at IS NULL ORDER BY so.id DESC LIMIT ?`).all(supplierId, MAX_LIST)
      : db
          .prepare(`${ORDER_SELECT} WHERE so.supplier_id = ? AND so.fulfilment_status = ? AND rr.archived_at IS NULL ORDER BY so.id DESC LIMIT ?`)
          .all(supplierId, status, MAX_LIST);
  return rows.map((row) => renderSupplierOrder(db, row));
}

export function getSupplierOrder(ctx, supplierId, orderId) {
  return renderSupplierOrder(ctx.db, loadOrder(ctx.db, orderId, supplierId));
}

// 404 for an order of another supplier (or an unknown/archived one), checked before the body is read.
export function assertOwnedOrder(db, supplierId, orderId) {
  loadOrder(db, orderId, supplierId);
}

// A refusal reason: 1-300 characters, not blank, no control characters except tab and line breaks.
export function checkRefusalReason(value) {
  if (typeof value !== 'string') return { ok: false, rule: 'string' };
  const text = value.normalize('NFC');
  const length = Array.from(text).length;
  if (length < 1 || length > 300) return { ok: false, rule: 'length:1..300' };
  if (text.trim().length === 0) return { ok: false, rule: 'blank' };
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(text)) return { ok: false, rule: 'characters' };
  return { ok: true, value: text };
}

// Audits a refused transition (outcome denied, code only) after the failed transaction rolled back, then rethrows.
function auditedTransition(ctx, user, action, orderId, fn) {
  try {
    return fn();
  } catch (err) {
    if (err instanceof AppError && DENIED_CODES.has(err.code)) {
      try {
        recordAudit(ctx.db, ctx.clock, {
          actorUserId: user.id, actorRole: user.role, action, entityType: 'supplier_order', entityId: orderId,
          outcome: 'denied', detail: { code: err.code }, requestId: ctx.requestId,
        });
      } catch {
        ctx.log.error('audit.failed', { code: 'AUDIT_FAILED' });
      }
    }
    throw err;
  }
}

function invalidState(from, to) {
  return new AppError(409, 'INVALID_STATE', { details: { from, to } });
}

// ------------------------------------------------------------------ confirm

export function checkConfirmLines(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 20) return { ok: false, rule: 'array:1..20' };
  const lines = [];
  for (const item of value) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) return { ok: false, rule: 'object' };
    const offerId = int(1, MAX_ID)(item.offerId);
    const bundles = int(1, 1_000_000)(item.committedBundles);
    if (!offerId.ok) return { ok: false, rule: `offerId:${offerId.rule}` };
    if (!bundles.ok) return { ok: false, rule: `committedBundles:${bundles.rule}` };
    lines.push({ offerId: offerId.value, committedBundles: bundles.value });
  }
  return { ok: true, value: lines };
}
export const checkCommittedReadyAt = ts();

// committed quantity >= planned for every planned offer, no other offer, ready time not after the deadline
function assertCommitmentValid(order, lines, committedReadyAt) {
  const planned = new Map(parseJson(order.lines_json, []).map((l) => [l.offerId, l.bundles]));
  const fields = [];
  const seen = new Set();
  for (const line of lines) {
    if (seen.has(line.offerId)) fields.push({ field: 'lines', rule: 'duplicate_offer' });
    seen.add(line.offerId);
    if (!planned.has(line.offerId)) fields.push({ field: 'lines', rule: 'unknown_offer' });
    else if (line.committedBundles < planned.get(line.offerId)) fields.push({ field: 'lines', rule: 'below_planned' });
  }
  for (const offerId of planned.keys()) if (!seen.has(offerId)) fields.push({ field: 'lines', rule: 'missing_offer' });
  if (order.deadline_at && Date.parse(committedReadyAt) > Date.parse(order.deadline_at)) fields.push({ field: 'committedReadyAt', rule: 'after_deadline' });
  if (fields.length > 0) {
    const unique = [...new Map(fields.map((f) => [`${f.field}:${f.rule}`, f])).values()];
    throw new AppError(422, 'COMMITMENT_INVALID', { details: { fields: unique } });
  }
}

const normalized = (lines) => JSON.stringify([...lines].sort((a, b) => a.offerId - b.offerId).map((l) => ({ offerId: l.offerId, committedBundles: l.committedBundles })));

export function confirmSupplierOrder(ctx, user, orderId, { lines, committedReadyAt }) {
  const { db, clock } = ctx;
  return auditedTransition(ctx, user, 'order.confirm', orderId, () =>
    db.tx(() => {
      const order = loadOrder(db, orderId, user.supplierId);
      if (order.fulfilment_status === 'confirmed') {
        const same = order.committed_qty_json === normalized(lines) && order.committed_ready_at === committedReadyAt;
        if (same) return renderSupplierOrder(db, order);
        throw invalidState('confirmed', 'confirmed');
      }
      if (order.fulfilment_status !== 'awaiting_supplier') throw invalidState(order.fulfilment_status, 'confirmed');
      if (order.plan_status !== 'approved') throw invalidState(order.plan_status, 'confirmed');
      const reservation = db.prepare('SELECT status, expires_at FROM reservations WHERE id = ?').get(order.reservation_id);
      if (reservation.status !== 'active') throw invalidState(`reservation_${reservation.status}`, 'confirmed');
      if (Date.parse(reservation.expires_at) <= clock.now()) throw new AppError(409, 'RESERVATION_EXPIRED');
      assertCommitmentValid(order, lines, committedReadyAt);

      assertTransition('fulfilment', 'awaiting_supplier', 'confirmed');
      const now = isoFromMs(clock.now());
      const moved = db
        .prepare(
          "UPDATE supplier_orders SET fulfilment_status = 'confirmed', committed_qty_json = ?, committed_ready_at = ?, confirmed_at = ? WHERE id = ? AND fulfilment_status = 'awaiting_supplier'",
        )
        .run(normalized(lines), committedReadyAt, now, orderId).changes;
      if (moved !== 1) throw invalidState('awaiting_supplier', 'confirmed');
      recordAudit(db, clock, {
        actorUserId: user.id, actorRole: user.role, action: 'order.confirm', entityType: 'supplier_order', entityId: orderId,
        outcome: 'ok', detail: { planVersionId: order.plan_version_id }, requestId: ctx.requestId,
      });
      return renderSupplierOrder(db, loadOrder(db, orderId, user.supplierId));
    }),
  );
}

// ------------------------------------------------------------------ refuse

// opts.supplierId: the caller's supplier (scopes the lookup); null = the admin fault, which may name any supplier's order.
// A refusal before the execute claim: order refused, the plan becomes non_executable (SUPPLIER_REFUSED), the void rule
// runs in the same transaction (reservation released, the other orders cancelled, operations voided locally) and a
// re-plan is queued. After the claim: 409 ORDER_EXECUTED. A repeat answers with the refused order.
export function refuseSupplierOrder(ctx, user, orderId, reason, { supplierId = user.supplierId } = {}) {
  const { db, clock } = ctx;
  return auditedTransition(ctx, user, 'order.refuse', orderId, () =>
    db.tx(() => {
      const order = loadOrder(db, orderId, supplierId);
      if (order.fulfilment_status === 'refused') return renderSupplierOrder(db, order);
      if (['executing', 'executed'].includes(order.plan_status) || ['ready', 'collected'].includes(order.fulfilment_status)) {
        throw new AppError(409, 'ORDER_EXECUTED');
      }
      if (!['awaiting_supplier', 'confirmed'].includes(order.fulfilment_status)) throw invalidState(order.fulfilment_status, 'refused');
      if (order.plan_status !== 'approved') throw invalidState(order.plan_status, 'refused');

      assertTransition('fulfilment', order.fulfilment_status, 'refused');
      const now = isoFromMs(clock.now());
      const moved = db
        .prepare('UPDATE supplier_orders SET fulfilment_status = ?, refusal_reason = ? WHERE id = ? AND fulfilment_status = ?')
        .run('refused', reason, orderId, order.fulfilment_status).changes;
      if (moved !== 1) throw invalidState(order.fulfilment_status, 'refused');
      markNonExecutable(ctx, {
        planVersionId: order.plan_version_id,
        reason: 'SUPPLIER_REFUSED',
        detail: { supplierCode: order.supplier_code, refusal: reason },
        actor: user,
        requestId: ctx.requestId,
      });
      enqueueReplan(db, order.request_id, 'SUPPLIER_REFUSED', now);
      recordAudit(db, clock, {
        actorUserId: user.id, actorRole: user.role, action: 'order.refuse', entityType: 'supplier_order', entityId: orderId,
        outcome: 'ok', detail: { planVersionId: order.plan_version_id, supplierCode: order.supplier_code }, requestId: ctx.requestId,
      });
      return renderSupplierOrder(db, loadOrder(db, orderId, supplierId));
    }),
  );
}

// Open (pre-claim) orders of one supplier, for the admin supplier_refusal fault.
export function openOrderIdsOfSupplier(db, supplierId) {
  return db
    .prepare(
      "SELECT so.id FROM supplier_orders so JOIN plan_versions pv ON pv.id = so.plan_version_id WHERE so.supplier_id = ? " +
        "AND so.fulfilment_status IN ('awaiting_supplier','confirmed') AND pv.status = 'approved' ORDER BY so.id",
    )
    .all(supplierId)
    .map((r) => r.id);
}

// ------------------------------------------------------------------ ready and handover

export function markOrderReady(ctx, user, orderId) {
  const { db, clock } = ctx;
  return auditedTransition(ctx, user, 'order.ready', orderId, () =>
    db.tx(() => {
      const order = loadOrder(db, orderId, user.supplierId);
      if (order.fulfilment_status === 'ready' || order.fulfilment_status === 'collected') return renderSupplierOrder(db, order);
      if (order.fulfilment_status !== 'confirmed') throw invalidState(order.fulfilment_status, 'ready');
      if (!handoverAllowed(db, order)) throw new AppError(409, 'HANDOVER_BLOCKED');
      assertTransition('fulfilment', 'confirmed', 'ready');
      const moved = db
        .prepare("UPDATE supplier_orders SET fulfilment_status = 'ready', ready_marked_at = ? WHERE id = ? AND fulfilment_status = 'confirmed'")
        .run(isoFromMs(clock.now()), orderId).changes;
      if (moved !== 1) throw invalidState('confirmed', 'ready');
      recordAudit(db, clock, {
        actorUserId: user.id, actorRole: user.role, action: 'order.ready', entityType: 'supplier_order', entityId: orderId,
        outcome: 'ok', detail: { planVersionId: order.plan_version_id }, requestId: ctx.requestId,
      });
      return renderSupplierOrder(db, loadOrder(db, orderId, user.supplierId));
    }),
  );
}

export function recordHandover(ctx, user, orderId) {
  const { db, clock } = ctx;
  return auditedTransition(ctx, user, 'order.handover', orderId, () =>
    db.tx(() => {
      const order = loadOrder(db, orderId, user.supplierId);
      if (order.fulfilment_status === 'collected') return renderSupplierOrder(db, order);
      if (order.fulfilment_status !== 'ready') {
        // A confirmed order of an unexecuted plan is blocked by the plan, not by its own state.
        if (order.fulfilment_status === 'confirmed' && !handoverAllowed(db, order)) throw new AppError(409, 'HANDOVER_BLOCKED');
        throw invalidState(order.fulfilment_status, 'collected');
      }
      if (!handoverAllowed(db, order)) throw new AppError(409, 'HANDOVER_BLOCKED');
      assertTransition('fulfilment', 'ready', 'collected');
      const now = isoFromMs(clock.now());
      const moved = db
        .prepare("UPDATE supplier_orders SET fulfilment_status = 'collected', collected_at = ? WHERE id = ? AND fulfilment_status = 'ready'")
        .run(now, orderId).changes;
      if (moved !== 1) throw invalidState('ready', 'collected');
      db.prepare("INSERT OR IGNORE INTO pickup_confirmations (supplier_order_id, kind, by_user, at) VALUES (?, 'handover', ?, ?)").run(orderId, user.id, now);
      recordAudit(db, clock, {
        actorUserId: user.id, actorRole: user.role, action: 'order.handover', entityType: 'supplier_order', entityId: orderId,
        outcome: 'ok', detail: { planVersionId: order.plan_version_id }, requestId: ctx.requestId,
      });
      return renderSupplierOrder(db, loadOrder(db, orderId, user.supplierId));
    }),
  );
}

// ------------------------------------------------------------------ the customer's side of an order

// The order of the caller's own, non-archived request, with what the payment routes need. Another customer's order, an
// archived one and an unknown id are all 404 (no existence leak).
export function findOwnedOrder(db, userId, orderId) {
  const row = db
    .prepare(
      'SELECT so.id, so.plan_version_id, so.supplier_id, so.reservation_id, so.total_cents, so.fulfilment_status, ' +
        'pv.request_id, pv.status AS plan_status, pv.non_executable_reason, pv.planning_run_id, s.code AS supplier_code ' +
        'FROM supplier_orders so JOIN plan_versions pv ON pv.id = so.plan_version_id JOIN suppliers s ON s.id = so.supplier_id ' +
        'JOIN rescue_requests rr ON rr.id = pv.request_id ' +
        'WHERE so.id = ? AND rr.customer_id = ? AND rr.archived_at IS NULL AND rr.deleted_at IS NULL',
    )
    .get(orderId, userId);
  if (!row) throw new AppError(404, 'NOT_FOUND');
  return row;
}

// POST /api/orders/:id/receipt: the buyer records that the goods were received. Allowed when the order is `ready` or
// `collected`; a repeat answers 200 with the unchanged order (UNIQUE (supplier_order_id, kind)).
export function recordReceipt(ctx, user, orderId) {
  const { db, clock } = ctx;
  const row = findOwnedOrder(db, user.id, orderId);
  if (row.fulfilment_status !== 'ready' && row.fulfilment_status !== 'collected') {
    try {
      recordAudit(db, clock, {
        actorUserId: user.id, actorRole: user.role, action: 'order.receipt', entityType: 'supplier_order', entityId: orderId,
        outcome: 'denied', detail: { code: 'INVALID_STATE' }, requestId: ctx.requestId,
      });
    } catch {
      ctx.log.error('audit.failed', { code: 'AUDIT_FAILED' });
    }
    throw invalidState(row.fulfilment_status, 'receipt');
  }
  db.tx(() => {
    const now = isoFromMs(clock.now());
    const added = db.prepare("INSERT OR IGNORE INTO pickup_confirmations (supplier_order_id, kind, by_user, at) VALUES (?, 'receipt', ?, ?)").run(orderId, user.id, now).changes;
    if (added === 1) {
      recordAudit(db, clock, {
        actorUserId: user.id, actorRole: user.role, action: 'order.receipt', entityType: 'supplier_order', entityId: orderId,
        outcome: 'ok', detail: { planVersionId: row.plan_version_id }, requestId: ctx.requestId,
      });
    }
  });
  return buildOrderView(ctx, row.request_id, user.id, orderId);
}

// ------------------------------------------------------------------ inventory

function inventoryItems(db, supplierId) {
  const products = db
    .prepare(
      'SELECT p.id, p.name, p.kind, p.capacity_ml, p.diameter_mm, p.demo, i.on_hand, i.reserved FROM products p JOIN inventory i ON i.product_id = p.id ' +
        'WHERE p.supplier_id = ? ORDER BY p.id',
    )
    .all(supplierId);
  const offers = new Map(
    db
      .prepare("SELECT * FROM offers WHERE supplier_id = ? AND status IN ('active','withdrawn')")
      .all(supplierId)
      .map((o) => [o.product_id, o]),
  );
  return products.map((p) => {
    const offer = offers.get(p.id);
    return {
      productId: p.id,
      name: p.name,
      kind: p.kind,
      capacityMl: p.capacity_ml ?? null,
      diameterMm: p.diameter_mm ?? null,
      onHand: p.on_hand,
      reserved: p.reserved,
      offer: offer
        ? { id: offer.id, version: offer.version, priceCents: offer.price_cents, prepFeeCents: offer.prep_fee_cents, readyAt: offer.ready_at, status: offer.status }
        : null,
      demo: p.demo === 1,
    };
  });
}

export function listSupplierInventory(ctx, supplierId) {
  return { items: inventoryItems(ctx.db, supplierId), labels: labelsOf(ctx.config) };
}

const PATCH_FIELDS = Object.freeze({
  onHand: int(0, 1_000_000),
  priceCents: int(0, 100_000_000),
  prepFeeCents: int(0, 100_000_000),
  readyAt: ts(),
  withdrawn: bool(),
});

// {items: [...]} -> checked items; 422 VALIDATION_FAILED lists every failing field as items.<index>.<name>.
export function checkInventoryPatch(body) {
  const fail = (fields) => new AppError(422, 'VALIDATION_FAILED', { details: { fields } });
  const items = body !== null && typeof body === 'object' ? body.items : undefined;
  if (!Array.isArray(items) || items.length < 1 || items.length > 20) throw fail([{ field: 'items', rule: Array.isArray(items) ? 'array:1..20' : 'array' }]);
  const fields = [];
  const out = [];
  const seen = new Set();
  items.forEach((raw, index) => {
    const at = `items.${index}`;
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      fields.push({ field: at, rule: 'object' });
      return;
    }
    const checked = {};
    const productId = int(1, MAX_ID)(raw.productId);
    if (!productId.ok) fields.push({ field: `${at}.productId`, rule: productId.rule });
    else if (seen.has(productId.value)) fields.push({ field: `${at}.productId`, rule: 'duplicate' });
    else {
      seen.add(productId.value);
      checked.productId = productId.value;
    }
    let changes = 0;
    for (const [name, check] of Object.entries(PATCH_FIELDS)) {
      if (raw[name] === undefined) continue;
      const result = check(raw[name]);
      if (result.ok) {
        checked[name] = result.value;
        changes += 1;
      } else fields.push({ field: `${at}.${name}`, rule: result.rule });
    }
    if (changes === 0 && productId.ok) fields.push({ field: at, rule: 'nothing_to_change' });
    out.push(checked);
  });
  if (fields.length > 0) throw fail(fields);
  return out;
}

const SUPERSEDE_PRIORITY = Object.freeze(['OFFER_WITHDRAWN', 'PRICE_CHANGED', 'PREP_FEE_CHANGED', 'READY_TIME_CHANGED']);

export function patchSupplierInventory(ctx, user, items) {
  const { db, clock } = ctx;
  // Ownership of the WHOLE patch first: one foreign product refuses everything (RS-28), then unknown ids.
  const ids = items.map((i) => i.productId);
  const owners = new Map(
    db.prepare(`SELECT id, supplier_id FROM products WHERE id IN (${ids.map(() => '?').join(',')})`).all(...ids).map((p) => [p.id, p.supplier_id]),
  );
  if (ids.some((id) => owners.has(id) && owners.get(id) !== user.supplierId)) {
    audit(ctx, user, 'denied', { code: 'FORBIDDEN' });
    throw new AppError(403, 'FORBIDDEN');
  }
  if (ids.some((id) => !owners.has(id))) throw new AppError(404, 'NOT_FOUND');

  try {
    return db.tx(() => {
      const now = isoFromMs(clock.now());
      const actor = actorOf(user);
      const changes = [];
      const drops = [];
      for (const item of items) {
        const inventory = db.prepare('SELECT on_hand, reserved FROM inventory WHERE product_id = ?').get(item.productId);
        const wantsOffer = ['priceCents', 'prepFeeCents', 'readyAt', 'withdrawn'].some((f) => item[f] !== undefined);
        if (item.onHand !== undefined && !inventory) throw new AppError(422, 'VALIDATION_FAILED', { details: { fields: [{ field: 'items.productId', rule: 'no_inventory' }] } });

        if (wantsOffer) {
          const current = db.prepare("SELECT * FROM offers WHERE product_id = ? AND status IN ('active','withdrawn')").get(item.productId);
          if (!current) throw new AppError(422, 'VALIDATION_FAILED', { details: { fields: [{ field: 'items.productId', rule: 'no_offer' }] } });
          const next = {
            price: item.priceCents ?? current.price_cents,
            prep: item.prepFeeCents ?? current.prep_fee_cents,
            readyAt: item.readyAt ?? current.ready_at,
            withdrawn: item.withdrawn ?? current.status === 'withdrawn',
          };
          const reasons = [];
          if (next.withdrawn && current.status !== 'withdrawn') reasons.push('OFFER_WITHDRAWN');
          if (next.price !== current.price_cents) reasons.push('PRICE_CHANGED');
          if (next.prep !== current.prep_fee_cents) reasons.push('PREP_FEE_CHANGED');
          if (next.readyAt !== current.ready_at) reasons.push('READY_TIME_CHANGED');
          const reactivated = !next.withdrawn && current.status === 'withdrawn';
          if (reasons.length > 0 || reactivated) {
            // The old row is replaced first: only one current (active or withdrawn) offer may exist per product.
            db.prepare("UPDATE offers SET status = 'replaced', valid_to = ? WHERE id = ?").run(now, current.id);
            db.prepare(
              'INSERT INTO offers (supplier_id, product_id, price_cents, prep_fee_cents, ready_at, version, status, valid_from, valid_to, demo) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)',
            ).run(current.supplier_id, current.product_id, next.price, next.prep, next.readyAt, current.version + 1, next.withdrawn ? 'withdrawn' : 'active', now, current.demo);
            const reason = SUPERSEDE_PRIORITY.find((r) => reasons.includes(r));
            if (reason) changes.push({ offerId: current.id, reason });
          }
        }

        if (item.onHand !== undefined) {
          const result = setOnHand(db, clock, { productId: item.productId, newOnHand: item.onHand, actor, requestId: ctx.requestId });
          if (result === null) throw new AppError(409, 'RESERVED_STOCK', { details: { productId: item.productId, reserved: inventory.reserved } });
          if (result.delta < 0) drops.push({ productId: item.productId, newOnHand: item.onHand });
        }
        recordAudit(db, clock, {
          actorUserId: user.id, actorRole: user.role, action: 'inventory.patch', entityType: 'product', entityId: item.productId,
          outcome: 'ok', detail: { onHand: item.onHand ?? -1, offerChanged: wantsOffer }, requestId: ctx.requestId,
        });
      }
      const superseded = supersedeForOfferChange(ctx, { changes, drops, actor: user, requestId: ctx.requestId });
      return { items: inventoryItems(db, user.supplierId), superseded: superseded.map((s) => ({ planVersionId: s.planVersionId, requestId: s.requestId })) };
    });
  } catch (err) {
    if (err instanceof AppError && err.code === 'RESERVED_STOCK') audit(ctx, user, 'denied', { code: err.code });
    throw err;
  }
}

function audit(ctx, user, outcome, detail) {
  try {
    recordAudit(ctx.db, ctx.clock, {
      actorUserId: user.id, actorRole: user.role, action: 'inventory.patch', entityType: 'inventory', entityId: user.supplierId,
      outcome, detail, requestId: ctx.requestId,
    });
  } catch {
    ctx.log.error('audit.failed', { code: 'AUDIT_FAILED' });
  }
}
