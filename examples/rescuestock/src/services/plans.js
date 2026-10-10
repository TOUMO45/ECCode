// Planning runs and plan approval (spec: Customer routes > plan, approve; Supersession basics).
//
//   createPlan(ctx, user, requestId)       POST /api/requests/:id/plan
//   approvePlan(ctx, user, planId, body)   POST /api/plans/:id/approve (RS-04 half, RS-12)
//   runPlanningFor(ctx, requestId, actor)  snapshot -> planner -> store (offers_hash re-checked, up to 3 attempts);
//                                          also the entry point for the re-plan drain of phase F (f1)
//   supersedeOpenVersions(ctx, id, reason) proposed/approved -> superseded; the void rule is a hook (ctx.voidRule)
//   takePlanSlot(ctx, userId)              per-customer planning rate limit (FU-8, RISK-19)
//   findOwnedPlan(db, userId, planId)      a plan version of the caller's own, non-archived request, else 404
//
// The planner is CPU-bound and synchronous (150-800 ms worst case, RISK-19). It runs outside any transaction; the
// result is stored in one BEGIN IMMEDIATE that first re-reads the catalog and refuses to store a result computed on
// a catalog that changed in the meantime.
import { isoFromMs } from '../clock.js';
import { canonicalHash } from '../domain/canonical.js';
import { PlannerLimitError } from '../domain/search.js';
import { assertTransition } from '../domain/states.js';
import { AppError } from '../http/envelope.js';
import { recordAudit } from './audit.js';
import { LIVE_RESERVATION_STATES, findOwnedRequest, labelsOf, parseJson, readSnapshot, renderPlanVersion, renderPlanningRun } from './view.js';

const MAX_ATTEMPTS = 3;
const GUARDED_DENIALS = new Set(['PLAN_CHANGED', 'PLAN_INVALID', 'MISSING_BUDGET', 'MISSING_DEADLINE']);

export const PLAN_RATE_DEFAULT = Object.freeze({ limit: 10, windowMs: 10 * 60 * 1000 });

// ------------------------------------------------------------------ ownership

export function findOwnedPlan(db, userId, planId) {
  const row = db
    .prepare(
      'SELECT pv.* FROM plan_versions pv JOIN rescue_requests rr ON rr.id = pv.request_id ' +
        'WHERE pv.id = ? AND rr.customer_id = ? AND rr.archived_at IS NULL AND rr.deleted_at IS NULL',
    )
    .get(planId, userId);
  if (!row) throw new AppError(404, 'NOT_FOUND');
  return row;
}

// ------------------------------------------------------------------ supersession (basics; f1 extends)

// proposed/approved versions of a request -> superseded with `reason`. A version that holds a live reservation
// needs the void rule (c3, src/services/void-rule.js, passed as ctx.voidRule): without it the call is refused,
// so stock is never left reserved under a superseded plan. Returns the ids. Call inside a transaction.
export function supersedeOpenVersions(ctx, requestId, reason, nowIso) {
  const { db } = ctx;
  const open = db.prepare("SELECT id, status FROM plan_versions WHERE request_id = ? AND status IN ('proposed','approved') ORDER BY version").all(requestId);
  const ids = [];
  for (const version of open) {
    const live = db
      .prepare(`SELECT id FROM reservations WHERE plan_version_id = ? AND status IN (${LIVE_RESERVATION_STATES.map(() => '?').join(',')}) LIMIT 1`)
      .get(version.id, ...LIVE_RESERVATION_STATES);
    if (live) {
      if (typeof ctx.voidRule !== 'function') throw new AppError(409, 'PLAN_IN_PROGRESS', { details: { planVersionId: version.id } });
      ctx.voidRule(db, { planVersionId: version.id, reason });
    }
    assertTransition('plan', version.status, 'superseded', reason);
    const changed = db
      .prepare("UPDATE plan_versions SET status = 'superseded', supersede_reason = ?, updated_at = ? WHERE id = ? AND status = ?")
      .run(reason, nowIso, version.id, version.status).changes;
    if (changed !== 1) throw new AppError(409, 'INVALID_STATE', { details: { from: version.status, to: 'superseded' } });
    ids.push(version.id);
  }
  return ids;
}

// ------------------------------------------------------------------ the planning rate limit (FU-8)

