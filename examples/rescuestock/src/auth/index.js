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
import { createAccess } from './rbac.js';
import { createSessionStore } from './sessions.js';
import { createThrottle } from './throttle.js';

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
  const access = createAccess({ sessions, publicUrl });
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
