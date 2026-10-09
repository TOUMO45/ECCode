export const SESSION_COOKIE = 'gw_sid';
export const CSRF_COOKIE = 'gw_csrf';

// Minimal cookie parse/serialize.
export function parseCookies(header) {
  const out = Object.create(null);
  if (typeof header !== 'string' || header.length > 4096) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 1) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (!(k in out)) out[k] = v;
  }
  return out;
}

export function serializeCookie(name, value, { httpOnly = false, secure = false, maxAge } = {}) {
  let s = `${name}=${value}; Path=/; SameSite=Strict`;
  if (httpOnly) s += '; HttpOnly';
  if (secure) s += '; Secure';
  if (maxAge !== undefined) s += `; Max-Age=${maxAge}`;
  return s;
}
