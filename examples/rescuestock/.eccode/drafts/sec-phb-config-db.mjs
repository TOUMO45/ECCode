// Security probe, phase B: config allow-lists and secrets, log redaction, database triggers,
// migrations, transactions and file modes (security-reviewer).
// Usage: node --disable-warning=ExperimentalWarning .eccode/drafts/sec-phb-config-db.mjs
// Lines starting "REPRO" are reproductions of a finding (they do not fail the run);
// "FAIL" lines are broken expectations (exit 1).
import { inspect, format } from 'node:util';
import { mkdtempSync, mkdirSync, statSync, chmodSync, cpSync, appendFileSync, readdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const ROOT = resolve(process.argv[1], '../../..');
const imp = (p) => import(join(ROOT, p));
const { loadConfig, ConfigError, Secret, buildLabels } = await imp('src/config.js');
const { createLogger } = await imp('src/log.js');
const { openDb } = await imp('src/db/connection.js');
const { migrate, MIGRATIONS_DIR } = await imp('src/db/migrate.js');
const { startApp } = await imp('src/main.js');

const LS = String.fromCharCode(0x2028);
const NEL = String.fromCharCode(0x85);
const ESC = String.fromCharCode(0x1b);
const CONTROL = new RegExp(`[${String.fromCharCode(0)}-${String.fromCharCode(0x1f)}${String.fromCharCode(0x7f)}-${String.fromCharCode(0x9f)}${LS}${String.fromCharCode(0x2029)}]`);

const failures = [];
const expect = (cond, label, info = '') => {
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${label}${info ? ` | ${info}` : ''}`);
  if (!cond) failures.push(label);
};
const repro = (cond, label, info = '') => console.log(`${cond ? 'REPRO' : 'no-repro'} ${label}${info ? ` | ${info}` : ''}`);
const tryLoad = (env) => {
  try { return { config: loadConfig(env) }; } catch (e) { return { error: e }; }
};

console.log('# A. Placeholder refusal and length rules (SEC-5); errors never echo the value');
const SECRET_VARS = ['ANTHROPIC_API_KEY', 'RS_ADMIN_PASSWORD', 'RS_DEMO_PASSWORD', 'RS_FAKE_WEBHOOK_SECRET',
  ...['A', 'B', 'C', 'D', 'E', 'DEFAULT'].flatMap((k) => [`RS_PAYPAL_${k}_CLIENT_ID`, `RS_PAYPAL_${k}_CLIENT_SECRET`, `RS_PAYPAL_${k}_WEBHOOK_ID`])];
let placeholderMisses = 0;
for (const name of SECRET_VARS) {
  for (const v of ['<placeholder>', '  <your-real-key-here-1234567890-abcdefghijk>  ', 'changeme', 'PassWord']) {
    const { error } = tryLoad({ [name]: v, RS_MODEL_PROVIDER: 'fake' });
    const ok = error instanceof ConfigError && error.variables.includes(name) && !error.message.includes(v.trim()) && !JSON.stringify(error.problems).includes(v.trim());
    if (!ok) { placeholderMisses += 1; expect(false, `${name}=${JSON.stringify(v)} refused without echo`, error ? error.message : 'accepted'); }
  }
}
expect(placeholderMisses === 0, `placeholder values refused for all ${SECRET_VARS.length} secret variables x 4 shapes, and the error names only the variable`);
{
  const v = 'Sup3r-Secret-15';
  const { error } = tryLoad({ RS_ADMIN_PASSWORD: v });
  expect(error && !error.message.includes(v) && error.message.includes('RS_ADMIN_PASSWORD'), 'RS_ADMIN_PASSWORD of 15 chars refused, value not in the message', error?.message);
  const d = tryLoad({ RS_DEMO_PASSWORD: 'elevenchars' });
  expect(d.error && d.error.message.includes('RS_DEMO_PASSWORD'), 'RS_DEMO_PASSWORD of 11 chars refused');
  const w31 = tryLoad({ RS_FAKE_WEBHOOK_SECRET: 'x'.repeat(31) });
  const w32 = tryLoad({ RS_FAKE_WEBHOOK_SECRET: 'x'.repeat(32) });
  expect(w31.error && w32.config, 'RS_FAKE_WEBHOOK_SECRET: 31 bytes refused, 32 accepted');
  const port = tryLoad({ PORT: 'my-secret-port' });
  expect(port.error && !port.error.message.includes('my-secret-port'), 'non-secret refusal does not echo the value either');
  const ws = tryLoad({ RS_ADMIN_PASSWORD: ' '.repeat(16) });
  const rep = tryLoad({ RS_ADMIN_PASSWORD: 'a'.repeat(16) });
  console.log(`info RS_ADMIN_PASSWORD of 16 spaces: ${ws.config ? 'accepted' : 'refused'}; 16 x "a": ${rep.config ? 'accepted' : 'refused'} (no strength rule beyond length; operator-chosen)`);
}

console.log('# B. Secret wrapper redaction');
{
  const value = 'sk-live-REALSECRET-0123456789abcdef';
  const { config } = tryLoad({ ANTHROPIC_API_KEY: value, RS_ADMIN_PASSWORD: `${value}-admin`, RS_PAYPAL_DEFAULT_CLIENT_ID: `${value}-id`, RS_PAYPAL_DEFAULT_CLIENT_SECRET: `${value}-sec`, RS_PAYMENT_PROVIDER: 'paypal-sandbox' });
  const s = config.anthropicApiKey;
  const renderings = {
    json: JSON.stringify(config),
    inspect: inspect(config, { depth: 20, showHidden: true }),
    inspectNoCustom: inspect(config, { depth: 20, customInspect: false, showHidden: true }),
    format: format('%s %o %O %j', s, s, config, config),
    template: `${s}`,
    concat: s + '',
    string: String(s),
    keys: Object.keys(s).join(','),
    entries: JSON.stringify(Object.entries(s)),
    structured: JSON.stringify(structuredClone({ s: config.paypal })),
    labels: JSON.stringify(buildLabels(config)),
    errorCause: inspect(new Error('x', { cause: config })),
  };
  for (const [how, text] of Object.entries(renderings)) {
    expect(!text.includes('REALSECRET'), `secret not revealed through ${how}`, text.length > 120 ? `${text.length} chars` : text);
  }
  expect(s.reveal() === value && Object.isFrozen(s), 'reveal() returns the value; the wrapper is frozen');
  let replaced = false;
  try { s.reveal = () => 'x'; replaced = s.reveal() === 'x'; } catch { replaced = false; }
  expect(!replaced, 'reveal cannot be replaced on the frozen instance');
}

console.log('# C. Outbound base-URL allow-lists (SEC-3, SEC-19) and other guards');
for (const name of ['RS_PAYPAL_BASE_URL', 'RS_ANTHROPIC_BASE_URL']) {
  const live = name === 'RS_PAYPAL_BASE_URL' ? 'https://api-m.sandbox.paypal.com' : 'https://api.anthropic.com';
  const host = new URL(live).host;
  const cases = [
    [live, false, true], [`${live}/`, false, true], [`${live}//`, false, false], [`https://${host}.evil.example`, false, false],
    [`https://${host}@evil.example`, false, false], [`https://evil.example/${host}`, false, false], [`https://${host.toUpperCase()}`, false, false],
    [`https://${host}:443`, false, false], [`http://${host}`, false, false], ['https://api-m.paypal.com', false, false],
    ['http://127.0.0.1:8080', false, false], ['http://localhost:8080', false, false], ['http://127.0.0.1:8080', true, true],
    ['http://localhost:8080/', true, true], ['http://127.0.0.1:8080/path', true, false], ['http://localhost.evil.example:80', true, false],
    ['http://127.0.0.1:0', true, false], ['http://[::1]:8080', true, false], ['http://127.0.0.2:8080', true, false], ['http://127.0.0.1:99999', true, false],
    ['https://127.0.0.1:8080', true, false],
  ];
  for (const [value, offline, accepted] of cases) {
    const r = tryLoad({ [name]: value, RS_TEST_OFFLINE: offline ? '1' : '0' });
    expect(Boolean(r.config) === accepted, `${name}=${value}${offline ? ' (RS_TEST_OFFLINE=1)' : ''} ${accepted ? 'accepted' : 'refused'}`);
  }
}
{
  const t = tryLoad({ RS_TEST_OFFLINE: '1', RS_PAYPAL_BASE_URL: 'http://127.0.0.1:9' }).config;
  expect(t && t.testMode === true && buildLabels(t).testMode === true, 'loopback accepted only together with testMode/labels.testMode');
  const rows = [
    [{ RS_REGISTER_PER_IP_PER_HOUR: '5' }, true], [{ RS_REGISTER_PER_IP_PER_HOUR: '6' }, false], [{ RS_REGISTER_PER_IP_PER_HOUR: '0' }, false],
    [{ RS_REGISTER_PER_IP_PER_HOUR: '1000', RS_TEST_OFFLINE: '1' }, true],
    [{ RS_PAYPAL_TIMEOUT_MS: '20000', RS_SAGA_LEASE_MS: '60000' }, true], [{ RS_PAYPAL_TIMEOUT_MS: '20001' }, false], [{ RS_SAGA_LEASE_MS: '59999' }, false],
    [{ RS_TEST_HOOKS: '1' }, true], [{ RS_TEST_HOOKS: '1', RS_PAYMENT_PROVIDER: 'paypal-sandbox', RS_PAYPAL_DEFAULT_CLIENT_ID: 'id-123456', RS_PAYPAL_DEFAULT_CLIENT_SECRET: 'sec-123456' }, false],
    [{ RS_PAYMENT_PROVIDER: 'paypal-live' }, false], [{ RS_FAKE_APPROVAL_HOST: '0.0.0.0' }, false], [{ RS_FAKE_APPROVAL_HOST: 'localhost' }, false],
    [{ RS_FAKE_APPROVAL_HOST: 'localhost', RS_TEST_OFFLINE: '1' }, true], [{ RS_PUBLIC_URL: 'https://user:pw@demo.example' }, false],
    [{ RS_PUBLIC_URL: 'https://demo.example/path' }, false], [{ RS_PUBLIC_URL: 'javascript:alert(1)' }, false], [{ RS_ALLOWED_HOSTS: 'a.example, evil example' }, false],
    [{ RS_TEST_OFFLINE: 'true' }, false], [{ HOST: '0.0.0.0' }, true],
  ];
  for (const [env, accepted] of rows) {
    const r = tryLoad(env);
    expect(Boolean(r.config) === accepted, `${JSON.stringify(env)} ${accepted ? 'accepted' : 'refused'}`, r.error ? r.error.message.slice(0, 140) : '');
  }
  const off = tryLoad({ RS_TEST_OFFLINE: '1', RS_MODEL_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'k-1234567890' }).config;
  expect(off.extractionProvider === 'fake', 'RS_TEST_OFFLINE=1 forces the fake extraction provider');
}

