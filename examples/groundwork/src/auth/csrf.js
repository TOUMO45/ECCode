// Double-submit CSRF tokens (spec 3.1, 3.2).
import crypto from 'node:crypto';

export function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) {
    crypto.timingSafeEqual(ba, ba); // keep work roughly constant
    return false;
  }
  return crypto.timingSafeEqual(ba, bb);
}

const b64u = (buf) => buf.toString('base64url');

export function loadCsrfKey(db) {
  const row = db.prepare("SELECT value FROM meta WHERE key = 'csrf_key'").get();
  if (row) return Buffer.from(row.value, 'base64url');
  const key = crypto.randomBytes(32);
  db.prepare("INSERT OR IGNORE INTO meta (key, value) VALUES ('csrf_key', ?)").run(b64u(key));
  const again = db.prepare("SELECT value FROM meta WHERE key = 'csrf_key'").get();
  return Buffer.from(again.value, 'base64url');
}

export function createCsrf(key) {
  const mac = (nonce) => b64u(crypto.createHmac('sha256', key).update(nonce).digest());
  return {
    /** Pre-login token: nonce.hmac(nonce). */
    issue() {
      const nonce = b64u(crypto.randomBytes(16));
      return `${nonce}.${mac(nonce)}`;
    },
    verifyPrelogin(token) {
      if (typeof token !== 'string' || token.length > 200) return false;
      const i = token.indexOf('.');
      if (i < 1) return false;
      return safeEqual(token.slice(i + 1), mac(token.slice(0, i)));
    },
    /** Session-bound token (stored in the session row). */
    newSessionToken() {
      return b64u(crypto.randomBytes(32));
    },
  };
}

/** Origin, when present, must be http(s)://<Host>. Absent Origin is allowed (token still required). */
export function originOk(headers) {
  const origin = headers.origin;
  if (origin === undefined) return true;
  const host = headers.host;
  if (typeof origin !== 'string' || typeof host !== 'string' || host === '') return false;
  return origin === `http://${host}` || origin === `https://${host}`;
}
