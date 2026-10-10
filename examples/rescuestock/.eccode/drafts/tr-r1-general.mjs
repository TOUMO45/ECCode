// technical-reviewer probe (rework-1, SEC-C-3 / TR-C-2), independent of the engineer's tests. In-process harness.
//   G1 a signed-in customer: 300 counted calls in one window pass, the 301st gets 429 RATE_LIMITED general + Retry-After;
//      the refusal writes no row; after the window the next call passes
//   G2 public routes (health, config, auth/session, auth/csrf) called by a signed-in user are not counted; anonymous
//      401s write no general row
//   G3 position: at the limit, a wrong-role call and a bad-CSRF call answer 429 (the limit sits between 401 and the
//      role check); an anonymous call still answers 401 and a foreign Origin still 403
//   G4 separation: 10 planning calls write 10 plan:u:<id> rows and 10 u:<id> rows; the 11th plan is 429 limit plan
//      while general still passes; filling the general budget does not touch the planning count; every general key
//      in rate_events matches ^u:\d+$ or ^plan:u:\d+$ (no other shape, no collision)
//   G5 busy_timeout 0 and a write lock held by another connection: a signed-in GET answers 503 DB_BUSY with
//      Retry-After 1 (not 500), and 200 once the lock is released
//   G6 config: RS_GENERAL_RATE_LIMIT / _WINDOW_SEC and RS_PLAN_RATE_LIMIT / _WINDOW_MIN out of range refuse startup by
//      name; in range they take effect (limit 3 -> the 4th call 429)
// Usage: node tr-r1-general.mjs   Exit 0 = all hold.
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
const root = process.cwd();
const imp = (p) => import(pathToFileURL(join(root, p)));
const { DEMO_PASSWORD, DEMO_DATE, startHarness, testEnv } = await imp('test/helpers/app-harness.js');
const { createClient } = await imp('test/helpers/fixtures.js');
const { canonicalFields } = await imp('test/helpers/plan-flow.js');
const { loadConfig } = await imp('src/config.js');

let failed = 0;
const check = (ok, what) => { console.log((ok ? 'PASS ' : 'FAIL ') + what); if (!ok) failed++; };
const general = (h, id) => h.db.prepare("SELECT COUNT(*) AS n FROM rate_events WHERE kind = 'general' AND user_key = ?").get(`u:${id}`).n;
const planned = (h, id) => h.db.prepare("SELECT COUNT(*) AS n FROM rate_events WHERE kind = 'general' AND user_key = ?").get(`plan:u:${id}`).n;

// G1-G4
{
  const h = await startHarness({ seed: true, record: false });
  try {
    const c = createClient(h.request);
    await c.signIn('cafe1', DEMO_PASSWORD);
    const id = c.user.id;
    const base = general(h, id);
    let firstRefused = null;
    for (let i = base + 1; i <= 301; i++) {
      const r = await c.get('/api/requests');
      if (r.status !== 200) { firstRefused = { i, r }; break; }
    }
    const r301 = firstRefused?.r;
    check(firstRefused?.i === 301 && r301.status === 429 && r301.json.error.code === 'RATE_LIMITED' && r301.json.error.details.limit === 'general' && Number(r301.headers['retry-after']) >= 1,
      `G1 first refusal at call ${firstRefused?.i} -> ${r301?.status} ${r301?.json?.error?.details?.limit} Retry-After ${r301?.headers?.['retry-after']} (rows before the loop ${base})`);
    const rowsAtLimit = general(h, id);
    await c.get('/api/requests');
    check(rowsAtLimit === 300 && general(h, id) === 300, `G1 rows at the limit ${rowsAtLimit}; after another refused call ${general(h, id)}`);

    // G3 at the limit
    const wrongRole = await c.get('/api/supplier/orders');
    const badCsrf = await c.post('/api/requests', { text: 'x' }, { headers: { 'X-CSRF-Token': 'bad-token' } });
    const anon = await h.request({ path: '/api/requests' });
    const foreignOrigin = await c.post('/api/requests', { text: 'x' }, { headers: { Origin: 'https://evil.example' } });
    check(wrongRole.status === 429 && badCsrf.status === 429 && anon.status === 401 && foreignOrigin.status === 403,
      `G3 at the limit: wrong role ${wrongRole.status}, bad CSRF ${badCsrf.status}, anonymous ${anon.status}, foreign Origin ${foreignOrigin.status} ${foreignOrigin.json?.error?.code}`);

    // G2 public routes while limited
    const pub = [];
    for (const p of ['/api/health', '/api/config', '/api/auth/csrf', '/api/auth/session']) pub.push((await c.get(p)).status);
    check(pub.every((s) => s === 200) && general(h, id) === 300, `G2 public routes while limited: ${pub.join(',')}; rows still ${general(h, id)}`);
    const before = h.db.prepare("SELECT COUNT(*) AS n FROM rate_events WHERE kind = 'general'").get().n;
    for (let i = 0; i < 5; i++) await h.request({ path: '/api/requests' });
    check(h.db.prepare("SELECT COUNT(*) AS n FROM rate_events WHERE kind = 'general'").get().n === before, 'G2 anonymous 401s write no general row');

    h.clock.advance(61_000);
    const after = await c.get('/api/requests');
    check(after.status === 200, `G1 after the window the next call passes -> ${after.status}`);

    // G4 separation
    h.clock.advance(61_000);
    const req = (await c.post('/api/requests', { text: 'separation' })).json.request.id;
    await c.post(`/api/requests/${req}/confirm`, { fields: canonicalFields(DEMO_DATE) });
    h.clock.advance(11 * 60_000);
    const g0 = general(h, id); const p0 = planned(h, id);
    const statuses = [];
    for (let i = 0; i < 11; i++) statuses.push((await c.post(`/api/requests/${req}/plan`, {})).status);
    const eleventh = statuses[10];
    check(statuses.slice(0, 10).every((s) => s === 201) && eleventh === 429 && planned(h, id) - p0 === 10 && general(h, id) === 11,
      `G4 11 plan calls: ${statuses.join(',')}; plan rows +${planned(h, id) - p0}; general rows in the window ${general(h, id)} (expired rows of earlier calls deleted: ${g0} before)`);
    const genOk = await c.get('/api/requests');
    check(genOk.status === 200, `G4 general still passes while planning is limited -> ${genOk.status}`);
    const keys = h.db.prepare("SELECT DISTINCT user_key FROM rate_events WHERE kind = 'general'").all().map((r) => r.user_key);
    check(keys.every((k) => /^u:\d+$/.test(k) || /^plan:u:\d+$/.test(k)), `G4 general keys: ${keys.join(', ')}`);
  } finally {
    await h.close();
  }
}

