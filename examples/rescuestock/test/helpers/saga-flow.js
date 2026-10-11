// Helpers shared by the phase F multi-process tests (rs26-restart, lease-takeover, return-crash): a pair of server processes on one
// SQLite file, the admin session that arms the fake PayPal faults, a reserved / confirmed / authorized plan to start from, process
// state (SIGSTOP / SIGCONT / SIGKILL) read from /proc, and read-only snapshots of the database.
//
// Everything here waits for an OBSERVABLE condition (a database row, a process state read from /proc, a log line); the timeouts only
// bound a hang. The tests that use it set the saga timings through TAKEOVER_ENV: lease 1500 ms, provider timeout 500 ms,
// reconcile interval 200 ms (spec: Testing Strategy, lease-takeover). Nothing here contacts a host other than 127.0.0.1.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as sleep } from 'node:timers/promises';
import { createClient } from './fixtures.js';
import { approveAtFake, confirmOrderAsSupplier, createPayment, waitFor } from './payment-flow.js';
import { approvedPlan, idempotencyKey, reserve } from './plan-flow.js';
import { SEED_PASSWORD, startServer, upcomingDemoDate } from './server-proc.js';

// Not a secret: the admin password of the temp databases of these tests (config requires at least 16 characters).
export const ADMIN_PASSWORD = 'admin-password-for-tests-0123';

// The timings of the takeover tests: a lease of 3 x the provider timeout is the smallest the config accepts.
export const TAKEOVER_ENV = Object.freeze({
  RS_SAGA_LEASE_MS: '1500',
  RS_PAYPAL_TIMEOUT_MS: '500',
  RS_RECONCILE_INTERVAL_MS: '200',
  RS_DB_BUSY_TIMEOUT_MS: '5000',
  RS_ADMIN_PASSWORD: ADMIN_PASSWORD,
});

// A generous bound for "the saga finished": the lease (1.5 s), the stale-intent limit (1 s) and a start-up are far below it.
export const SETTLE_TIMEOUT_MS = 40000;

export const isLinux = process.platform === 'linux';

// ---- the database ---------------------------------------------------------------------------------------------------------------

/** A read-only connection; `cleanups` (an array of async functions run by the test's afterEach) closes it. */
export function readDb(path, cleanups) {
  const db = new DatabaseSync(path, { readOnly: true });
  cleanups?.push(() => db.close());
  return db;
}

/** A writable connection for a test that edits stored time while every server process is dead. Close it before starting a process. */
export function writeDb(path) {
  return new DatabaseSync(path);
}

const SNAPSHOT_TABLES = Object.freeze([
  'plan_versions', 'plan_approvals', 'reservations', 'reservation_items', 'supplier_orders', 'payment_operations', 'provider_calls',
  'inventory_ledger', 'audit_events', 'fake_paypal_orders', 'fake_paypal_authorizations', 'fake_paypal_captures', 'fake_paypal_calls',
]);

/** Every row of the money and stock tables as JSON text, by primary key: { table: Map(id -> json) }. */
export function snapshotRows(db) {
  const snap = {};
  for (const table of SNAPSHOT_TABLES) {
    const rows = db.prepare(`SELECT * FROM ${table}`).all();
    snap[table] = new Map(rows.map((row) => [row.id ?? `${row.reservation_id}:${row.product_id}`, JSON.stringify({ ...row })]));
  }
  return snap;
}

/** Every row of `before` is still in `after` (RS-26: nothing was lost). Append-only tables must also be unchanged byte for byte. */
export function assertRowsPreserved(before, after) {
  const appendOnly = new Set(['inventory_ledger', 'audit_events', 'fake_paypal_calls', 'fake_paypal_captures']);
  for (const [table, rows] of Object.entries(before)) {
    for (const [id, json] of rows) {
      assert.ok(after[table].has(id), `${table} row ${id} survived the restart`);
      if (appendOnly.has(table)) assert.equal(after[table].get(id), json, `${table} row ${id} is unchanged`);
    }
  }
}

/** fake_paypal_calls since `afterId`, oldest first. */
export function fakeCallsSince(db, afterId = 0) {
  return db.prepare('SELECT id, kind, merchant_key AS merchant, request_id AS requestId, resource_id AS resourceId, replayed, pid, at FROM fake_paypal_calls WHERE id > ? ORDER BY id').all(afterId).map((r) => ({ ...r }));
}

