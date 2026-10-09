// /api/csrf, /api/auth/login, /api/auth/logout, /api/me (spec 3.2).
import { requests } from '../api/contract-schemas.js';
import { ApiError } from '../http/envelope.js';
import { serializeCookie, SESSION_COOKIE, CSRF_COOKIE } from '../http/cookies.js';
import { verifyPassword, DUMMY_HASH } from '../auth/password.js';
import { toUser } from '../auth/users.js';

export default function register(router, ctx) {
  const secure = ctx.config.cookieSecure;
  const sidCookie = (v, extra = {}) => serializeCookie(SESSION_COOKIE, v, { httpOnly: true, secure, ...extra });
  const csrfCookie = (v, extra = {}) => serializeCookie(CSRF_COOKIE, v, { secure, ...extra });

  router.get('/api/csrf', { auth: 'none' }, async () => {
    const csrfToken = ctx.csrf.issue();
    return { body: { csrfToken }, headers: { 'Set-Cookie': [csrfCookie(csrfToken)] } };
  });

  router.post('/api/auth/login', { auth: 'none', body: requests.login }, async (rc) => {
    const { username, password } = rc.body;
    const key = `${username.toLowerCase()}|${rc.ip ?? 'unknown'}`;
    const lim = ctx.limiter.check(key);
    if (lim.limited) {
      throw new ApiError('RATE_LIMITED', {
        details: { retryAfterSeconds: lim.retryAfterSeconds },
        headers: { 'Retry-After': String(lim.retryAfterSeconds) },
      });
    }

    const row = ctx.users.findByUsername(username);
    const usable = row && !row.disabled;
    const ok = await verifyPassword(password, usable ? row.password_hash : DUMMY_HASH);
    const audit = { actor: { id: row?.id ?? null, name: username }, action: 'auth.login', ip: rc.ip, requestId: rc.requestId, teamId: row?.team_id ?? null };
    if (!usable || !ok) {
      ctx.limiter.fail(key);
      ctx.audit.record({ ...audit, outcome: 'fail', detail: { reason: !row ? 'unknown_user' : !usable ? 'disabled' : 'bad_password' } });
      throw new ApiError('INVALID_CREDENTIALS');
    }

    ctx.limiter.clear(key);
    // Rotation: whatever session id the client presented is discarded; a fresh one is issued.
    ctx.sessions.destroyByCookie(rc.cookies[SESSION_COOKIE]);
    const s = ctx.sessions.create(row.id);
    ctx.audit.record({ ...audit, targetType: 'user', targetId: row.id, outcome: 'ok', detail: {} });
    return {
      body: { user: toUser(row), csrfToken: s.csrfToken },
      headers: { 'Set-Cookie': [sidCookie(s.id), csrfCookie(s.csrfToken)] },
    };
  });

  router.post('/api/auth/logout', { action: 'logout', body: requests.logout }, async (rc) => {
    ctx.sessions.destroyByHash(rc.session.idHash);
    ctx.audit.record({
      teamId: rc.user.teamId, actor: { id: rc.user.id, name: rc.user.username }, action: 'auth.logout',
      targetType: 'user', targetId: rc.user.id, ip: rc.ip, requestId: rc.requestId,
    });
    return {
      body: { ok: true },
      headers: { 'Set-Cookie': [sidCookie('', { maxAge: 0 }), csrfCookie('', { maxAge: 0 })] },
    };
  });

  router.get('/api/me', { action: 'me' }, async (rc) => ({
    body: { user: rc.user, csrfToken: rc.session.csrfToken },
  }));
}