// rate_events.kind has no 'plan' value (002_requests.sql CHECK), so planning is counted under kind 'general' with
// the key 'plan:u:<userId>'. The general per-user limit uses 'u:<userId>', so the two never share a count.
export function takePlanSlot(ctx, userId) {
  const { db, clock, planRate } = ctx;
  const nowMs = clock.now();
  const cutoff = isoFromMs(nowMs - planRate.windowMs);
  const key = `plan:u:${userId}`;
  const decision = db.tx(() => {
    db.prepare("DELETE FROM rate_events WHERE kind = 'general' AND user_key = ? AND at <= ?").run(key, cutoff);
    const row = db.prepare("SELECT COUNT(*) AS n, MIN(at) AS oldest FROM rate_events WHERE kind = 'general' AND user_key = ? AND at > ?").get(key, cutoff);
    if (row.n >= planRate.limit) {
      return { allowed: false, retryAfterS: Math.max(1, Math.ceil((Date.parse(row.oldest) + planRate.windowMs - nowMs) / 1000)) };
    }
    db.prepare("INSERT INTO rate_events (user_key, kind, at) VALUES (?, 'general', ?)").run(key, isoFromMs(nowMs));
    return { allowed: true };
  });
  if (!decision.allowed) {
    throw new AppError(429, 'RATE_LIMITED', { details: { limit: 'plan' }, headers: { 'Retry-After': String(decision.retryAfterS) } });
  }
}

// ------------------------------------------------------------------ the catalog snapshot

// Current offers of bundle products with their stock, in the planner's input shape (contract: Internal module contracts).
export function loadOffers(db) {
  const rows = db
    .prepare(
      'SELECT o.id AS offer_id, o.version AS offer_version, o.price_cents, o.prep_fee_cents, o.ready_at, o.status, o.demo AS offer_demo, ' +
        'p.id AS product_id, p.name AS product_name, p.capacity_ml AS bundle_capacity_ml, s.code AS supplier_code, ' +
        'COALESCE(i.on_hand, 0) AS on_hand, COALESCE(i.reserved, 0) AS reserved ' +
        "FROM offers o JOIN products p ON p.id = o.product_id AND p.kind = 'bundle' JOIN suppliers s ON s.id = o.supplier_id " +
        "LEFT JOIN inventory i ON i.product_id = p.id WHERE o.status IN ('active','withdrawn') ORDER BY s.code, o.id",
    )
    .all();
  const items = db
    .prepare(
      'SELECT bi.bundle_product_id, bi.qty, ip.id AS item_id, ip.kind, ip.capacity_ml, ip.diameter_mm ' +
        "FROM bundle_items bi JOIN products ip ON ip.id = bi.item_product_id WHERE ip.kind IN ('cup','lid')",
    )
    .all();
  const itemsByBundle = new Map();
  for (const item of items) {
    const list = itemsByBundle.get(item.bundle_product_id);
    if (list) list.push(item);
    else itemsByBundle.set(item.bundle_product_id, [item]);
  }
  const compatible = new Set(db.prepare('SELECT cup_product_id, lid_product_id FROM compatibility').all().map((c) => `${c.cup_product_id}:${c.lid_product_id}`));

  const offers = [];
  for (const row of rows) {
    const parts = itemsByBundle.get(row.product_id) ?? [];
    const cups = parts.filter((p) => p.kind === 'cup');
    const lids = parts.filter((p) => p.kind === 'lid');
    if (cups.length === 0 || lids.length === 0) continue; // only bundles of cups with lids are plannable
    const cup = cups[0];
    const lid = lids[0];
    offers.push({
      offerId: row.offer_id,
      offerVersion: row.offer_version,
      supplierCode: row.supplier_code,
      productId: row.product_id,
      productName: row.product_name,
      units: { cups: cups.reduce((n, c) => n + c.qty, 0), lids: lids.reduce((n, l) => n + l.qty, 0) },
      capacityMl: cup.capacity_ml ?? row.bundle_capacity_ml,
      cupDiameterMm: cup.diameter_mm,
      lidDiameterMm: lid.diameter_mm,
      confirmedCompatible: compatible.has(`${cup.item_id}:${lid.item_id}`),
      priceCents: row.price_cents,
      prepFeeCents: row.prep_fee_cents,
      readyAt: row.ready_at,
      availability: Math.max(0, row.on_hand - row.reserved),
      withdrawn: row.status === 'withdrawn',
      demo: row.offer_demo === 1,
    });
  }
  return offers;
}

