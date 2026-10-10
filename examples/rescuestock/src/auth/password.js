// Password hashing with scrypt. The stored format is the one scripts/seed.js writes (FU-6):
//   scrypt$16384$8$1$<salt base64url>$<64-byte key base64url>
// A hash with any other parameters is not accepted: verification returns false, it never throws
// and never runs a cost chosen by the stored text.
import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

export const SCRYPT = Object.freeze({ N: 16384, r: 8, p: 1, keyLen: 64, saltLen: 16 });
const MAX_PASSWORD_BYTES = 1024;
const SALT_TEXT = /^[A-Za-z0-9_-]{16,64}$/;
const KEY_TEXT = /^[A-Za-z0-9_-]{86}$/; // 64 bytes in base64url, no padding

function derive(password, salt) {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, SCRYPT.keyLen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, maxmem: 64 * 1024 * 1024 }, (err, key) => {
      if (err) reject(err);
      else resolve(key);
    });
  });
}

function checkLength(password) {
  if (typeof password !== 'string' || Buffer.byteLength(password, 'utf8') > MAX_PASSWORD_BYTES) {
    throw new TypeError('Password must be a string of at most 1024 bytes.');
  }
}

export async function hashPassword(password) {
  checkLength(password);
  const salt = randomBytes(SCRYPT.saltLen);
  const key = await derive(password, salt);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64url')}$${key.toString('base64url')}`;
}

// Returns { salt: Buffer, key: Buffer } or null when the text is not exactly the supported format.
export function parseHash(stored) {
  if (typeof stored !== 'string' || stored.length > 300) return null;
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return null;
  if (parts[1] !== String(SCRYPT.N) || parts[2] !== String(SCRYPT.r) || parts[3] !== String(SCRYPT.p)) return null;
  if (!SALT_TEXT.test(parts[4]) || !KEY_TEXT.test(parts[5])) return null;
  const salt = Buffer.from(parts[4], 'base64url');
  const key = Buffer.from(parts[5], 'base64url');
  if (key.length !== SCRYPT.keyLen || salt.length < 12) return null;
  return { salt, key };
}

// True only for the right password. A malformed hash or an oversize password is false, never an error.
export async function verifyPassword(password, stored) {
  if (typeof password !== 'string' || Buffer.byteLength(password, 'utf8') > MAX_PASSWORD_BYTES) return false;
  const parsed = parseHash(stored);
  if (!parsed) return false;
  const candidate = await derive(password, parsed.salt);
  return timingSafeEqual(candidate, parsed.key);
}

// Hash of a random password with the same parameters, built once. An unknown or disabled username is
// checked against it, so the work done (one scrypt) does not tell the caller whether the user exists (T24).
let dummyHash = null;
export function getDummyHash() {
  if (!dummyHash) dummyHash = hashPassword(randomBytes(24).toString('base64url'));
  return dummyHash;
}

export async function verifyAgainstDummy(password) {
  await verifyPassword(password, await getDummyHash());
  return false;
}
