// Security review reproduction (security-reviewer): executes the design spec's own tables, statements
// and rules (spec.md sha256 ea9c0c68...) in an in-memory SQLite database to trace three attack paths.
// This models the SPEC, not an implementation (none exists at the design gate).
//   H1  Idempotency scope (user id, route template, key) + body hash of `{}`: a key reused on another plan
//       replays the first plan's reservation instead of 422 IDEMPOTENCY_KEY_REUSED.
//   H2  Sign-in throttle: >= 5 failures per username in 15 min refuses BEFORE the password check, so an
//       anonymous caller with 5 wrong guesses locks the admin out, from any IP.
//   H6  Reservation: one customer reserves every seeded bundle (on_hand = 1); nothing caps live reservations
//       per customer; another customer's reserve fails OUT_OF_STOCK for the 30-minute TTL.
// Exit 1 when all three paths reproduce (the expected outcome), 0 otherwise.
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';

const db = new DatabaseSync(':memory:');
const sha = (s) => createHash('sha256').update(s).digest('hex');
const canonical = (o) => JSON.stringify(o, Object.keys(o).sort());
const now = Date.parse('2026-10-20T06:00:00.000Z');
const iso = (ms) => new Date(ms).toISOString();
const results = {};

// ---- H1 (spec 004_payments.sql idempotency_keys + Conventions › Idempotency) ----------------------
db.exec(`CREATE TABLE idempotency_keys (
  user_id INTEGER NOT NULL, route TEXT NOT NULL, key TEXT NOT NULL, body_sha256 TEXT NOT NULL,
  status_code INTEGER NOT NULL, response_json TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY (user_id, route, key));`);
const ROUTE = 'POST /api/plans/:id/reserve'; // "route template"
function reserve(userId, planId, key, body = {}) {
  const h = sha(canonical(body));
  const row = db.prepare('SELECT * FROM idempotency_keys WHERE user_id = ? AND route = ? AND key = ?').get(userId, ROUTE, key);
  if (row) {
    if (row.body_sha256 !== h) return { status: 422, code: 'IDEMPOTENCY_KEY_REUSED' };
    return { status: row.status_code, replayed: true, body: JSON.parse(row.response_json) };
  }
  const resp = { reservation: { id: 100 + planId, planVersionId: planId, status: 'active' } };
  db.prepare('INSERT INTO idempotency_keys VALUES (?,?,?,?,?,?,?)').run(userId, ROUTE, key, h, 201, JSON.stringify(resp), iso(now));
  return { status: 201, body: resp };
}
{
  const key = 'k-0123456789abcdef';
  const a = reserve(7, 7, key);
  const b = reserve(7, 9, key); // same customer, same key, DIFFERENT plan (path :id)
  console.log('H1 reserve plan 7:', JSON.stringify(a));
  console.log('H1 reserve plan 9 with the same key:', JSON.stringify(b));
  results.H1 = b.status === 201 && b.replayed === true && b.body.reservation.planVersionId === 7;
  console.log('H1 plan 9 answered with plan 7\'s reservation (no 422):', results.H1);
}

