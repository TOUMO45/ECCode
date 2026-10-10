// Customer request routes (spec: Interface Contracts > Customer routes). Policy 'customer' on every route: the
// access hook has already done Origin -> session -> role -> CSRF, and every query below is scoped by ctx.user.id.
//   GET  /api/requests              the caller's requests with derived status (newest first, max 100)
//   POST /api/requests              {text} -> 201; 429 requests_per_day (SEC-2)
//   GET  /api/requests/:id          RequestView (RS-36: rescueStatus is derived on this read)
//   POST /api/requests/:id/confirm  {fields: {<name>: value}} values only -> 201 requirements version
//   POST /api/requests/:id/plan     {} -> 201 {planningRun, plan|null}; 429 plan (FU-8); 422 planner_limit (FU-1)
// A foreign, archived or deleted id is 404 and is checked before the body is read.
import { idParam, validateObject } from '../http/validate.js';
import { checkRequestText, confirmRequirements, createRequest, findOwnedRequest } from '../services/requests.js';
import { createPlan } from '../services/plans.js';
import { buildRequestList, buildRequestView, buildRescueStatus } from '../services/view.js';

export function register(router) {
  router.add('GET', '/api/requests', (ctx) => ({ status: 200, body: buildRequestList(ctx, ctx.user.id) }), { policy: 'customer' });

  router.add(
    'POST',
    '/api/requests',
    async (ctx) => {
      const input = validateObject(await ctx.body(), { text: checkRequestText });
      const created = createRequest(ctx, ctx.user, input.text);
      return {
        status: 201,
        body: { request: { id: created.id, createdAt: created.createdAt, language: created.language, intakeStatus: created.intakeStatus } },
      };
    },
    { policy: 'customer' },
  );

  router.add(
    'GET',
    '/api/requests/:id',
    (ctx) => ({ status: 200, body: buildRequestView(ctx, idParam(ctx.params.id), ctx.user.id) }),
    { policy: 'customer' },
  );

  router.add(
    'POST',
    '/api/requests/:id/confirm',
    async (ctx) => {
      const requestId = idParam(ctx.params.id);
      findOwnedRequest(ctx.db, ctx.user.id, requestId);
      const { requirements } = confirmRequirements(ctx, ctx.user, requestId, await ctx.body());
      return { status: 201, body: { requirements, rescueStatus: buildRescueStatus(ctx, requestId, ctx.user.id) } };
    },
    { policy: 'customer' },
  );

  router.add(
    'POST',
    '/api/requests/:id/plan',
    async (ctx) => {
      const requestId = idParam(ctx.params.id);
      findOwnedRequest(ctx.db, ctx.user.id, requestId);
      await ctx.body();
      return { status: 201, body: createPlan(ctx, ctx.user, requestId) };
    },
    { policy: 'customer' },
  );
}