// Suppliers that refused an order of this request are left out of every later plan for it.
export function loadExcludedSuppliers(db, requestId) {
  return db
    .prepare(
      'SELECT DISTINCT s.code FROM supplier_orders so JOIN plan_versions pv ON pv.id = so.plan_version_id ' +
        "JOIN suppliers s ON s.id = so.supplier_id WHERE pv.request_id = ? AND so.fulfilment_status = 'refused' ORDER BY s.code",
    )
    .all(requestId)
    .map((r) => r.code);
}

function latestRequirements(db, requestId) {
  return db.prepare('SELECT * FROM requirements WHERE request_id = ? ORDER BY version DESC LIMIT 1').get(requestId) ?? null;
}

function takeSnapshot(db, requestId) {
  const requirements = latestRequirements(db, requestId);
  if (!requirements) return null;
  const offers = loadOffers(db);
  const excluded = loadExcludedSuppliers(db, requestId);
  return { requirements, offers, excluded, offersHash: canonicalHash({ offers, excluded }) };
}

function plannerInput(config, snapshot) {
  const r = snapshot.requirements;
  return {
    requirement: { cups: r.cups, lids: r.lids, capacityMl: r.capacity_ml, diameterMm: r.diameter_mm, material: r.material ?? null },
    budgetCents: r.budget_cents ?? null,
    deadlineAt: r.deadline_at ?? null,
    maxPickups: r.max_pickups,
    taxBp: config.taxBp,
    offers: snapshot.offers,
    excludeSupplierCodes: snapshot.excluded,
  };
}

// RISK-19 / FU-1: the planner's defensive node cap is a typed 422, never an untyped 500. Nothing is stored.
export function runPlanner(ctx, input) {
  try {
    return ctx.planner(input);
  } catch (err) {
    if (err instanceof PlannerLimitError || err?.code === 'PLANNER_LIMIT') {
      throw new AppError(422, 'VALIDATION_FAILED', { details: { fields: [{ field: 'plan', rule: 'planner_limit' }] } });
    }
    throw err;
  }
}

// ------------------------------------------------------------------ create a plan

function assertNoPlanInProgress(db, requestId) {
  const executing = db.prepare("SELECT id FROM plan_versions WHERE request_id = ? AND status IN ('executing','executed') LIMIT 1").get(requestId);
  if (executing) throw new AppError(409, 'PLAN_IN_PROGRESS', { details: { planVersionId: executing.id } });
  const live = db
    .prepare(
      `SELECT r.plan_version_id AS id FROM reservations r JOIN plan_versions pv ON pv.id = r.plan_version_id WHERE pv.request_id = ? ` +
        `AND r.status IN (${LIVE_RESERVATION_STATES.map(() => '?').join(',')}) LIMIT 1`,
    )
    .get(requestId, ...LIVE_RESERVATION_STATES);
  if (live) throw new AppError(409, 'PLAN_IN_PROGRESS', { details: { planVersionId: live.id } });
}

