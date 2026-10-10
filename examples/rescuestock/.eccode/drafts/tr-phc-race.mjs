// technical-reviewer probe (phase C, RS-14 / RS-16 across processes), independent of c6's test.
// Each round: a new database, two server processes (busy_timeout 5000) on the same SQLite file, four freshly
// registered customers, each with an approved canonical plan (A + B; A has on_hand = 1). Then, all at once:
//   - customer 1 sends reserve with key K1 to process 1 AND the same key to process 2 (same-key race across processes)
//   - customers 2..4 send reserve with their own keys, alternating processes
// Expected: no 5xx; exactly one reservation row and it is active; A reserved 1 of 1 and reserved <= on_hand everywhere;
// every loser answers 409 OUT_OF_STOCK; customer 1's two answers name the same reservation when either wins
// (one of them replayed), or are both 409 OUT_OF_STOCK; the ledger has one reserve row per item of the one reservation;
// loser plans are non_executable; no "database is locked" / SQLITE_BUSY / DB_BUSY in either log.
// Usage: node tr-phc-race.mjs <rounds>   Exit 0 = every round held.
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
const root = process.cwd();
const imp = (p) => import(pathToFileURL(join(root, p)));
const { startServer, upcomingDemoDate } = await imp('test/helpers/server-proc.js');
const { createClient } = await imp('test/helpers/fixtures.js');
const { approvedPlan } = await imp('test/helpers/plan-flow.js');

