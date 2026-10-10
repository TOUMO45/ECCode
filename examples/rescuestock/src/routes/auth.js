// Authentication routes (spec: Interface Contracts > Authentication, ARCH-25).
//   GET  /api/auth/csrf      public   pre-login CSRF token (nonce.hmac, 2 h)
//   POST /api/auth/register  public   pre-login CSRF; always role customer; rotates the session
//   POST /api/auth/signin    public   pre-login CSRF; throttled; rotates the session
//   POST /api/auth/signout   session  session CSRF
//   GET  /api/auth/session   public   the current user and CSRF token, or nulls
// The two public POST routes check CSRF themselves (the access hook only sees non-public routes).
import { clearSessionCookie, sessionCookie } from '../http/cookies.js';
import { AppError } from '../http/envelope.js';
import { str, validateObject } from '../http/validate.js';
import { checkOrigin, requirePreLoginOrSessionToken } from '../auth/csrf.js';
import { getDummyHash, hashPassword, verifyPassword } from '../auth/password.js';
import { usernameKey } from '../auth/throttle.js';
import { createCustomer, findByUsernameKey, toPublicUser } from '../services/users.js';

const USERNAME_PATTERN = /^[A-Za-z0-9_.-]+$/;
// No C0 or C1 control, no DEL, and none of the Unicode line and paragraph separators (U+2028, U+2029).
const NO_CONTROL = new RegExp(`^[^\\u0000-\\u001f\\u007f-\\u009f${String.fromCharCode(0x2028, 0x2029)}]*$`);

// displayName: 1-80 code points, no control characters, not only blanks.
function displayNameCheck(value) {
  const checked = str(1, 80, NO_CONTROL)(value);
  if (!checked.ok) return checked;
  return checked.value.trim().length === 0 ? { ok: false, rule: 'blank' } : checked;
}

function rateLimited(decision) {
  return new AppError(429, 'RATE_LIMITED', {
    details: { limit: decision.limit },
    headers: { 'Retry-After': String(decision.retryAfterS) },
  });
}

// Origin + (pre-login | session) CSRF token for the public POST routes.
function guardPreLogin(ctx) {
  checkOrigin(ctx.req, ctx.publicUrl());
  ctx.auth.identify(ctx);
  requirePreLoginOrSessionToken(ctx.req, { session: ctx.session, preLogin: ctx.auth.preLogin });
}

function sessionResponse(ctx, status, user, started) {
  return {
    status,
    body: { user: toPublicUser(user), csrfToken: started.csrfToken },
    headers: { 'Set-Cookie': sessionCookie(started.id, { secure: ctx.config.secureCookies }) },
  };
}

// Destroys any session that came with the request, then creates a fresh one (rotation, SEC-20).
function rotateSession(ctx, userId) {
  if (ctx.sessionId) ctx.auth.sessions.destroy(ctx.sessionId);
  ctx.auth.sessions.purgeExpired();
  return ctx.auth.sessions.create(userId);
}

async function signin(ctx) {
  guardPreLogin(ctx);
  const input = validateObject(await ctx.body(), { username: str(1, 200), password: str(1, 200) });
  const { auth, db } = ctx;
  const key = usernameKey(input.username);
  const ip = ctx.clientIp();
  const audit = (event) => auth.recordAudit({ action: 'auth.signin', entityType: 'user', requestId: ctx.requestId, ...event });

  // 1. Hard limits, decided and counted in one transaction before any password work.
  const admitted = auth.throttle.reserveSignin({ usernameKey: key, ip });
  if (!admitted.allowed) {
    audit({ outcome: 'denied', detail: { limit: admitted.limit } });
    throw rateLimited(admitted);
  }
  // 2. Cross-IP pressure on this username only delays; the password is still checked afterwards.
  if (admitted.delayMs > 0) await auth.sleep(admitted.delayMs);

  // 3. The same scrypt work whether or not the user exists (T24).
  const user = findByUsernameKey(db, key);
  const storedHash = user ? user.password_hash : await getDummyHash();
  const matches = await verifyPassword(input.password, storedHash);
  if (!user || !matches || user.disabled === 1) {
    audit({ outcome: 'failed', entityId: user ? user.id : null, detail: { reason: 'invalid_credentials' } });
    throw new AppError(401, 'INVALID_CREDENTIALS');
  }

  const started = db.tx(() => {
    auth.throttle.clearPair({ usernameKey: key, ip });
    const fresh = rotateSession(ctx, user.id);
    audit({ actorUserId: user.id, actorRole: user.role, entityId: user.id, outcome: 'ok' });
    return fresh;
  });
  return sessionResponse(ctx, 200, user, started);
}

