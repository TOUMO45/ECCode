// LIVE (opt-in, never run in the offline build): RS-23 against the REAL PayPal Sandbox. A GENUINE webhook delivery (signed by PayPal)
// is replayed to the app twice: the first answer is 200 applied / ignored / flagged, the second 200 duplicate with no second
// effect. A genuine delivery cannot be made here (the Sandbox simulator's events do not verify), so you provide one:
//   1. subscribe the Sandbox webhook (RS_PAYPAL_*_WEBHOOK_ID) to the seven mapped events and let PayPal deliver one to a URL you
//      can read (for example the delivery log of the PayPal developer dashboard, or a tunnel to a scratch endpoint);
//   2. save its five paypal-* headers and the exact body bytes as JSON: {"merchantKey":"DEFAULT","headers":{"paypal-transmission-id":...,
//      "paypal-transmission-time":...,"paypal-transmission-sig":...,"paypal-cert-url":...,"paypal-auth-algo":...},"body":"<raw text>"};
//   3. run this suite within 15 minutes of the delivery (the app refuses a transmission time more than 15 minutes old):
//      RS_LIVE_PAYPAL_WEBHOOK_SAMPLE=/path/to/sample.json npm run test:live-paypal
// Without RS_LIVE_PAYPAL_WEBHOOK_SAMPLE the check is reported as SKIPPED with this reason (never as passed).
// Refuses (exit 2) unless RS_LIVE_PAYPAL=1 and the Sandbox credentials are set.
import { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createSuiteReport, liveTest, requireLive, startLiveApp } from './live-support.js';

const launch = requireLive();
const report = createSuiteReport('rs23-webhook-duplicate', launch);
let app;
before(async () => {
  app = await startLiveApp(launch);
});
after(async () => {
  if (app) await app.close();
  process.stdout.write(`# live-paypal report (${report.results.length} checks, provider paypal-sandbox, ${launch.mode}): ${report.write()}\n`);
});

liveTest(report, 'RS-23: a genuine PayPal delivery replayed twice is applied once and answered duplicate the second time', async (_t, skip) => {
  const file = process.env.RS_LIVE_PAYPAL_WEBHOOK_SAMPLE;
  if (!file) {
    skip('RS_LIVE_PAYPAL_WEBHOOK_SAMPLE is not set: a genuine signed delivery from the Sandbox is needed (see the header of this file)');
    return;
  }
  const sample = JSON.parse(readFileSync(file, 'utf8'));
  assert.ok(sample && typeof sample.body === 'string' && sample.headers && typeof sample.merchantKey === 'string', 'the sample has merchantKey, headers and body');
  const send = () => app.server.request({
    method: 'POST',
    path: `/api/webhooks/paypal/${sample.merchantKey}`,
    headers: { 'Content-Type': 'application/json', ...sample.headers },
    body: Buffer.from(sample.body, 'utf8'),
  });
  const first = await send();
  assert.equal(first.status, 200, `the genuine delivery was accepted: ${first.status} ${first.text.slice(0, 160)}`);
  assert.ok(['applied', 'ignored', 'flagged'].includes(first.json.outcome), `first outcome ${first.json.outcome}`);
  const second = await send();
  assert.equal(second.status, 200, second.text);
  assert.equal(second.json.outcome, 'duplicate');
  const db = app.openDb();
  try {
    const rows = db.prepare("SELECT COUNT(*) AS n FROM webhook_events WHERE signature_status = 'valid'").get().n;
    assert.equal(rows, 1, 'one valid row for the transmission id');
  } finally {
    db.close();
  }
});