const ROUNDS = Number(process.argv[2] || 5);
const failures = [];
const outcomes = {};
for (let round = 1; round <= ROUNDS; round++) {
  const demoDate = upcomingDemoDate();
  const env = { RS_DB_BUSY_TIMEOUT_MS: '5000', RS_DEMO_DATE: demoDate, RS_REGISTER_PER_IP_PER_HOUR: '1000' };
  const first = await startServer({ env, seed: true });
  const second = await startServer({ env, dir: first.dir, dbPath: first.dbPath });
  const servers = [first, second];
  try {
    const customers = [];
    for (let i = 0; i < 4; i++) {
      const c = createClient(servers[i % 2].request);
      await c.register({ username: `race-${round}-${i}-${process.pid}`, password: 'race-password-0001', displayName: 'Race' });
      const { plan } = await approvedPlan(c, demoDate);
      if (!plan.body.lines.some((l) => l.supplierCode === 'A')) failures.push(`round ${round}: plan ${i} does not use A`);
      customers.push({ c, plan, other: createClient(servers[(i + 1) % 2].request) });
    }
    // The second client of customer 1 shares the session cookie and CSRF token through a sign-in on the other process.
    await customers[0].other.signIn(`race-${round}-0-${process.pid}`, 'race-password-0001');
    const k = (i) => `race-key-${round}-${i}-${'x'.repeat(16)}`;
    const send = (client, planId, key) => client.post(`/api/plans/${planId}/reserve`, {}, { headers: { 'Idempotency-Key': key } });
    const pairLast = round % 2 === 0;
    const jobs = [
      () => send(customers[0].c, customers[0].plan.id, k(0)),
      () => send(customers[0].other, customers[0].plan.id, k(0)),
      () => send(customers[1].c, customers[1].plan.id, k(1)),
      () => send(customers[2].c, customers[2].plan.id, k(2)),
      () => send(customers[3].c, customers[3].plan.id, k(3)),
    ];
    const order = pairLast ? [2, 3, 4, 0, 1] : [0, 1, 2, 3, 4];
    const started = [];
    for (const i of order) {
      started[i] = jobs[i]();
      if (pairLast && i === 4) await new Promise((r) => setTimeout(r, 15));
    }
    const answers = await Promise.all(started);
    const tag = answers.map((a) => `${a.status}${a.json?.error ? ' ' + a.json.error.code : ''}${a.headers['idempotent-replayed'] ? ' (replay)' : ''}`);
    for (const t of tag) outcomes[t] = (outcomes[t] || 0) + 1;
    if (answers.some((a) => a.status >= 500)) failures.push(`round ${round}: 5xx ${tag.join(' | ')}`);
    const wins = answers.filter((a) => a.status === 201 || a.status === 200);
    const winIds = new Set(wins.map((a) => a.json.reservation.id));
    if (winIds.size !== 1) failures.push(`round ${round}: ${winIds.size} distinct winning reservations: ${tag.join(' | ')}`);
    for (const a of answers) if (a.status === 409 && a.json.error.code !== 'OUT_OF_STOCK') failures.push(`round ${round}: loser code ${a.json.error.code}`);
    const c0 = answers.slice(0, 2);
    const c0Won = c0.filter((a) => a.status < 300);
    if (c0Won.length === 1 || (c0Won.length === 2 && c0Won[0].json.reservation.id !== c0Won[1].json.reservation.id)) {
      failures.push(`round ${round}: customer 1's same-key pair disagrees: ${tag.slice(0, 2).join(' | ')}`);
    }
    const db = new DatabaseSync(first.dbPath, { readOnly: true });
    try {
      const rows = db.prepare('SELECT id, status, plan_version_id FROM reservations').all();
      if (rows.length !== 1 || rows[0].status !== 'active') failures.push(`round ${round}: reservations ${JSON.stringify(rows)}`);
      const stock = db.prepare('SELECT s.code, i.on_hand, i.reserved FROM inventory i JOIN suppliers s ON s.id = i.supplier_id').all();
      for (const r of stock) if (r.reserved > r.on_hand || r.reserved < 0) failures.push(`round ${round}: supplier ${r.code} reserved ${r.reserved} > on_hand ${r.on_hand}`);
      const a = stock.filter((r) => r.code === 'A');
      if (a.reduce((n, r) => n + r.reserved, 0) !== 1) failures.push(`round ${round}: A reserved ${JSON.stringify(a)}`);
      if (rows.length === 1) {
        const items = db.prepare('SELECT COUNT(*) AS n FROM reservation_items WHERE reservation_id = ?').get(rows[0].id).n;
        const ledger = db.prepare("SELECT COUNT(*) AS n FROM inventory_ledger WHERE reason = 'reserve'").get().n;
        if (ledger !== items) failures.push(`round ${round}: ${items} items but ${ledger} reserve ledger rows`);
        const losers = customers.map((x) => x.plan.id).filter((id) => id !== rows[0].plan_version_id);
        for (const id of losers) {
          const st = db.prepare('SELECT status FROM plan_versions WHERE id = ?').get(id).status;
          if (st !== 'non_executable') failures.push(`round ${round}: loser plan ${id} is ${st}`);
        }
        const orders = db.prepare('SELECT COUNT(*) AS n FROM supplier_orders').get().n;
        const ops = db.prepare('SELECT COUNT(*) AS n FROM payment_operations').get().n;
        const suppliersInPlan = db.prepare('SELECT plan_json FROM plan_versions WHERE id = ?').get(rows[0].plan_version_id);
        const n = JSON.parse(suppliersInPlan.plan_json).suppliers.length;
        if (orders !== n || ops !== n) failures.push(`round ${round}: ${orders} orders / ${ops} operations for ${n} suppliers`);
      }
    } finally {
      db.close();
    }
    for (const s of servers) {
      const logs = `${s.stdout()}\n${s.stderr()}`;
      if (/database is locked|SQLITE_BUSY|DB_BUSY/i.test(logs)) failures.push(`round ${round}: lock error in process ${s.pid}`);
    }
  } catch (err) {
    failures.push(`round ${round}: threw ${err.message}`);
  } finally {
    await second.cleanup();
    await first.cleanup();
  }
}
console.log(`rounds ${ROUNDS}; answer tally: ${JSON.stringify(outcomes)}`);
console.log(failures.length ? `FAILURES:\n  ${failures.join('\n  ')}` : 'every round: one active reservation, losers OUT_OF_STOCK, same-key pair consistent, no 5xx, no lock errors');
process.exit(failures.length ? 1 : 0);
