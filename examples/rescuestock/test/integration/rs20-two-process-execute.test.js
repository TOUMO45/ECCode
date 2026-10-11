// RS-20 (multi-process half) and F-TR-8: two separate OS processes serve one SQLite file; five execute calls are sent to EACH
// at the same moment (ten in all) for one approved, reserved, confirmed plan whose two PayPal approvals were returned.
//   Expected:
//   - exactly one answer is 202 {claimed:true}; the other nine are 200 {claimed:false} with the current state;
//   - exactly one claim committed (lease_epoch 1, one `plan.execute` ok audit event), by the process that answered 202;
//   - the plan ends `executed`, both operations `captured`;
//   - fake_paypal_calls (the DB-backed fake, shared by both processes) gained EXACTLY N get_authorization + N capture calls,
//     N = the supplier orders, and nothing else (F-TR-8): a stray call from a loser, in either process, would add a row;
//     every one of them is a first send (replayed = 0), made by the winner's process, and each capture carries the request
//     id so:<supplierOrderId>:capture:1.
// The test process only counts rows (read-only); the provider calls are made by the two server processes. Each round uses a new
// database and alternates which process serves the buyer's approvals.
import { afterEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { NET_GUARD_PATH, PROJECT_ROOT } from '../helpers/node-proc.js';
import { LIVE_MESSAGES, createSuiteReport, evaluateLiveLaunch, missingCredentialsMessage } from '../live/paypal/live-support.js';
import { runLivePaypal } from '../live/paypal/run-live-paypal.js';
import { createClient } from '../helpers/fixtures.js';
import { approveAtFake, confirmOrderAsSupplier, createPayment, waitFor } from '../helpers/payment-flow.js';
import { approvedPlan, idempotencyKey, reserve } from '../helpers/plan-flow.js';
import { SEED_PASSWORD, startServer, upcomingDemoDate } from '../helpers/server-proc.js';

const ROUNDS = 2;
const EXECUTES_PER_PROCESS = 5;
const cleanups = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()();
});

function readDb(path) {
  const db = new DatabaseSync(path, { readOnly: true });
  cleanups.push(() => db.close());
  return db;
}

async function signedIn(server, username) {
  const client = createClient(server.request);
  await client.signIn(username, SEED_PASSWORD);
  return client;
}

