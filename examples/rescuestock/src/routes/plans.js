// Plan routes (spec: Interface Contracts > Customer routes). Policy 'customer'; queries are scoped by ctx.user.id.
//   POST /api/plans/:id/approve   {expectedTotalCents, planHash} -> 200 {plan, approvalsNeeded}
//     404 foreign id | 409 PLAN_SUPERSEDED, PLAN_NOT_EXECUTABLE, MISSING_BUDGET, MISSING_DEADLINE (budget first),
//     PLAN_INVALID, PLAN_CHANGED (details: currentPlanHash, currentTotalCents) | 422
//   POST /api/plans/:id/reserve   header Idempotency-Key, body {} -> 201 (new) {reservation, orders, approvalsNeeded}
//     400 IDEMPOTENCY_KEY_REQUIRED | 404 | 409 PLAN_SUPERSEDED, PLAN_NOT_EXECUTABLE, MISSING_BUDGET, MISSING_DEADLINE,
//     OUT_OF_STOCK, ALREADY_RESERVED, RESERVATION_LIMIT, INVALID_STATE | 422 IDEMPOTENCY_KEY_REUSED, VALIDATION_FAILED | 503 DB_BUSY
//     A repeat of the same key and request replays the stored answer with the header Idempotent-Replayed: true.
//   POST /api/plans/:id/abandon   body {} -> 200 {plan, rescueStatus}: approved -> non_executable (PAYMENT_CANCELLED) and the void rule;
//     a plan already abandoned answers 200 with its state. 404 | 409 INVALID_STATE (not approved)
// The execute route is added by the saga task.
import { AppError } from '../http/envelope.js';
import { idParam, int, str, validateObject } from '../http/validate.js';
import { abandonPlan } from '../services/payments.js';
import { approvePlan, findOwnedPlan } from '../services/plans.js';
import { reservationFingerprint, reservePlan } from '../services/reservations.js';

const HASH = /^[0-9a-f]{64}$/;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9_-]{16,128}$/;

// Missing -> 400 IDEMPOTENCY_KEY_REQUIRED; malformed (also a repeated header, which Node joins with ", ") -> 422.
function idempotencyKey(header) {
  if (header === undefined || header === '') throw new AppError(400, 'IDEMPOTENCY_KEY_REQUIRED');
  if (typeof header !== 'string' || !IDEMPOTENCY_KEY.test(header)) {
    throw new AppError(422, 'VALIDATION_FAILED', { details: { fields: [{ field: 'Idempotency-Key', rule: 'pattern' }] } });
  }
  return header;
}

export function register(router) {
  router.add(
    'POST',
    '/api/plans/:id/approve',
    async (ctx) => {
      const planId = idParam(ctx.params.id);
      findOwnedPlan(ctx.db, ctx.user.id, planId);
      const input = validateObject(await ctx.body(), { expectedTotalCents: int(0, 100_000_000_000), planHash: str(64, 64, HASH) });
      const { plan, approvalsNeeded, labels } = approvePlan(ctx, ctx.user, planId, input);
      return { status: 200, body: { plan, approvalsNeeded, labels } };
    },
    { policy: 'customer' },
  );

  router.add(
    'POST',
    '/api/plans/:id/reserve',
    async (ctx) => {
      const planId = idParam(ctx.params.id);
      findOwnedPlan(ctx.db, ctx.user.id, planId); // 404 for a foreign plan before anything else is looked at
      const key = idempotencyKey(ctx.req.headers['idempotency-key']);
      const body = await ctx.body();
      const fingerprint = reservationFingerprint(`/api/plans/${planId}/reserve`, body);
      const outcome = reservePlan(ctx, ctx.user, planId, { key, fingerprint });
      return { status: outcome.status, body: outcome.body, headers: outcome.replayed ? { 'Idempotent-Replayed': 'true' } : undefined };
    },
    { policy: 'customer' },
  );

  router.add(
    'POST',
    '/api/plans/:id/abandon',
    async (ctx) => {
      const planId = idParam(ctx.params.id);
      findOwnedPlan(ctx.db, ctx.user.id, planId); // 404 for a foreign plan before the body is read
      await ctx.body();
      return { status: 200, body: await abandonPlan(ctx, ctx.user, planId) };
    },
    { policy: 'customer' },
  );
}
