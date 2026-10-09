// technical-reviewer check (design gate, revision 2): the REVISED migration SQL (every ```sql block under Data Design)
// on node:sqlite, plus the revision-2 constraints and races:
//  - append-only triggers (RS-38); CHECK reserved <= on_hand; valid-only webhook dedupe (RS-23/24)
//  - F-TR-1: reservations UNIQUE (customer_id, idempotency_key) refuses the same key on another plan even with no
//    idempotency_keys row (purged); operation_key carries the plan; idempotency_keys PK (user_id, key)
//  - SEC-2: two OS processes, SAME customer, two different plans and products: the live-reservation cap inside
//    BEGIN IMMEDIATE lets exactly one through (RESERVED + RESERVATION_LIMIT)
//  - RS-32 sequence: reservation released by the void rule, then the replacement plan reserves under the cap
//  - RS-14: two customers race for A's last bundle (RESERVED + OUT_OF_STOCK); busy_timeout 0 vs held lock -> BUSY
//  - RS-15: concurrent expiry passes -> exactly one EXPIRED and one expire ledger row
//  - SEC-1/SEC-9: login_failures keyed (username_key, ip): 5 failures from IP1 refuse the pair on IP1 only
//  - F-TR-12 / F-TR-2: integer micro-dollar spend columns; replan_queue keeps failed_drains/next_attempt_at
// Usage: node tr-design-r2-ddl-race.mjs <spec.md>.  Exit 0 = every check held.
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

