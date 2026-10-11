// fake-approval-headers (revision 3, F-TR-14; RS-31 [D] part; SEC-12): the fake approval listener's headers, routes and redirects.
//
// The app runs with the fake adapter (RS_TEST_OFFLINE harness) and the approval listener is started next to it. Every response of
// the listener must carry exactly ONE Content-Security-Policy header, equal to the pinned string with the app's origin in
// form-action; the 303 responses of approve and cancel must go to the stored return and cancel URLs; and the app's own pages must
// still send form-action 'self'. Chromium's enforcement of that policy across the redirect chain is covered by the browser suite
// (verified once in Playwright's Chromium 141, ev:ev-mv1dsh6c-019c5a8d); this file pins the bytes it depends on.
// A SIMULATION: nothing here is PayPal.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { APP_CSP } from '../../src/http/headers.js';
import { approveFakeOrder, createFakeProvider } from '../../src/payments/fake.js';
import { ListenerRefusedError, PAGE_TITLE, startApprovalListener } from '../../src/payments/listener.js';
import { startHarness } from '../helpers/app-harness.js';

let h;
let listener;
let provider;
let appOrigin;
let returnUrl;
let cancelUrl;
let seq = 0;

before(async () => {
  h = await startHarness({ record: false });
  appOrigin = `http://localhost:${h.port}`;
  returnUrl = `${appOrigin}/api/paypal/return`;
  cancelUrl = `${appOrigin}/api/paypal/cancel`;
  listener = await startApprovalListener({ db: h.db, clock: h.clock, config: h.config, log: undefined, appOrigin: () => appOrigin });
  provider = createFakeProvider({ db: h.db, clock: h.clock, approvalOrigin: () => listener.origin });
});
after(async () => {
  await listener?.close();
  await h?.close();
});

const PINNED_CSP = () => `default-src 'none'; style-src 'self'; form-action 'self' http://localhost:${h.port}; frame-ancestors 'none'; base-uri 'none'`;

