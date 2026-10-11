// Support for the opt-in LIVE PayPal Sandbox suite (task e6; LIVE-P1, LIVE-P2). NOT RUN IN THIS BUILD: nothing here has
// talked to PayPal. Every file in this directory that ends in .test.js talks to the REAL PayPal Sandbox, so each one starts by
// calling requireLive(), which refuses (exit 2, a named message, nothing printed on stdout, no network) unless
//   RS_LIVE_PAYPAL=1
//   and a complete credential set: RS_PAYPAL_DEFAULT_CLIENT_ID + RS_PAYPAL_DEFAULT_CLIENT_SECRET + RS_PAYPAL_DEFAULT_WEBHOOK_ID
//   (single-credential mode), or the same three variables for each of the suppliers A, B, C, D and E (per-supplier mode),
// and never runs under the offline network guard or with RS_TEST_OFFLINE=1. The refusal logic is the pure function
// evaluateLiveLaunch(env), so it is tested without setting any of these variables (test/integration/rs20-two-process-execute.test.js).
//
//   RS_LIVE_PAYPAL=1 RS_PAYPAL_DEFAULT_CLIENT_ID=... RS_PAYPAL_DEFAULT_CLIENT_SECRET=... RS_PAYPAL_DEFAULT_WEBHOOK_ID=... npm run test:live-paypal
//
// Only api-m.sandbox.paypal.com and www.sandbox.paypal.com are contacted (README: allow-list exactly those). Credentials are read
// from the environment, handed to the server child process and to the Sandbox REST calls, and are never printed, logged or put
// into a report. Each suite writes reports/live-paypal-<suite>-<UTC>.json with the suite, the provider (paypal-sandbox) and the
// merchant mode (single-credential | per-supplier); a skipped check is reported as skipped with its reason, never as passed.
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { createClient } from '../../helpers/fixtures.js';
import { confirmOrderAsSupplier, createPayment } from '../../helpers/payment-flow.js';
import { approvedPlan, idempotencyKey, reserve } from '../../helpers/plan-flow.js';
import { openReadOnlyDb } from '../../browser/helpers/db.js';
import { SEED_PASSWORD, startServer, upcomingDemoDate } from '../../helpers/server-proc.js';

export const SANDBOX_API = 'https://api-m.sandbox.paypal.com';
export const SUPPLIER_KEYS = Object.freeze(['A', 'B', 'C', 'D', 'E']);
export const PROVIDER = 'paypal-sandbox';
const GUARD_KEY = Symbol.for('rescuestock.netGuard');
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const PARTS = Object.freeze(['CLIENT_ID', 'CLIENT_SECRET', 'WEBHOOK_ID']);

export const LIVE_MESSAGES = Object.freeze({
  notEnabled: 'Set RS_LIVE_PAYPAL=1 to run the live PayPal Sandbox suite (it contacts the PayPal Sandbox)',
  netGuard: 'The live PayPal suite must not run under the offline network guard; run it with npm run test:live-paypal',
  offline: 'The live PayPal suite must not run with RS_TEST_OFFLINE=1',
});

const names = (key) => PARTS.map((p) => `RS_PAYPAL_${key}_${p}`);
const complete = (env, key) => names(key).every((n) => typeof env[n] === 'string' && env[n] !== '');

/** The message for missing credentials: it names variables only, never a value. */
export function missingCredentialsMessage(env) {
  const missing = names('DEFAULT').filter((n) => !(typeof env[n] === 'string' && env[n] !== ''));
  return `Set ${names('DEFAULT').join(', ')} (single-credential mode), or those three variables for each of the suppliers A to E (per-supplier mode), to run the live PayPal Sandbox suite; missing for DEFAULT: ${missing.join(', ')}`;
}

/**
 * -> { ok: true, mode, keys } | { ok: false, message }. The order of the checks is part of the contract: the flag, then the
 * guard and the offline flag, then the credentials. Reads only the `env` it is given.
 */
export function evaluateLiveLaunch(env, { guardInstalled = Boolean(globalThis[GUARD_KEY]) } = {}) {
  if (env.RS_LIVE_PAYPAL !== '1') return { ok: false, message: LIVE_MESSAGES.notEnabled };
  if (guardInstalled) return { ok: false, message: LIVE_MESSAGES.netGuard };
  if (env.RS_TEST_OFFLINE === '1') return { ok: false, message: LIVE_MESSAGES.offline };
  if (SUPPLIER_KEYS.every((k) => complete(env, k))) return { ok: true, mode: 'per-supplier', keys: [...SUPPLIER_KEYS] };
  if (complete(env, 'DEFAULT')) return { ok: true, mode: 'single-credential', keys: ['DEFAULT'] };
  return { ok: false, message: missingCredentialsMessage(env) };
}