function storeResult(ctx, { requestId, snapshot, result, actor }) {
  const { db, clock } = ctx;
  const now = isoFromMs(clock.now());
  supersedeOpenVersions(ctx, requestId, 'REPLANNED', now);
  const run = db
    .prepare(
      'INSERT INTO planning_runs (request_id, requirements_version, feasible, trace_json, rejections_json, candidate_codes_json, ' +
        'relaxations_json, blocking_json, excluded_suppliers_json, offers_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    )
    .run(
      requestId,
      snapshot.requirements.version,
      result.feasible ? 1 : 0,
      JSON.stringify(result.trace),
      JSON.stringify(result.rejections),
      JSON.stringify(result.feasible ? [] : result.candidateCodes),
      JSON.stringify(result.feasible ? [] : result.relaxations),
      JSON.stringify(result.feasible ? [] : result.blocking),
      JSON.stringify(snapshot.excluded),
      snapshot.offersHash,
      now,
    );
  const runId = Number(run.lastInsertRowid);

  let versionId = null;
  if (result.feasible) {
    const body = { ...result.best };
    delete body.supplierCodes; // PlanBody has no supplierCodes; the suppliers list carries them
    const planJson = JSON.stringify(body);
    const planHash = canonicalHash(JSON.parse(planJson));
    const last = db.prepare('SELECT COALESCE(MAX(version), 0) AS v FROM plan_versions WHERE request_id = ?').get(requestId).v;
    versionId = Number(
      db
        .prepare(
          'INSERT INTO plan_versions (request_id, planning_run_id, version, status, plan_json, alternatives_json, plan_hash, total_cents, ' +
            "pickup_count, ready_at, created_at, updated_at) VALUES (?, ?, ?, 'proposed', ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run(requestId, runId, last + 1, planJson, JSON.stringify(result.alternatives), planHash, body.totalCents, body.pickupCount, body.readyAt, now, now)
        .lastInsertRowid,
    );
    // Versions replaced earlier (requirements change, catalog change, this run) now point at their successor.
    db.prepare("UPDATE plan_versions SET superseded_by = ? WHERE request_id = ? AND status = 'superseded' AND superseded_by IS NULL AND id <> ?").run(
      versionId, requestId, versionId,
    );
  }
  // The queued re-plan (if any) is answered by this run (F-TR-2: removed only with the stored result).
  db.prepare('DELETE FROM replan_queue WHERE request_id = ?').run(requestId);
  recordAudit(db, clock, {
    actorUserId: actor?.id ?? null,
    actorRole: actor?.role ?? 'system',
    action: 'plan.create',
    entityType: 'request',
    entityId: requestId,
    outcome: 'ok',
    detail: { feasible: result.feasible, planVersionId: versionId ?? 0, runId },
    requestId: ctx.requestId,
  });
  return { runId, versionId };
}

// Plans a request on a fresh catalog snapshot and stores the outcome. Throws 422 on the planner limit (nothing stored),
// 409 INVALID_STATE without confirmed requirements, 409 PLAN_IN_PROGRESS when a version is executing or reserved, and
// 503 DB_BUSY when the catalog kept changing for three attempts. Returns { runId, versionId|null }.
export function runPlanningFor(ctx, requestId, actor = null) {
  const { db } = ctx;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const snapshot = readSnapshot(db, () => takeSnapshot(db, requestId));
    if (!snapshot) throw new AppError(409, 'INVALID_STATE', { details: { from: 'unconfirmed', to: 'planned' } });
    const result = runPlanner(ctx, plannerInput(ctx.config, snapshot));
    const stored = db.tx(() => {
      assertNoPlanInProgress(db, requestId);
      const fresh = takeSnapshot(db, requestId);
      if (!fresh || fresh.requirements.version !== snapshot.requirements.version || fresh.offersHash !== snapshot.offersHash) return null;
      return storeResult(ctx, { requestId, snapshot, result, actor });
    });
    if (stored) return stored;
  }
  throw new AppError(503, 'DB_BUSY', { headers: { 'Retry-After': '1' } });
}

export function createPlan(ctx, user, requestId) {
  const { db } = ctx;
  const request = findOwnedRequest(db, user.id, requestId);
  if (!latestRequirements(db, requestId)) {
    throw new AppError(409, 'INVALID_STATE', { details: { from: request.intake_status, to: 'planned' } });
  }
  assertNoPlanInProgress(db, requestId);
  // Only a request that would really run the planner uses a slot (RISK-19).
  takePlanSlot(ctx, user.id);
  const { runId, versionId } = runPlanningFor(ctx, requestId, user);

  return readSnapshot(db, () => {
    const run = db.prepare('SELECT * FROM planning_runs WHERE id = ?').get(runId);
    const version = versionId === null ? null : db.prepare('SELECT * FROM plan_versions WHERE id = ?').get(versionId);
    return {
      planningRun: renderPlanningRun(run, version),
      plan: version ? renderPlanVersion(version, run) : null,
      labels: labelsOf(ctx.config),
    };
  });
}

// ------------------------------------------------------------------ approve

// Server-side re-validation of a stored plan against the requirements it was made for (RS-12).
// Returns a code (ids and codes only) or null when the plan is sound.
export function revalidateStoredPlan(plan, requirements) {
  const body = parseJson(plan.plan_json, null);
  if (!body || !Array.isArray(body.lines) || body.lines.length === 0 || !Array.isArray(body.suppliers)) return 'unreadable';
  if (canonicalHash(body) !== plan.plan_hash) return 'hash_mismatch';
  let cups = 0;
  let lids = 0;
  for (const line of body.lines) {
    if (!Number.isSafeInteger(line.bundles) || line.bundles < 1 || !Number.isSafeInteger(line.cups) || !Number.isSafeInteger(line.lids)) return 'bad_line';
    cups += line.cups;
    lids += line.lids;
  }
  if (cups < requirements.cups) return 'cups_below_required';
  if (lids < requirements.lids) return 'lids_below_required';
  if (body.suppliers.length > requirements.max_pickups) return 'too_many_pickups';
  const sum = body.suppliers.reduce((n, s) => n + s.totalCents, 0);
  if (!Number.isSafeInteger(sum) || sum !== body.totalCents || body.totalCents !== plan.total_cents) return 'total_mismatch';
  if (requirements.budget_cents !== null && body.totalCents > requirements.budget_cents) return 'over_budget';
  if (requirements.deadline_at !== null && Date.parse(body.readyAt) > Date.parse(requirements.deadline_at)) return 'ready_after_deadline';
  return null;
}

function approveInTx(ctx, user, planId, input) {
  const { db, clock } = ctx;
  const plan = findOwnedPlan(db, user.id, planId);
  const matches = input.planHash === plan.plan_hash && input.expectedTotalCents === plan.total_cents;
  const changed = () => new AppError(409, 'PLAN_CHANGED', { details: { currentPlanHash: plan.plan_hash, currentTotalCents: plan.total_cents } });

  switch (plan.status) {
    case 'superseded':
      throw new AppError(409, 'PLAN_SUPERSEDED');
    case 'non_executable':
      throw new AppError(409, 'PLAN_NOT_EXECUTABLE', { details: { reason: plan.non_executable_reason } });
    case 'approved':
      if (!matches) throw changed();
      return { planId, unchanged: true };
    case 'proposed':
      break;
    default:
      throw new AppError(409, 'INVALID_STATE', { details: { from: plan.status, to: 'approved' } });
  }

  const run = db.prepare('SELECT requirements_version FROM planning_runs WHERE id = ?').get(plan.planning_run_id);
  const requirements = db.prepare('SELECT * FROM requirements WHERE request_id = ? AND version = ?').get(plan.request_id, run.requirements_version);
  // RS-04: the budget is checked first, then the deadline.
  if (requirements.budget_cents === null) throw new AppError(409, 'MISSING_BUDGET');
  if (requirements.deadline_at === null) throw new AppError(409, 'MISSING_DEADLINE');
  const invalid = revalidateStoredPlan(plan, requirements);
  if (invalid) throw new AppError(409, 'PLAN_INVALID', { details: { reason: invalid } });
  if (!matches) throw changed();

  assertTransition('plan', 'proposed', 'approved');
  const now = isoFromMs(clock.now());
  const moved = db.prepare("UPDATE plan_versions SET status = 'approved', updated_at = ? WHERE id = ? AND status = 'proposed'").run(now, planId).changes;
  if (moved !== 1) throw new AppError(409, 'INVALID_STATE', { details: { from: 'proposed', to: 'approved' } });
  db.prepare('INSERT INTO plan_approvals (plan_version_id, customer_id, approved_hash, approved_total_cents, at) VALUES (?, ?, ?, ?, ?)').run(
    planId, user.id, plan.plan_hash, plan.total_cents, now,
  );
  recordAudit(db, clock, {
    actorUserId: user.id, actorRole: user.role, action: 'plan.approve', entityType: 'plan_version', entityId: planId,
    outcome: 'ok', detail: { totalCents: plan.total_cents }, requestId: ctx.requestId,
  });
  return { planId, unchanged: false };
}

export function approvePlan(ctx, user, planId, input) {
  const { db, clock } = ctx;
  let outcome;
  try {
    outcome = db.tx(() => approveInTx(ctx, user, planId, input));
  } catch (err) {
    // A refused approval is recorded (ids and codes only); the failed transaction wrote nothing.
    if (err instanceof AppError && GUARDED_DENIALS.has(err.code)) {
      try {
        recordAudit(db, clock, {
          actorUserId: user.id, actorRole: user.role, action: 'plan.approve', entityType: 'plan_version', entityId: planId,
          outcome: 'denied', detail: { code: err.code }, requestId: ctx.requestId,
        });
      } catch {
        ctx.log.error('audit.failed', { code: 'AUDIT_FAILED' });
      }
    }
    throw err;
  }
  return readSnapshot(db, () => {
    const plan = findOwnedPlan(db, user.id, planId);
    const run = db.prepare('SELECT * FROM planning_runs WHERE id = ?').get(plan.planning_run_id);
    const view = renderPlanVersion(plan, run);
    return { plan: view, approvalsNeeded: view.body.suppliers.length, unchanged: outcome.unchanged, labels: labelsOf(ctx.config) };
  });
}
