// scrypt password hashing (spec 6.2): scrypt$N$r$p$saltB64$hashB64.
import crypto from 'node:crypto';

const N = 16384;
const R = 8;
const P = 1;
const KEYLEN = 64;
const SALT_BYTES = 16;
const MAX_N = 1 << 17; // refuse stored parameters that would exhaust memory

function scrypt(password, salt, n, r, p, keylen) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password.normalize('NFKC'), salt, keylen, { N: n, r, p, maxmem: 256 * n * r + 1024 * 1024 }, (err, key) => {
      if (err) reject(err); else resolve(key);
    });
  });
}

export async function hashPassword(password) {
  if (typeof password !== 'string' || password.length === 0) throw new TypeError('password required');
  const salt = crypto.randomBytes(SALT_BYTES);
  const key = await scrypt(password, salt, N, R, P, KEYLEN);
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64')}$${key.toString('base64')}`;
}

export function parseHash(stored) {
  if (typeof stored !== 'string') return null;
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return null;
  const [n, r, p] = parts.slice(1, 4).map((x) => (/^\d{1,7}$/.test(x) ? Number(x) : NaN));
  if (![n, r, p].every(Number.isInteger) || n < 2 || n > MAX_N || (n & (n - 1)) !== 0) return null;
  if (r < 1 || r > 32 || p < 1 || p > 16 || n * r > (1 << 18)) return null;
  const salt = Buffer.from(parts[4], 'base64');
  const hash = Buffer.from(parts[5], 'base64');
  if (salt.length < 8 || hash.length < 16 || hash.length > 128) return null;
  return { n, r, p, salt, hash };
}

// A well-formed hash that no password matches: unknown users still pay for a scrypt.
export const DUMMY_HASH = `scrypt$${N}$${R}$${P}$${Buffer.alloc(SALT_BYTES, 7).toString('base64')}$${Buffer.alloc(KEYLEN, 9).toString('base64')}`;

/** Constant-work verify. Malformed stored hashes verify false after a dummy scrypt. */
export async function verifyPassword(password, stored) {
  let parsed = parseHash(stored);
  let valid = parsed !== null;
  if (!parsed) parsed = parseHash(DUMMY_HASH);
  const key = await scrypt(String(password), parsed.salt, parsed.n, parsed.r, parsed.p, parsed.hash.length);
  const eq = crypto.timingSafeEqual(key, parsed.hash);
  return valid && eq;
}