/** Refuses with exit code 2 and the named message on stderr (nothing on stdout); returns the launch description otherwise. */
export function requireLive({ env = process.env, err = (s) => process.stderr.write(s), exit = (code) => process.exit(code) } = {}) {
  const launch = evaluateLiveLaunch(env);
  if (!launch.ok) {
    err(`${launch.message}\n`);
    exit(2);
  }
  return launch;
}

// The merchant key a supplier code pays through, and the credentials of every active key (read from the environment).
export const merchantKeyFor = (launch, supplierCode) => (launch.mode === 'per-supplier' ? supplierCode : 'DEFAULT');
export function merchantsFrom(launch, env = process.env) {
  return Object.fromEntries(launch.keys.map((k) => [k, { clientId: env[`RS_PAYPAL_${k}_CLIENT_ID`], clientSecret: env[`RS_PAYPAL_${k}_CLIENT_SECRET`], webhookId: env[`RS_PAYPAL_${k}_WEBHOOK_ID`] }]));
}

// ---- reports ---------------------------------------------------------------------------------------------------------------

/** suite('rs18-cancel', launch) -> { record(name, status, detail), write() }. status: passed | failed | skipped. */
export function createSuiteReport(suite, launch, { reportDir = join(ROOT, 'reports'), now = () => new Date() } = {}) {
  const startedAt = now();
  const results = [];
  return {
    record(name, status, detail = null) {
      if (!['passed', 'failed', 'skipped'].includes(status)) throw new RangeError(`unknown status ${status}`);
      results.push({ name, status, detail: detail === null ? null : String(detail).slice(0, 300) });
    },
    results,
    write() {
      const body = {
        suite: `live-paypal:${suite}`,
        provider: PROVIDER,
        merchantMode: launch.mode,
        merchantKeys: launch.keys,
        startedAt: startedAt.toISOString(),
        finishedAt: now().toISOString(),
        counts: { passed: results.filter((r) => r.status === 'passed').length, failed: results.filter((r) => r.status === 'failed').length, skipped: results.filter((r) => r.status === 'skipped').length },
        results,
        pass: results.length > 0 && results.every((r) => r.status === 'passed'),
      };
      mkdirSync(reportDir, { recursive: true });
      const file = join(reportDir, `live-paypal-${suite}-${startedAt.toISOString().replace(/[:.]/g, '-')}.json`);
      writeFileSync(file, `${JSON.stringify(body, null, 2)}\n`);
      return file;
    },
  };
}

/**
 * liveTest(report, name, fn): a node:test test that records passed / failed in the suite report. `fn(t, skip)` may call
 * `skip(reason)` (it returns after the call) to report the check as SKIPPED with its reason, never as passed.
 */
export function liveTest(report, name, fn) {
  test(name, async (t) => {
    let skipped = null;
    try {
      await fn(t, (reason) => {
        skipped = String(reason);
        t.skip(skipped);
      });
    } catch (err) {
      report.record(name, 'failed', err?.message ?? err);
      throw err;
    }
    if (skipped !== null) report.record(name, 'skipped', skipped);
    else report.record(name, 'passed');
  });
}

// ---- the application under test: a real server process on the system clock, the Sandbox adapter, a localhost public URL ---