export const lastFakeCallId = (db) => db.prepare('SELECT COALESCE(MAX(id), 0) AS id FROM fake_paypal_calls').get().id;

// ---- processes ------------------------------------------------------------------------------------------------------------------

/** The kernel's state letter of a process from /proc/<pid>/stat ('R', 'S', 'T' for stopped, 'Z' ...), or null when it is gone. */
export function processState(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    return stat.slice(stat.lastIndexOf(')') + 2, stat.lastIndexOf(')') + 3);
  } catch {
    return null;
  }
}

/** Resolves once the process is really stopped (SIGSTOP delivered). SIGCONT sent earlier than this would be lost. */
export function waitStopped(pid, what = `process ${pid} to stop`) {
  return waitFor(() => processState(pid) === 'T', { what, timeoutMs: SETTLE_TIMEOUT_MS, intervalMs: 20 });
}

/** SIGCONT, then waits until the process left the stopped state. */
export async function resume(server) {
  server.kill('SIGCONT');
  await waitFor(() => processState(server.pid) !== 'T', { what: `process ${server.pid} to continue`, timeoutMs: 10000, intervalMs: 20 });
}

/** A stopped process cannot handle SIGTERM: continue it (if it is stopped) before the normal cleanup. */
export function safeCleanup(server) {
  return async () => {
    if (processState(server.pid) === 'T') server.kill('SIGCONT');
    await server.cleanup();
  };
}

/** SIGKILL and wait for the exit; resolves { code, signal }. */
export async function killHard(server) {
  server.kill('SIGKILL');
  const info = await server.exited;
  return info;
}

/** The structured log lines (JSON) of a server process with the given msg. */
export function logLines(server, msg) {
  return `${server.stdout()}\n${server.stderr()}`
    .split('\n')
    .filter(Boolean)
    .flatMap((line) => {
      try {
        const parsed = JSON.parse(line);
        return parsed && parsed.msg === msg ? [parsed] : [];
      } catch {
        return [];
      }
    });
}

/** Waits until the process logged `msg` at least `n` times. */
export function waitForLog(server, msg, { n = 1, timeoutMs = SETTLE_TIMEOUT_MS } = {}) {
  return waitFor(() => logLines(server, msg).length >= n, { what: `the log line "${msg}" of process ${server.pid}`, timeoutMs, intervalMs: 20 });
}

/** No error-level line and no lock error in the logs of a process. */
export function assertHealthyLogs(server) {
  const logs = `${server.stdout()}\n${server.stderr()}`;
  assert.doesNotMatch(logs, /database is locked|SQLITE_BUSY|DB_BUSY/i, `process ${server.pid} reported a lock error`);
  assert.doesNotMatch(logs, /"level":"error"/, `process ${server.pid} logged an error`);
}

/**
 * Two (or one) server processes on one database file. The first seeds RS-FIX-1. `second: false` starts only the first (a restart
 * test starts the next process itself with restartServer()).
 * Returns { first, second, demoDate, env }. Every process is stopped by the test's cleanups (a stopped one is continued first).
 */
export async function startPair({ cleanups, env = {}, second = true } = {}) {
  const demoDate = upcomingDemoDate();
  const fullEnv = { ...TAKEOVER_ENV, RS_DEMO_DATE: demoDate, ...env };
  const first = await startServer({ env: fullEnv, seed: true });
  cleanups.push(safeCleanup(first));
  let other = null;
  if (second) {
    other = await startServer({ env: fullEnv, dir: first.dir, dbPath: first.dbPath });
    cleanups.push(safeCleanup(other));
    assert.notEqual(first.pid, other.pid, 'two server processes');
  }
  return { first, second: other, demoDate, env: fullEnv };
}

/** A new process on the database file of `server` (a restart after a kill). */
export async function restartServer(server, env, cleanups) {
  const next = await startServer({ env, dir: server.dir, dbPath: server.dbPath });
  cleanups.push(safeCleanup(next));
  assert.notEqual(next.pid, server.pid, 'a new process');
  return next;
}

/**
 * Arms a fake PayPal fault the admin route does not accept (http_429:<kind>) by inserting its fault_flags row, the row the admin
 * route would write, from a short write transaction of the test process. `value` is the supplier code (merchant key) or ''.
 */