console.log('# D. Log allow-list, truncation and control characters');
{
  const out = [];
  const log = createLogger({ write: (l) => out.push(l) });
  const secret = new Secret('LOGSECRET-123');
  log.info(`line1\nline2${LS}{"level":"forged"}`, {
    password: 'LOGSECRET-pw', body: { text: 'LOGSECRET-body' }, authorization: 'Bearer LOGSECRET', code: secret, kind: `a\r\nb${NEL}c${ESC}[31m`,
    route: 'x'.repeat(500), userId: 7, counts: { ok: 1, nested: { LOGSECRET: 1 }, ['k\nnewline']: 2 }, requestId: 'bad id\n', status: Infinity,
    providerStatus: ['LOGSECRET-arr'], operationKey: () => 'LOGSECRET-fn',
  });
  const child = log.child('aaaaaaaa"}\n');
  child.warn('x', { requestRef: 'LOGSECRET'.padEnd(200, '!') });
  expect(out.length === 2 && out.every((l) => l.indexOf('\n') === l.length - 1), 'two events -> exactly two physical lines');
  const first = JSON.parse(out[0]);
  console.log(`info first line: ${out[0].trim()}`);
  expect(!out[0].includes('LOGSECRET-pw') && !out[0].includes('LOGSECRET-body') && !out[0].includes('Bearer') && !out[0].includes('LOGSECRET-123') && !out[0].includes('LOGSECRET-arr') && !out[0].includes('LOGSECRET-fn'),
    'keys outside the allow-list, Secret objects, arrays and functions never reach the line');
  expect(!CONTROL.test(first.msg + first.kind), 'control characters (C0, C1, U+2028) stripped from msg and values');
  expect(Array.from(first.route).length === 120, 'string values truncated to 120 characters');
  expect(!('status' in first) && first.requestId !== 'bad id\n', 'non-finite numbers dropped; a malformed requestId falls back');
  const second = JSON.parse(out[1]);
  console.log(`info truncated requestRef (a value an allow-listed key could carry): ${second.requestRef.length} chars kept`);
}

