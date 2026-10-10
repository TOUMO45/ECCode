// Assembles the authentication pieces for one application instance. createApp builds it once and
// exposes it as deps.auth (so route modules and ctx.auth see it):
//   auth.authorize(ctx, route)   the access hook for non-public routes (see rbac.js)
//   auth.identify(ctx)           soft identification for public routes
//   auth.requireRole(ctx, ...r)  401/403 gate for handlers of public routes
//   auth.sessions / auth.throttle / auth.preLogin / auth.recordAudit  used by routes/auth.js
import { randomBytes } from 'node:crypto';
import { getOrCreateMeta } from '../db/meta.js';
import { recordAudit } from '../services/audit.js';
import { createPreLoginTokens } from './csrf.js';
import { createGeneralLimiter } from './general-limit.js';
import { createAccess } from './rbac.js';
import { createSessionStore } from './sessions.js';
import { createThrottle } from './throttle.js';

// The spec's general limit, used when a hand-built config (a unit test) does not carry the fields.
const DEFAULT_GENERAL_LIMIT = 300;
const DEFAULT_GENERAL_WINDOW_SEC = 60;
const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function createAuth({ db, clock, config, publicUrl, sleep = defaultSleep }) {
  let csrfKey = null;
  // The key lives in the meta table so every process signs with the same one (main.js creates it too).
  const key = () => {
    if (!csrfKey) csrfKey = Buffer.from(getOrCreateMeta(db, 'csrf_key', () => randomBytes(32).toString('hex')), 'hex');
    return csrfKey;
  };
  const sessions = createSessionStore({ db, clock });
  const throttle = createThrottle({ db, clock });
  const preLogin = createPreLoginTokens({ key, clock });
  const limiter = createGeneralLimiter({
    db,
    clock,
    limit: config.generalRateLimit ?? DEFAULT_GENERAL_LIMIT,
    windowMs: (config.generalRateWindowSec ?? DEFAULT_GENERAL_WINDOW_SEC) * 1000,
  });
  const access = createAccess({ sessions, publicUrl, limiter });
  return {
    ...access,
    sessions,
    throttle,
    preLogin,
    sleep,
    secureCookies: Boolean(config.secureCookies),
    recordAudit: (event) => recordAudit(db, clock, event),
  };
}