// ---- H2 (spec 001_core.sql login_failures + Authentication › Throttle) -----------------------------
db.exec(`CREATE TABLE login_failures (id INTEGER PRIMARY KEY, username_key TEXT NOT NULL, ip TEXT NOT NULL, at TEXT NOT NULL);
CREATE INDEX login_failures_user ON login_failures(username_key, at);
CREATE INDEX login_failures_ip ON login_failures(ip, at);`);
const ADMIN_PASSWORD = 'correct-horse-battery-staple-42'; // >= 16 chars
function signin(username, password, ip, t) {
  const since = iso(t - 15 * 60 * 1000);
  const u = db.prepare('SELECT count(*) AS n FROM login_failures WHERE username_key = ? AND at > ?').get(username, since).n;
  const i = db.prepare('SELECT count(*) AS n FROM login_failures WHERE ip = ? AND at > ?').get(ip, since).n;
  if (u >= 5 || i >= 20) return { status: 429, code: 'RATE_LIMITED' }; // refused BEFORE the password check
  if (username === 'admin' && password === ADMIN_PASSWORD) {
    db.prepare('DELETE FROM login_failures WHERE username_key = ?').run(username);
    return { status: 200 };
  }
  db.prepare('INSERT INTO login_failures (username_key, ip, at) VALUES (?,?,?)').run(username, ip, iso(t));
  return { status: 401, code: 'INVALID_CREDENTIALS' };
}
{
  const attacks = [];
  for (let k = 0; k < 5; k++) attacks.push(signin('admin', 'wrong-' + k, '203.0.113.9', now + k * 1000).status);
  const legit = signin('admin', ADMIN_PASSWORD, '198.51.100.20', now + 10_000);
  // attacker repeats 5 guesses every 15 minutes: admin stays locked
  const later = [];
  for (let k = 0; k < 5; k++) signin('admin', 'w' + k, '203.0.113.9', now + 15 * 60 * 1000 + k * 1000);
  later.push(signin('admin', ADMIN_PASSWORD, '198.51.100.20', now + 16 * 60 * 1000).status);
  console.log('H2 attacker (1 IP, 5 requests):', attacks.join(','), '| real admin, other IP, correct password:', JSON.stringify(legit), '| after the next 5-guess cycle:', later.join(','));
  results.H2 = attacks.every((s) => s === 401) && legit.status === 429 && later[0] === 429;
  console.log('H2 admin locked out by 5 anonymous requests per 15 min:', results.H2);
}

// ---- H6 (spec 001_core.sql inventory + Background › Reservation step 3; seed on_hand = 1) ----------
db.exec(`CREATE TABLE inventory (product_id INTEGER PRIMARY KEY, supplier_id INTEGER NOT NULL, on_hand INTEGER NOT NULL CHECK (on_hand >= 0),
  reserved INTEGER NOT NULL DEFAULT 0 CHECK (reserved >= 0), version INTEGER NOT NULL DEFAULT 1, CHECK (reserved <= on_hand));
CREATE TABLE reservations (id INTEGER PRIMARY KEY, customer_id INTEGER NOT NULL, status TEXT NOT NULL, expires_at TEXT NOT NULL);`);
for (let p = 1; p <= 5; p++) db.prepare('INSERT INTO inventory (product_id, supplier_id, on_hand) VALUES (?,?,1)').run(p, p);
const upd = db.prepare('UPDATE inventory SET reserved = reserved + ?, version = version + 1 WHERE product_id = ? AND reserved + ? <= on_hand');
function reserveItems(customerId, productIds) {
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const p of productIds) if (upd.run(1, p, 1).changes === 0) throw Object.assign(new Error('OUT_OF_STOCK'), { code: 'OUT_OF_STOCK' });
    db.prepare('INSERT INTO reservations (customer_id, status, expires_at) VALUES (?,?,?)').run(customerId, 'active', iso(now + 30 * 60 * 1000));
    db.exec('COMMIT');
    return { status: 201 };
  } catch (e) { db.exec('ROLLBACK'); return { status: 409, code: e.code }; }
}
{
  // attacker: self-registered customer 666 runs five requests (manual confirm, no model call, no payment)
  const hoard = [1, 2, 3, 4, 5].map((p) => reserveItems(666, [p]).status);
  const victim = reserveItems(1, [1, 2]);
  const live = db.prepare("SELECT count(*) AS n FROM reservations WHERE customer_id = 666 AND status = 'active'").get().n;
  console.log('H6 attacker reserves each supplier bundle:', hoard.join(','), '| live reservations held:', live, '| victim reserve:', JSON.stringify(victim));
  results.H6 = hoard.every((s) => s === 201) && victim.code === 'OUT_OF_STOCK';
  console.log('H6 one customer holds all seeded stock; others get OUT_OF_STOCK:', results.H6);
}

const all = Object.values(results).every(Boolean);
console.log('\nreproduced:', JSON.stringify(results), all ? '(all three paths reproduce)' : '');
process.exit(all ? 1 : 0);
