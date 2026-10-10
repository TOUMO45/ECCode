// Access control: the `authorize(ctx, route)` hook that createApp calls for every non-public route.
//
// Order of checks (default deny):
//   policy 'signature'  only POST /api/webhooks/paypal/:merchantKey; no session, no CSRF (signature auth).
//                       Any other route declared 'signature' is refused (403 FORBIDDEN).
//   state-changing      Origin check first (403 CSRF_FAILED);
//   identification      the rs_sid cookie -> ctx.user, ctx.session; none -> 401 UNAUTHENTICATED;
//   role                policy 'session' = any signed-in role; 'customer' | 'supplier' | 'admin' = that role,
//                       else 403 FORBIDDEN (admin routes: anonymous 401, other roles 403, RS-30);
//   CSRF token          every non-GET request must carry X-CSRF-Token equal to the session's token.
//
// Public routes are not passed to this hook. A public route that needs the user (GET /api/auth/session,
// the PayPal return/cancel redirects) calls ctx.auth.identify(ctx), which sets ctx.user without failing.
import { AppError } from '../http/envelope.js';
import { SESSION_COOKIE, parseCookies } from '../http/cookies.js';
import { checkOrigin, requireSessionToken } from './csrf.js';

export const WEBHOOK_TEMPLATE = '/api/webhooks/paypal/:merchantKey';
const ROLE_POLICIES = new Set(['customer', 'supplier', 'admin']);

export function isStateChanging(method) {
  return method !== 'GET' && method !== 'HEAD';
}

export function createAccess({ sessions, publicUrl }) {
  // Soft identification: sets ctx.user, ctx.session and ctx.sessionId (the raw cookie value, kept so a
  // sign-in or registration can destroy it). Never throws for a missing or dead session.
  function identify(ctx) {
    if (ctx.identified) return ctx.user;
    ctx.identified = true;
    const raw = parseCookies(ctx.req.headers.cookie)[SESSION_COOKIE];
    ctx.sessionId = typeof raw === 'string' ? raw : null;
    const found = ctx.sessionId ? sessions.resolve(ctx.sessionId) : null;
    ctx.user = found ? found.user : null;
    ctx.session = found ? found.session : null;
    return ctx.user;
  }

  // For handlers of public routes that still want a role gate: 401 anonymous, 403 wrong role.
  function requireRole(ctx, ...roles) {
    identify(ctx);
    if (!ctx.user) throw new AppError(401, 'UNAUTHENTICATED');
    if (roles.length > 0 && !roles.includes(ctx.user.role)) throw new AppError(403, 'FORBIDDEN');
    return ctx.user;
  }

  async function authorize(ctx, route) {
    const { req } = ctx;
    if (route.policy === 'signature') {
      if (route.method !== 'POST' || route.template !== WEBHOOK_TEMPLATE) throw new AppError(403, 'FORBIDDEN');
      return;
    }
    const changing = isStateChanging(req.method);
    if (changing) checkOrigin(req, ctx.publicUrl());

    identify(ctx);
    if (!ctx.user) throw new AppError(401, 'UNAUTHENTICATED');

    if (route.policy === 'session') {
      // any signed-in role
    } else if (ROLE_POLICIES.has(route.policy)) {
      if (ctx.user.role !== route.policy) throw new AppError(403, 'FORBIDDEN');
    } else {
      // 'public' never reaches this hook; an unknown policy is denied.
      throw new AppError(403, 'FORBIDDEN');
    }

    if (changing) requireSessionToken(req, ctx.session);
  }

  return { authorize, identify, requireRole };
}