console.log('# E. Database: append-only triggers, partial UNIQUE indexes, transactions');
const work = mkdtempSync(join(tmpdir(), 'sec-phb-db-'));
{
  const db = openDb(join(work, 'probe.db'));
  migrate(db);
  const pragmas = ['journal_mode', 'foreign_keys', 'busy_timeout', 'synchronous', 'recursive_triggers', 'trusted_schema']
    .map((p) => `${p}=${Object.values(db.prepare(`PRAGMA ${p}`).get())[0]}`);
  console.log(`info connection PRAGMAs: ${pragmas.join(' ')}`);
  db.prepare("INSERT INTO audit_events (at, actor_user_id, actor_role, action, entity_type, entity_id, outcome, detail_json, request_id) VALUES ('2026-10-09T00:00:00.000Z', NULL, 'system', 'original.action', 'seed', NULL, 'ok', '{}', NULL)").run();
  const auditId = db.prepare('SELECT max(id) AS id FROM audit_events').get().id;
  const attempt = (label, sql, ...args) => {
    try { db.prepare(sql).run(...args); return `${label}: ALLOWED`; } catch (e) { return `${label}: refused (${String(e.message).slice(0, 60)})`; }
  };
  const u = attempt('UPDATE audit_events', 'UPDATE audit_events SET action = ? WHERE id = ?', 'tampered', auditId);
  const d = attempt('DELETE audit_events', 'DELETE FROM audit_events WHERE id = ?', auditId);
  const up = attempt('UPSERT DO UPDATE audit_events', "INSERT INTO audit_events (id, at, actor_role, action, entity_type, outcome, detail_json) VALUES (?, 'x', 'system', 'upsert', 'seed', 'ok', '{}') ON CONFLICT(id) DO UPDATE SET action = 'upsert-tampered'", auditId);
  expect(u.includes('refused') && d.includes('refused') && up.includes('refused'), 'audit_events refuses UPDATE, DELETE and UPSERT-update', [u, d, up].join('; '));
  const rep = attempt('INSERT OR REPLACE audit_events', "INSERT OR REPLACE INTO audit_events (id, at, actor_user_id, actor_role, action, entity_type, entity_id, outcome, detail_json, request_id) VALUES (?, '2026-10-09T00:00:00.000Z', NULL, 'system', 'REWRITTEN', 'seed', NULL, 'ok', '{}', NULL)", auditId);
  const after = db.prepare('SELECT action FROM audit_events WHERE id = ?').get(auditId);
  repro(rep.includes('ALLOWED') && after.action === 'REWRITTEN', 'INSERT OR REPLACE rewrites an existing audit_events row (the DELETE trigger does not fire: recursive_triggers is off)', `${rep}; row ${auditId} action now "${after.action}"`);
  const rep1 = attempt('REPLACE INTO audit_events', "REPLACE INTO audit_events (id, at, actor_role, action, entity_type, outcome) VALUES (?, 'x', 'system', 'REWRITTEN-B', 'seed', 'ok')", auditId);
  repro(rep1.includes('ALLOWED'), 'plain REPLACE INTO also rewrites the audit row', rep1);

  db.prepare("INSERT INTO suppliers (code, name, pickup_address, paypal_merchant_key, demo, created_at) VALUES ('A', 'S', 'P', 'A', 1, 'x')").run();
  const sid = db.prepare("SELECT id FROM suppliers WHERE code = 'A'").get().id;
  db.prepare("INSERT INTO products (supplier_id, kind, name, capacity_ml, diameter_mm, material, demo, created_at) VALUES (?, 'bundle', 'B', 250, 90, 'paper', 1, 'x')").run(sid);
  const pid = db.prepare('SELECT max(id) AS id FROM products').get().id;
  db.prepare("INSERT INTO inventory_ledger (supplier_id, product_id, reason, delta_on_hand, delta_reserved, on_hand_after, reserved_after, ref_type, ref_id, actor, request_id, at) VALUES (?, ?, 'adjust', 1, 0, 1, 0, 'seed', NULL, 'seed', NULL, 'x')").run(sid, pid);
  const lid = db.prepare('SELECT max(id) AS id FROM inventory_ledger').get().id;
  const lu = attempt('UPDATE inventory_ledger', 'UPDATE inventory_ledger SET delta_on_hand = 99 WHERE id = ?', lid);
  const ld = attempt('DELETE inventory_ledger', 'DELETE FROM inventory_ledger WHERE id = ?', lid);
  expect(lu.includes('refused') && ld.includes('refused'), 'inventory_ledger refuses UPDATE and DELETE', `${lu}; ${ld}`);
  const lr = attempt('INSERT OR REPLACE inventory_ledger', "INSERT OR REPLACE INTO inventory_ledger (id, supplier_id, product_id, reason, delta_on_hand, delta_reserved, on_hand_after, reserved_after, ref_type, ref_id, actor, request_id, at) VALUES (?, ?, ?, 'adjust', 500, 0, 500, 0, 'seed', NULL, 'seed', NULL, 'x')", lid, sid, pid);
  const lafter = db.prepare('SELECT delta_on_hand FROM inventory_ledger WHERE id = ?').get(lid);
  repro(lr.includes('ALLOWED') && lafter.delta_on_hand === 500, 'INSERT OR REPLACE rewrites an existing inventory_ledger row', `${lr}; delta_on_hand now ${lafter.delta_on_hand}`);

  // Control: the same REPLACE with recursive_triggers=ON is refused by the existing triggers.
  db.exec('PRAGMA recursive_triggers = ON');
  const rep2 = attempt('INSERT OR REPLACE audit_events with recursive_triggers=ON', "INSERT OR REPLACE INTO audit_events (id, at, actor_user_id, actor_role, action, entity_type, entity_id, outcome, detail_json, request_id) VALUES (?, 'x', NULL, 'system', 'REWRITTEN-2', 'seed', NULL, 'ok', '{}', NULL)", auditId);
  const lr2 = attempt('INSERT OR REPLACE inventory_ledger with recursive_triggers=ON', "INSERT OR REPLACE INTO inventory_ledger (id, supplier_id, product_id, reason, delta_on_hand, delta_reserved, on_hand_after, reserved_after, ref_type, ref_id, actor, request_id, at) VALUES (?, ?, ?, 'adjust', 7, 0, 7, 0, 'seed', NULL, 'seed', NULL, 'x')", lid, sid, pid);
  const fresh = attempt('plain INSERT of a new audit row with recursive_triggers=ON', "INSERT INTO audit_events (at, actor_role, action, entity_type, outcome) VALUES ('x', 'system', 'new', 'seed', 'ok')");
  expect(rep2.includes('refused') && lr2.includes('refused') && fresh.includes('ALLOWED'), 'control: with PRAGMA recursive_triggers=ON both REPLACE rewrites are refused and plain appends still work', `${rep2}; ${lr2}; ${fresh}`);
  db.exec('PRAGMA recursive_triggers = OFF');

  db.prepare("INSERT INTO offers (supplier_id, product_id, price_cents, prep_fee_cents, ready_at, version, status, valid_from, valid_to, demo) VALUES (?, ?, 100, 0, 'x', 1, 'active', 'x', NULL, 1)").run(sid, pid);
  const o2 = attempt('second active offer for one product', "INSERT INTO offers (supplier_id, product_id, price_cents, prep_fee_cents, ready_at, version, status, valid_from, valid_to, demo) VALUES (?, ?, 100, 0, 'x', 2, 'active', 'x', NULL, 1)", sid, pid);
  const neg = attempt('negative price', "INSERT INTO offers (supplier_id, product_id, price_cents, prep_fee_cents, ready_at, version, status, valid_from, valid_to, demo) VALUES (?, ?, -1, 0, 'x', 3, 'replaced', 'x', NULL, 1)", sid, pid);
  expect(o2.includes('refused') && neg.includes('refused'), 'partial UNIQUE offers_one_current and CHECK price_cents >= 0 hold', `${o2}; ${neg}`);

  let nested = 'not refused';
  try { db.tx(() => db.tx(() => 1)); } catch (e) { nested = e.code; }
  let asyncRes = 'not refused';
  try { db.tx(async () => { db.prepare("INSERT INTO meta (key, value) VALUES ('async', 'x')").run(); }); } catch (e) { asyncRes = e.code; }
  const asyncRow = db.prepare("SELECT value FROM meta WHERE key = 'async'").get();
  expect(nested === 'TX_NESTED' && asyncRes === 'TX_ASYNC' && !asyncRow && !db.inTx, 'db.tx refuses nesting and a returned promise, and rolls the synchronous part back', `${nested} ${asyncRes} row=${JSON.stringify(asyncRow)}`);
  db.close();
}

