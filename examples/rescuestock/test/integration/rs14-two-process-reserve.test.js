// RS-14 (multi-process half): two separate OS processes, each with PRAGMA busy_timeout = 5000, serve one customer
// each against the same SQLite file. Both customers hold an approved plan that needs supplier A's last bundle
// (RS-FIX-1: on_hand = 1). The two reserve calls are sent in the same tick, one to each process.
//   Expected: exactly one reservation is `active` (201), the other customer gets 409 OUT_OF_STOCK (not a lock error,
//   not a 500), and reserved <= on_hand for every product.
// Each round uses a new database, and the round alternates which process the first customer talks to.
import { afterEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createClient } from '../helpers/fixtures.js';
import { approvedPlan, idempotencyKey, reserve } from '../helpers/plan-flow.js';
import { SEED_PASSWORD, startServer, upcomingDemoDate } from '../helpers/server-proc.js';

const ROUNDS = 3;
const cleanups = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()();
});

function readDb(path) {
  const db = new DatabaseSync(path, { readOnly: true });
  cleanups.push(() => db.close());
  return db;
}

describe('RS-14: two OS processes reserve the last bundle of supplier A against one SQLite file', () => {
  for (let round = 1; round <= ROUNDS; round++) {
    test(`RS-14: round ${round}: one reservation is active, the other customer gets 409 OUT_OF_STOCK, reserved <= on_hand`, async () => {
      const demoDate = upcomingDemoDate();
      const env = { RS_DB_BUSY_TIMEOUT_MS: '5000', RS_DEMO_DATE: demoDate };
      // The first server migrates and seeds; the second opens the same file afterwards (no start-up race).
      const first = await startServer({ env, seed: true });
      cleanups.push(() => first.cleanup());
      const second = await startServer({ env, dir: first.dir, dbPath: first.dbPath });
      cleanups.push(() => second.cleanup());

      assert.notEqual(first.pid, second.pid, 'two server processes');
      assert.notEqual(first.pid, process.pid);
      assert.equal(second.dbPath, first.dbPath, 'both processes use the same database file');

      // Alternate which process serves which customer.
      const [serverOne, serverTwo] = round % 2 === 1 ? [first, second] : [second, first];
      const cafe1 = createClient(serverOne.request);
      const cafe2 = createClient(serverTwo.request);
      await cafe1.signIn('cafe1', SEED_PASSWORD);
      await cafe2.signIn('cafe2', SEED_PASSWORD);
      const planOne = await approvedPlan(cafe1, demoDate);
      const planTwo = await approvedPlan(cafe2, demoDate);
      assert.deepEqual(planOne.plan.body.lines.map((l) => l.supplierCode), ['A', 'B'], 'the plan needs supplier A');
      assert.deepEqual(planTwo.plan.body.lines.map((l) => l.supplierCode), ['A', 'B']);

      const answers = await Promise.all([
        reserve(cafe1, planOne.plan.id, idempotencyKey(`r${round}a`)),
        reserve(cafe2, planTwo.plan.id, idempotencyKey(`r${round}b`)),
      ]);

      const statuses = answers.map((a) => a.status).sort();
      assert.deepEqual(statuses, [201, 409], `statuses ${answers.map((a) => `${a.status} ${a.json?.error?.code ?? ''}`).join(' | ')}`);
      const winner = answers.find((a) => a.status === 201);
      const loser = answers.find((a) => a.status === 409);
      assert.equal(winner.json.reservation.status, 'active');
      assert.equal(loser.json.error.code, 'OUT_OF_STOCK', 'the loser is told the stock is gone, not that the database was locked');
      assert.ok(loser.json.error.details.supplierCodes.includes('A'));
      assert.equal(typeof loser.json.error.requestId, 'string');
      for (const a of answers) assert.ok(a.status < 500, `no 5xx: ${a.text}`);

      // The truth is in the file, read by this test process.
      const db = readDb(first.dbPath);
      const active = db.prepare("SELECT COUNT(*) AS n FROM reservations WHERE status = 'active'").get().n;
      assert.equal(active, 1, 'exactly one active reservation');
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM reservations').get().n, 1, 'the loser left no reservation row');
      const stock = db.prepare('SELECT s.code AS code, i.on_hand AS onHand, i.reserved AS reserved FROM inventory i JOIN suppliers s ON s.id = i.supplier_id ORDER BY s.code').all();
      for (const row of stock) assert.ok(row.reserved <= row.onHand, `reserved <= on_hand for supplier ${row.code}: ${row.reserved} <= ${row.onHand}`);
      assert.deepEqual(stock.filter((r) => r.code === 'A').map((r) => [r.onHand, r.reserved]), [[1, 1]], 'supplier A: the one bundle is reserved once');
      const loserPlanId = loser === answers[0] ? planOne.plan.id : planTwo.plan.id;
      assert.equal(db.prepare('SELECT status FROM plan_versions WHERE id = ?').get(loserPlanId).status, 'non_executable');

      for (const server of [first, second]) {
        const logs = `${server.stdout()}\n${server.stderr()}`;
        assert.doesNotMatch(logs, /database is locked|SQLITE_BUSY|DB_BUSY/i, `process ${server.pid} reported a lock error`);
      }
    });
  }
});
