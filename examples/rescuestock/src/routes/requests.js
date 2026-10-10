// Customer request routes (spec: Interface Contracts > Customer routes). Policy 'customer' on every route: the
// access hook has already done Origin -> session -> role -> CSRF, and every query below is scoped by ctx.user.id.
//   GET  /api/requests              the caller's requests with derived status (newest first, max 100)
//   POST /api/requests              {text} -> 201; 429 requests_per_day (SEC-2)
//   GET  /api/requests/:id          RequestView (RS-36: rescueStatus is derived on this read)
//   POST /api/requests/:id/confirm  {fields: {<name>: value}} values only -> 201 requirements version
//   POST /api/requests/:id/plan     {} -> 201 {planningRun, plan|null}; 429 plan (FU-8); 422 planner_limit (FU-1)
//   DELETE /api/requests/:id        -> 200 {deleted: hard|tombstoned}; 409 PAYMENT_IN_PROGRESS (RS-39)
//   POST /api/requests/:id/image    raw PNG/JPEG/WebP body, Content-Length required -> 201 {image}; 415, 413, 429 (RS-39)
//   GET  /api/requests/:id/image    the bytes with the detected type, nosniff, CSP sandbox, no-store
//   POST /api/requests/:id/extract  {} -> 200 {extraction}; a provider failure is still 200 with degraded: true (RS-03);
//                                   429 RATE_LIMITED / 503 MODEL_BUDGET_EXHAUSTED carry details {degraded: true, extraction}
// A foreign, archived or deleted id is 404 and is checked before the body is read.
import { idParam, validateObject } from '../http/validate.js';
import { AppError } from '../http/envelope.js';
import {
  checkRequestText, confirmRequirements, createRequest, deleteRequest, findOwnedRequest,
} from '../services/requests.js';
import {
  DEFAULT_UPLOAD_DEADLINE_MS, declaredImageMime, declaredUploadLength, detectImageMime, extractRequest, readStoredImage, readUploadBody, saveImage,
} from '../services/extraction.js';
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

  router.add(
    'DELETE',
    '/api/requests/:id',
    async (ctx) => ({ status: 200, body: await deleteRequest(ctx, ctx.user, idParam(ctx.params.id)) }),
    { policy: 'customer' },
  );

  // Order of checks: owner (404, nothing read, nothing written) -> declared type (415) -> Content-Length (400 / 413) ->
  // upload rate (429) -> the body, capped while streaming and bounded by the upload deadline -> magic bytes (415) -> store.
  router.add(
    'POST',
    '/api/requests/:id/image',
    async (ctx) => {
      const requestId = idParam(ctx.params.id);
      findOwnedRequest(ctx.db, ctx.user.id, requestId);
      const declared = declaredImageMime(ctx.req.headers['content-type']);
      if (declared === null) throw new AppError(415, 'UNSUPPORTED_MEDIA_TYPE');
      declaredUploadLength(ctx.req);
      ctx.ai.gate.takeRate(ctx.user.id);
      const bytes = await readUploadBody(ctx.req, { deadlineMs: ctx.uploadDeadlineMs ?? DEFAULT_UPLOAD_DEADLINE_MS });
      if (detectImageMime(bytes) !== declared) throw new AppError(415, 'UNSUPPORTED_MEDIA_TYPE');
      return { status: 201, body: await saveImage(ctx, ctx.user, requestId, { mime: declared, bytes }) };
    },
    { policy: 'customer' },
  );

  router.add(
    'GET',
    '/api/requests/:id/image',
    async (ctx) => {
      const { mime, bytes } = await readStoredImage(ctx, ctx.user, idParam(ctx.params.id));
      const { res } = ctx;
      // The one response of the API that is not JSON. The detected type, nosniff, a sandboxing CSP and no caching (T11, T12).
      res.statusCode = 200;
      res.setHeader('Content-Type', mime);
      res.setHeader('Content-Length', bytes.length);
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Content-Security-Policy', 'sandbox');
      res.setHeader('Cache-Control', 'private, no-store');
      res.setHeader('Content-Disposition', 'inline; filename="image"');
      res.end(bytes);
      return undefined;
    },
    { policy: 'customer' },
  );

  router.add(
    'POST',
    '/api/requests/:id/extract',
    async (ctx) => {
      const requestId = idParam(ctx.params.id);
      findOwnedRequest(ctx.db, ctx.user.id, requestId);
      await ctx.body();
      return { status: 200, body: await extractRequest(ctx, ctx.user, requestId) };
    },
    { policy: 'customer' },
  );
}