console.log('# F. Migration checksum refusal');
{
  const dir = join(work, 'migrations');
  cpSync(MIGRATIONS_DIR, dir, { recursive: true });
  const db = openDb(join(work, 'mig.db'));
  migrate(db, { dir });
  appendFileSync(join(dir, '001_core.sql'), '\n-- harmless comment\n');
  let code = 'started';
  try { migrate(db, { dir }); } catch (e) { code = e.code; }
  expect(code === 'MIGRATION_CHECKSUM_MISMATCH', 'a changed applied migration (even a comment) refuses startup', code);
  db.close();
}

console.log('# G. File modes (SEC-14)');
{
  const mode = (p) => (existsSync(p) ? (statSync(p).mode & 0o777).toString(8) : 'absent');
  const base = join(work, 'fresh');
  mkdirSync(base);
  process.umask(0o022);
  const env = { PORT: '0', RS_DB_PATH: join(base, 'data', 'app.db'), RS_UPLOAD_DIR: join(base, 'data', 'uploads'), RS_MODEL_PROVIDER: 'fake' };
  const silent = createLogger({ write: () => {} });
  const running = await startApp({ env, log: silent });
  const files = readdirSync(join(base, 'data'));
  const modes = Object.fromEntries([['data/', mode(join(base, 'data'))], ['data/uploads/', mode(join(base, 'data', 'uploads'))], ...files.filter((f) => f.startsWith('app.db')).map((f) => [f, mode(join(base, 'data', f))])]);
  console.log(`info fresh start modes: ${JSON.stringify(modes)}`);
  expect(modes['data/'] === '700' && modes['data/uploads/'] === '700' && modes['app.db'] === '600' && modes['app.db-wal'] === '600' && modes['app.db-shm'] === '600',
    'npm start equivalent: data/ and uploads/ 0700; app.db, -wal and -shm 0600');
  await running.close();

  const pre = join(work, 'pre');
  mkdirSync(join(pre, 'data'), { recursive: true });
  chmodSync(join(pre, 'data'), 0o755);
  process.umask(0o022);
  const running2 = await startApp({ env: { ...env, RS_DB_PATH: join(pre, 'data', 'app.db'), RS_UPLOAD_DIR: join(pre, 'data', 'uploads') }, log: silent });
  console.log(`info pre-existing data/ (0755) stays ${mode(join(pre, 'data'))}; app.db ${mode(join(pre, 'data', 'app.db'))}; uploads ${mode(join(pre, 'data', 'uploads'))}`);
  await running2.close();
  console.log(`info process umask after startApp: ${process.umask().toString(8)}`);
}

rmSync(work, { recursive: true, force: true });
console.log(failures.length === 0 ? '\nALL CONFIG/DB EXPECTATIONS HELD' : `\n${failures.length} FAILED:\n- ${failures.join('\n- ')}`);
process.exitCode = failures.length === 0 ? 0 : 1;
