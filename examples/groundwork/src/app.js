// Application wiring: createApp({config, db, providers, clock, logStream, publicDir}).
// Pipeline per request (spec 3.1, 9): request id + security headers -> route
// match (404/405) -> session -> CSRF -> RBAC -> query/body validation -> handler.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Router } from './http/router.js';
import { ApiError, sendError, sendJson } from './http/envelope.js';
import { applySecurityHeaders, requestIdFor } from './http/headers.js';
import { parseCookies, SESSION_COOKIE, CSRF_COOKIE } from './http/cookies.js';
import { readJson, hasBody, drainLimited } from './http/body.js';
import { parseQuery, validationError } from './http/query.js';
import { validate } from './lib/schema.js';
import { requests } from './api/contract-schemas.js';
import { createCsrf, loadCsrfKey, safeEqual, originOk } from './auth/csrf.js';
import { createSessions } from './auth/sessions.js';
import { createLoginLimiter } from './auth/ratelimit.js';
import { createUsers } from './auth/users.js';
import { authorize, AUDIT_ON_DENY } from './auth/rbac.js';
import { createAudit } from './audit/audit.js';
import { registerRoutes } from './routes/index.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SOCKET_TIMEOUT_MS = 30000;
export { SESSION_COOKIE, CSRF_COOKIE };

function readVersion() {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version || '0.0.0';
  } catch {
    return '0.0.0';
  }
}

export async function createApp({
  config, db, providers = {}, clock = Date.now, logStream = process.stdout,
  publicDir = path.join(ROOT, 'public'), loginLimiter,
} = {}) {
  if (!config || !db) throw new TypeError('createApp requires config and db');

  const log = (rec) => {
    if (config.log === 'off') return;
    try { logStream.write(`${JSON.stringify({ ts: new Date(clock()).toISOString(), ...rec })}\n`); } catch { /* logging must never break a request */ }
  };

  const csrf = createCsrf(loadCsrfKey(db));
  const sessions = createSessions({ db, clock, csrf });
  const audit = createAudit({ db, clock });
  const users = createUsers({ db, clock });
  const limiter = loginLimiter || createLoginLimiter({ clock });
  const router = new Router();
  const ctx = {
    config, db, providers, clock, log, csrf, sessions, audit, users, limiter, router,
    publicDir: path.resolve(publicDir), version: readVersion(),
  };
  await registerRoutes(router, ctx);

  async function pipeline(req, res, rc) {
    const url = new URL(req.url, 'http://localhost');
    const method = req.method;
    const isApi = url.pathname === '/api' || url.pathname.startsWith('/api/');
    rc.route = isApi ? '/api/*' : 'static';

    if (!isApi) {
      if (method !== 'GET' && method !== 'HEAD') {
        throw new ApiError('METHOD_NOT_ALLOWED', { details: { allow: ['GET', 'HEAD'] }, headers: { Allow: 'GET, HEAD' } });
      }
      if (!router.fallback) throw new ApiError('NOT_FOUND');
      return router.fallback(req, res, rc);
    }

    res.setHeader('Cache-Control', 'no-store');
    const m = router.match(method, url.pathname);
    if (!m) throw new ApiError('NOT_FOUND');
    if (m.allow) {
      throw new ApiError('METHOD_NOT_ALLOWED', { details: { allow: m.allow }, headers: { Allow: m.allow.join(', ') } });
    }
    const { route, params } = m;
    rc.route = route.template;
    rc.params = params;

    // Session
    const cookies = parseCookies(req.headers.cookie);
    rc.cookies = cookies;
    const session = sessions.lookup(cookies[SESSION_COOKIE]);
    rc.session = session;
    rc.user = session?.user ?? null;
    if (route.opts.auth === 'session' && !session) throw new ApiError('UNAUTHENTICATED');

    // CSRF on state-changing requests
    const mutating = method !== 'GET' && method !== 'HEAD';
    if (mutating) {
      const header = req.headers['x-csrf-token'];
      const ok = originOk(req.headers)
        && typeof header === 'string' && header !== ''
        && safeEqual(header, cookies[CSRF_COOKIE] ?? '')
        && ((session && safeEqual(header, session.csrfToken))
          || (route.opts.auth === 'none' && csrf.verifyPrelogin(header)));
      if (!ok) throw new ApiError('CSRF_FAILED');
    }

    // RBAC (before any data lookup)
    if (route.opts.action && !authorize(rc.user, route.opts.action)) {
      if (rc.user && AUDIT_ON_DENY.has(route.opts.action)) {
        audit.record({
          teamId: rc.user.teamId, actor: { id: rc.user.id, name: rc.user.username }, action: 'access.denied',
          outcome: 'denied', ip: rc.ip, requestId: rc.requestId, detail: { required: route.opts.action },
        });
      }
      throw new ApiError('FORBIDDEN');
    }

    // Query and body
    rc.query = parseQuery(url.searchParams, route.opts.query ?? { type: 'object', additionalProperties: false, properties: {} });
    if (mutating) {
      const body = await readJson(req);
      const schema = typeof route.opts.body === 'function' ? route.opts.body(body) : (route.opts.body ?? requests.logout);
      const r = validate(schema, body);
      if (!r.valid) throw validationError(r.errors);
      rc.body = body;
    } else {
      rc.body = undefined;
    }

    rc.req = req;
    rc.res = res;
    rc.ctx = ctx;
    rc.extendTimeout = (ms) => req.socket.setTimeout(ms);
    const out = await route.handler(rc);
    sendJson(res, out?.status ?? 200, out?.body ?? {}, out?.headers ?? {});
  }

  async function handler(req, res) {
    const started = process.hrtime.bigint();
    const requestId = requestIdFor(req);
    res.req = req;
    res.setHeader('X-Request-Id', requestId);
    applySecurityHeaders(res);
    const rc = { requestId, ip: req.socket.remoteAddress ?? null, route: 'unmatched', user: null };
    let errorCode = null;
    res.on('close', () => {
      const durationMs = Number((process.hrtime.bigint() - started) / 1000000n);
      log({
        requestId, method: req.method, route: rc.route, status: res.statusCode, durationMs,
        userId: rc.user?.id ?? null, errorCode,
      });
      drainLimited(req);
    });
    try {
      await pipeline(req, res, rc);
    } catch (err) {
      let e = err;
      if (!(err instanceof ApiError)) {
        e = new ApiError('INTERNAL');
        const c = typeof err?.code === 'string' && /^[A-Z0-9_]{1,40}$/.test(err.code) ? err.code : undefined;
        log({ level: 'error', requestId, route: rc.route, errorClass: String(err?.constructor?.name ?? 'Error').slice(0, 60), errorCode: c });
      }
      errorCode = e.code;
      if (e.code === 'PAYLOAD_TOO_LARGE') e.headers = { ...e.headers, Connection: 'close' };
      sendError(res, requestId, e);
    }
  }

  const server = http.createServer(handler);
  server.requestTimeout = SOCKET_TIMEOUT_MS;
  server.headersTimeout = 15000;
  server.keepAliveTimeout = 5000;
  server.timeout = SOCKET_TIMEOUT_MS;
  server.maxHeadersCount = 100;

  return {
    ctx,
    handler,
    server,
    listen(port = config.port, host = config.host) {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
          server.off('error', reject);
          const { port: p } = server.address();
          resolve({ port: p, url: `http://${host.includes(':') ? `[${host}]` : host}:${p}` });
        });
      });
    },
    close() {
      return new Promise((resolve) => {
        if (!server.listening) return resolve();
        server.close(() => resolve());
        server.closeAllConnections();
      });
    },
  };
}
