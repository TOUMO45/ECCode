// Security probe for phase:rework-1 (security-reviewer): SEC-C-2 (/64 throttle keys), SEC-C-3 (general limit,
// unchanged confirm) and regression hypotheses (busy write lock on GETs, cross-site budget spending, 429 body).
// In-process app on temp databases; no latency samples. REPRO lines expect the issue to reproduce.
// Usage: node .eccode/drafts/sec-rw1-probe.mjs [R1 R2 R3 R4]
import { startHarness, DEMO_DATE, DEMO_PASSWORD } from '../../test/helpers/app-harness.js';
import { createClient } from '../../test/helpers/fixtures.js';
import { canonicalFields } from '../../test/helpers/plan-flow.js';
import { holdWriteLock } from '../../test/helpers/lock-proc.js';
import { throttleKey } from '../../src/auth/client-ip.js';

const only = new Set(process.argv.slice(2));
let failures = 0;
const check = (label, cond, info = '') => { if (!cond) failures += 1; console.log(`${cond ? 'PASS' : 'FAIL'} ${label}${info ? ` | ${info}` : ''}`); };
const short = (r) => `${r.status} ${r.json?.error?.code ?? ''}`.trim();
const clientOf = (h, ip) => createClient((o) => h.request({ ...o, headers: { ...(o.headers || {}), ...(ip ? { 'X-Forwarded-For': ip } : {}) } }));
const count = (h, table, where = '1=1', ...a) => h.db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`).get(...a).n;
async function signin(h, username, password, ip) {
  const tok = (await h.request({ path: '/api/auth/csrf' })).json.csrfToken;
  return h.request({ method: 'POST', path: '/api/auth/signin', headers: { 'X-CSRF-Token': tok, 'X-Forwarded-For': ip }, jsonBody: { username, password } });
}

async function r1() {
  console.log('== R1 SEC-C-2 throttle keys');
  const cases = [
    ['2001:db8:1:1::1', '2001:db8:1:1::/64'],
    ['2001:DB8:0001:0001:ffff:ffff:ffff:ffff', '2001:db8:1:1::/64'],
    ['[2001:db8:1:1::abcd]', '2001:db8:1:1::/64'],
    ['2001:db8:1:1::1%eth0', '2001:db8:1:1::/64'],
    ['2001:db8:1:2::1', '2001:db8:1:2::/64'],
    ['::ffff:203.0.113.51', '203.0.113.51'],
    ['::FFFF:203.0.113.51', '203.0.113.51'],
    ['::ffff:cb00:7133', '203.0.113.51'],
    ['0:0:0:0:0:ffff:cb00:7133', '203.0.113.51'],
    ['203.0.113.51', '203.0.113.51'],
    ['not-an-ip', null],
    ['999.1.1.1', null],
  ];
  const bad = cases.filter(([i, o]) => throttleKey(i) !== o).map(([i, o]) => `${i} -> ${throttleKey(i)} (want ${o})`);
  check('R1 throttleKey: /64 for IPv6 in every spelling; mapped IPv4 (dotted, hex, upper case, expanded) -> IPv4; junk -> null', bad.length === 0, bad.join('; '));
  note(`info: NAT64 64:ff9b::cb00:7133 -> ${throttleKey('64:ff9b::cb00:7133')}; ::1 -> ${throttleKey('::1')}; IPv4-compatible ::203.0.113.51 -> ${throttleKey('::203.0.113.51')}`);

  const h = await startHarness({ seed: true, record: false, env: { RS_TRUST_PROXY: '1' } });
  try {
    const st = [];
    for (let i = 1; i <= 5; i += 1) st.push((await signin(h, 'cafe1', 'wrong', `2001:db8:1:1::${i}`)).status);
    const sixth = await signin(h, 'cafe1', DEMO_PASSWORD, '2001:db8:1:1::99');
    check('R1 SEC-C-2: 5 failures over 5 addresses of one /64 -> the 6th (correct password, new address in the same /64) is 429 signin_pair', st.every((s) => s === 401) && sixth.status === 429 && sixth.json.error.details.limit === 'signin_pair', `${st.join(',')} | ${short(sixth)}`);
    const other = await signin(h, 'cafe1', DEMO_PASSWORD, '2001:db8:1:2::1');
    const v4 = await signin(h, 'cafe1', DEMO_PASSWORD, '198.51.100.20');
    check('R1 another /64 and an IPv4 client are separate budgets', other.status === 200 && v4.status === 200, `${short(other)} ${short(v4)}`);
    const m = [];
    for (let i = 0; i < 5; i += 1) m.push((await signin(h, 'cafe2', 'wrong', i % 2 ? '::ffff:203.0.113.77' : '203.0.113.77')).status);
    const m6 = await signin(h, 'cafe2', DEMO_PASSWORD, '::ffff:cb00:714d');
    check('R1 mapped IPv4 (dotted and hex) shares the plain IPv4 budget', m.every((s) => s === 401) && m6.status === 429, `${m.join(',')} | ${short(m6)}`);
    const sp = [];
    for (let i = 0; i < 21; i += 1) sp.push((await signin(h, `spray-${i}`, 'x', `2001:db8:9:9::${(i + 1).toString(16)}`)).status);
    check('R1 per-IP limit applies to the /64: 21st attempt over 21 addresses and 21 usernames -> 429 signin_ip', sp.slice(0, 20).every((s) => s === 401) && sp[20] === 429, sp.join(','));
  } finally {
    await h.close();
  }
}
const note = (t) => console.log(`  .. ${t}`);

async function r2() {
  console.log('== R2 SEC-C-3 general limit and unchanged confirm');
  const h = await startHarness({ seed: true, record: false });
  try {
    const c = clientOf(h);
    await c.signIn('cafe1', DEMO_PASSWORD);
    const uid = c.user.id;
    const created = await c.post('/api/requests', { text: '200 cups' });
    const rid = created.json.request.id;
    await c.post(`/api/requests/${rid}/confirm`, { fields: canonicalFields(DEMO_DATE) });
    const made = await c.post(`/api/requests/${rid}/plan`, {});
    const planRows = () => count(h, 'rate_events', "kind = 'general' AND user_key = ?", `plan:u:${uid}`);
    const plansBefore = planRows();
    const used = count(h, 'rate_events', "kind = 'general' AND user_key = ?", `u:${uid}`);
    const st = [];
    for (let i = used; i < 300; i += 1) st.push((await c.get(`/api/requests/${rid}`)).status);
    const r301 = await c.get(`/api/requests/${rid}`);
    const bodyKeys = Object.keys(r301.json?.error ?? {}).sort().join(',');
    check('R2 SEC-C-3: calls 1..300 in one minute pass; the 301st is 429 RATE_LIMITED limit general with Retry-After', st.every((s) => s === 200) && r301.status === 429 && r301.json.error.details.limit === 'general' && Number(r301.headers['retry-after']) >= 1 && Number(r301.headers['retry-after']) <= 60, `${st.length} x 200 then ${short(r301)} retry-after=${r301.headers['retry-after']}`);
    check('R2 the 429 body carries only code, message, requestId and details.limit (nothing about other users or counts)', bodyKeys === 'code,details,message,requestId' && JSON.stringify(r301.json.error.details) === '{"limit":"general"}', `${bodyKeys} ${JSON.stringify(r301.json.error.details)}`);
    const rows = count(h, 'rate_events', "kind = 'general' AND user_key = ?", `u:${uid}`);
    const more = [];
    for (let i = 0; i < 50; i += 1) more.push((await c.get('/api/requests')).status);
    check('R2 refused calls are not inserted: 50 more refused calls leave the row count at 300', rows === 300 && count(h, 'rate_events', "kind = 'general' AND user_key = ?", `u:${uid}`) === 300 && more.every((s) => s === 429), `rows ${rows}`);
    check('R2 planning count untouched by 350 general calls (plan:u: rows unchanged)', planRows() === plansBefore && made.status === 201, `plan rows ${plansBefore} -> ${planRows()}`);
    const so = await c.post('/api/auth/signout', {});
    note(`observation: sign-out while limited -> ${short(so)}`);
    h.clock.advance(61 * 1000);
    const after = await c.get('/api/requests');
    check('R2 after the window the user is served again; expired rows of that user are deleted on the next call', after.status === 200 && count(h, 'rate_events', "kind = 'general' AND user_key = ?", `u:${uid}`) === 1, `${short(after)} rows ${count(h, 'rate_events', "kind = 'general' AND user_key = ?", `u:${uid}`)}`);
    const other = clientOf(h);
    await other.signIn('cafe2', DEMO_PASSWORD);
    check("R2 another user is not affected by cafe1's limit", (await other.get('/api/requests')).status === 200);
  } finally {
    await h.close();
  }

  const h2 = await startHarness({ seed: true, record: false, env: { RS_GENERAL_RATE_LIMIT: '1000' } });
  try {
    const c = clientOf(h2);
    await c.signIn('cafe1', DEMO_PASSWORD);
    const rid = (await c.post('/api/requests', { text: '200 cups' })).json.request.id;
    const first = await c.post(`/api/requests/${rid}/confirm`, { fields: canonicalFields(DEMO_DATE) });
    const reqBefore = count(h2, 'requirements');
    const audBefore = count(h2, 'audit_events');
    const rq = count(h2, 'replan_queue');
    const st = [];
    for (let i = 0; i < 300; i += 1) st.push((await c.post(`/api/requests/${rid}/confirm`, { fields: canonicalFields(DEMO_DATE) })).json?.requirements?.version);
    check('R2 SEC-C-3: 300 identical confirms -> same version every time, 0 requirements rows, 0 audit rows, 0 re-plans', st.every((v) => v === first.json.requirements.version) && count(h2, 'requirements') === reqBefore && count(h2, 'audit_events') === audBefore && count(h2, 'replan_queue') === rq, `version ${first.json.requirements.version}; +${count(h2, 'requirements') - reqBefore} req, +${count(h2, 'audit_events') - audBefore} audit`);
    const changed = await c.post(`/api/requests/${rid}/confirm`, { fields: canonicalFields(DEMO_DATE, { cupQuantity: 201 }) });
    const back = await c.post(`/api/requests/${rid}/confirm`, { fields: canonicalFields(DEMO_DATE) });
    check('R2 a real change still writes a version, and changing back writes another (no stale short-circuit)', changed.json.requirements.version === first.json.requirements.version + 1 && back.json.requirements.version === first.json.requirements.version + 2, `${first.json.requirements.version} -> ${changed.json.requirements.version} -> ${back.json.requirements.version}`);
    const p = [];
    for (let i = 0; i < 10; i += 1) p.push((await c.post(`/api/requests/${rid}/plan`, {})).status);
    check('R2 planning limit still 10 per window with the general limit raised (keys separate)', p.slice(0, 10).every((s) => s === 201) && (await c.post(`/api/requests/${rid}/plan`, {})).json.error.details.limit === 'plan', p.join(','));
  } finally {
    await h2.close();
  }
}

async function r3() {
  console.log('== R3 general limit under a held write lock (busy_timeout 0)');
  const h = await startHarness({ seed: true, record: false, dbBusyTimeoutMs: 0 });
  try {
    const c = clientOf(h);
    await c.signIn('cafe1', DEMO_PASSWORD);
    const uid = c.user.id;
    const rows = () => count(h, 'rate_events', "kind = 'general' AND user_key = ?", `u:${uid}`);
    const before = rows();
    const lock = await holdWriteLock(h.config.dbPath);
    let get;
    let pub;
    try {
      get = await c.get('/api/requests');
      pub = await c.get('/api/auth/session');
    } finally {
      await lock.release();
    }
    check('R3 REPRO: with another process holding the write lock, an authenticated READ (GET /api/requests) is 503 DB_BUSY with Retry-After (the limiter needs BEGIN IMMEDIATE); a public read is 200', get.status === 503 && get.json.error.code === 'DB_BUSY' && get.headers['retry-after'] === '1' && pub.status === 200, `${short(get)} retry-after=${get.headers['retry-after']} | public ${short(pub)}`);
    check('R3 the 503 is not counted (rolled back)', rows() === before, `${before} -> ${rows()}`);
    const ok = await c.get('/api/requests');
    check('R3 after release the same read is 200', ok.status === 200, short(ok));
  } finally {
    await h.close();
  }
}

async function r4() {
  console.log('== R4 cross-site top-level navigations spend a signed-in victim\'s general budget');
  const { launchChromium } = await import('../../test/helpers/playwright.js');
  const h = await startHarness({ seed: true, record: false, env: { RS_GENERAL_RATE_LIMIT: '20' } });
  let browser;
  try {
    const victim = clientOf(h);
    await victim.signIn('cafe1', DEMO_PASSWORD);
    const uid = victim.user.id;
    const sid = victim.cookies().rs_sid;
    const origin = `http://127.0.0.1:${h.port}`;
    browser = await launchChromium({ args: typeof process.getuid === 'function' && process.getuid() === 0 ? ['--no-sandbox'] : [] });
    const context = await browser.newContext();
    await context.addCookies([{ name: 'rs_sid', value: sid, url: origin, httpOnly: true, sameSite: 'Lax' }]);
    const html = `<!doctype html><title>cat pictures</title><script>
      window.go = async (target, n) => { const w = window.open('about:blank', 'x'); for (let i = 0; i < n; i++) { w.location = target + '?n=' + i; await new Promise(r => setTimeout(r, 120)); } return true; };
    </script>`;
    await context.route('http://attacker.example/**', (route) => route.fulfill({ status: 200, contentType: 'text/html', body: html }));
    const page = await context.newPage();
    await page.goto('http://attacker.example/');
    const before = count(h, 'rate_events', "kind = 'general' AND user_key = ?", `u:${uid}`);
    await page.evaluate(([t, n]) => window.go(t, n), [`${origin}/api/requests`, 30]);
    await page.waitForTimeout(800);
    const after = count(h, 'rate_events', "kind = 'general' AND user_key = ?", `u:${uid}`);
    const own = await victim.get('/api/requests');
    const out = await victim.post('/api/auth/signout', {});
    check('R4 REPRO: a cross-site page (attacker.example) navigating a popup to /api/requests 30 times carries the Lax cookie, fills the victim\'s budget, and the victim\'s own SPA call and sign-out are 429 general', after - before >= 20 && own.status === 429 && own.json.error.details.limit === 'general' && out.status === 429, `rows ${before} -> ${after}; victim GET ${short(own)}; sign-out ${short(out)}`);
    h.clock.advance(61 * 1000);
    check('R4 the lock-out lasts one window (the clock moved 61 s: served again)', (await victim.get('/api/requests')).status === 200);
    await context.close();
  } finally {
    if (browser) await browser.close();
    await h.close();
  }
}

for (const [name, fn] of Object.entries({ R1: r1, R2: r2, R3: r3, R4: r4 })) {
  if (only.size > 0 && !only.has(name)) continue;
  try {
    await fn();
  } catch (err) {
    failures += 1;
    console.log(`FAIL ${name} threw: ${err?.stack ?? err}`);
  }
}
console.log(failures === 0 ? 'ALL EXPECTATIONS MET' : `${failures} EXPECTATION(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