const spec = readFileSync(process.argv[2], 'utf8');
const dd = spec.slice(spec.indexOf('## Data Design'), spec.indexOf('## Background Processing'));
const blocks = [...dd.matchAll(/```sql\n([\s\S]*?)```/g)].map((m) => m[1]);
const child = join(dirname(fileURLToPath(import.meta.url)), 'tr-design-r2-sqlite-child.mjs');
let fails = 0;
const check = (name, ok, extra = '') => { if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${extra ? ' | ' + extra : ''}`); };
const throws = (fn) => { try { fn(); return null; } catch (e) { return e.message; } };

const file = join(mkdtempSync(join(tmpdir(), 'tr-r2-ddl-')), 'app.db');
const db = new DatabaseSync(file);
db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
check('spec has 5 sql blocks (001-005)', blocks.length === 5, `found ${blocks.length}`);
blocks.forEach((b, i) => { const err = throws(() => db.exec(b)); check(`migration block ${i + 1} executes`, !err, err || ''); });

const now = '2026-10-20T07:00:00.000Z';
const H = 'a'.repeat(64);
db.exec(`INSERT INTO suppliers (id, code, name, pickup_address, paypal_merchant_key, created_at) VALUES (1,'A','A','Amman','A','${now}'),(2,'B','B','Amman','B','${now}'),(3,'E','E','Amman','E','${now}');
INSERT INTO products (id, supplier_id, kind, name, created_at) VALUES (1,1,'bundle','A','${now}'),(2,2,'bundle','B','${now}'),(3,3,'bundle','E','${now}');
INSERT INTO inventory (product_id, supplier_id, on_hand, reserved) VALUES (1,1,1,0),(2,2,1,0),(3,3,1,0);
INSERT INTO inventory_ledger (supplier_id, product_id, reason, delta_on_hand, delta_reserved, on_hand_after, reserved_after, ref_type, actor, at) VALUES (1,1,'adjust',1,0,1,0,'seed','seed','${now}');
INSERT INTO audit_events (at, actor_role, action, entity_type, outcome) VALUES ('${now}','system','seed','inventory','ok');
INSERT INTO users (id, username, password_hash, role, display_name, created_at) VALUES (1,'cafe1','h','customer','C1','${now}'),(2,'cafe2','h','customer','C2','${now}');
INSERT INTO rescue_requests (id, customer_id, raw_text, language, intake_status, created_at) VALUES (1,1,'x','en','confirmed','${now}'),(2,2,'y','en','confirmed','${now}'),(3,1,'z','en','confirmed','${now}');
INSERT INTO planning_runs (id, request_id, requirements_version, feasible, trace_json, rejections_json, offers_hash, created_at) VALUES (1,1,1,1,'{}','[]','h','${now}'),(2,2,1,1,'{}','[]','h','${now}'),(3,3,1,1,'{}','[]','h','${now}');
INSERT INTO plan_versions (id, request_id, planning_run_id, version, status, plan_json, plan_hash, total_cents, pickup_count, ready_at, created_at, updated_at) VALUES
 (1,1,1,1,'approved','{}','${H}',8400,2,'${now}','${now}','${now}'),(2,1,1,2,'approved','{}','${H}',9500,2,'${now}','${now}','${now}'),
 (3,2,2,1,'approved','{}','${H}',8400,2,'${now}','${now}','${now}'),(4,3,3,1,'approved','{}','${H}',4000,1,'${now}','${now}','${now}');`);
check('RS-38 UPDATE inventory_ledger refused', !!throws(() => db.exec("UPDATE inventory_ledger SET actor='x'")));
check('RS-38 DELETE inventory_ledger refused', !!throws(() => db.exec('DELETE FROM inventory_ledger')));
check('RS-38 UPDATE audit_events refused', !!throws(() => db.exec("UPDATE audit_events SET action='x'")));
check('RS-38 DELETE audit_events refused', !!throws(() => db.exec('DELETE FROM audit_events')));
check('CHECK reserved <= on_hand', !!throws(() => db.exec('UPDATE inventory SET reserved = 2 WHERE product_id = 1')));
const wh = (s) => `INSERT INTO webhook_events (provider, transmission_id, merchant_key, signature_status, outcome, payload_sha256, received_at) VALUES ('fake','t1','A','${s}','${s === 'valid' ? 'applied' : 'rejected'}','x','${now}')`;
db.exec(wh('invalid')); db.exec(wh('invalid'));
check('RS-23/24 invalid rows do not occupy the transmission id', !throws(() => db.exec(wh('valid'))));
check('RS-23 second valid row refused', !!throws(() => db.exec(wh('valid'))));

// F-TR-1 constraints (no idempotency_keys row: the "purged" case)
const insRes = (pv, c, key, st = 'released') => db.exec(`INSERT INTO reservations (plan_version_id, customer_id, idempotency_key, operation_key, status, expires_at, created_at) VALUES (${pv},${c},'${key}','res:${c}:${pv}:${key}','${st}','2026-10-20T07:30:00.000Z','${now}')`);
check('F-TR-1 reservation with key K on plan 1 inserts', !throws(() => insRes(1, 1, 'KEY-AAAAAAAAAAAAAAAA')));
check('F-TR-1 same customer, same key K on plan 2 refused by UNIQUE (customer_id, idempotency_key)', !!throws(() => insRes(2, 1, 'KEY-AAAAAAAAAAAAAAAA')));
check('F-TR-1 another customer may use the same key text', !throws(() => insRes(3, 2, 'KEY-AAAAAAAAAAAAAAAA')));
db.exec("DELETE FROM reservations");
db.exec(`INSERT INTO idempotency_keys (user_id, key, fingerprint, status_code, response_json, created_at) VALUES (1,'KEY-BBBBBBBBBBBBBBBB','f1',201,'{}','${now}')`);
check('F-TR-1 idempotency_keys PK (user_id, key): a second fingerprint row for the same key refused', !!throws(() => db.exec(`INSERT INTO idempotency_keys (user_id, key, fingerprint, status_code, response_json, created_at) VALUES (1,'KEY-BBBBBBBBBBBBBBBB','f2',201,'{}','${now}')`)));
// SEC-1 throttle shape
for (let i = 0; i < 5; i++) db.exec(`INSERT INTO login_failures (username_key, ip, at) VALUES ('admin','10.0.0.1','${now}')`);
const pair = (ip) => db.prepare('SELECT count(*) AS n FROM login_failures WHERE username_key = ? AND ip = ? AND at > ?').get('admin', ip, '2026-10-20T06:45:00.000Z').n;
const user = db.prepare('SELECT count(*) AS n FROM login_failures WHERE username_key = ? AND at > ?').get('admin', '2026-10-20T06:45:00.000Z').n;
check('SEC-1 pair (admin, attacker IP) reaches the hard limit; pair (admin, other IP) does not; cross-IP total below the delay threshold', pair('10.0.0.1') >= 5 && pair('10.0.0.2') === 0 && user < 10, `attackerPair=${pair('10.0.0.1')} otherPair=${pair('10.0.0.2')} userTotal=${user}`);
check('F-TR-12 model_spend takes integer micro-dollars', !throws(() => db.exec(`INSERT INTO model_spend (day, customer_id, purpose, reserved_micro_usd, status, created_at) VALUES ('2026-10-20',1,'extract',100000,'reserved','${now}')`)));
check('F-TR-2 replan_queue keeps failed_drains and next_attempt_at', !throws(() => db.exec(`INSERT INTO replan_queue (request_id, reason, enqueued_at, failed_drains, next_attempt_at) VALUES (1,'OFFER_WITHDRAWN','${now}',5,'${now}')`)));
db.exec('DELETE FROM replan_queue');
db.close();

const runAll = (bt, jobs) => new Promise((res) => {
  const startAt = Date.now() + 400; const outs = []; let n = 0;
  jobs.forEach(([mode, args, offset]) => {
    const p = spawn(process.execPath, [...process.execArgv, child, file, String(bt), mode, String(startAt + (offset || 0)), ...args.map(String)]);
    let o = ''; p.stdout.on('data', (x) => (o += x)); p.stderr.on('data', () => {});
    p.on('close', () => { outs.push(o.trim()); if (++n === jobs.length) res(outs.sort()); });
  });
});
const q = (sql) => { const d = new DatabaseSync(file); const r = d.prepare(sql).all(); d.close(); return r; };

// SEC-2: same customer, plans 1 (product B) and 4 (product E): exactly one passes the cap
const c1 = await runAll(5000, [['reserve', [1, 1, 2, 'KEY-C1-PLAN1-000001']], ['reserve', [1, 4, 3, 'KEY-C1-PLAN4-000001']]]);
check('SEC-2 two processes, same customer, two plans: one RESERVED, one RESERVATION_LIMIT', c1.join(',') === 'RESERVATION_LIMIT,RESERVED', c1.join(' | '));
// RS-32 sequence: void rule releases the live reservation, then the replacement plan reserves under the cap
{
  const d = new DatabaseSync(file);
  d.exec('PRAGMA busy_timeout=5000; BEGIN IMMEDIATE');
  const live = d.prepare("SELECT id FROM reservations WHERE customer_id = 1 AND status = 'active'").get();
  const item = d.prepare("SELECT product_id FROM inventory WHERE reserved = 1").get();
  d.prepare("UPDATE reservations SET status = 'released', closed_at = ? WHERE id = ? AND status = 'active'").run(now, live.id);
  d.prepare('UPDATE inventory SET reserved = reserved - 1 WHERE product_id = ?').run(item.product_id);
  d.exec('COMMIT'); d.close();
}
const c2 = await runAll(5000, [['reserve', [1, 2, 1, 'KEY-C1-PLAN2-000001']]]);
check('RS-32 replacement plan reserves after the void rule released the old reservation (cap not hit)', c2[0] === 'RESERVED', c2.join(' | '));
// RS-14: customer 2 races customer 1? customer 1 already holds one live reservation, so race customers 2 and a fresh hold on A
{
  const d = new DatabaseSync(file);
  d.exec("PRAGMA busy_timeout=5000; UPDATE reservations SET status='released' WHERE customer_id = 1; UPDATE inventory SET reserved = 0");
  d.exec(`INSERT INTO users (id, username, password_hash, role, display_name, created_at) VALUES (3,'cafe3','h','customer','C3','${now}')`);
  d.close();
}
const c3 = await runAll(5000, [['reserve', [2, 3, 1, 'KEY-C2-PLAN3-000001']], ['reserve', [1, 1, 1, 'KEY-C1-PLAN1-000002']]]);
const inv = q('SELECT on_hand, reserved FROM inventory WHERE product_id = 1')[0];
check('RS-14 two customers race for A\'s last bundle: one RESERVED, one OUT_OF_STOCK; reserved <= on_hand', c3.join(',') === 'OUT_OF_STOCK,RESERVED' && inv.reserved <= inv.on_hand, c3.join(' | ') + ` final ${JSON.stringify(inv)}`);
// RS-15 expiry race on the live reservation
const liveId = q("SELECT id FROM reservations WHERE status = 'active' AND plan_version_id IN (1,3)")[0].id;
const c4 = await runAll(5000, [['expire', [0, liveId]], ['expire', [0, liveId]]]);
const expRows = q(`SELECT count(*) AS n FROM inventory_ledger WHERE reason = 'expire' AND ref_id = ${liveId}`)[0].n;
check('RS-15 concurrent expiry passes: one EXPIRED, one NOOP, one expire ledger row', c4.join(',') === 'EXPIRED,NOOP' && expRows === 1, c4.join(' | ') + ` expireRows=${expRows}`);
const c5 = await runAll(0, [['hold', [], 0], ['reserve', [3, 4, 3, 'KEY-C3-PLAN4-000001'], 500]]);
check('RS-14 busy_timeout 0 vs held BEGIN IMMEDIATE: SQLITE_BUSY surfaces', c5.includes('HELD') && c5.some((x) => /ERROR .*(locked|busy)/i.test(x)), c5.join(' | '));
console.log(`node ${process.version}; failures: ${fails}`);
process.exit(fails ? 1 : 0);