describe('RS-20 / F-TR-8: two OS processes, five concurrent execute calls each, one claim, exactly N reads and N captures', () => {
  for (let round = 1; round <= ROUNDS; round++) {
    test(`RS-20: round ${round}: one 202 and nine 200 {claimed:false}; fake_paypal_calls gained exactly N get_authorization + N capture, request ids so:<id>:capture:1`, async () => {
      const demoDate = upcomingDemoDate();
      const env = { RS_DB_BUSY_TIMEOUT_MS: '5000', RS_DEMO_DATE: demoDate };
      const first = await startServer({ env, seed: true });
      cleanups.push(() => first.cleanup());
      const second = await startServer({ env, dir: first.dir, dbPath: first.dbPath });
      cleanups.push(() => second.cleanup());
      assert.notEqual(first.pid, second.pid, 'two server processes');
      assert.equal(second.dbPath, first.dbPath, 'both processes use the same database file');

      // Alternate which process serves the set-up (and so which process created the PayPal orders).
      const [one, two] = round % 2 === 1 ? [first, second] : [second, first];
      const cafe1On1 = await signedIn(one, 'cafe1');
      const cafe1On2 = await signedIn(two, 'cafe1');
      const { plan } = await approvedPlan(cafe1On1, demoDate);
      assert.deepEqual(plan.body.lines.map((l) => l.supplierCode), ['A', 'B'], 'the plan buys from A and B');
      const reserved = await reserve(cafe1On1, plan.id, idempotencyKey(`rs20r${round}`));
      assert.equal(reserved.status, 201, reserved.text);
      const orders = reserved.json.orders.map((o) => ({ id: o.id, code: o.supplier.code }));
      assert.equal(orders.length, 2);
      const N = orders.length;

      for (const { id, code } of orders) await confirmOrderAsSupplier(await signedIn(one, `supplier-${code.toLowerCase()}`), id);
      for (const { id } of orders) {
        const created = await createPayment(cafe1On1, id);
        const { ret } = await approveAtFake(cafe1On1, created.json.approvalUrl);
        assert.equal(ret.status, 303, ret.text);
      }

      const db = readDb(first.dbPath);
      await waitFor(
        () => db.prepare("SELECT COUNT(*) AS n FROM payment_operations WHERE status = 'authorized'").get().n === N,
        { what: 'both operations to be authorized' },
      );
      const baseline = db.prepare('SELECT COALESCE(MAX(id), 0) AS id FROM fake_paypal_calls').get().id;
      const callsBefore = db.prepare('SELECT COUNT(*) AS n FROM fake_paypal_calls').get().n;
      assert.ok(callsBefore >= 3 * N, 'create_order, get_order and authorize calls of the set-up exist before the run');

      // Ten execute calls, five per process, all started in the same tick.
      const sends = [];
      for (let i = 0; i < EXECUTES_PER_PROCESS; i++) {
        sends.push(cafe1On1.post(`/api/plans/${plan.id}/execute`, {}).then((res) => ({ res, server: one })));
        sends.push(cafe1On2.post(`/api/plans/${plan.id}/execute`, {}).then((res) => ({ res, server: two })));
      }
      const answers = await Promise.all(sends);
      assert.equal(answers.length, 2 * EXECUTES_PER_PROCESS);
      for (const { res } of answers) assert.ok(res.status < 500, `no 5xx: ${res.status} ${res.text}`);
      assert.deepEqual(
        answers.map((a) => a.res.status).sort(),
        [200, 200, 200, 200, 200, 200, 200, 200, 200, 202],
        `statuses ${answers.map((a) => `${a.res.status}${a.res.json?.error ? ` ${a.res.json.error.code}` : ''}`).join(' | ')}`,
      );
      const winner = answers.find((a) => a.res.status === 202);
      assert.equal(winner.res.json.claimed, true);
      assert.deepEqual(winner.res.json.plan, { id: plan.id, status: 'executing' });
      const losers = answers.filter((a) => a.res.status === 200);
      assert.equal(losers.length, 9, 'nine current-state answers');
      for (const { res } of losers) {
        assert.equal(res.json.claimed, false);
        assert.equal(res.json.plan.id, plan.id);
        assert.ok(['executing', 'executed'].includes(res.json.plan.status), `a loser sees the current plan state: ${res.json.plan.status}`);
        assert.equal(typeof res.json.rescueStatus.status, 'string');
      }
      const perProcess = (server) => answers.filter((a) => a.server === server).length;
      assert.deepEqual([perProcess(one), perProcess(two)], [EXECUTES_PER_PROCESS, EXECUTES_PER_PROCESS], 'five calls went to each process');

      // The saga continues in the winner's process.
      await waitFor(() => db.prepare('SELECT status FROM plan_versions WHERE id = ?').get(plan.id).status === 'executed', { what: 'the plan to be executed' });

      const row = db.prepare('SELECT status, lease_epoch, executor_id FROM plan_versions WHERE id = ?').get(plan.id);
      assert.equal(row.status, 'executed');
      assert.equal(row.lease_epoch, 1, 'exactly one claim committed');
      assert.ok(row.executor_id.includes(`:${winner.server.pid}:`), `the executor is the winning process (${row.executor_id}, pid ${winner.server.pid})`);
      assert.equal(db.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE action = 'plan.execute' AND outcome = 'ok'").get().n, 1, 'one claim audited');
      const ops = db.prepare('SELECT supplier_order_id AS orderId, status, provider_capture_id AS captureId FROM payment_operations ORDER BY supplier_order_id').all();
      assert.deepEqual(ops.map((o) => o.status), ['captured', 'captured']);
      assert.ok(ops.every((o) => /^FAKECAP-/.test(o.captureId)));

      // F-TR-8: the run's total is exactly N get_authorization + N capture, and nothing else.
      const gained = db.prepare('SELECT id, kind, request_id AS requestId, replayed, pid FROM fake_paypal_calls WHERE id > ? ORDER BY id').all(baseline);
      assert.equal(gained.length, 2 * N, `exactly ${2 * N} provider calls during the run: ${gained.map((c) => c.kind).join(', ')}`);
      assert.deepEqual(
        { get_authorization: gained.filter((c) => c.kind === 'get_authorization').length, capture: gained.filter((c) => c.kind === 'capture').length },
        { get_authorization: N, capture: N },
        'N get_authorization + N capture, nothing else',
      );
      assert.ok(gained.every((c) => c.replayed === 0), 'every call was a first send, none a replay');
      assert.ok(gained.every((c) => c.pid === winner.server.pid), `every call came from the winner's process (pid ${winner.server.pid}): ${gained.map((c) => c.pid).join(',')}`);
      assert.deepEqual(
        gained.filter((c) => c.kind === 'capture').map((c) => c.requestId).sort(),
        orders.map((o) => `so:${o.id}:capture:1`).sort(),
        'one capture per supplier order with PayPal-Request-Id so:<id>:capture:1',
      );
      const readsBeforeCaptures = gained.slice(0, N).every((c) => c.kind === 'get_authorization');
      assert.ok(readsBeforeCaptures, 'step 2 reads every authorization before the first capture');
      assert.equal(db.prepare("SELECT COUNT(*) AS n FROM fake_paypal_captures").get().n, N, 'N captures exist at the fake provider');

      // Nothing more happens afterwards: a request served by each process (and the reconciler ticks) adds no provider call.
      for (const client of [cafe1On1, cafe1On2]) {
        const view = await client.get('/api/requests');
        assert.equal(view.status, 200, view.text);
      }
      const settled = db.prepare('SELECT COUNT(*) AS n FROM fake_paypal_calls WHERE id > ?').get(baseline).n;
      assert.equal(settled, 2 * N, 'no further provider call after the plan is executed');

      for (const server of [first, second]) {
        const logs = `${server.stdout()}\n${server.stderr()}`;
        assert.doesNotMatch(logs, /database is locked|SQLITE_BUSY|DB_BUSY/i, `process ${server.pid} reported a lock error`);
        assert.doesNotMatch(logs, /"level":"error"/, `process ${server.pid} logged an error`);
      }
    });
  }
});

// ---- NFR3 / LIVE-P1: the live PayPal suite refuses without the flag, and nothing here touches the network ------------------------
// The live files in test/live/paypal talk to the REAL PayPal Sandbox. These tests prove that WITHOUT RS_LIVE_PAYPAL=1 each of them,
// and the npm launcher, exits 2 with the named message before doing anything; the children run under the offline network guard
// and with an environment that holds no RS_* variable. The cases that need the flag set go through the pure function
// evaluateLiveLaunch(env) with plain objects: RS_LIVE_PAYPAL=1 is never put into any process environment here.
const LIVE_DIR = join(PROJECT_ROOT, 'test', 'live', 'paypal');
const LIVE_FILES = readdirSync(LIVE_DIR).filter((f) => f.endsWith('.test.js')).sort();
const DEFAULT_SET = Object.freeze({ RS_PAYPAL_DEFAULT_CLIENT_ID: 'id-value-1', RS_PAYPAL_DEFAULT_CLIENT_SECRET: 'secret-value-2', RS_PAYPAL_DEFAULT_WEBHOOK_ID: 'hook-value-3' });
const FIVE_SETS = Object.freeze(Object.fromEntries(['A', 'B', 'C', 'D', 'E'].flatMap((k) => ['CLIENT_ID', 'CLIENT_SECRET', 'WEBHOOK_ID'].map((p) => [`RS_PAYPAL_${k}_${p}`, `${k}-${p}`]))));

function runNodeClean(args, env = {}) {
  return spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', `--import=${NET_GUARD_PATH}`, ...args], {
    cwd: PROJECT_ROOT, env: { PATH: '/usr/local/bin:/usr/bin:/bin', ...env }, encoding: 'utf8', timeout: 30_000,
  });
}

