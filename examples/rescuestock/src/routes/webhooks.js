// Webhook route (spec: Interface Contracts > Webhooks).
//   POST /api/webhooks/paypal/:merchantKey   policy `signature`: no session, no CSRF token, authenticated by the provider
//     signature only (c1 routing contract; src/auth/rbac.js lets exactly this route through).
//     200 {outcome: "applied" | "ignored" | "flagged" | "duplicate"}
//     400 WEBHOOK_SIGNATURE_INVALID | 404 (merchantKey is not a configured key) | 413 PAYLOAD_TOO_LARGE
//     429 RATE_LIMITED {limit: "webhook_ip"} | 503 PROVIDER_UNAVAILABLE (verification unavailable; PayPal retries)
// The handler reads the raw body itself (ctx.body is never called): the bytes are verified exactly as received.
import { receivePaypalWebhook } from '../services/webhooks.js';

export function register(router) {
  router.add('POST', '/api/webhooks/paypal/:merchantKey', receivePaypalWebhook, { policy: 'signature' });
}
