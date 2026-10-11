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
import { DatabaseSync } from 'node:sqlite';
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
