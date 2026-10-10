// Plan routes (spec: Interface Contracts > Customer routes). Policy 'customer'; queries are scoped by ctx.user.id.
//   POST /api/plans/:id/approve   {expectedTotalCents, planHash} -> 200 {plan, approvalsNeeded}
//     404 foreign id | 409 PLAN_SUPERSEDED, PLAN_NOT_EXECUTABLE, MISSING_BUDGET, MISSING_DEADLINE (budget first),
//     PLAN_INVALID, PLAN_CHANGED (details: currentPlanHash, currentTotalCents) | 422
// Later tasks add reserve, execute and abandon to this module.
import { idParam, int, str, validateObject } from '../http/validate.js';
import { approvePlan, findOwnedPlan } from '../services/plans.js';

const HASH = /^[0-9a-f]{64}$/;

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
}
