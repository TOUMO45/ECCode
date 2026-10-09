// Design probe (technical-designer, design rev 2): executes the REVISED rules for F-TR-1/SEC-4 (reserve
// idempotency), SEC-1/SEC-9 (sign-in throttle) and SEC-2 (live-reservation cap, daily request cap) in node:sqlite,
// against the same attack paths the security reviewer modelled in sec-spec-model.mjs (H1, H2, H6).
// This models the spec text of revision 2, not an implementation. Exit 0 when every revised rule blocks its path
// and the legitimate case still works.
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';

const db = new DatabaseSync(':memory:');
const sha = (s) => createHash('sha256').update(s).digest('hex');
const iso = (ms) => new Date(ms).toISOString();
const T0 = Date.parse('2026-10-20T06:00:00.000Z');
const ok = {};

// ---------- F-TR-1 / SEC-4: scope (user, key); fingerprint = sha256(method + concrete path + canonical body);
// reservations.idempotency_key UNIQUE per customer; operation_key = res:<customerId>:<planVersionId>:<key>.
db.exec(`
CREATE TABLE idempotency_keys (user_id INTEGER NOT NULL, key TEXT NOT NULL, fingerprint TEXT NOT NULL, status_code INTEGER NOT NULL,
  response_json TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY (user_id, key));
CREATE TABLE reservations (id INTEGER PRIMARY KEY, plan_version_id INTEGER NOT NULL, customer_id INTEGER NOT NULL,
  idempotency_key TEXT NOT NULL, operation_key TEXT NOT NULL UNIQUE, status TEXT NOT NULL, UNIQUE (customer_id, idempotency_key));
CREATE TABLE inventory_ledger (id INTEGER PRIMARY KEY, ref_id INTEGER);
CREATE TABLE supplier_orders (id INTEGER PRIMARY KEY, reservation_id INTEGER);`);
const counts = () => ['reservations', 'inventory_ledger', 'supplier_orders'].map((t) => db.prepare(`SELECT count(*) AS n FROM ${t}`).get().n).join('/');
function reserve(user, plan, key, { purged = false, cap = 1 } = {}) {
  const fp = sha('POST /api/plans/' + plan + '/reserve' + '{}');
  db.exec('BEGIN IMMEDIATE');
  try {
    const row = purged ? null : db.prepare('SELECT * FROM idempotency_keys WHERE user_id = ? AND key = ?').get(user, key);
    if (row) { db.exec('COMMIT'); return row.fingerprint === fp ? { status: row.status_code, replayed: true } : { status: 422, code: 'IDEMPOTENCY_KEY_REUSED' }; }
    const prior = db.prepare('SELECT * FROM reservations WHERE customer_id = ? AND idempotency_key = ?').get(user, key);
    if (prior) { db.exec('COMMIT'); return prior.plan_version_id === plan ? { status: 200, replayed: true, via: 'reservation row' } : { status: 422, code: 'IDEMPOTENCY_KEY_REUSED', via: 'reservation row' }; }
    const live = db.prepare("SELECT count(*) AS n FROM reservations WHERE customer_id = ? AND status = 'active'").get(user).n;
    if (live >= cap) { db.exec('ROLLBACK'); return { status: 409, code: 'RESERVATION_LIMIT' }; }
    const r = db.prepare("INSERT INTO reservations (plan_version_id, customer_id, idempotency_key, operation_key, status) VALUES (?,?,?,?, 'active')")
      .run(plan, user, key, `res:${user}:${plan}:${key}`);
    db.prepare('INSERT INTO inventory_ledger (ref_id) VALUES (?)').run(r.lastInsertRowid);
    db.prepare('INSERT INTO supplier_orders (reservation_id) VALUES (?)').run(r.lastInsertRowid);
    db.prepare('INSERT INTO idempotency_keys VALUES (?,?,?,?,?,?)').run(user, key, fp, 201, '{}', iso(T0));
    db.exec('COMMIT');
    return { status: 201 };
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}
{
  const k = 'k-0123456789abcdef';
  const a = reserve(7, 7, k, { cap: 5 });
  const before = counts();
  const b = reserve(7, 9, k, { cap: 5 });
  const after = counts();
  const c = reserve(7, 7, k, { cap: 5 });
  const d = reserve(7, 9, k, { purged: true, cap: 5 });
  console.log('F-TR-1 plan 7:', JSON.stringify(a), '| same key on plan 9:', JSON.stringify(b), `| rows before/after ${before} -> ${after}`,
    '| replay plan 7:', JSON.stringify(c), '| plan 9 after key purge:', JSON.stringify(d));
  ok.FTR1 = a.status === 201 && b.status === 422 && before === after && c.replayed === true && d.status === 422;
}

// ---------- SEC-2: live-reservation cap 1 per customer ----------
{
  const atk = 50;
  const results = [1, 2, 3, 4, 5].map((s) => reserve(atk, 100 + s, 'atk-key-000000000' + s, { cap: 1 }).status);
  const victim = reserve(51, 200, 'victim-key-0000000', { cap: 1 }).status;
  console.log('SEC-2 attacker reserves 5 plans:', results.join(','), '| victim reserve:', victim);
  ok.SEC2 = results.join(',') === '201,409,409,409,409' && victim === 201;
}

// ---------- SEC-1 / SEC-9: throttle ----------
db.exec(`CREATE TABLE login_failures (id INTEGER PRIMARY KEY, username_key TEXT NOT NULL, ip TEXT NOT NULL, at TEXT NOT NULL);`);
const ADMIN = 'correct-horse-battery-staple-42';
const norm = (u) => String(u).trim().normalize('NFC').toLowerCase();
function signin(username, password, ip, t) {
  const key = norm(username);
  const since = iso(t - 15 * 60 * 1000);
  const pair = db.prepare('SELECT count(*) AS n FROM login_failures WHERE username_key = ? AND ip = ? AND at > ?').get(key, ip, since).n;
  const perIp = db.prepare('SELECT count(*) AS n FROM login_failures WHERE ip = ? AND at > ?').get(ip, since).n;
  if (pair >= 5 || perIp >= 20) return { status: 429, code: 'RATE_LIMITED' };
  const perUser = db.prepare('SELECT count(*) AS n FROM login_failures WHERE username_key = ? AND at > ?').get(key, since).n;
  const delayMs = perUser >= 10 ? Math.min(10000, 1000 * (perUser - 9)) : 0; // delay, never a refusal, across IPs
  if (key === 'admin' && password === ADMIN) return { status: 200, delayMs };
  db.prepare('INSERT INTO login_failures (username_key, ip, at) VALUES (?,?,?)').run(key, ip, iso(t));
  return { status: 401, code: 'INVALID_CREDENTIALS', delayMs };
}
{
  const atk = [1, 2, 3, 4, 5].map((i) => signin(i % 2 ? 'admin' : 'ADMIN ', 'guess' + i, '203.0.113.9', T0 + i).status);
  const sixth = signin('Admin', 'guess6', '203.0.113.9', T0 + 6);
  const real = signin('admin', ADMIN, '198.51.100.7', T0 + 7);
  // distributed attacker: 15 more failures from 3 other IPs (5 each), then the real admin again
  for (let n = 0; n < 15; n++) signin('admin', 'x' + n, '192.0.2.' + (n % 3), T0 + 10 + n);
  const real2 = signin('admin', ADMIN, '198.51.100.7', T0 + 40);
  const unknownUser = [1, 2, 3, 4, 5].map((i) => signin('nobody', 'g' + i, '203.0.113.10', T0 + 50 + i).status).join(',');
  const unknown6 = signin('nobody', 'g6', '203.0.113.10', T0 + 60).status;
  console.log('SEC-1 attacker (1 IP, case variants):', atk.join(','), '| 6th same IP:', sixth.status,
    '| real admin other IP:', JSON.stringify(real), '| after 20 failures from 4 IPs:', JSON.stringify(real2),
    '| unknown user 5x then 6th:', unknownUser, unknown6);
  ok.SEC1 = atk.join(',') === '401,401,401,401,401' && sixth.status === 429 && real.status === 200 && real2.status === 200 &&
    real2.delayMs > 0 && real2.delayMs <= 10000 && unknown6 === 429;
}
console.log(JSON.stringify(ok));
process.exit(Object.values(ok).every(Boolean) ? 0 : 1);