function ask(port, { method = 'GET', path, headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path, headers, agent: false }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({
        status: res.statusCode, headers: res.headers, rawHeaders: res.rawHeaders, text: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}
const onListener = (options) => ask(listener.port, options);
const newOrder = async (amountCents = 1250, merchantKey = 'C') => {
  seq += 1;
  const outcome = await provider.createOrder({
    merchantKey, requestId: `so:${900 + seq}:create_order:1`, amountCents, currency: 'USD', referenceId: `so-${900 + seq}`, returnUrl, cancelUrl,
  });
  assert.equal(outcome.kind, 'ok');
  return outcome.value;
};
const cspHeaders = (res) => res.rawHeaders.filter((_, i) => i % 2 === 0 && /^content-security-policy$/i.test(res.rawHeaders[i]));
const pathOf = (orderId, action = '') => `/fake-paypal/checkout/${orderId}${action ? `/${action}` : ''}`;

function assertOneCsp(res, what) {
  assert.equal(cspHeaders(res).length, 1, `${what}: exactly one Content-Security-Policy header`);
  assert.equal(res.headers['content-security-policy'], PINNED_CSP(), `${what}: the pinned policy`);
  assert.equal(res.rawHeaders.some((n, i) => i % 2 === 0 && /^content-security-policy-report-only$/i.test(n)), false);
}

function assertAppSecurityHeaders(res, what) {
  assert.equal(res.headers['x-content-type-options'], 'nosniff', what);
  assert.equal(res.headers['referrer-policy'], 'no-referrer', what);
  assert.equal(res.headers['x-frame-options'], 'DENY', what);
  assert.equal(res.headers['cross-origin-opener-policy'], 'same-origin', what);
  assert.equal(res.headers['permissions-policy'], 'camera=(), microphone=(), geolocation=()', what);
  assert.equal(res.headers['cache-control'], 'no-store', what);
  assert.ok(!Object.keys(res.headers).some((n) => n.startsWith('access-control-')), `${what}: no CORS header (SEC-20)`);
}

describe('the pinned policy', () => {
  test('GET the checkout page: 200, exactly one CSP header, the pinned string, the app security headers', async () => {
    const o = await newOrder();
    const res = await onListener({ path: pathOf(o.orderId) });
    assert.equal(res.status, 200);
    assertOneCsp(res, 'checkout page');
    assertAppSecurityHeaders(res, 'checkout page');
    assert.equal(res.headers['content-type'], 'text/html; charset=utf-8');
    assert.equal(PINNED_CSP(), `default-src 'none'; style-src 'self'; form-action 'self' ${appOrigin}; frame-ancestors 'none'; base-uri 'none'`);
  });

  test('POST approve and POST cancel: 303 responses carry the same single policy', async () => {
    const o = await newOrder();
    const approved = await onListener({ method: 'POST', path: pathOf(o.orderId, 'approve') });
    assert.equal(approved.status, 303);
    assertOneCsp(approved, 'approve 303');
    assertAppSecurityHeaders(approved, 'approve 303');
    const p = await newOrder();
    const cancelled = await onListener({ method: 'POST', path: pathOf(p.orderId, 'cancel') });
    assert.equal(cancelled.status, 303);
    assertOneCsp(cancelled, 'cancel 303');
  });

  test('error responses carry it too: 404 (unknown order, unknown path), 405, 409, 421 and 400', async () => {
    const o = await newOrder();
    await provider.authorizeOrder({ merchantKey: 'C', requestId: 'so:1:authorize:1', orderId: o.orderId }); // not approved: nothing changes
    approveFakeOrder(h.db, o.orderId);
    await provider.authorizeOrder({ merchantKey: 'C', requestId: 'so:2:authorize:1', orderId: o.orderId }); // order is COMPLETED now
    const responses = {
      'unknown order': await onListener({ path: pathOf('FAKE-00000000000000000000000000000000') }),
      'malformed id': await onListener({ path: pathOf('nope') }),
      'unknown path': await onListener({ path: '/' }),
      'app path': await onListener({ path: '/api/health' }),
      'wrong method on the page': await onListener({ method: 'POST', path: pathOf(o.orderId) }),
      'wrong method on approve': await onListener({ method: 'GET', path: pathOf(o.orderId, 'approve') }),
      'approve a completed order': await onListener({ method: 'POST', path: pathOf(o.orderId, 'approve') }),
      'wrong host': await onListener({ path: pathOf(o.orderId), headers: { Host: 'evil.example' } }),
      'bad target': await onListener({ path: '//evil.example/x' }),
    };
    assert.deepEqual(Object.fromEntries(Object.entries(responses).map(([k, v]) => [k, v.status])), {
      'unknown order': 404, 'malformed id': 404, 'unknown path': 404, 'app path': 404, 'wrong method on the page': 405, 'wrong method on approve': 405,
      'approve a completed order': 409, 'wrong host': 421, 'bad target': 400,
    });
    for (const [what, res] of Object.entries(responses)) {
      assertOneCsp(res, what);
      assertAppSecurityHeaders(res, what);
    }
    assert.equal(responses['wrong method on the page'].headers.allow, 'GET');
    assert.equal(responses['wrong method on approve'].headers.allow, 'POST');
  });

  test('the listener does not inherit the app policy: its CSP differs from the app\'s and has no script or img source', async () => {
    const o = await newOrder();
    const csp = (await onListener({ path: pathOf(o.orderId) })).headers['content-security-policy'];
    assert.notEqual(csp, APP_CSP);
    assert.doesNotMatch(csp, /script-src|img-src|connect-src/);
    assert.match(csp, /form-action 'self' http:\/\/localhost:\d+;/);
    assert.match(csp, /frame-ancestors 'none'/);
  });
});

describe('the app\'s own pages are unchanged (RS-31 [D] part)', () => {
  test('the app still sends form-action \'self\' and its own single policy on pages and API responses', async () => {
    for (const path of ['/', '/api/health', '/api/config', '/no-such-page']) {
      const res = await h.request({ path });
      const csp = res.headers['content-security-policy'];
      assert.equal(csp, APP_CSP, path);
      assert.match(csp, /form-action 'self'(;|$)/, path);
      assert.equal(csp.includes(appOrigin), false, `${path}: the app policy does not list its own origin`);
      assert.equal(csp.includes('http://localhost'), false);
    }
  });

  test('the app does not serve the fake routes: the approval page exists only on the listener', async () => {
    const o = await newOrder();
    const res = await h.request({ path: pathOf(o.orderId) });
    assert.equal(res.status, 404);
    const post = await h.request({ method: 'POST', path: pathOf(o.orderId, 'approve') });
    assert.notEqual(post.status, 303);
  });
});

describe('the three routes (SEC-12)', () => {
  test('the page is titled and bannered "Simulated payment approval — not PayPal", shows the amount and merchant label, has two forms and no script', async () => {
    const o = await newOrder(1999, 'B');
    const res = await onListener({ path: pathOf(o.orderId) });
    assert.match(res.text, new RegExp(`<title>${PAGE_TITLE}</title>`));
    assert.match(res.text, new RegExp(`<h1>${PAGE_TITLE}</h1>`));
    assert.equal(PAGE_TITLE, 'Simulated payment approval — not PayPal');
    assert.match(res.text, /Amount: 19\.99 USD/);
    assert.match(res.text, /Merchant: B \(simulated\)/);
    assert.match(res.text, new RegExp(`<form method="post" action="${pathOf(o.orderId, 'approve')}"><button type="submit">Approve \\(simulated\\)</button></form>`));
    assert.match(res.text, new RegExp(`<form method="post" action="${pathOf(o.orderId, 'cancel')}"><button type="submit">Cancel</button></form>`));
    assert.doesNotMatch(res.text, /<script|<link|<style|style=|on[a-z]+=|<img|<iframe/i);
  });

  test('approve: CREATED -> APPROVED, then 303 to the stored return_url + ?token=<fakeOrderId>&PayerID=FAKEPAYER; approving again gives the same 303', async () => {
    const o = await newOrder();
    const expected = `${returnUrl}?token=${o.orderId}&PayerID=FAKEPAYER`;
    const first = await onListener({ method: 'POST', path: pathOf(o.orderId, 'approve') });
    assert.equal(first.status, 303);
    assert.equal(first.headers.location, expected);
    assert.equal(h.db.prepare('SELECT status FROM fake_paypal_orders WHERE id = ?').get(o.orderId).status, 'APPROVED');
    const again = await onListener({ method: 'POST', path: pathOf(o.orderId, 'approve') });
    assert.equal(again.status, 303);
    assert.equal(again.headers.location, expected);
    assert.equal(again.text, '');
  });

  test('cancel: no state change, 303 to the stored cancel_url + ?token=<fakeOrderId>', async () => {
    const o = await newOrder();
    const res = await onListener({ method: 'POST', path: pathOf(o.orderId, 'cancel') });
    assert.equal(res.status, 303);
    assert.equal(res.headers.location, `${cancelUrl}?token=${o.orderId}`);
    assert.equal(h.db.prepare('SELECT status FROM fake_paypal_orders WHERE id = ?').get(o.orderId).status, 'CREATED');
    assert.equal((await onListener({ path: pathOf(o.orderId) })).status, 200, 'the order can still be approved afterwards');
  });

  test('redirects go only to the stored URLs: nothing from the query string, the body or the headers can change the target', async () => {
    const o = await newOrder();
    for (const [action, expected] of [['approve', `${returnUrl}?token=${o.orderId}&PayerID=FAKEPAYER`], ['cancel', `${cancelUrl}?token=${o.orderId}`]]) {
      const res = await onListener({
        method: 'POST',
        path: `${pathOf(o.orderId, action)}?return_url=https://evil.example/&next=//evil.example&token=HIJACK&PayerID=EVIL`,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Referer: 'https://evil.example/', Origin: 'https://evil.example', 'X-Forwarded-Host': 'evil.example' },
        body: 'return_url=https%3A%2F%2Fevil.example%2F&cancel_url=https%3A%2F%2Fevil.example%2F',
      });
      assert.equal(res.status, 303, action);
      assert.equal(res.headers.location, expected, action);
    }
  });

  test('the stored URLs are the ones the order was created with, whatever they look like (a path with a query keeps its query)', async () => {
    seq += 1;
    const outcome = await provider.createOrder({
      merchantKey: 'A', requestId: `so:${900 + seq}:create_order:1`, amountCents: 100, currency: 'USD', referenceId: 'so-1',
      returnUrl: `${appOrigin}/api/paypal/return?ref=7`, cancelUrl: `${appOrigin}/api/paypal/cancel?ref=7`,
    });
    const id = outcome.value.orderId;
    assert.equal((await onListener({ method: 'POST', path: pathOf(id, 'approve') })).headers.location, `${appOrigin}/api/paypal/return?ref=7&token=${id}&PayerID=FAKEPAYER`);
    assert.equal((await onListener({ method: 'POST', path: pathOf(id, 'cancel') })).headers.location, `${appOrigin}/api/paypal/cancel?ref=7&token=${id}`);
  });

  test('order_not_approvable: the approval is refused with a 409 page and the order stays CREATED', async () => {
    h.db.prepare("INSERT OR REPLACE INTO fault_flags (name, value, remaining, created_at) VALUES ('fake_paypal:order_not_approvable', '', 1, ?)").run(new Date(h.clock.now()).toISOString());
    const o = await newOrder();
    const res = await onListener({ method: 'POST', path: pathOf(o.orderId, 'approve') });
    assert.equal(res.status, 409);
    assertOneCsp(res, 'refused approval');
    assert.equal(h.db.prepare('SELECT status FROM fake_paypal_orders WHERE id = ?').get(o.orderId).status, 'CREATED');
  });

  test('an oversized request body is refused (413) and changes nothing', async () => {
    const o = await newOrder();
    let outcome;
    try {
      outcome = await onListener({ method: 'POST', path: pathOf(o.orderId, 'approve'), headers: { 'Content-Type': 'text/plain' }, body: 'x'.repeat(20000) });
    } catch (err) {
      outcome = { status: err.code }; // the server may close the socket as soon as it has answered
    }
    assert.ok(outcome.status === 413 || outcome.status === 'ECONNRESET' || outcome.status === 'EPIPE', String(outcome.status));
    assert.equal(h.db.prepare('SELECT status FROM fake_paypal_orders WHERE id = ?').get(o.orderId).status, 'CREATED');
  });
});

describe('the Host check', () => {
  test('the listener\'s own host and port are accepted; the app\'s port, a foreign name and a Host without the port are misdirected (421)', async () => {
    const o = await newOrder();
    for (const host of [`127.0.0.1:${listener.port}`, `localhost:${listener.port}`, `LOCALHOST:${listener.port}`]) {
      assert.equal((await onListener({ path: pathOf(o.orderId), headers: { Host: host } })).status, 200, host);
    }
    for (const host of [`127.0.0.1:${h.port}`, `localhost:${h.port}`, 'evil.example', `evil.example:${listener.port}`, `127.0.0.1.evil.example:${listener.port}`, '127.0.0.1']) {
      const res = await onListener({ path: pathOf(o.orderId), headers: { Host: host } });
      assert.equal(res.status, 421, host);
      assertOneCsp(res, host);
    }
  });
});

describe('start-up rules', () => {
  test('it binds 127.0.0.1 and the configured port, and reports its origin', () => {
    assert.equal(listener.host, '127.0.0.1');
    assert.equal(listener.origin, `http://127.0.0.1:${listener.port}`);
    assert.ok(listener.port > 0 && listener.port !== h.port);
  });

  test('it refuses to start with RS_PAYMENT_PROVIDER=paypal-sandbox', async () => {
    const config = { ...h.config, paymentProvider: 'paypal-sandbox' };
    await assert.rejects(startApprovalListener({ db: h.db, clock: h.clock, config, appOrigin }), (err) => err instanceof ListenerRefusedError && err.code === 'APPROVAL_LISTENER_REFUSED');
  });

  test('outside test mode only 127.0.0.1 is accepted; in test mode only loopback names; never a public address', async () => {
    for (const fakeApprovalHost of ['0.0.0.0', '::', '192.168.1.5', 'example.com', 'localhost']) {
      await assert.rejects(startApprovalListener({ db: h.db, clock: h.clock, config: { ...h.config, testOffline: false, fakeApprovalHost }, appOrigin }), ListenerRefusedError, fakeApprovalHost);
    }
    for (const fakeApprovalHost of ['0.0.0.0', '::', '192.168.1.5', 'example.com']) {
      await assert.rejects(startApprovalListener({ db: h.db, clock: h.clock, config: { ...h.config, testOffline: true, fakeApprovalHost }, appOrigin }), ListenerRefusedError, fakeApprovalHost);
    }
    const second = await startApprovalListener({ db: h.db, clock: h.clock, config: { ...h.config, testOffline: true, fakeApprovalHost: 'localhost' }, appOrigin });
    try {
      assert.ok(second.port > 0);
    } finally {
      await second.close();
    }
  });

  test('an unusable app origin still answers with exactly one (the most restrictive) CSP header and a 500 page, never none', async () => {
    const broken = await startApprovalListener({ db: h.db, clock: h.clock, config: h.config, appOrigin: () => 'javascript:alert(1)' });
    try {
      const res = await ask(broken.port, { path: '/fake-paypal/checkout/FAKE-00000000000000000000000000000000' });
      assert.equal(res.status, 500);
      assert.equal(cspHeaders(res).length, 1);
      assert.equal(res.headers['content-security-policy'], "default-src 'none'; frame-ancestors 'none'; base-uri 'none'");
    } finally {
      await broken.close();
    }
  });
});
