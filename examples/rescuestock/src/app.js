// createApp: the HTTP application. Everything it needs is injected:
//   createApp({ db, clock, config, log, ai, payments, publicDir, authorize, routes })
// It returns { handle, router, deps, listen, close }. `handle(req, res)` can be
// mounted on any node:http server; `listen` builds the standard one.
//
// Request pipeline: request id -> security headers -> Host allow-list (421)
// -> route match (or static file) -> access policy -> handler -> JSON response.
// Policy 'public' needs nothing (public routes that want the user call ctx.auth.identify(ctx)).
// Any other policy is passed to the access hook: `authorize` if one is injected, else the RBAC hook of
// src/auth/rbac.js (anonymous 401, wrong role 403, CSRF 403, webhook signature policy exempt).
import { fileURLToPath } from 'node:url';
import { systemClock } from './clock.js';
import { createLogger } from './log.js';
import { registerRoutes } from './routes/index.js';
import { createAuth } from './auth/index.js';
import { clientIp } from './auth/client-ip.js';
import { AppError, adoptAppError, sendError, sendJson } from './http/envelope.js';
import { applySecurityHeaders } from './http/headers.js';
import { hostAllowed } from './http/host.js';
import { readJsonObject } from './http/body.js';
import { resolveRequestId } from './http/request-id.js';
import { createRouter } from './http/router.js';
import { closeServer, createHttpServer, listen as listenOn } from './http/server.js';
import { createStaticHandler } from './http/static.js';
import { mapDbError, DbConstraintError } from './db/errors.js';

const DEFAULT_PUBLIC_DIR = fileURLToPath(new URL('../public/', import.meta.url));
const MAX_URL_LENGTH = 2048;

function parseRequestUrl(req) {
  const target = req.url;
  if (typeof target !== 'string' || target.length === 0 || target.length > MAX_URL_LENGTH || !target.startsWith('/') || target.startsWith('//')) {
    throw new AppError(400, 'BAD_REQUEST');
  }
  let url;
  try {
    url = new URL(target, 'http://placeholder.invalid');
  } catch {
    throw new AppError(400, 'BAD_REQUEST');
  }
  const query = Object.create(null);
  for (const [key, value] of url.searchParams) {
    if (!(key in query)) query[key] = value;
  }
  return { pathname: url.pathname, query };
}

function toAppError(err) {
  const adopted = adoptAppError(err);
  if (adopted) return { error: adopted, unexpected: false };
  const mapped = mapDbError(err);
  if (mapped instanceof AppError) return { error: mapped, unexpected: false };
  return { error: new AppError(500, 'INTERNAL'), unexpected: true, cause: mapped instanceof DbConstraintError ? mapped : err };
}

export function createApp({
  db,
  clock = systemClock,
  config,
  log = createLogger({ clock }),
  ai = null,
  payments = null,
  publicDir = DEFAULT_PUBLIC_DIR,
  authorize = null,
  routes = [],
} = {}) {
  if (!db || !config) throw new TypeError('createApp needs db and config');

  const runtime = { port: config.port };
  // The public URL: RS_PUBLIC_URL, else http://localhost:<the port actually bound>.
  const publicUrl = () => config.publicUrl || `http://localhost:${runtime.port}`;
  const deps = { db, clock, config, log, ai, payments, publicUrl };
  // Sessions, CSRF, throttles and the access hook (ARCH-25). An `authorize` passed in (a test double)
  // replaces the access hook only; deps.auth is always there for the auth routes.
  deps.auth = createAuth({ db, clock, config, publicUrl });
  const access = typeof authorize === 'function' ? authorize : deps.auth.authorize;

  const router = createRouter();
  registerRoutes(router, deps);
  for (const extra of routes) extra(router, deps);
  router.assertPolicies();

  const serveStatic = createStaticHandler({ root: publicDir, extraHeaders: () => ({}) });

  async function handle(req, res) {
    const started = process.hrtime.bigint();
    const requestId = resolveRequestId(req.headers['x-request-id']);
    res.setHeader('X-Request-Id', requestId);
    const reqLog = log.child(requestId);
    const logState = { route: 'unmatched', userId: undefined, role: undefined, code: undefined };

    res.once('close', () => {
      reqLog.info('http.request', {
        route: logState.route,
        method: req.method,
        status: res.statusCode,
        durationMs: Number((process.hrtime.bigint() - started) / 1000n),
        userId: logState.userId,
        role: logState.role,
        code: logState.code,
      });
    });

    try {
      const { pathname, query } = parseRequestUrl(req);
      const isApi = pathname === '/api' || pathname.startsWith('/api/');
      applySecurityHeaders(res, { api: isApi });

      const allowed = hostAllowed(req.headers.host, {
        publicUrl: config.publicUrl,
        configuredPort: config.port,
        localPort: req.socket?.localPort,
        extraHosts: config.allowedHosts,
      });
      if (!allowed) throw new AppError(421, 'MISDIRECTED_REQUEST');

      let matched;
      try {
        matched = router.match(req.method, pathname);
      } catch (err) {
        if (err instanceof AppError && err.status === 404 && !isApi && (await serveStatic(req, res, pathname))) return;
        throw err;
      }

      const { route, params } = matched;
      logState.route = route.template;
      const ctx = {
        ...deps,
        log: reqLog,
        req,
        res,
        method: req.method,
        pathname,
        query,
        params,
        requestId,
        route,
        user: null,
        session: null,
        sessionId: null,
        identified: false,
        // Socket address; the last X-Forwarded-For hop only with RS_TRUST_PROXY=1 and only if it is an IP.
        clientIp: () => clientIp(req, config.trustProxy),
        body: () => readJsonObject(req),
      };

      if (route.policy !== 'public') await access(ctx, route);
      if (ctx.user) {
        logState.userId = ctx.user.id;
        logState.role = ctx.user.role;
      }

      const result = await route.handler(ctx);
      if (res.writableEnded || res.headersSent) return;
      const status = result?.status ?? 200;
      if (result?.body === undefined && status !== 200) {
        for (const [name, value] of Object.entries(result?.headers || {})) res.setHeader(name, value);
        res.statusCode = status;
        res.end();
        return;
      }
      sendJson(res, status, result?.body ?? {}, { requestId, headers: result?.headers });
    } catch (err) {
      const { error, unexpected } = toAppError(err);
      logState.code = error.code;
      if (unexpected) reqLog.error('http.error', { code: 'INTERNAL', kind: err?.name });
      if (res.headersSent) {
        res.destroy();
        return;
      }
      // An error before the headers were applied (for example a malformed URL) still gets them.
      if (!res.hasHeader('X-Content-Type-Options')) applySecurityHeaders(res, { api: true });
      sendError(res, error, requestId);
    }
  }

  let server = null;
  return {
    handle,
    router,
    deps,
    // Starts the standard server. Resolves with the bound port.
    async listen(port = config.port, host = config.host) {
      server = createHttpServer(handle);
      runtime.port = await listenOn(server, port, host);
      return runtime.port;
    },
    get server() {
      return server;
    },
    async close() {
      if (server) await closeServer(server);
      server = null;
    },
  };
}
