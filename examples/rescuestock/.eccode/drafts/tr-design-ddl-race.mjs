// technical-reviewer check (design gate): (1) the spec's migration SQL (every ```sql block under Data Design,
// 001-005) executes on node:sqlite in order; (2) the append-only triggers refuse UPDATE/DELETE (RS-38);
// (3) CHECK reserved <= on_hand, the provider_calls key GLOB and the valid-only webhook dedupe index behave as
// the spec says; (4) two OS processes with busy_timeout 5000 race for A's last bundle: one RESERVED, one
// OUT_OF_STOCK (RS-14); (5) two processes run the expiry CAS on one reservation: exactly one EXPIRED, one
// ledger row (RS-15); (6) busy_timeout 0 against a held BEGIN IMMEDIATE gives SQLITE_BUSY (RS-14 503 path).
// Usage: node tr-design-ddl-race.mjs <spec.md>
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

const spec = readFileSync(process.argv[2], 'utf8');
const dd = spec.slice(spec.indexOf('## Data Design'), spec.indexOf('## Background Processing'));
const blocks = [...dd.matchAll(/```sql\n([\s\S]*?)```/g)].map((m) => m[1]);
const child = join(dirname(fileURLToPath(import.meta.url)), 'tr-design-sqlite-child.mjs');
let fails = 0;
const check = (name, ok, extra = '') => { if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${extra ? ' | ' + extra : ''}`); };
const throws = (fn) => { try { fn(); return null; } catch (e) { return e.message; } };

const dir = mkdtempSync(join(tmpdir(), 'tr-ddl-'));
const file = join(dir, 'app.db');
const db = new DatabaseSync(file);
db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
check(`spec has 5 sql blocks (001-005)`, blocks.length === 5, `found ${blocks.length}`);
blocks.forEach((b, i) => { const err = throws(() => db.exec(b)); check(`migration block ${i + 1} executes`, !err, err || ''); });

const now = '2026-10-20T07:00:00.000Z';
db.exec(`INSERT INTO suppliers (id, code, name, pickup_address, paypal_merchant_key, created_at) VALUES (1, 'A', 'Supplier A', 'Amman', 'A', '${now}');
INSERT INTO products (id, supplier_id, kind, name, capacity_ml, diameter_mm, created_at) VALUES (1, 1, 'bundle', 'A bundle', 250, 90, '${now}');
INSERT INTO inventory (product_id, supplier_id, on_hand, reserved) VALUES (1, 1, 1, 0);
INSERT INTO inventory_ledger (supplier_id, product_id, reason, delta_on_hand, delta_reserved, on_hand_after, reserved_after, ref_type, actor, at) VALUES (1, 1, 'adjust', 1, 0, 1, 0, 'seed', 'seed', '${now}');
INSERT INTO audit_events (at, actor_role, action, entity_type, outcome) VALUES ('${now}', 'system', 'seed', 'inventory', 'ok');`);
check('RS-38 UPDATE inventory_ledger refused', !!throws(() => db.exec("UPDATE inventory_ledger SET actor='x'")));
check('RS-38 DELETE inventory_ledger refused', !!throws(() => db.exec('DELETE FROM inventory_ledger')));
check('RS-38 UPDATE audit_events refused', !!throws(() => db.exec("UPDATE audit_events SET action='x'")));
check('RS-38 DELETE audit_events refused', !!throws(() => db.exec('DELETE FROM audit_events')));
check('CHECK reserved <= on_hand', !!throws(() => db.exec('UPDATE inventory SET reserved = 2 WHERE product_id = 1')));
db.exec(`INSERT INTO webhook_events (provider, transmission_id, merchant_key, signature_status, outcome, payload_sha256, received_at) VALUES ('fake','t1','A','invalid','rejected','x','${now}');
INSERT INTO webhook_events (provider, transmission_id, merchant_key, signature_status, outcome, payload_sha256, received_at) VALUES ('fake','t1','A','invalid','rejected','x','${now}');`);
check('RS-23/24 forged (invalid) rows do not occupy the transmission id', !throws(() => db.exec(`INSERT INTO webhook_events (provider, transmission_id, merchant_key, signature_status, outcome, payload_sha256, received_at) VALUES ('fake','t1','A','valid','applied','x','${now}')`)));
check('RS-23 second valid row with the same transmission id refused', !!throws(() => db.exec(`INSERT INTO webhook_events (provider, transmission_id, merchant_key, signature_status, outcome, payload_sha256, received_at) VALUES ('fake','t1','A','valid','duplicate','x','${now}')`)));
// reservation row for the expiry race (FK chain: request -> run -> version -> reservation)
db.exec(`INSERT INTO users (id, username, password_hash, role, display_name, created_at) VALUES (1, 'cafe1', 'h', 'customer', 'Cafe', '${now}');
INSERT INTO rescue_requests (id, customer_id, raw_text, language, intake_status, created_at) VALUES (1, 1, 'x', 'en', 'confirmed', '${now}');
INSERT INTO planning_runs (id, request_id, requirements_version, feasible, trace_json, rejections_json, offers_hash, created_at) VALUES (1, 1, 1, 1, '{}', '[]', 'h', '${now}');
INSERT INTO plan_versions (id, request_id, planning_run_id, version, status, plan_json, plan_hash, total_cents, pickup_count, ready_at, created_at, updated_at) VALUES (1, 1, 1, 1, 'approved', '{}', '${'a'.repeat(64)}', 8400, 2, '${now}', '${now}', '${now}');
INSERT INTO reservations (id, plan_version_id, customer_id, operation_key, status, expires_at, created_at) VALUES (1, 1, 1, 'res:1:k', 'active', '2026-10-20T07:30:00.000Z', '${now}');`);
check('provider_calls operation_key GLOB accepts so:<id>:capture:1', !throws(() => db.exec(`INSERT INTO supplier_orders (id, plan_version_id, supplier_id, reservation_id, lines_json, subtotal_cents, prep_fee_cents, tax_cents, total_cents, fulfilment_status, created_at) VALUES (1, 1, 1, 1, '[]', 3000, 1000, 0, 4000, 'confirmed', '${now}');
INSERT INTO payment_operations (id, supplier_order_id, status, provider, merchant_key, amount_cents, currency, created_at, updated_at) VALUES (1, 1, 'authorized', 'fake', 'A', 4000, 'USD', '${now}', '${now}');
INSERT INTO provider_calls (payment_operation_id, kind, attempt, operation_key, status, created_at) VALUES (1, 'capture', 1, 'so:1:capture:1', 'intent', '${now}')`)));
check('provider_calls UNIQUE key refuses a second so:1:capture:1', !!throws(() => db.exec(`INSERT INTO provider_calls (payment_operation_id, kind, attempt, operation_key, status, created_at) VALUES (1, 'capture', 1, 'so:1:capture:1', 'intent', '${now}')`)));
check("payment_operations 'unknown' requires prev_status and unknown_since", !!throws(() => db.exec("UPDATE payment_operations SET status='unknown' WHERE id=1")));
db.close();

// offsets: per-process start delay in ms (the lock holder must start first in the busy_timeout 0 case)
const runPair = (bt, modes, offsets = []) => new Promise((res) => {
  const startAt = Date.now() + 400; const outs = []; let n = 0;
  modes.forEach((m, i) => {
    const p = spawn(process.execPath, [...process.execArgv, child, file, String(bt), m, String(startAt + (offsets[i] || 0))]);
    let o = ''; p.stdout.on('data', (x) => (o += x)); p.stderr.on('data', () => {});
    p.on('close', () => { outs.push(o.trim()); if (++n === modes.length) res(outs.sort()); });
  });
});
const r1 = await runPair(5000, ['reserve', 'reserve']);
const d2 = new DatabaseSync(file);
const inv = d2.prepare('SELECT on_hand, reserved FROM inventory WHERE product_id = 1').get();
const resRows = d2.prepare("SELECT count(*) AS n FROM inventory_ledger WHERE reason = 'reserve'").get().n;
d2.close();
check('RS-14 two processes, busy_timeout 5000: one RESERVED, one OUT_OF_STOCK', r1.join(',') === 'OUT_OF_STOCK,RESERVED', r1.join(' | ') + ` final ${JSON.stringify(inv)} reserveRows=${resRows}`);
check('RS-14 reserved <= on_hand after the race', inv.reserved <= inv.on_hand && inv.reserved === 1 && resRows === 1);
const r2 = await runPair(5000, ['expire', 'expire']);
const d3 = new DatabaseSync(file);
const exp = d3.prepare("SELECT count(*) AS n FROM inventory_ledger WHERE reason = 'expire'").get().n;
d3.close();
check('RS-15 two concurrent expiry passes: exactly one EXPIRED, one NOOP, one expire ledger row', r2.join(',') === 'EXPIRED,NOOP' && exp === 1, r2.join(' | ') + ` expireRows=${exp}`);
const r3 = await runPair(0, ['hold', 'reserve'], [0, 500]);
check('RS-14 busy_timeout 0 vs held BEGIN IMMEDIATE: SQLITE_BUSY surfaces (to be mapped to 503 DB_BUSY)', r3.some((x) => /ERROR .*(locked|busy)/i.test(x)) && r3.includes('HELD'), r3.join(' | '));
console.log(`node ${process.version}; failures: ${fails}`);
process.exit(fails ? 1 : 0);