// G5 busy
{
  const h = await startHarness({ seed: true, record: false, dbBusyTimeoutMs: 0 });
  try {
    const c = createClient(h.request);
    await c.signIn('cafe1', DEMO_PASSWORD);
    const holder = new DatabaseSync(h.config.dbPath);
    holder.exec('PRAGMA busy_timeout = 0');
    holder.exec('BEGIN IMMEDIATE');
    let busy;
    try {
      busy = await c.get('/api/requests');
    } finally {
      holder.exec('ROLLBACK');
      holder.close();
    }
    const ok = await c.get('/api/requests');
    check(busy.status === 503 && busy.json?.error?.code === 'DB_BUSY' && busy.headers['retry-after'] === '1' && ok.status === 200,
      `G5 held write lock, busy_timeout 0: ${busy.status} ${busy.json?.error?.code} Retry-After ${busy.headers['retry-after']}; after release ${ok.status}`);
    const internal = h.logEntries().filter((e) => JSON.stringify(e).includes('INTERNAL'));
    check(internal.length === 0, `G5 no INTERNAL error logged (${internal.length})`);
  } finally {
    await h.close();
  }
}

// G6 config
{
  const refused = [];
  for (const [name, value] of [['RS_GENERAL_RATE_LIMIT', '0'], ['RS_GENERAL_RATE_LIMIT', '100001'], ['RS_GENERAL_RATE_WINDOW_SEC', '3601'], ['RS_PLAN_RATE_LIMIT', '1001'], ['RS_PLAN_RATE_WINDOW_MIN', '0']]) {
    let message = 'accepted';
    try { loadConfig(testEnv('/tmp/tr-r1-config', { [name]: value })); } catch (e) { message = e.message; }
    refused.push(message.includes(name) && !message.includes(value === '0' ? 'XXXX' : value + 'X'));
  }
  check(refused.every(Boolean), `G6 out-of-range values refused by name: ${refused.join(',')}`);
  const h = await startHarness({ seed: true, record: false, env: { RS_GENERAL_RATE_LIMIT: '3', RS_GENERAL_RATE_WINDOW_SEC: '10' } });
  try {
    const c = createClient(h.request);
    await c.signIn('cafe1', DEMO_PASSWORD);
    const s = [];
    for (let i = 0; i < 4; i++) s.push((await c.get('/api/requests')).status);
    h.clock.advance(11_000);
    s.push((await c.get('/api/requests')).status);
    check(s.join(',') === '200,200,200,429,200', `G6 limit 3 per 10 s: ${s.join(',')}`);
  } finally {
    await h.close();
  }
}
console.log(failed ? `${failed} FAILED` : 'general limit, separation, order, busy mapping and config hold');
process.exit(failed ? 1 : 0);
