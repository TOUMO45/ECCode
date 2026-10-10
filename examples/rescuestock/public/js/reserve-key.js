// The Idempotency-Key of a reservation (RS-16). It is generated once per plan version and stored in
// sessionStorage under reserve:<planVersionId>, so a page refresh or a second click reuses the same key and the
// server replays the stored answer instead of reserving twice. The key is not a secret and is never logged.

export const KEY_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;

export function reserveStorageKey(planVersionId) {
  return `reserve:${planVersionId}`;
}

// 32 random bytes as 64 hex characters, which satisfies the server's ^[A-Za-z0-9_-]{16,128}$.
export function generateIdempotencyKey(cryptoImpl = globalThis.crypto) {
  const bytes = new Uint8Array(32);
  cryptoImpl.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Returns the key stored for this plan version, or creates and stores one.
 * `storage` has getItem/setItem (sessionStorage). When storage is unavailable (private mode), a key is still
 * returned, but it is only reused by the caller holding it.
 */
export function getReserveKey(storage, planVersionId, generate = generateIdempotencyKey) {
  const name = reserveStorageKey(planVersionId);
  try {
    const existing = storage?.getItem(name);
    if (typeof existing === 'string' && KEY_PATTERN.test(existing)) return existing;
  } catch {
    // storage refused the read: fall through and make a key
  }
  const fresh = generate();
  try {
    storage?.setItem(name, fresh);
  } catch {
    // storage refused the write: the key is still valid for this attempt
  }
  return fresh;
}
