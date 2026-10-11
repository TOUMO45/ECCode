// LIVE (opt-in, never run in the offline build): RS-24 against the REAL PayPal Sandbox verify-webhook-signature endpoint. A forged
// event (made-up signature, a PayPal-looking certificate URL, a plausible body) is posted to the app's webhook route; the app
// asks PayPal to verify it with the real webhook id, and must answer 400 WEBHOOK_SIGNATURE_INVALID with an `invalid` row and no
// state change. An event with no signature headers is refused before any PayPal call. Refuses (exit 2) unless RS_LIVE_PAYPAL=1
// and the Sandbox credentials (including the webhook id) are set. What the REAL endpoint answers to a forged request is exactly
// what this check settles (OQ-D5): if PayPal answers something the adapter maps to `unverified` (503), this test FAILS and says so.
import { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createSuiteReport, liveTest, requireLive, startLiveApp } from './live-support.js';

const launch = requireLive();
const report = createSuiteReport('rs24-webhook-signature', launch);
let app;
before(async () => {
  app = await startLiveApp(launch);
});
after(async () => {
  if (app) await app.close();
  process.stdout.write(`# live-paypal report (${report.results.length} checks, provider paypal-sandbox, ${launch.mode}): ${report.write()}\n`);
});

const merchantKey = launch.mode === 'per-supplier' ? 'A' : 'DEFAULT';
const forgedBody = () => JSON.stringify({
  id: `WH-FORGED-${randomBytes(6).toString('hex')}`,
  event_version: '1.0',
  create_time: new Date().toISOString(),
  resource_type: 'capture',
  event_type: 'PAYMENT.CAPTURE.COMPLETED',
  summary: 'forged event for the live signature check',
  resource: { id: `FORGED-${randomBytes(6).toString('hex')}`, status: 'COMPLETED' },
  links: [],
});

function post(headers, body) {
  return app.server.request({ method: 'POST', path: `/api/webhooks/paypal/${merchantKey}`, headers: { 'Content-Type': 'application/json', ...headers }, body });
}

liveTest(report, 'RS-24: a forged signature is refused with 400 WEBHOOK_SIGNATURE_INVALID, stored as invalid, and changes nothing', async () => {
  const db = app.openDb();
  try {
    const before = db.prepare('SELECT COUNT(*) AS n FROM payment_operations').get().n;
    const res = await post({
      'paypal-transmission-id': randomBytes(12).toString('hex'),
      'paypal-transmission-time': new Date().toISOString(),
      'paypal-transmission-sig': randomBytes(48).toString('base64'),
      'paypal-cert-url': 'https://api.sandbox.paypal.com/v1/notifications/certs/CERT-FORGED-0000',
      'paypal-auth-algo': 'SHA256withRSA',
    }, forgedBody());
    assert.equal(res.status, 400, `a forged event answered ${res.status} ${res.text.slice(0, 120)} (503 means PayPal's answer was not a clean FAILURE: see the adapter's mapping)`);
    assert.equal(res.json.error.code, 'WEBHOOK_SIGNATURE_INVALID');
    const rows = db.prepare('SELECT signature_status AS sig, outcome FROM webhook_events ORDER BY id').all();
    assert.equal(rows.length, 1, 'one row is stored');
    assert.equal(rows[0].sig, 'invalid');
    assert.notEqual(rows[0].outcome, 'applied');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM payment_operations').get().n, before, 'no operation changed');
  } finally {
    db.close();
  }
});

liveTest(report, 'RS-24: an event without signature headers is refused with 400 before any PayPal call', async () => {
  const res = await post({}, forgedBody());
  assert.equal(res.status, 400, res.text);
  assert.equal(res.json.error.code, 'WEBHOOK_SIGNATURE_INVALID');
});
