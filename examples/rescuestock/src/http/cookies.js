// Cookie parsing and serialisation. Names and values are restricted to the
// RFC 6265 token and cookie-octet sets, so a value can never inject an attribute.

const NAME = /^[A-Za-z0-9!#$%&'*+\-.^_`|~]+$/;
const VALUE = /^[\x21\x23-\x2b\x2d-\x3a\x3c-\x5b\x5d-\x7e]*$/;

export const SESSION_COOKIE = 'rs_sid';
export const SESSION_MAX_AGE_S = 43200;

export function parseCookies(header) {
  const out = Object.create(null);
  if (typeof header !== 'string' || header.length === 0 || header.length > 8192) return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const name = part.slice(0, eq).trim();
    let value = part.slice(eq + 1).trim();
    if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) value = value.slice(1, -1);
    if (!NAME.test(name) || !VALUE.test(value)) continue;
    if (!(name in out)) out[name] = value;
  }
  return out;
}

export function serializeCookie(name, value, { maxAge, secure = false, httpOnly = true, sameSite = 'Lax', path = '/' } = {}) {
  if (!NAME.test(name) || !VALUE.test(value)) throw new TypeError('Invalid cookie name or value');
  if (!/^\/[\x21-\x3a\x3c-\x7e]*$/.test(path)) throw new TypeError('Invalid cookie path');
  if (!['Lax', 'Strict', 'None'].includes(sameSite)) throw new TypeError('Invalid SameSite value');
  const parts = [`${name}=${value}`, `Path=${path}`];
  if (maxAge !== undefined) {
    if (!Number.isInteger(maxAge) || maxAge < 0) throw new TypeError('Invalid cookie Max-Age');
    parts.push(`Max-Age=${maxAge}`);
  }
  if (httpOnly) parts.push('HttpOnly');
  parts.push(`SameSite=${sameSite}`);
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

// rs_sid=<43-char base64url id>; HttpOnly; SameSite=Lax; Path=/; Max-Age=43200 (+ Secure over https)
export function sessionCookie(sessionId, { secure = false } = {}) {
  return serializeCookie(SESSION_COOKIE, sessionId, { maxAge: SESSION_MAX_AGE_S, secure });
}

export function clearSessionCookie({ secure = false } = {}) {
  return serializeCookie(SESSION_COOKIE, '', { maxAge: 0, secure });
}