describe('NFR3: the live PayPal suite files refuse without RS_LIVE_PAYPAL=1 (exit 2, named message, nothing on stdout, no network)', () => {
  test('NFR3: the directory holds the RS-18, RS-19, RS-20, RS-23, RS-24 files and the Sandbox journey', () => {
    assert.deepEqual(LIVE_FILES, [
      'journey-sandbox.test.js', 'rs18-cancel-abandon.test.js', 'rs19-amount.test.js', 'rs20-double-capture.test.js', 'rs23-webhook-duplicate.test.js', 'rs24-webhook-signature.test.js',
    ]);
  });

  for (const file of LIVE_FILES) {
    test(`NFR3: ${file} run without RS_LIVE_PAYPAL exits 2 with the fixed message and prints nothing else`, () => {
      for (const extra of [{}, { RS_LIVE_PAYPAL: '0' }, { RS_LIVE_PAYPAL: '' }, { RS_LIVE_PAYPAL: 'true' }, { RS_LIVE_PAYPAL: 'yes' }, { ...DEFAULT_SET }]) {
        const r = runNodeClean([join(LIVE_DIR, file)], extra);
        assert.equal(r.status, 2, `${file} with ${JSON.stringify(Object.keys(extra))}: exit ${r.status}, stderr ${r.stderr}`);
        assert.equal(r.stderr.trim(), LIVE_MESSAGES.notEnabled);
        assert.equal(r.stdout, '');
      }
    });
  }

  test('NFR3: the npm launcher refuses the same way and never starts the test files', async () => {
    const r = runNodeClean([join(LIVE_DIR, 'run-live-paypal.js'), 'test/live/paypal/**/*.test.js']);
    assert.equal(r.status, 2);
    assert.equal(r.stderr.trim(), 'Set RS_LIVE_PAYPAL=1 to run the live PayPal Sandbox suite (it contacts the PayPal Sandbox)');
    assert.equal(r.stdout, '');
    // Injected: a refused launch never reaches spawnTests; an allowed one passes the patterns on and returns its exit code.
    let spawned = 0;
    const errs = [];
    assert.equal(await runLivePaypal({ env: {}, guardInstalled: false, argv: [], err: (s) => errs.push(s), spawnTests: async () => { spawned += 1; return 0; } }), 2);
    assert.equal(spawned, 0);
    assert.deepEqual(errs, [`${LIVE_MESSAGES.notEnabled}\n`]);
    let seen = null;
    const env = { RS_LIVE_PAYPAL: '1', ...DEFAULT_SET };
    assert.equal(await runLivePaypal({ env, guardInstalled: false, argv: ['x/*.test.js'], err: () => {}, spawnTests: async (patterns) => { seen = patterns; return 7; } }), 7);
    assert.deepEqual(seen, ['x/*.test.js']);
    assert.equal(await runLivePaypal({ env, guardInstalled: false, argv: [], err: () => {}, spawnTests: async (patterns) => { seen = patterns; return 0; } }), 0);
    assert.deepEqual(seen, ['test/live/paypal/**/*.test.js']);
  });

  test('NFR3: the flag alone is not enough: the missing credential variables are named (never a value); guard and offline flag refuse', () => {
    const noCreds = evaluateLiveLaunch({ RS_LIVE_PAYPAL: '1' }, { guardInstalled: false });
    assert.equal(noCreds.ok, false);
    assert.equal(noCreds.message, missingCredentialsMessage({ RS_LIVE_PAYPAL: '1' }));
    for (const name of Object.keys(DEFAULT_SET)) assert.match(noCreds.message, new RegExp(name));
    for (const missing of Object.keys(DEFAULT_SET)) {
      const r = evaluateLiveLaunch({ RS_LIVE_PAYPAL: '1', ...DEFAULT_SET, [missing]: '' }, { guardInstalled: false });
      assert.equal(r.ok, false, `without ${missing}`);
      assert.match(r.message, new RegExp(missing));
      for (const value of Object.values(DEFAULT_SET)) assert.equal(r.message.includes(value), false, 'no credential value in a message');
    }
    assert.deepEqual(evaluateLiveLaunch({ RS_LIVE_PAYPAL: '1', ...DEFAULT_SET }, { guardInstalled: true }), { ok: false, message: LIVE_MESSAGES.netGuard });
    assert.deepEqual(evaluateLiveLaunch({ RS_LIVE_PAYPAL: '1', RS_TEST_OFFLINE: '1', ...DEFAULT_SET }, { guardInstalled: false }), { ok: false, message: LIVE_MESSAGES.offline });
    assert.deepEqual(evaluateLiveLaunch({ RS_LIVE_PAYPAL: '1', ...DEFAULT_SET }, { guardInstalled: false }), { ok: true, mode: 'single-credential', keys: ['DEFAULT'] });
    // Per-supplier mode needs all of A to E; four complete sets are not enough.
    assert.deepEqual(evaluateLiveLaunch({ RS_LIVE_PAYPAL: '1', ...FIVE_SETS }, { guardInstalled: false }), { ok: true, mode: 'per-supplier', keys: ['A', 'B', 'C', 'D', 'E'] });
    const four = { ...FIVE_SETS };
    delete four.RS_PAYPAL_E_WEBHOOK_ID;
    assert.equal(evaluateLiveLaunch({ RS_LIVE_PAYPAL: '1', ...four }, { guardInstalled: false }).ok, false);
  });

  test('NFR3: a suite report carries the suite, the provider and the merchant mode, and a skipped check is never counted as passed', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rs-live-report-'));
    try {
      const report = createSuiteReport('unit', { mode: 'single-credential', keys: ['DEFAULT'] }, { reportDir: dir });
      report.record('a passed check', 'passed');
      report.record('a skipped check', 'skipped', 'needs a person');
      const file = report.write();
      const body = JSON.parse(readFileSync(file, 'utf8'));
      assert.equal(body.suite, 'live-paypal:unit');
      assert.equal(body.provider, 'paypal-sandbox');
      assert.equal(body.merchantMode, 'single-credential');
      assert.deepEqual(body.counts, { passed: 1, failed: 0, skipped: 1 });
      assert.equal(body.pass, false, 'a run with a skipped check is not a pass');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('NFR3: test:live-paypal keeps the check-node prefix and runs the live files (each refuses by itself); they stay out of npm test', () => {
    const pkg = JSON.parse(readFileSync(join(PROJECT_ROOT, 'package.json'), 'utf8'));
    assert.ok(pkg.scripts['test:live-paypal'].startsWith('node scripts/check-node.cjs && '));
    assert.match(pkg.scripts['test:live-paypal'], /test\/live\/paypal\/\*\*\/\*\.test\.js/);
    assert.equal(/live/.test(pkg.scripts.test), false);
  });
});