export async function startLiveApp(launch, { env = process.env } = {}) {
  const credentials = {};
  for (const k of launch.keys) for (const n of names(k)) credentials[n] = env[n];
  const adminPassword = `live-admin-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
  const demoDate = upcomingDemoDate();
  const server = await startServer({
    seed: true,
    publicUrlOnLocalhost: true,
    env: {
      ...credentials,
      RS_PAYMENT_PROVIDER: PROVIDER,
      RS_ADMIN_PASSWORD: adminPassword,
      RS_DEMO_DATE: demoDate,
      // The Sandbox needs the network and refuses the test hooks: undo what the offline harness sets.
      RS_TEST_OFFLINE: undefined,
      RS_TEST_HOOKS: undefined,
    },
  });
  return {
    server,
    demoDate,
    adminPassword,
    openDb: () => openReadOnlyDb(server.dbPath),
    async signIn(username, password = SEED_PASSWORD) {
      const client = createClient(server.request);
      await client.signIn(username, password);
      return client;
    },
    close: () => server.cleanup(),
  };
}

// ---- Sandbox REST reads and the one direct write the double-capture check needs ---------------------------------------------

const tokens = new Map();
async function accessToken(launch, merchantKey, env = process.env) {
  const cached = tokens.get(merchantKey);
  if (cached && Date.now() < cached.until) return cached.value;
  const basic = Buffer.from(`${env[`RS_PAYPAL_${merchantKey}_CLIENT_ID`]}:${env[`RS_PAYPAL_${merchantKey}_CLIENT_SECRET`]}`).toString('base64');
  const res = await fetch(`${SANDBOX_API}/v1/oauth2/token`, {
    method: 'POST',
    redirect: 'manual',
    headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials',
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`PayPal Sandbox OAuth for merchant ${merchantKey} answered ${res.status}`);
  const json = await res.json();
  tokens.set(merchantKey, { value: json.access_token, until: Date.now() + Math.max(0, (json.expires_in ?? 300) - 60) * 1000 });
  return json.access_token;
}

/** sandbox(launch, merchantKey, method, path, {body, requestId}) -> { status, json }. Only api-m.sandbox.paypal.com. */
export async function sandbox(launch, merchantKey, method, path, { body, requestId } = {}) {
  const headers = { Authorization: `Bearer ${await accessToken(launch, merchantKey)}`, Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (requestId) headers['PayPal-Request-Id'] = requestId;
  const res = await fetch(`${SANDBOX_API}${path}`, { method, redirect: 'manual', headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(30_000) });
  const text = await res.text();
  let json = null;
  try {
    json = text === '' ? null : JSON.parse(text);
  } catch {
    // Not JSON: callers read the status.
  }
  return { status: res.status, json };
}

/**
 * Waits for a human to approve each PayPal order with a Sandbox buyer account (the real approval page cannot be automated
 * reliably). Prints the approval links to stdout and polls the orders until all are APPROVED or the time is up.
 */
export async function awaitBuyerApproval(launch, orders, { say = (s) => process.stdout.write(s), timeoutMs = 10 * 60_000, intervalMs = 3000 } = {}) {
  say('\nApprove each of these PayPal Sandbox orders with a Sandbox BUYER account (a personal account), then wait:\n');
  for (const o of orders) say(`  ${o.label}: ${o.approvalUrl}\n`);
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const states = [];
    for (const o of orders) {
      const res = await sandbox(launch, o.merchantKey, 'GET', `/v2/checkout/orders/${encodeURIComponent(o.orderId)}`);
      states.push(res.json?.status ?? `HTTP_${res.status}`);
    }
    if (states.every((s) => s === 'APPROVED')) return;
    if (Date.now() > deadline) throw new Error(`the buyer did not approve every order within ${Math.round(timeoutMs / 1000)} s (states: ${states.join(', ')})`);
    await sleep(intervalMs);
  }
}

/**
 * cafe1 plans, approves and reserves A + B; both suppliers confirm; the buyer creates the PayPal order of each supplier order
 * (a REAL Sandbox order). Returns { customer, requestId, plan, orders: [{ id, code, merchantKey, approvalUrl, orderId, response }] }.
 */
export async function reserveAndCreatePayments(app, launch, { label = 'live' } = {}) {
  const customer = await app.signIn('cafe1');
  const { requestId, plan } = await approvedPlan(customer, app.demoDate);
  const reserved = await reserve(customer, plan.id, idempotencyKey(label));
  assert.equal(reserved.status, 201, reserved.text);
  const orders = [];
  for (const o of reserved.json.orders) {
    const code = o.supplier.code;
    await confirmOrderAsSupplier(await app.signIn(`supplier-${code.toLowerCase()}`), o.id);
    const response = await createPayment(customer, o.id);
    const approvalUrl = response.json.approvalUrl;
    assert.equal(new URL(approvalUrl).hostname, 'www.sandbox.paypal.com', 'the approval link is on the PayPal Sandbox');
    orders.push({ id: o.id, code, merchantKey: merchantKeyFor(launch, code), approvalUrl, orderId: orderIdOfApprovalUrl(approvalUrl), response });
  }
  return { customer, requestId, plan, orders };
}

/** The PayPal order id of an app approval URL (the `token` the approval page carries). */
export function orderIdOfApprovalUrl(approvalUrl) {
  const u = new URL(approvalUrl);
  const token = u.searchParams.get('token');
  if (!token) throw new Error('the approval URL carries no token');
  return token;
}