export function armFlagDirect(dbPath, fault, { value = '', remaining = 1, createdAt = new Date().toISOString() } = {}) {
  const db = writeDb(dbPath);
  try {
    db.exec('PRAGMA busy_timeout = 10000');
    db.prepare('INSERT INTO fault_flags (name, value, remaining, created_at) VALUES (?, ?, ?, ?)').run(`fake_paypal:${fault}`, value, remaining, createdAt);
  } finally {
    db.close();
  }
}

// ---- sessions -------------------------------------------------------------------------------------------------------------------

export async function signedIn(server, username, password = SEED_PASSWORD) {
  const client = createClient(server.request);
  await client.signIn(username, password);
  return client;
}

/** Arms one fake PayPal fault through the admin route (POST /api/admin/faults) on `server`. */
export async function armFault(admin, { fault, supplierCode, count = 1 }) {
  const body = { kind: 'fake_paypal', fault, count };
  if (supplierCode) body.supplierCode = supplierCode;
  const res = await admin.post('/api/admin/faults', body);
  assert.equal(res.status, 200, `arming ${fault}: ${res.status} ${res.text}`);
  return res;
}

// ---- the purchase ---------------------------------------------------------------------------------------------------------------

/**
 * A request for cups and lids, its A + B plan approved and reserved as `cafe1`, and both suppliers' orders confirmed.
 * Returns { cafe1, plan, orders: [{ id, code }] } (orders in supplier-code order).
 */
export async function confirmedPlan(server, demoDate, label) {
  const cafe1 = await signedIn(server, 'cafe1');
  const { requestId, plan } = await approvedPlan(cafe1, demoDate);
  assert.deepEqual(plan.body.lines.map((l) => l.supplierCode), ['A', 'B'], 'the plan buys from A and B');
  const reserved = await reserve(cafe1, plan.id, idempotencyKey(label));
  assert.equal(reserved.status, 201, reserved.text);
  const orders = reserved.json.orders.map((o) => ({ id: o.id, code: o.supplier.code })).sort((a, b) => a.code.localeCompare(b.code));
  assert.equal(orders.length, 2);
  for (const { id, code } of orders) await confirmOrderAsSupplier(await signedIn(server, `supplier-${code.toLowerCase()}`), id);
  return { cafe1, requestId, plan, orders };
}

/** The buyer creates the PayPal order of `order` and approves it at the fake page; the return is answered by `server`. */
export async function payOrder(cafe1, order) {
  const created = await createPayment(cafe1, order.id);
  return { created, ...(await approveAtFake(cafe1, created.json.approvalUrl)) };
}

/** A confirmed plan whose two PayPal approvals were returned and whose authorizations are in (operations `authorized`). */
export async function authorizedPlan(server, demoDate, label, db) {
  const flow = await confirmedPlan(server, demoDate, label);
  for (const order of flow.orders) {
    const paid = await payOrder(flow.cafe1, order);
    assert.equal(paid.ret.status, 303, paid.ret.text);
  }
  await waitFor(
    () => db.prepare("SELECT COUNT(*) AS n FROM payment_operations WHERE status = 'authorized'").get().n === flow.orders.length,
    { what: 'both operations to be authorized', timeoutMs: SETTLE_TIMEOUT_MS },
  );
  return flow;
}

export const planStatus = (db, planId) => db.prepare('SELECT status, lease_epoch AS epoch, executor_id AS executorId, lease_until AS leaseUntil FROM plan_versions WHERE id = ?').get(planId);

/** Waits for the plan to be `executed`; on a timeout the message names the state it was in. */
export async function waitExecuted(db, planId) {
  await waitFor(() => db.prepare('SELECT status FROM plan_versions WHERE id = ?').get(planId).status === 'executed', {
    what: 'the plan to be executed',
    timeoutMs: SETTLE_TIMEOUT_MS,
    intervalMs: 50,
  });
  return planStatus(db, planId);
}

/** A beat for "nothing more happens": the reconciler of every process ticks at least `ticks` times (meta reconciler_last_tick_at moves). */
export async function waitTicks(db, ticks = 3, timeoutMs = 10000) {
  const read = () => db.prepare("SELECT value FROM meta WHERE key = 'reconciler_last_tick_at'").get()?.value ?? '';
  const seen = new Set([read()]);
  const deadline = Date.now() + timeoutMs;
  while (seen.size < ticks + 1) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${ticks} reconciler ticks`);
    await sleep(20);
    seen.add(read());
  }
}
