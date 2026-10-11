// Merchant mapping (decision dec-mv16pz0g-01d5c4c2, Q1 merchant mode).
//
// Credentials come from RS_PAYPAL_<KEY>_CLIENT_ID / _CLIENT_SECRET / _WEBHOOK_ID with KEY in A-E (one merchant per supplier) or
// DEFAULT (one merchant for everybody). src/config.js reads them as Secret values; nothing here prints or logs a value, and
// every summary this file returns is secret-free.
//
//   per-supplier       the fake adapter always; the Sandbox adapter when A, B, C, D and E are all configured.
//                      Supplier code A-E -> merchant key A-E. A code outside A-E uses DEFAULT when it is configured.
//   single-credential  the Sandbox adapter with DEFAULT only (or without all of A-E): every supplier -> DEFAULT.
import { MERCHANT_KEYS } from '../config.js';

export const SUPPLIER_MERCHANT_KEYS = Object.freeze(['A', 'B', 'C', 'D', 'E']);

export const isMerchantKey = (key) => typeof key === 'string' && MERCHANT_KEYS.includes(key);

export function merchantMode(config) {
  return config.merchantMode === 'per-supplier' ? 'per-supplier' : 'single-credential';
}

const configuredKeys = (config) => Object.keys(config.paypal?.merchants ?? {});

// The merchant keys this configuration can pay through. The fake needs no credential: every key is available.
export function activeMerchantKeys(config) {
  if (config.paymentProvider === 'fake') return [...MERCHANT_KEYS];
  const have = configuredKeys(config);
  if (merchantMode(config) === 'per-supplier') {
    return MERCHANT_KEYS.filter((k) => have.includes(k) && (SUPPLIER_MERCHANT_KEYS.includes(k) || k === 'DEFAULT'));
  }
  return have.includes('DEFAULT') ? ['DEFAULT'] : [];
}

// Is `key` a merchant the webhook route and the adapters may use under this configuration?
export function isActiveMerchantKey(config, key) {
  return isMerchantKey(key) && activeMerchantKeys(config).includes(key);
}

// The merchant key that receives the money of a supplier, or null when none is configured for it.
export function merchantKeyForSupplier(config, supplierCode) {
  if (typeof supplierCode !== 'string') return null;
  const active = activeMerchantKeys(config);
  if (merchantMode(config) === 'per-supplier' && SUPPLIER_MERCHANT_KEYS.includes(supplierCode) && active.includes(supplierCode)) return supplierCode;
  return active.includes('DEFAULT') ? 'DEFAULT' : null;
}

// The credentials of a merchant as Secret values ({clientId, clientSecret, webhookId}); webhookId may be null.
// Null when the key is not configured. The fake has none.
export function merchantCredentials(config, key) {
  if (!isMerchantKey(key)) return null;
  const found = config.paypal?.merchants?.[key];
  return found ? { clientId: found.clientId, clientSecret: found.clientSecret, webhookId: found.webhookId ?? null } : null;
}

// The map the Sandbox adapter is built with: only the active keys, values still wrapped in Secret.
export function sandboxMerchants(config) {
  const out = {};
  for (const key of activeMerchantKeys(config)) {
    const creds = merchantCredentials(config, key);
    if (creds) out[key] = Object.freeze(creds);
  }
  return Object.freeze(out);
}

// A secret-free description for logs and the startup line: the mode and the keys, never a value.
export function describeMerchants(config) {
  const keys = activeMerchantKeys(config);
  return Object.freeze({
    mode: merchantMode(config),
    provider: config.paymentProvider,
    keys: Object.freeze(keys),
    webhookIds: Object.freeze(keys.filter((k) => merchantCredentials(config, k)?.webhookId)),
  });
}
