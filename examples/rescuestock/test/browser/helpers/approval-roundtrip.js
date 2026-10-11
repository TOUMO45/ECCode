// The approval round-trip assertion (spec: Testing Strategy > E2E, F-TR-14; RS-31(a)), shared by every browser journey that pays:
// journey-happy (e6), journey-replacement (RS-32(a), phase F) and the NFR2 keyboard-only run (phase G) call approvalRoundTrip().
//
// One call is one trip to the fake approval page and back:
//   1. `trigger()` is the click that starts it ("Approve with PayPal", "Try approval again", or the keyboard equivalent);
//   2. the page lands on the fake approval page, a DIFFERENT SITE (http://127.0.0.1:<port2>) from the app (http://localhost:<port>);
//   3. action 'approve' presses "Approve (simulated)", action 'cancel' presses "Cancel";
//   4. page.waitForURL waits for the browser to be back on the APP origin (the 303 chain, whose form-action CSP is what F-TR-14 fixed);
//   5. the server log shows exactly ONE new `GET /api/paypal/return` (approve) or `GET /api/paypal/cancel` (cancel), answered 303,
//      and that request ran as the journey's user: the audit event written under the same request id names the user's id (the
//      session cookie crossed the sites, SameSite=Lax). The log line itself must carry that user's id (and role customer), always;
//   6. no console message matching "Content Security Policy" was emitted while the approval page was open or being left.
// Waits are for events (a URL, a log line); the timeouts only bound a hang.
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';

export const APPROVAL_PAGE_TITLE = 'Simulated payment approval — not PayPal';
const APPROVAL_URL = /^http:\/\/127\.0\.0\.1:\d+\/fake-paypal\/checkout\/FAKE-[0-9a-f]{32}$/;
const ROUTES = Object.freeze({ approve: '/api/paypal/return', cancel: '/api/paypal/cancel' });
const AUDIT_ACTIONS = Object.freeze({ approve: 'payment.return', cancel: 'payment.cancel' });
const BUTTONS = Object.freeze({ approve: 'Approve (simulated)', cancel: 'Cancel' });
const OUTCOME_QUERY = Object.freeze({ approve: 'paypal=returned', cancel: 'paypal=cancelled' });

/** The `http.request` lines of a server process (test/helpers/server-proc.js startServer result), parsed. */
export function requestLog(server) {
  const entries = () => server.stdout().split('\n').filter(Boolean).flatMap((line) => {
    try {
      const parsed = JSON.parse(line);
      return parsed && parsed.msg === 'http.request' ? [parsed] : [];
    } catch {
      return [];
    }
  });
  return {
    entries,
    of: (route, method = 'GET') => entries().filter((e) => e.route === route && e.method === method),
  };
}

async function eventually(read, what, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs} ms waiting for ${what}`);
    await sleep(25);
  }
}

/**
 * approvalRoundTrip(page, { harness, userId, trigger, action = 'approve', label })
 *   harness  the object of startBrowserHarness() (server, publicUrl, openDb)
 *   userId   the id of the signed-in user (users.id)
 * Returns { requestId, entry, audit, approvalUrl, landedOn }.
 */
export async function approvalRoundTrip(page, { harness, userId, trigger, action = 'approve', label = action }) {
  assert.ok(Object.hasOwn(ROUTES, action), `action is approve or cancel, not ${action}`);
  assert.ok(Number.isInteger(userId), 'the journey knows its user id');
  const appOrigin = new URL(harness.publicUrl).origin;
  const route = ROUTES[action];
  const log = requestLog(harness.server);
  const before = log.of(route).length;
  const cspMessages = [];
  const onConsole = (message) => {
    if (/Content Security Policy/i.test(message.text())) cspMessages.push(`${message.type()}: ${message.text()}`);
  };
  page.on('console', onConsole);
  try {
    await trigger();

    // 2. The fake approval page, on another site than the app.
    await page.waitForURL(APPROVAL_URL, { timeout: 15000 });
    const approvalUrl = page.url();
    const approvalOrigin = new URL(approvalUrl).origin;
    assert.notEqual(approvalOrigin, appOrigin, `${label}: the approval page is on another origin than the app`);
    assert.equal(new URL(approvalUrl).hostname, '127.0.0.1', `${label}: the approval page is on 127.0.0.1`);
    assert.equal(new URL(appOrigin).hostname, 'localhost', `${label}: the app is on localhost (cross-site)`);
    assert.equal((await page.textContent('h1')).trim(), APPROVAL_PAGE_TITLE, `${label}: the approval page says it is simulated`);

    // 3. Press the button of this action.
    await page.locator('button', { hasText: BUTTONS[action] }).click();

    // 4. Back on the app origin.
    try {
      await page.waitForURL((url) => url.origin === appOrigin, { timeout: 15000 });
    } catch (err) {
      throw new Error(`${label}: the browser did not come back to ${appOrigin} (still on ${page.url()}); CSP console messages: ${JSON.stringify(cspMessages)}; ${err.message}`);
    }
    const landedOn = page.url();
    assert.ok(landedOn.includes(OUTCOME_QUERY[action]), `${label}: the browser came back to ${landedOn} (expected ${OUTCOME_QUERY[action]})`);
    await page.waitForLoadState('load');

    // 5. Exactly one new return/cancel request in the server log, answered 303, run as this user.
    const [entry] = await eventually(() => (log.of(route).length >= before + 1 ? log.of(route).slice(before) : null), `the server log line for GET ${route} (${label})`);
    await sleep(150); // a stray second hit would show now; the count below must still be exactly one
    const fresh = log.of(route).slice(before);
    assert.equal(fresh.length, 1, `${label}: exactly one GET ${route} per ${action}, saw ${fresh.length}`);
    assert.equal(entry.status, 303, `${label}: GET ${route} answered ${entry.status}`);
    // The log line itself MUST name the session's user (TR-E-3): the public return and cancel routes identify the user inside the
    // handler and src/app.js copies it into the line. An absent or different userId fails; the audit event below is a second proof.
    assert.equal(entry.userId, userId, `${label}: the GET ${route} log line names the session's user (userId ${entry.userId})`);
    assert.equal(entry.role, 'customer', `${label}: the log line names the role`);
    const db = harness.openDb();
    let audit;
    try {
      audit = db.prepare('SELECT actor_user_id AS actorUserId, actor_role AS actorRole, action, outcome FROM audit_events WHERE request_id = ?').all(entry.requestId);
    } finally {
      db.close();
    }
    assert.deepEqual(
      audit.map((a) => [a.action, a.outcome, a.actorUserId, a.actorRole]),
      [[AUDIT_ACTIONS[action], 'ok', userId, 'customer']],
      `${label}: request ${entry.requestId} ran as user ${userId} (the session cookie reached ${route})`,
    );

    // 6. No CSP complaint.
    assert.deepEqual(cspMessages, [], `${label}: no "Content Security Policy" console message`);
    return { requestId: entry.requestId, entry, audit: audit[0], approvalUrl, landedOn, logUserId: entry.userId };
  } finally {
    page.off('console', onConsole);
  }
}

/** At the end of a journey: the totals of GET /api/paypal/return and /cancel in the server log are exactly what the journey did. */
export function assertRoundTripTotals(server, { approvals, cancels }) {
  const log = requestLog(server);
  assert.equal(log.of(ROUTES.approve).length, approvals, `GET ${ROUTES.approve} count in the server log`);
  assert.equal(log.of(ROUTES.cancel).length, cancels, `GET ${ROUTES.cancel} count in the server log`);
}
