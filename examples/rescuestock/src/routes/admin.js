// Admin routes (spec: Interface Contracts > Admin routes). Policy 'admin' on every route: anonymous 401, customer and
// supplier 403 (RS-30), CSRF on the POSTs, all before the handler runs.
//   POST /api/admin/reset     {force?, reason?} -> 200 {reset, archivedOperations[, stranded]}; 409 RESET_BLOCKED
//   POST /api/admin/faults    {kind, ...} -> 200 {applied, superseded?}
//   GET  /api/admin/timeline  ?requestId&afterId&limit -> 200 {events}
//   GET  /api/admin/metrics   -> 200 {counts, reconciler, providerLatencyMs, model}
import { applyFault, buildMetrics, buildTimeline, checkResetBody, resetDemo } from '../services/admin.js';

export function register(router) {
  router.add(
    'POST',
    '/api/admin/reset',
    async (ctx) => ({ status: 200, body: await resetDemo(ctx, ctx.user, checkResetBody(await ctx.body())) }),
    { policy: 'admin' },
  );

  router.add(
    'POST',
    '/api/admin/faults',
    async (ctx) => ({ status: 200, body: await applyFault(ctx, ctx.user, await ctx.body()) }),
    { policy: 'admin' },
  );

  router.add('GET', '/api/admin/timeline', (ctx) => ({ status: 200, body: buildTimeline(ctx, ctx.query) }), { policy: 'admin' });

  router.add('GET', '/api/admin/metrics', (ctx) => ({ status: 200, body: buildMetrics(ctx) }), { policy: 'admin' });
}