async function registerCustomer(ctx) {
  guardPreLogin(ctx);
  const { auth, db, config } = ctx;
  const audit = (event) => auth.recordAudit({ action: 'auth.register', entityType: 'user', requestId: ctx.requestId, ...event });

  if (!config.allowSignup) {
    audit({ outcome: 'denied', detail: { reason: 'signup_disabled' } });
    throw new AppError(403, 'SIGNUP_DISABLED');
  }
  // Unknown fields, including any `role`, are dropped here.
  const input = validateObject(await ctx.body(), {
    username: str(3, 40, USERNAME_PATTERN),
    password: str(10, 200),
    displayName: displayNameCheck,
  });
  const admitted = auth.throttle.reserveRegister({ ip: ctx.clientIp(), limit: config.registerPerIpPerHour });
  if (!admitted.allowed) {
    audit({ outcome: 'denied', detail: { limit: admitted.limit } });
    throw rateLimited(admitted);
  }
  const displayName = input.displayName.trim();
  const passwordHash = await hashPassword(input.password);
  let created;
  try {
    created = db.tx(() => {
      const id = createCustomer(db, ctx.clock, { username: input.username, passwordHash, displayName });
      const fresh = rotateSession(ctx, id);
      audit({ actorUserId: id, actorRole: 'customer', entityId: id, outcome: 'ok' });
      return { id, fresh };
    });
  } catch (err) {
    if (err instanceof AppError && err.code === 'USERNAME_TAKEN') audit({ outcome: 'failed', detail: { reason: 'username_taken' } });
    throw err;
  }
  const user = { id: created.id, username: input.username, displayName, role: 'customer', supplierCode: null };
  return sessionResponse(ctx, 201, user, created.fresh);
}

async function signout(ctx) {
  await ctx.body();
  const { auth, db } = ctx;
  db.tx(() => {
    auth.sessions.destroy(ctx.sessionId);
    auth.recordAudit({
      action: 'auth.signout',
      entityType: 'user',
      actorUserId: ctx.user.id,
      actorRole: ctx.user.role,
      entityId: ctx.user.id,
      outcome: 'ok',
      requestId: ctx.requestId,
    });
  });
  return { status: 200, body: {}, headers: { 'Set-Cookie': clearSessionCookie({ secure: ctx.config.secureCookies }) } };
}

export function register(router) {
  router.add('GET', '/api/auth/csrf', (ctx) => ({ status: 200, body: { csrfToken: ctx.auth.preLogin.issue() } }), { policy: 'public' });
  router.add('POST', '/api/auth/register', registerCustomer, { policy: 'public' });
  router.add('POST', '/api/auth/signin', signin, { policy: 'public' });
  router.add('POST', '/api/auth/signout', signout, { policy: 'session' });
  router.add(
    'GET',
    '/api/auth/session',
    (ctx) => {
      ctx.auth.identify(ctx);
      return {
        status: 200,
        body: { user: ctx.user ? toPublicUser(ctx.user) : null, csrfToken: ctx.session ? ctx.session.csrfToken : null },
      };
    },
    { policy: 'public' },
  );
}
