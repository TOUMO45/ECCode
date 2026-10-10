// Security probe for phase C (security-reviewer). Runs the real app in-process on temp databases (seeded RS-FIX-1),
// never touches the project database, records no latency samples. Each check prints PASS/FAIL; lines tagged REPRO
// are reproductions of findings (their expectation is that the issue reproduces). Exit 1 if any expectation fails.
// Usage: node .eccode/drafts/sec-phc-probe.mjs [section ...]   sections: S1..S13 (default all; S13 launches Chromium)
import { performance } from 'node:perf_hooks';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { startHarness, DEMO_DATE, DEMO_PASSWORD } from '../../test/helpers/app-harness.js';
import { createClient } from '../../test/helpers/fixtures.js';
import { canonicalFields } from '../../test/helpers/plan-flow.js';
import { ensureAdmin, disableUser } from '../../src/services/users.js';
import { expireDueReservations } from '../../src/services/reservations.js';

const ADMIN_PW = 'Probe-admin-password-0123456789';
const only = new Set(process.argv.slice(2));
let failures = 0;
function check(label, cond, info = '') {
  const tag = cond ? 'PASS' : 'FAIL';
  if (!cond) failures += 1;
  console.log(`${tag} ${label}${info ? ` | ${info}` : ''}`);
}
const note = (text) => console.log(`  .. ${text}`);
const short = (r) => `${r.status} ${r.json?.error?.code ?? ''}`.trim();

async function world(env = {}, extra = {}) {
  const h = await startHarness({ seed: true, record: false, env: { RS_ADMIN_PASSWORD: ADMIN_PW, ...env }, ...extra });
  await ensureAdmin({ db: h.db, config: h.config, clock: h.clock });
  const clientAt = (ip) =>
    createClient((opts) => h.request({ ...opts, headers: { ...(opts.headers || {}), ...(ip ? { 'X-Forwarded-For': ip } : {}) } }));
  const count = (table, where = '1=1', ...args) => h.db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`).get(...args).n;
  const addStock = (n) => {
    for (const row of h.db.prepare('SELECT product_id FROM inventory').all()) h.db.prepare('UPDATE inventory SET on_hand = on_hand + ?, version = version + 1 WHERE product_id = ?').run(n, row.product_id);
  };
  return { h, clientAt, count, addStock };
}

const cookieOf = (res) => {
  const raw = res.headers['set-cookie'];
  return (Array.isArray(raw) ? raw : raw ? [raw] : []).find((c) => c.startsWith('rs_sid=')) ?? null;
};
const sidOf = (res) => /^rs_sid=([^;]*)/.exec(cookieOf(res) ?? '')?.[1] ?? null;

async function preLoginToken(h, headers = {}) {
  const r = await h.request({ path: '/api/auth/csrf', headers });
  return r.json.csrfToken;
}
async function rawSignin(h, { username, password, ip, cookie, origin, token } = {}) {
  const tok = token === undefined ? await preLoginToken(h) : token;
  const headers = {};
  if (tok) headers['X-CSRF-Token'] = tok;
  if (ip) headers['X-Forwarded-For'] = ip;
  if (cookie) headers.Cookie = `rs_sid=${cookie}`;
  if (origin) headers.Origin = origin;
  const t0 = performance.now();
  const res = await h.request({ method: 'POST', path: '/api/auth/signin', headers, jsonBody: { username, password } });
  res.ms = performance.now() - t0;
  return res;
}

async function makePlan(client, overrides = {}, approve = true) {
  const created = await client.post('/api/requests', { text: 'I need 200 cups and 200 lids by 11:00.' });
  const requestId = created.json?.request?.id;
  const confirmed = await client.post(`/api/requests/${requestId}/confirm`, { fields: canonicalFields(DEMO_DATE, overrides) });
  const made = await client.post(`/api/requests/${requestId}/plan`, {});
  const plan = made.json?.plan ?? null;
  if (approve && plan) {
    const a = await client.post(`/api/plans/${plan.id}/approve`, { expectedTotalCents: plan.body.totalCents, planHash: plan.planHash });
    if (a.status !== 200) note(`approve failed ${short(a)}`);
  }
  return { requestId, plan, created, confirmed, made };
}
const reserve = (client, planId, key) => client.post(`/api/plans/${planId}/reserve`, {}, { headers: { 'Idempotency-Key': key } });
const KEY = (n) => `probe-key-${String(n).padStart(8, '0')}-xyz`;
const OPEN_ON_DEAD_PLAN = [
  'supplier_orders so JOIN plan_versions pv ON pv.id = so.plan_version_id',
  "so.fulfilment_status IN ('awaiting_supplier','confirmed') AND pv.status IN ('superseded','non_executable')",
];
const ACTIVE_ON_DEAD_PLAN = [
  'reservations r JOIN plan_versions pv ON pv.id = r.plan_version_id',
  "r.status = 'active' AND pv.status IN ('superseded','non_executable')",
];

// ---------------------------------------------------------------- S1 sessions and cookies
async function s1() {
  console.log('== S1 sessions, cookies, rotation, fixation, sign-out, expiry');
  const { h, clientAt } = await world();
  try {
    const c = clientAt();
    const r = await c.signIn('cafe1', DEMO_PASSWORD);
    const sc = cookieOf(r);
    check('S1 cookie flags HttpOnly; SameSite=Lax; Path=/; Max-Age=43200', /HttpOnly/.test(sc) && /SameSite=Lax/.test(sc) && /Path=\//.test(sc) && /Max-Age=43200/.test(sc), sc.replace(/rs_sid=[^;]+/, 'rs_sid=<id>'));
    check('S1 cookie has no Secure over plain http (config secureCookies false)', !/Secure/.test(sc));
    const stored = h.db.prepare('SELECT id_hash FROM sessions').all().map((x) => x.id_hash);
    check('S1 raw session id not stored (sha256 only)', !stored.includes(sidOf(r)) && stored.every((x) => /^[0-9a-f]{64}$/.test(x)));

    const planted = 'A'.repeat(43);
    const fx = await rawSignin(h, { username: 'cafe2', password: DEMO_PASSWORD, cookie: planted });
    check('S1 fixation: planted id not adopted at sign-in', fx.status === 200 && sidOf(fx) !== planted, short(fx));
    const asPlanted = await h.request({ path: '/api/auth/session', headers: { Cookie: `rs_sid=${planted}` } });
    check('S1 fixation: planted id resolves to nobody', asPlanted.json.user === null);

    const s1id = sidOf(r);
    const again = await rawSignin(h, { username: 'cafe1', password: DEMO_PASSWORD, cookie: s1id, token: c.csrfToken });
    const old = await h.request({ path: '/api/requests', headers: { Cookie: `rs_sid=${s1id}` } });
    check('S1 rotation on sign-in: old session dead (401), new id differs', again.status === 200 && sidOf(again) !== s1id && old.status === 401, `${short(again)} old=${short(old)}`);

    const s2id = sidOf(again);
    const tok = again.json.csrfToken;
    const reg = await h.request({ method: 'POST', path: '/api/auth/register', headers: { Cookie: `rs_sid=${s2id}`, 'X-CSRF-Token': tok }, jsonBody: { username: 'rotate-probe', password: 'long-enough-pw', displayName: 'R' } });
    const old2 = await h.request({ path: '/api/requests', headers: { Cookie: `rs_sid=${s2id}` } });
    check('S1 SEC-20 rotation on register: incoming session destroyed', reg.status === 201 && old2.status === 401 && sidOf(reg) !== s2id, `${short(reg)} old=${short(old2)}`);

    const c3 = clientAt();
    const r3 = await c3.signIn('cafe2', DEMO_PASSWORD);
    const sid3 = sidOf(r3);
    const tok3 = c3.csrfToken;
    const out = await c3.signOut();
    const reuse = await h.request({ path: '/api/requests', headers: { Cookie: `rs_sid=${sid3}` } });
    const reusePost = await h.request({ method: 'POST', path: '/api/requests', headers: { Cookie: `rs_sid=${sid3}`, 'X-CSRF-Token': tok3 }, jsonBody: { text: 'x' } });
    check('S1 sign-out: cookie cleared and the old id is dead for GET and POST', out.status === 200 && /Max-Age=0/.test(cookieOf(out)) && reuse.status === 401 && reusePost.status === 401, `${short(reuse)} ${short(reusePost)}`);

    const ci = clientAt();
    await ci.signIn('cafe1', DEMO_PASSWORD);
    h.clock.advance(59 * 60 * 1000);
    const i1 = await ci.get('/api/requests');
    h.clock.advance(59 * 60 * 1000);
    const i2 = await ci.get('/api/requests');
    h.clock.advance(60 * 60 * 1000 + 1000);
    const i3 = await ci.get('/api/requests');
    check('S1 idle: 59 min gaps keep the session, a 60 min gap ends it', i1.status === 200 && i2.status === 200 && i3.status === 401, `${i1.status} ${i2.status} ${i3.status}`);

    const ca = clientAt();
    await ca.signIn('cafe2', DEMO_PASSWORD);
    const statuses = [];
    for (let i = 0; i < 14; i += 1) {
      h.clock.advance(55 * 60 * 1000);
      statuses.push((await ca.get('/api/requests')).status);
    }
    check('S1 absolute: a session kept active every 55 min is alive at 715 min and dead at 770 min (12 h cap)', statuses.slice(0, 13).every((s) => s === 200) && statuses[13] === 401, statuses.join(','));

    const cd = clientAt();
    await cd.signIn('cafe1', DEMO_PASSWORD);
    const uid = h.db.prepare("SELECT id FROM users WHERE username = 'cafe1'").get().id;
    disableUser(h.db, uid);
    const dis = await cd.get('/api/requests');
    const dis2 = await rawSignin(h, { username: 'cafe1', password: DEMO_PASSWORD });
    check('S1 disabled user: session dead and sign-in 401', dis.status === 401 && dis2.status === 401, `${short(dis)} ${short(dis2)}`);
  } finally {
    await h.close();
  }

  const w2 = await world({ RS_PUBLIC_URL: 'https://rescue.example' });
  try {
    const tok = (await w2.h.request({ path: '/api/auth/csrf', host: 'rescue.example' })).json.csrfToken;
    const r = await w2.h.request({ method: 'POST', path: '/api/auth/signin', host: 'rescue.example', headers: { 'X-CSRF-Token': tok, Origin: 'https://rescue.example' }, jsonBody: { username: 'cafe1', password: DEMO_PASSWORD } });
    check('S1 https public URL: cookie carries Secure', r.status === 200 && /; Secure/.test(cookieOf(r) ?? ''), short(r));
    const evilHost = await w2.h.request({ path: '/api/auth/csrf', host: 'evil.example' });
    check('S1 SEC-13: a foreign Host header -> 421', evilHost.status === 421, short(evilHost));
  } finally {
    await w2.h.close();
  }
}

// ---------------------------------------------------------------- S2 CSRF and Origin
async function s2() {
  console.log('== S2 CSRF token binding and Origin order');
  const { h, clientAt, count } = await world();
  try {
    const c = clientAt();
    const r = await c.signIn('cafe1', DEMO_PASSWORD);
    const sid = sidOf(r);
    const good = c.csrfToken;
    const base = { Cookie: `rs_sid=${sid}` };
    const before = count('rescue_requests');
    const post = (headers) => h.request({ method: 'POST', path: '/api/requests', headers: { ...base, ...headers }, jsonBody: { text: 'csrf probe' } });
    const other = clientAt();
    await other.signIn('cafe2', DEMO_PASSWORD);
    const pre = await preLoginToken(h);
    const cases = [
      ['no token', {}],
      ['wrong token', { 'X-CSRF-Token': 'x'.repeat(43) }],
      ["another user's session token", { 'X-CSRF-Token': other.csrfToken }],
      ['valid pre-login token on a session route', { 'X-CSRF-Token': pre }],
      ['correct token, Origin https://evil.example', { 'X-CSRF-Token': good, Origin: 'https://evil.example' }],
      ['correct token, Origin null', { 'X-CSRF-Token': good, Origin: 'null' }],
      ['correct token, Origin with suffix trick', { 'X-CSRF-Token': good, Origin: `http://127.0.0.1:${h.port}.evil.example` }],
    ];
    for (const [label, headers] of cases) {
      const res = await post(headers);
      check(`S2 refused: ${label}`, res.status === 403 && res.json.error.code === 'CSRF_FAILED', short(res));
    }
    check('S2 refused attempts created no request rows', count('rescue_requests') === before);
    const okSame = await post({ 'X-CSRF-Token': good, Origin: `http://127.0.0.1:${h.port}` });
    const okNone = await post({ 'X-CSRF-Token': good });
    check('S2 accepted: same Origin + token, and absent Origin + token', okSame.status === 201 && okNone.status === 201, `${short(okSame)} ${short(okNone)}`);
    const anonEvil = await h.request({ method: 'POST', path: '/api/requests', headers: { Origin: 'https://evil.example' }, jsonBody: { text: 'x' } });
    check('S2 order: anonymous + foreign Origin -> 403 CSRF_FAILED before identification', anonEvil.status === 403 && anonEvil.json.error.code === 'CSRF_FAILED', short(anonEvil));

    const noTok = await rawSignin(h, { username: 'cafe1', password: DEMO_PASSWORD, token: null });
    check('S2 signin without token -> 403', noTok.status === 403, short(noTok));
    const evil = await rawSignin(h, { username: 'cafe1', password: DEMO_PASSWORD, origin: 'https://evil.example' });
    check('S2 signin with foreign Origin -> 403 (login CSRF)', evil.status === 403, short(evil));
    const parts = pre.split('.');
    const forged = `${parts[0].slice(0, -2)}AA.${parts[1]}`;
    const fr = await rawSignin(h, { username: 'cafe1', password: DEMO_PASSWORD, token: forged });
    check('S2 signin with a tampered pre-login nonce -> 403', fr.status === 403, short(fr));
    const oldTok = await preLoginToken(h);
    h.clock.advance(2 * 60 * 60 * 1000 + 1000);
    const ex = await rawSignin(h, { username: 'cafe1', password: DEMO_PASSWORD, token: oldTok });
    check('S2 signin with a pre-login token older than 2 h -> 403', ex.status === 403, short(ex));
    const tp = await h.request({ method: 'POST', path: '/api/auth/signin', headers: { 'Content-Type': 'text/plain', 'X-CSRF-Token': await preLoginToken(h) }, body: JSON.stringify({ username: 'cafe1', password: DEMO_PASSWORD }) });
    check('S2 text/plain body (simple cross-site form) -> 415', tp.status === 415, short(tp));
    const pf = await h.request({ method: 'OPTIONS', path: '/api/requests', headers: { Origin: 'https://evil.example', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'x-csrf-token' } });
    check('S2 no Access-Control-* header on a preflight', !Object.keys(pf.headers).some((k) => k.startsWith('access-control-')), `status ${pf.status}`);
  } finally {
    await h.close();
  }
}

// ---------------------------------------------------------------- S3 sign-in throttle
async function s3() {
  console.log('== S3 sign-in throttle (SEC-1, SEC-9, FU-11), timing');
  const { h, count } = await world({ RS_TRUST_PROXY: '1' });
  try {
    const attacker = '203.0.113.1';
    const st = [];
    for (let i = 0; i < 5; i += 1) st.push(short(await rawSignin(h, { username: 'admin', password: `wrong-${i}`, ip: attacker })));
    const sixth = await rawSignin(h, { username: 'admin', password: ADMIN_PW, ip: attacker });
    check('S3 5 wrong from one IP -> 401 x5; the 6th from the same IP with the CORRECT password -> 429 signin_pair', st.every((s) => s === '401 INVALID_CREDENTIALS') && sixth.status === 429 && sixth.json.error.details.limit === 'signin_pair' && Number(sixth.headers['retry-after']) > 0, `${st.join(',')} | ${short(sixth)} retry-after=${sixth.headers['retry-after']}`);
    const real = await rawSignin(h, { username: 'admin', password: ADMIN_PW, ip: '198.51.100.7' });
    check('S3 SEC-1: the real admin from another IP still signs in (no cross-IP lockout)', real.status === 200, `${short(real)} ${Math.round(real.ms)} ms`);

    for (const ip of ['203.0.113.2', '203.0.113.3', '203.0.113.4']) {
      for (let i = 0; i < 5; i += 1) await rawSignin(h, { username: 'admin', password: `wrong-${ip}-${i}`, ip });
    }
    const n = count('login_failures', 'username_key = ?', 'admin');
    const delayed = await rawSignin(h, { username: 'admin', password: ADMIN_PW, ip: '198.51.100.8' });
    check('S3 cross-IP pressure (>=10 failures) delays but admits the correct password', delayed.status === 200 && delayed.ms >= 900, `${short(delayed)} after ${n} failures, ${Math.round(delayed.ms)} ms`);

    const v = '203.0.113.20';
    for (const u of ['ADMIN', 'Admin', ' admin ', 'aDmIn', 'admin ']) await rawSignin(h, { username: u, password: 'nope', ip: v });
    const v6 = await rawSignin(h, { username: 'admin', password: ADMIN_PW, ip: v });
    check('S3 SEC-9: five case/space variants exhaust the same pair budget', v6.status === 429, short(v6));
    const caseOk = await rawSignin(h, { username: 'ADMIN', password: ADMIN_PW, ip: '198.51.100.9' });
    check('S3 SEC-9: lookup is case-insensitive (ADMIN + correct password -> 200)', caseOk.status === 200, short(caseOk));

    const u = '203.0.113.30';
    const us = [];
    for (let i = 0; i < 5; i += 1) us.push(short(await rawSignin(h, { username: 'no-such-user', password: 'x', ip: u })));
    const u6 = await rawSignin(h, { username: 'no-such-user', password: 'x', ip: u });
    check('S3 unknown username: same 401 x5 then 429 signin_pair (no enumeration by status)', us.every((s) => s === '401 INVALID_CREDENTIALS') && u6.status === 429 && u6.json.error.details.limit === 'signin_pair', `${us.join(',')} | ${short(u6)}`);

    const p = '203.0.113.40';
    const ps = [];
    for (let i = 0; i < 21; i += 1) ps.push((await rawSignin(h, { username: `spray-${i}`, password: 'x', ip: p })).status);
    check('S3 per-IP: the 21st attempt across 21 usernames -> 429 signin_ip', ps.slice(0, 20).every((s) => s === 401) && ps[20] === 429, ps.join(','));

    const chain = await rawSignin(h, { username: 'cafe2', password: 'bad', ip: '1.2.3.4, 203.0.113.50' });
    const keyed = h.db.prepare("SELECT ip FROM login_failures WHERE username_key = 'cafe2' ORDER BY id DESC LIMIT 1").get();
    check('S3 FU-11: the LAST X-Forwarded-For hop is the key', chain.status === 401 && keyed.ip === '203.0.113.50', keyed?.ip);
    await rawSignin(h, { username: 'cafe2', password: 'bad', ip: '<script>' });
    const k2 = h.db.prepare("SELECT ip FROM login_failures WHERE username_key = 'cafe2' ORDER BY id DESC LIMIT 1").get();
    check('S3 FU-11: a non-IP hop falls back to the socket address', k2.ip === '127.0.0.1', k2.ip);
    await rawSignin(h, { username: 'cafe2', password: 'bad', ip: '::ffff:203.0.113.51' });
    const k3 = h.db.prepare("SELECT ip FROM login_failures WHERE username_key = 'cafe2' ORDER BY id DESC LIMIT 1").get();
    check('S3 FU-11: IPv4-mapped IPv6 collapses to IPv4', k3.ip === '203.0.113.51', k3.ip);
    const v6s = [];
    for (let i = 1; i <= 8; i += 1) v6s.push((await rawSignin(h, { username: 'cafe1', password: 'bad', ip: `2001:db8:1:1::${i.toString(16)}` })).status);
    const v6pair = await rawSignin(h, { username: 'cafe1', password: DEMO_PASSWORD, ip: '2001:db8:1:1::99' });
    check('S3 info REPRO: 8 failures from 8 addresses of one IPv6 /64 never hit the pair or IP limit', v6s.every((s) => s === 401) && v6pair.status === 200, `${v6s.join(',')} then correct -> ${short(v6pair)}`);

    const tUnknown = [];
    const tKnown = [];
    for (let i = 0; i < 12; i += 1) {
      tUnknown.push((await rawSignin(h, { username: `ghost-${i}`, password: 'wrong-password', ip: `192.0.2.${10 + i}` })).ms);
      tKnown.push((await rawSignin(h, { username: 'supplier-e', password: 'wrong-password', ip: `192.0.2.${100 + i}` })).ms);
    }
    const med = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
    const mu = med(tUnknown);
    const mk = med(tKnown);
    check('S3 timing: unknown vs known-wrong median within 35 %', Math.abs(mu - mk) / Math.max(mu, mk) < 0.35, `unknown ${mu.toFixed(1)} ms, known ${mk.toFixed(1)} ms`);
  } finally {
    await h.close();
  }

  const w = await world();
  try {
    const st = [];
    for (let i = 0; i < 5; i += 1) st.push((await rawSignin(w.h, { username: 'cafe1', password: 'bad', ip: `10.9.9.${i}` })).status);
    const sixth = await rawSignin(w.h, { username: 'cafe1', password: DEMO_PASSWORD, ip: '10.9.9.200' });
    check('S3 trust off: rotating X-Forwarded-For does not reset the pair budget', sixth.status === 429, `${st.join(',')} | ${short(sixth)}`);
  } finally {
    await w.h.close();
  }
}

// ---------------------------------------------------------------- S4 register
async function s4() {
  console.log('== S4 registration');
  const { h, count } = await world();
  try {
    const reg = async (body, headers = {}) => {
      const tok = await preLoginToken(h);
      return h.request({ method: 'POST', path: '/api/auth/register', headers: { 'X-CSRF-Token': tok, ...headers }, jsonBody: body });
    };
    const bad = [];
    bad.push(short(await reg({ username: 'a\r\nSet-Cookie: x=1', password: 'long-enough-pw', displayName: 'X' })));
    bad.push(short(await reg({ username: 'okname1', password: 'long-enough-pw', displayName: 'line\nbreak' })));
    bad.push(short(await reg({ username: 'okname2', password: 'long-enough-pw', displayName: `sep${String.fromCharCode(0x2028)}x` })));
    bad.push(short(await reg({ username: 'okname3', password: 'long-enough-pw', displayName: '\u0085' })));
    bad.push(short(await reg({ username: 'okname4', password: 'short', displayName: 'X' })));
    check('S4 header/log-injection shapes and short password -> 422 and consume no register budget', bad.every((s) => s === '422 VALIDATION_FAILED') && count('rate_events', "kind = 'register'") === 0, bad.join(','));
    const r1 = await reg({ username: 'role-probe', password: 'long-enough-pw', displayName: '<img src=x onerror=alert(1)>', role: 'admin', supplierId: 1 });
    const row = h.db.prepare("SELECT role, supplier_id, display_name FROM users WHERE username = 'role-probe'").get();
    check('S4 role/supplierId in the body are ignored (customer, no supplier)', r1.status === 201 && row.role === 'customer' && row.supplier_id === null, JSON.stringify(row));
    const taken = await reg({ username: 'ADMIN', password: 'long-enough-pw', displayName: 'X' });
    check('S4 "ADMIN" cannot be registered (409 USERNAME_TAKEN, admin row reserved)', taken.status === 409, short(taken));
    const st = [];
    for (let i = 0; i < 5; i += 1) st.push((await reg({ username: `cap-${i}`, password: 'long-enough-pw', displayName: 'X' })).status);
    check('S4 register cap: 5 admitted per IP per hour (1 ok + 1 taken + 3 more), then 429', st.slice(0, 3).every((s) => s === 201) && st[3] === 429 && st[4] === 429, st.join(','));
  } finally {
    await h.close();
  }
  const h2 = await startHarness({ seed: true, record: false });
  try {
    const state = await ensureAdmin({ db: h2.db, config: h2.config, clock: h2.clock });
    const s = await rawSignin(h2, { username: 'admin', password: 'anything-at-all-123' });
    check('S4 no RS_ADMIN_PASSWORD: admin row disabled, sign-in 401', state === 'disabled' && s.status === 401, `${state} ${short(s)}`);
  } finally {
    await h2.close();
  }
}

// ---------------------------------------------------------------- S5 route enumeration, default deny, signature policy
async function s5() {
  console.log('== S5 every registered route x anonymous/customer/supplier/admin');
  const { h, clientAt } = await world();
  try {
    const roles = { customer: clientAt(), supplier: clientAt(), admin: clientAt() };
    await roles.customer.signIn('cafe1', DEMO_PASSWORD);
    await roles.supplier.signIn('supplier-a', DEMO_PASSWORD);
    await roles.admin.signIn('admin', ADMIN_PW);
    // sign-out last, so it does not end the role sessions used for the other routes
    const routes = h.app.router.list().sort((a, b) => (a.template === '/api/auth/signout') - (b.template === '/api/auth/signout'));
    note(`routes: ${routes.map((r) => `${r.method} ${r.template} [${r.policy}]`).join('; ')}`);
    const policies = new Set(routes.map((r) => r.policy));
    check('S5 policies in use are public/session/customer/supplier/admin only', [...policies].every((p) => ['public', 'session', 'customer', 'supplier', 'admin'].includes(p)), [...policies].join(','));
    const bad = [];
    let cells = 0;
    for (const route of routes) {
      const path = route.template.replace(/:[A-Za-z]+/g, '999999');
      const send = (client) => client.send({ method: route.method, path, jsonBody: route.method === 'GET' ? undefined : {}, headers: { 'Idempotency-Key': KEY(1) } });
      if (route.policy === 'public') continue;
      const anon = await h.request({ method: route.method, path, jsonBody: route.method === 'GET' ? undefined : {} });
      cells += 1;
      if (anon.status !== 401) bad.push(`anon ${route.method} ${route.template} -> ${short(anon)}`);
      for (const [role, client] of Object.entries(roles)) {
        const res = await send(client);
        cells += 1;
        const allowed = route.policy === 'session' || route.policy === role;
        if (!allowed && !(res.status === 403 && res.json?.error?.code === 'FORBIDDEN')) bad.push(`${role} ${route.method} ${route.template} -> ${short(res)}`);
        if (allowed && (res.status === 401 || res.status === 403)) bad.push(`${role} (allowed) ${route.method} ${route.template} -> ${short(res)}`);
      }
    }
    check(`S5 default deny: ${routes.filter((r) => r.policy !== 'public').length} non-public routes x 4 callers (${cells} cells): anonymous 401, wrong role 403 FORBIDDEN, right role passes the hook`, bad.length === 0, bad.join(' ; '));
    const methodProbe = await roles.customer.send({ method: 'DELETE', path: '/api/requests/1' });
    check('S5 unregistered method on a known path -> 404/405, never a handler', [404, 405].includes(methodProbe.status), short(methodProbe));
  } finally {
    await h.close();
  }

  let called = 0;
  const extra = (router) => {
    router.add('POST', '/api/probe/sig', () => { called += 1; return { status: 200, body: { reached: true } }; }, { policy: 'signature' });
    router.add('GET', '/api/webhooks/paypal/:merchantKey', () => { called += 1; return { status: 200, body: {} }; }, { policy: 'signature' });
    router.add('POST', '/api/webhooks/paypal/:merchantKey', () => { called += 100; return { status: 200, body: { webhook: true } }; }, { policy: 'signature' });
  };
  const w = await startHarness({ seed: true, record: false, routes: [extra] });
  try {
    const a = await w.request({ method: 'POST', path: '/api/probe/sig', jsonBody: {} });
    const b = await w.request({ method: 'GET', path: '/api/webhooks/paypal/A' });
    check('S5 signature policy on any other route (or GET on the webhook path) -> 403 and the handler never runs', a.status === 403 && b.status === 403 && called === 0, `${short(a)} ${short(b)} called=${called}`);
    const c = await w.request({ method: 'POST', path: '/api/webhooks/paypal/A', jsonBody: {} });
    check('S5 signature policy on POST /api/webhooks/paypal/:merchantKey reaches the handler with no session/CSRF (e3 must verify)', c.status === 200 && called === 100, short(c));
  } finally {
    await w.close();
  }
}

// ---------------------------------------------------------------- S6 customer isolation (RS-27)
async function s6() {
  console.log('== S6 customer isolation, sequential ids, no side effects');
  const { h, clientAt, count } = await world();
  try {
    const owner = clientAt();
    await owner.signIn('cafe1', DEMO_PASSWORD);
    const { requestId, plan } = await makePlan(owner);
    const thief = clientAt();
    await thief.signIn('cafe2', DEMO_PASSWORD);
    const tables = ['requirements', 'planning_runs', 'plan_versions', 'plan_approvals', 'reservations', 'idempotency_keys', 'rate_events', 'supplier_orders', 'audit_events', 'replan_queue'];
    const snap = () => Object.fromEntries(tables.map((t) => [t, count(t)]));
    const before = snap();
    const attempts = [
      await thief.get(`/api/requests/${requestId}`),
      await thief.post(`/api/requests/${requestId}/confirm`, { fields: canonicalFields(DEMO_DATE, { cupQuantity: 1 }) }),
      await thief.post(`/api/requests/${requestId}/plan`, {}),
      await thief.post(`/api/plans/${plan.id}/approve`, { expectedTotalCents: plan.body.totalCents, planHash: plan.planHash }),
      await reserve(thief, plan.id, KEY(77)),
    ];
    const after = snap();
    check('S6 RS-27: foreign request/plan ids -> 404 NOT_FOUND on GET, confirm, plan, approve, reserve', attempts.every((r) => r.status === 404 && r.json.error.code === 'NOT_FOUND'), attempts.map(short).join(','));
    check('S6 no row written by the foreign attempts (10 tables incl. rate_events and audit)', JSON.stringify(before) === JSON.stringify(after), JSON.stringify(after));
    const unknown = await thief.get('/api/requests/987654');
    check('S6 foreign id and nonexistent id answer identically (code and message)', unknown.json.error.code === attempts[0].json.error.code && unknown.json.error.message === attempts[0].json.error.message);
    const seen = [];
    for (let id = 1; id <= 40; id += 1) {
      const r = await thief.get(`/api/requests/${id}`);
      if (r.status !== 404) seen.push(`${id}:${r.status}`);
    }
    for (let id = 1; id <= 20; id += 1) {
      const r = await thief.post(`/api/plans/${id}/approve`, { expectedTotalCents: 1, planHash: '0'.repeat(64) });
      if (r.status !== 404) seen.push(`plan ${id}:${r.status}`);
    }
    check('S6 sequential probing: requests 1..40 and plans 1..20 by cafe2 all 404', seen.length === 0, seen.join(','));
    const list = await thief.get('/api/requests');
    check("S6 list shows only the caller's requests", list.status === 200 && (list.json.requests ?? []).length === 0, `${list.json.requests?.length} items`);
    const ownerView = await owner.get(`/api/requests/${requestId}`);
    check('S6 RequestView carries no password hash, session or csrf data', !/scrypt\$|password|csrf|id_hash/i.test(JSON.stringify(ownerView.json)));
  } finally {
    await h.close();
  }
}

// ---------------------------------------------------------------- S7 supplier isolation (RS-28)
async function s7() {
  console.log('== S7 supplier isolation on orders and inventory');
  const { h, clientAt, count } = await world();
  try {
    const cust = clientAt();
    await cust.signIn('cafe1', DEMO_PASSWORD);
    const { plan } = await makePlan(cust);
    const rr = await reserve(cust, plan.id, KEY(1));
    check('S7 setup: reservation created', rr.status === 201, short(rr));
    const supA = clientAt();
    await supA.signIn('supplier-a', DEMO_PASSWORD);
    const supC = clientAt();
    await supC.signIn('supplier-c', DEMO_PASSWORD);
    const aList = await supA.get('/api/supplier/orders');
    const aId = aList.json.orders[0]?.id;
    const snapOrders = () => JSON.stringify(h.db.prepare('SELECT id, fulfilment_status, refusal_reason, committed_qty_json FROM supplier_orders ORDER BY id').all());
    const before = snapOrders();
    const attempts = [
      await supC.post(`/api/supplier/orders/${aId}/confirm`, { lines: [{ offerId: 1, committedBundles: 1 }], committedReadyAt: '2026-10-20T07:00:00.000Z' }),
      await supC.post(`/api/supplier/orders/${aId}/refuse`, { reason: 'not mine' }),
      await supC.post(`/api/supplier/orders/${aId}/ready`, {}),
      await supC.post(`/api/supplier/orders/${aId}/handover`, {}),
    ];
    check(`S7 RS-28: supplier C on supplier A's order ${aId}: 404 on confirm/refuse/ready/handover, nothing changed`, attempts.every((r) => r.status === 404) && before === snapOrders(), attempts.map(short).join(','));
    const cList = await supC.get('/api/supplier/orders');
    check("S7 supplier C's order list excludes A's orders", cList.json.orders.every((o) => o.id !== aId), `${cList.json.orders.length} orders`);
    const badStatus = await supC.get(`/api/supplier/orders?status=${encodeURIComponent("x' OR 1=1--")}`);
    const allStatus = await supC.get('/api/supplier/orders?status=awaiting_supplier');
    check('S7 status filter with SQL text -> 400/422 or empty, real filter still scoped', ([400, 422].includes(badStatus.status) || (badStatus.status === 200 && badStatus.json.orders.length === 0)) && allStatus.json.orders.every((o) => o.id !== aId), `${short(badStatus)} ${short(allStatus)}`);
    const aInv = (await supA.get('/api/supplier/inventory')).json.items;
    const cInv = (await supC.get('/api/supplier/inventory')).json.items;
    const invBefore = JSON.stringify(h.db.prepare('SELECT * FROM inventory ORDER BY product_id').all());
    const offersBefore = count('offers');
    const mixed = await supC.send({ method: 'PATCH', path: '/api/supplier/inventory', jsonBody: { items: [{ productId: cInv[0].productId, onHand: 50 }, { productId: aInv[0].productId, onHand: 0, priceCents: 1 }] } });
    const invAfter = JSON.stringify(h.db.prepare('SELECT * FROM inventory ORDER BY product_id').all());
    check("S7 RS-28: PATCH naming A's product with C's own -> 403, whole patch refused, inventory and offers unchanged", mixed.status === 403 && invBefore === invAfter && count('offers') === offersBefore, short(mixed));
    const reservedItem = aInv.find((i) => i.reserved > 0);
    const below = await supA.send({ method: 'PATCH', path: '/api/supplier/inventory', jsonBody: { items: [{ productId: reservedItem.productId, onHand: 0 }] } });
    check('S7 onHand below reserved -> 409 RESERVED_STOCK (reserved <= on_hand holds)', below.status === 409 && below.json.error.code === 'RESERVED_STOCK', short(below));
    check('S7 invariant reserved <= on_hand on every row', count('inventory', 'reserved > on_hand OR reserved < 0') === 0);
  } finally {
    await h.close();
  }
}

// ---------------------------------------------------------------- S8 money and state
async function s8() {
  console.log('== S8 approval guards, idempotency, caps, supersession, expiry, reset');
  const { h, clientAt, count, addStock } = await world();
  try {
    const c1 = clientAt();
    await c1.signIn('cafe1', DEMO_PASSWORD);
    const p1 = await makePlan(c1, {}, false);
    const plan = p1.plan;
    const t1 = await c1.post(`/api/plans/${plan.id}/approve`, { expectedTotalCents: plan.body.totalCents, planHash: 'f'.repeat(64) });
    const t2 = await c1.post(`/api/plans/${plan.id}/approve`, { expectedTotalCents: 1, planHash: plan.planHash });
    const t3 = await c1.post(`/api/plans/${plan.id}/approve`, { expectedTotalCents: String(plan.body.totalCents), planHash: plan.planHash });
    check('S8 RS-12: tampered hash or total -> 409 PLAN_CHANGED; a string total -> 422; no approval row', t1.status === 409 && t1.json.error.code === 'PLAN_CHANGED' && t2.status === 409 && t3.status === 422 && count('plan_approvals') === 0, `${short(t1)} ${short(t2)} ${short(t3)}`);
    const ok = await c1.post(`/api/plans/${plan.id}/approve`, { expectedTotalCents: plan.body.totalCents, planHash: plan.planHash, totalCents: 1, body: { totalCents: 1 } });
    const appr = h.db.prepare('SELECT approved_total_cents FROM plan_approvals').get();
    check('S8 client-supplied totals ignored: stored approval total is the server total', ok.status === 200 && appr.approved_total_cents === plan.body.totalCents, `${appr.approved_total_cents}`);

    const noKey = await c1.post(`/api/plans/${plan.id}/reserve`, {});
    const badKey = await reserve(c1, plan.id, 'short');
    check('S8 reserve without key -> 400, malformed key -> 422', noKey.status === 400 && badKey.status === 422, `${short(noKey)} ${short(badKey)}`);
    const r1 = await reserve(c1, plan.id, KEY(1));
    const r1b = await reserve(c1, plan.id, KEY(1));
    check('S8 RS-16: same key replays the same reservation with Idempotent-Replayed', r1.status === 201 && r1b.json?.reservation?.id === r1.json.reservation.id && r1b.headers['idempotent-replayed'] === 'true' && count('reservations') === 1, `${short(r1)} ${short(r1b)}`);
    const orderTotals = h.db.prepare('SELECT SUM(total_cents) AS s FROM supplier_orders WHERE reservation_id = ?').get(r1.json.reservation.id).s;
    check('S8 order totals at reserve equal the approved total', orderTotals === plan.body.totalCents, `${orderTotals}`);

    const p2 = await makePlan(c1, { cupQuantity: 100, lidQuantity: 100, maxPickups: 5, budgetCents: 100000 });
    const reuse = await reserve(c1, p2.plan?.id, KEY(1));
    check('S8 F-TR-1: the same key on another plan -> 422 IDEMPOTENCY_KEY_REUSED', reuse.status === 422 && reuse.json.error.code === 'IDEMPOTENCY_KEY_REUSED', `${short(reuse)} plan2=${p2.plan?.id ?? 'none: ' + short(p2.made)}`);
    const cap = await reserve(c1, p2.plan?.id, KEY(2));
    check('S8 SEC-2: a second live reservation -> 409 RESERVATION_LIMIT, no row', cap.status === 409 && cap.json.error.code === 'RESERVATION_LIMIT' && count('reservations') === 1, short(cap));
    h.db.prepare('DELETE FROM idempotency_keys').run();
    const reusePurged = await reserve(c1, p2.plan?.id, KEY(1));
    const replayPurged = await reserve(c1, plan.id, KEY(1));
    check('S8 after the key purge: other plan -> 422, same plan -> 200 replay', reusePurged.status === 422 && replayPurged.status === 200 && replayPurged.json.reservation.id === r1.json.reservation.id, `${short(reusePurged)} ${short(replayPurged)}`);

    addStock(10);
    const c2 = clientAt();
    await c2.signIn('cafe2', DEMO_PASSWORD);
    const q = await makePlan(c2, { maxPickups: 5, budgetCents: 100000 });
    const cross = await reserve(c2, q.plan?.id, KEY(1));
    check("S8 key scope is per user: cafe2's use of cafe1's key on its own plan is a fresh 201, not a replay", cross.status === 201 && cross.json.reservation.id !== r1.json.reservation.id && !cross.headers['idempotent-replayed'], `${short(cross)} plan=${q.plan?.id}`);

    const c3 = clientAt();
    await c3.register({ username: 'race-probe', password: 'long-enough-pw' });
    const ra = await makePlan(c3, { maxPickups: 5, budgetCents: 100000 });
    const rb = await makePlan(c3, { maxPickups: 5, budgetCents: 100000, cupQuantity: 150, lidQuantity: 150 });
    const [x, y] = await Promise.all([reserve(c3, ra.plan?.id, KEY(31)), reserve(c3, rb.plan?.id, KEY(32))]);
    const uid3 = h.db.prepare("SELECT id FROM users WHERE username = 'race-probe'").get().id;
    check('S8 SEC-2 race: two parallel reserves of two plans by one customer -> exactly one active reservation', count('reservations', "customer_id = ? AND status = 'active'", uid3) === 1, `${short(x)} ${short(y)}`);

    // supersession by supplier A's price change: A confirms order o1 (commitment stands, spec Supersession),
    // order o2 of another reserved plan on the same product is still awaiting -> that plan must be superseded.
    const supA = clientAt();
    await supA.signIn('supplier-a', DEMO_PASSWORD);
    const aOrders = (await supA.get('/api/supplier/orders')).json.orders.filter((o) => o.fulfilmentStatus === 'awaiting_supplier');
    let o1 = null;
    for (const o of aOrders) {
      const conf = await supA.post(`/api/supplier/orders/${o.id}/confirm`, { lines: o.lines.map((l) => ({ offerId: l.offerId, committedBundles: l.bundles })), committedReadyAt: '2026-10-20T07:00:00.000Z' });
      if (conf.status === 200) { o1 = o; break; }
      note(`confirm ${o.id}: ${short(conf)} ${JSON.stringify(conf.json?.error?.details ?? {})}`);
    }
    const o2 = aOrders.find((o) => o !== o1);
    if (o1 && o2) {
      const productId = h.db.prepare('SELECT product_id FROM offers WHERE id = ?').get(o1.lines[0].offerId).product_id;
      const row = (id) => h.db.prepare('SELECT so.fulfilment_status AS f, so.total_cents AS t, so.reservation_id AS r, pv.status AS p FROM supplier_orders so JOIN plan_versions pv ON pv.id = so.plan_version_id WHERE so.id = ?').get(id);
      const o1Before = row(o1.id);
      const price = h.db.prepare("SELECT price_cents FROM offers WHERE product_id = ? AND status = 'active'").get(productId).price_cents;
      const patch = await supA.send({ method: 'PATCH', path: '/api/supplier/inventory', jsonBody: { items: [{ productId, priceCents: price + 1 }] } });
      const a1 = row(o1.id);
      const a2 = row(o2.id);
      const res2 = h.db.prepare('SELECT status FROM reservations WHERE id = ?').get(a2.r).status;
      const sib2 = h.db.prepare('SELECT fulfilment_status FROM supplier_orders WHERE reservation_id = ?').all(a2.r).map((s) => s.fulfilment_status);
      check('S8 supersession: price change supersedes the plan of the UNCONFIRMED order: its orders cancelled, reservation released', patch.status === 200 && a2.p === 'superseded' && a2.f === 'cancelled' && res2 === 'released' && sib2.every((s) => s === 'cancelled'), `${short(patch)} o2 plan=${a2.p} order=${a2.f} reservation=${res2} siblings=${sib2.join('/')}`);
      check('S8 supersession: the CONFIRMED order keeps its plan and its approved total (customer pays the approved price)', a1.f === 'confirmed' && a1.p === 'approved' && a1.t === o1Before.t, `o1 plan=${a1.p} order=${a1.f} total ${o1Before.t}->${a1.t}`);
    } else check('S8 supersession setup: two awaiting A orders, one confirmed', false, `${aOrders.length} awaiting`);
    check('S8 global: no active reservation and no awaiting/confirmed order on a superseded or non-executable plan', count(...ACTIVE_ON_DEAD_PLAN) === 0 && count(...OPEN_ON_DEAD_PLAN) === 0);
    check('S8 invariant reserved <= on_hand after supersession', count('inventory', 'reserved > on_hand OR reserved < 0') === 0);
    const ledgerOk = h.db.prepare('SELECT i.product_id, i.reserved, COALESCE(SUM(l.delta_reserved),0) AS s FROM inventory i LEFT JOIN inventory_ledger l ON l.product_id = i.product_id GROUP BY i.product_id').all().every((r) => r.reserved === r.s);
    check('S8 ledger: sum of delta_reserved equals inventory.reserved for every product', ledgerOk);

    // requirements change by the customer on a plan whose supplier order is CONFIRMED
    const live = h.db.prepare("SELECT r.id, pv.request_id, r.customer_id FROM reservations r JOIN plan_versions pv ON pv.id = r.plan_version_id JOIN supplier_orders so ON so.reservation_id = r.id WHERE r.status = 'active' AND so.fulfilment_status = 'confirmed' LIMIT 1").get()
      ?? h.db.prepare("SELECT r.id, pv.request_id, r.customer_id FROM reservations r JOIN plan_versions pv ON pv.id = r.plan_version_id WHERE r.status = 'active' LIMIT 1").get();
    if (live) {
      const who = h.db.prepare('SELECT username FROM users WHERE id = ?').get(live.customer_id).username;
      const cc = clientAt();
      await cc.signIn(who, who === 'race-probe' ? 'long-enough-pw' : DEMO_PASSWORD);
      const ch = await cc.post(`/api/requests/${live.request_id}/confirm`, { fields: canonicalFields(DEMO_DATE, { cupQuantity: 210, lidQuantity: 210, maxPickups: 5, budgetCents: 100000 }) });
      const st = h.db.prepare('SELECT status FROM reservations WHERE id = ?').get(live.id).status;
      const ords = h.db.prepare('SELECT fulfilment_status FROM supplier_orders WHERE reservation_id = ?').all(live.id).map((o) => o.fulfilment_status);
      check('S8 requirements change while reserved (incl. a confirmed order): reservation released, every order cancelled', ch.status === 201 && st === 'released' && ords.every((s) => s === 'cancelled'), `${short(ch)} reservation ${st} orders ${ords.join('/')}`);
    } else check('S8 requirements-change setup: a live reservation exists', false);

    const c4 = clientAt();
    await c4.register({ username: 'expiry-probe', password: 'long-enough-pw' });
    const e = await makePlan(c4, { maxPickups: 5, budgetCents: 100000 });
    const er = await reserve(c4, e.plan?.id, KEY(41));
    h.clock.advance((h.config.reservationTtlMin + 1) * 60 * 1000);
    const ctx = { ...h.app.deps, requestId: null };
    const first = expireDueReservations(ctx);
    const second = expireDueReservations(ctx);
    const expRows = count('inventory_ledger', "reason = 'expire' AND ref_id = ?", er.json?.reservation?.id ?? -1);
    const ordersAfter = h.db.prepare('SELECT fulfilment_status FROM supplier_orders WHERE reservation_id = ?').all(er.json?.reservation?.id ?? -1).map((o) => o.fulfilment_status);
    check('S8 expiry exactly once: first pass expires, second finds nothing, expire ledger rows, orders cancelled', er.status === 201 && first.expired.length >= 1 && second.expired.length === 0 && expRows >= 1 && ordersAfter.every((s) => s === 'cancelled'), `${short(er)} first=${first.expired.length} second=${second.expired.length} rows=${expRows} orders=${ordersAfter.join('/')}`);
    check('S8 invariant after expiry', count('inventory', 'reserved > on_hand OR reserved < 0') === 0 && count(...ACTIVE_ON_DEAD_PLAN) === 0 && count(...OPEN_ON_DEAD_PLAN) === 0);

    const c5 = clientAt();
    await c5.register({ username: 'plan-probe', password: 'long-enough-pw' });
    const pr = await makePlan(c5, { maxPickups: 5, budgetCents: 100000 }, false);
    const pst = [];
    for (let i = 0; i < 10; i += 1) pst.push((await c5.post(`/api/requests/${pr.requestId}/plan`, {})).status);
    check('S8 FU-8: planning limit 10 per 10 min (setup used 1): 9 x 201 then 429 limit plan', pst.slice(0, 9).every((s) => s === 201) && pst[9] === 429, pst.join(','));

    const adm = clientAt();
    await adm.signIn('admin', ADMIN_PW);
    const op = h.db.prepare('SELECT id FROM payment_operations ORDER BY id LIMIT 1').get();
    h.db.prepare("UPDATE payment_operations SET status = 'authorized' WHERE id = ?").run(op.id);
    const reqBefore = count('rescue_requests', 'archived_at IS NULL');
    const blocked = await adm.post('/api/admin/reset', {});
    check('S8 RS-37: reset with an authorized operation -> 409 RESET_BLOCKED, nothing archived', blocked.status === 409 && blocked.json.error.code === 'RESET_BLOCKED' && count('rescue_requests', 'archived_at IS NULL') === reqBefore, short(blocked));
    const noReason = await adm.post('/api/admin/reset', { force: true });
    const forced = await adm.post('/api/admin/reset', { force: true, reason: 'probe forced reset reason' });
    check('S8 forced reset needs a reason; then archives (operations kept, archived_at set) and lists stranded', noReason.status === 422 && forced.status === 200 && count('payment_operations', 'archived_at IS NULL') === 0 && count('payment_operations') > 0 && Array.isArray(forced.json.stranded), `${short(noReason)} ${short(forced)} stranded=${JSON.stringify(forced.json.stranded)}`);
    check('S8 after reset: no active reservation, reserved all 0', count('reservations', "status = 'active'") === 0 && count('inventory', 'reserved <> 0') === 0);
  } finally {
    await h.close();
  }
}

// ---------------------------------------------------------------- S9 flooding exposure (FU-15)
async function s9() {
  console.log('== S9 flooding exposure without the general 300/min limit (FU-15)');
  const { h, clientAt, count } = await world();
  try {
    const c = clientAt();
    await c.signIn('cafe1', DEMO_PASSWORD);
    const { requestId } = await makePlan(c, {}, false);
    const N = 600;
    let t0 = performance.now();
    let limited = 0;
    for (let i = 0; i < N; i += 1) if ((await c.get(`/api/requests/${requestId}`)).status === 429) limited += 1;
    let dt = performance.now() - t0;
    check(`S9 REPRO (FU-15): ${N} RequestView reads by one customer in one frozen minute, none limited`, limited === 0, `${(N / (dt / 1000)).toFixed(0)} req/s sequential`);
    const reqBefore = count('requirements');
    const auditBefore = count('audit_events');
    const bytesBefore = h.db.prepare('SELECT COALESCE(SUM(length(fields_json)),0) AS b FROM requirements').get().b;
    t0 = performance.now();
    limited = 0;
    for (let i = 0; i < 300; i += 1) {
      const r = await c.post(`/api/requests/${requestId}/confirm`, { fields: canonicalFields(DEMO_DATE, { cupQuantity: 200 + (i % 2) }) });
      if (r.status === 429) limited += 1;
    }
    dt = performance.now() - t0;
    const bytes = h.db.prepare('SELECT COALESCE(SUM(length(fields_json)),0) AS b FROM requirements').get().b - bytesBefore;
    check('S9 REPRO (FU-15): 300 confirms in one frozen minute -> 300 requirements versions + 300 audit rows, none limited', limited === 0 && count('requirements') - reqBefore === 300, `+${count('requirements') - reqBefore} requirements (${bytes} bytes of fields_json), +${count('audit_events') - auditBefore} audit rows, ${dt.toFixed(0)} ms`);
    t0 = performance.now();
    let anonOk = 0;
    for (let i = 0; i < N; i += 1) if ((await h.request({ path: '/api/auth/csrf' })).status === 200) anonOk += 1;
    dt = performance.now() - t0;
    check(`S9 ${N} anonymous GET /api/auth/csrf all answered (stateless, no DB write)`, anonOk === N, `${(N / (dt / 1000)).toFixed(0)} req/s`);
    const sp = [];
    for (let i = 0; i < 25; i += 1) sp.push((await rawSignin(h, { username: `flood-${i}`, password: 'x' })).status);
    check('S9 anonymous sign-in flood from one IP: cheap 429 after 20 (no scrypt)', sp.slice(20).every((s) => s === 429), sp.join(','));
  } finally {
    await h.close();
  }
}

// ---------------------------------------------------------------- S10 input handling
async function s10() {
  console.log('== S10 input handling, error envelope, untrusted supplier text');
  const { h, clientAt, addStock } = await world();
  try {
    const c = clientAt();
    await c.signIn('cafe1', DEMO_PASSWORD);
    const long = await c.post('/api/requests', { text: 'x'.repeat(4001) });
    const nul = await c.post('/api/requests', { text: 'a\u0000b' });
    const notStr = await c.post('/api/requests', { text: ['a'] });
    check('S10 request text: 4001 chars, NUL, non-string -> 422', [long, nul, notStr].every((r) => r.status === 422), [long, nul, notStr].map(short).join(','));
    let deep = '{}';
    for (let i = 0; i < 40; i += 1) deep = `{"a":${deep}}`;
    const dr = await c.send({ method: 'POST', path: '/api/requests', body: deep, headers: { 'Content-Type': 'application/json' } });
    check('S10 SEC-B-3: 40-deep body -> 422 (not 500)', dr.status === 422, short(dr));
    const ids = ['0', '01', '1e3', '-1', '9999999999999999', 'abc', '1%2F2'];
    const idr = [];
    for (const id of ids) idr.push((await c.get(`/api/requests/${id}`)).status);
    check('S10 id formats 0/01/1e3/-1/16 digits/abc/encoded slash -> 400, never 500', idr.every((s) => s === 400 || s === 404), idr.join(','));
    const { requestId } = await makePlan(c, {}, false);
    const prov = await c.post(`/api/requests/${requestId}/confirm`, { fields: { ...canonicalFields(DEMO_DATE), provenance: 'image' }, extra: 1 });
    const provBad = await c.post(`/api/requests/${requestId}/confirm`, { fields: canonicalFields(DEMO_DATE, { cupQuantity: { value: 200, provenance: 'image' } }) });
    check('S10 SEC-8: client provenance ignored (manual); an object value -> 422', prov.status === 201 && prov.json.requirements.fields.cupQuantity.provenance === 'manual' && provBad.status === 422, `${short(prov)} ${short(provBad)}`);
    const arr = await c.post(`/api/requests/${requestId}/confirm`, { fields: [1, 2] });
    check('S10 confirm fields as array -> 422', arr.status === 422, short(arr));
    const adm = clientAt();
    await adm.signIn('admin', ADMIN_PW);
    const tl = [];
    for (const q of ['afterId=1.0.1%20OR%201=1', 'limit=0', 'limit=501', 'requestId=1;DROP', 'afterId=99999999999999999.0.1']) tl.push((await adm.get(`/api/admin/timeline?${q}`)).status);
    check('S10 timeline query injection shapes -> 422', tl.every((s) => s === 422), tl.join(','));
    const unk = await adm.post('/api/admin/faults', { kind: 'eval', code: 'process.exit()' });
    check('S10 unknown fault kind -> 422', unk.status === 422, short(unk));

    addStock(5);
    const cust2 = clientAt();
    await cust2.signIn('cafe2', DEMO_PASSWORD);
    const pl = await makePlan(cust2, { maxPickups: 5, budgetCents: 100000 });
    const rs = await reserve(cust2, pl.plan?.id, KEY(5));
    const firstOrder = rs.json?.orders?.[0];
    const code = h.db.prepare('SELECT s.code FROM supplier_orders so JOIN suppliers s ON s.id = so.supplier_id WHERE so.id = ?').get(firstOrder?.id ?? -1)?.code;
    const sup = clientAt();
    await sup.signIn(`supplier-${(code ?? 'a').toLowerCase()}`, DEMO_PASSWORD);
    const payload = `Closed today\n{"level":"error","msg":"forged"}${String.fromCharCode(0x2028)}<img src=x onerror=alert(1)> javascript:alert(1)`;
    const ctrl = await sup.post(`/api/supplier/orders/${firstOrder?.id}/refuse`, { reason: 'bell\u0007' });
    const ref = await sup.post(`/api/supplier/orders/${firstOrder?.id}/refuse`, { reason: payload });
    check('S10 refusal reason: C0 control -> 422; line breaks/markup accepted (RS-17 shows the text)', ctrl.status === 422 && ref.status === 200, `${short(ctrl)} ${short(ref)}`);
    const logs = h.lines.join('');
    const audit = JSON.stringify(h.db.prepare('SELECT detail_json FROM audit_events').all());
    check('S10 SEC-7: the supplier text reaches neither the log lines nor audit_events', !logs.includes('forged') && !logs.includes('onerror') && !audit.includes('forged') && !audit.includes('onerror'));
    check('S10 log: every line is exactly one JSON object', h.lines.every((l) => { const body = l.endsWith('\n') ? l.slice(0, -1) : l; try { return !body.includes('\n') && typeof JSON.parse(body) === 'object'; } catch { return false; } }), `${h.lines.length} lines`);
    const view = await cust2.get(`/api/requests/${pl.requestId}`);
    check('S10 the refusal text reaches the customer RequestView as a JSON string (data)', JSON.stringify(view.json).includes('onerror'), `${view.status}`);
    const li = await rawSignin(h, { username: 'admin\n{"msg":"forged-login"}', password: 'x' });
    check('S10 log injection via the sign-in username: not logged, lines stay JSON', li.status === 401 && !h.lines.join('').includes('forged-login'), short(li));
    check('S10 error bodies carry no stack, path or SQL text', [long, dr, unk, provBad].every((r) => !/at \w+ \(|\/src\/|SQLITE|node:/.test(r.text)));
  } finally {
    await h.close();
  }
}

// ---------------------------------------------------------------- S11 frontend dom.js and public/**
async function s11() {
  console.log('== S11 dom.js attribute and URL guards; public/** scan');
  const dom = await import('../../public/js/dom.js');
  const fakeDoc = {
    createElement: (tag) => ({ tag, attrs: {}, children: [], setAttribute(k, v) { this.attrs[k] = v; }, appendChild(c) { this.children.push(c); }, addEventListener() {}, get firstChild() { return this.children[0]; }, removeChild(c) { this.children.splice(this.children.indexOf(c), 1); } }),
    createTextNode: (t) => ({ text: t }),
    createDocumentFragment: () => ({ children: [], appendChild(c) { this.children.push(c); } }),
  };
  dom.setDocument(fakeDoc);
  const refused = (fn) => { try { fn(); return false; } catch { return true; } };
  const hrefs = ['javascript:alert(1)', ' JavaScript:alert(1)', 'java\tscript:alert(1)', '\u0000javascript:alert(1)', 'data:text/html,<script>alert(1)</script>', 'vbscript:x', '//evil.example/x', 'mailto:x@y'];
  const r1 = hrefs.map((v) => refused(() => dom.el('a', { href: v })));
  check('S11 dom.js refuses javascript:/data:/vbscript:/protocol-relative/mailto hrefs', r1.every(Boolean), hrefs.map((v, i) => `${JSON.stringify(v)}:${r1[i] ? 'refused' : 'ALLOWED'}`).join(' '));
  const attrs = ['onclick', 'onerror', 'ONCLICK', 'style', 'srcdoc', 'on-x', 'xlink:href', 'formaction'];
  const r2 = attrs.map((a) => refused(() => dom.el('a', { [a]: a === 'formaction' ? 'javascript:x' : 'x' })));
  check('S11 dom.js refuses on*/style/srcdoc/namespaced attributes and javascript: formaction', r2.every(Boolean), attrs.map((a, i) => `${a}:${r2[i] ? 'refused' : 'ALLOWED'}`).join(' '));
  const sneaky = ['/\\evil.example/x', '/\t/evil.example/x', '/\n/evil.example/x'];
  const r3 = sneaky.map((v) => !refused(() => dom.el('a', { href: v })));
  const resolved = sneaky.map((v) => new URL(v, 'http://127.0.0.1:8080/').host);
  check('S11 info REPRO: dom.js accepts "/\\host", "/<TAB>/host", "/<LF>/host", which the WHATWG URL parser resolves off-origin', r3.every(Boolean) && resolved.every((x) => x === 'evil.example'), sneaky.map((v, i) => `${JSON.stringify(v)} -> ${r3[i] ? 'allowed' : 'refused'} -> ${resolved[i]}`).join(' | '));
  const t = dom.el('p', { text: '<img src=x onerror=alert(1)>' });
  check('S11 text is a text property, never parsed', t.textContent === '<img src=x onerror=alert(1)>');

  const files = [];
  const walk = (d) => { for (const f of readdirSync(d)) { const p = join(d, f); if (statSync(p).isDirectory()) walk(p); else files.push(p); } };
  walk('public');
  const hits = [];
  const sinks = [];
  for (const f of files) {
    const s = readFileSync(f, 'utf8');
    if (/client[_-]?id|client[_-]?secret|sk-ant|Bearer\s+[A-Za-z0-9]|AKIA[0-9A-Z]{16}|PAYPAL_(CLIENT|SECRET)|RS_[A-Z_]*(SECRET|PASSWORD)|A[A-Za-z0-9_-]{60,}/i.test(s)) hits.push(f);
    if (/\.innerHTML|outerHTML|insertAdjacentHTML|document\.write|\beval\(|new Function|setTimeout\(\s*['"`]|localStorage|\.src\s*=[^=]|\.href\s*=[^=]/.test(s)) sinks.push(f);
  }
  check(`S11 RS-29: no secrets or client ids in public/** (${files.length} files)`, hits.length === 0, hits.join(','));
  check('S11 no HTML sinks, eval, localStorage or direct .href/.src assignment in public/**', sinks.length === 0, sinks.join(','));
}

// ---------------------------------------------------------------- S12 SPA delivery headers
async function s12() {
  console.log('== S12 SPA delivery headers');
  const { h } = await world();
  try {
    const idx = await h.request({ path: '/' });
    const csp = idx.headers['content-security-policy'] ?? '';
    check("S12 index.html served with script-src 'self' and no unsafe-*", idx.status === 200 && /script-src 'self'/.test(csp) && !/unsafe/.test(csp), csp);
    const sess = await h.request({ path: '/api/auth/session' });
    check('S12 /api responses no-store', /no-store/.test(sess.headers['cache-control'] ?? ''), sess.headers['cache-control']);
  } finally {
    await h.close();
  }
}

// ---------------------------------------------------------------- S13 Chromium: hostile strings rendered by the SPA
async function s13() {
  console.log('== S13 Chromium renders hostile supplier and customer strings as text');
  const { launchChromium } = await import('../../test/helpers/playwright.js');
  const { h, clientAt, addStock } = await world();
  let browser;
  try {
    addStock(5);
    const evilName = '<img src=x onerror="window.__xss=1">';
    const cust = clientAt();
    await cust.register({ username: 'xss-buyer', password: 'long-enough-pw', displayName: evilName });
    const pl = await makePlan(cust, { maxPickups: 5, budgetCents: 100000 });
    const rs = await reserve(cust, pl.plan?.id, KEY(9));
    const orders = rs.json?.orders ?? [];
    check('S13 setup: reservation with orders', rs.status === 201 && orders.length >= 1, short(rs));
    const code = h.db.prepare('SELECT s.code FROM supplier_orders so JOIN suppliers s ON s.id = so.supplier_id WHERE so.id = ?').get(orders[0].id).code;
    const sup = clientAt();
    await sup.signIn(`supplier-${code.toLowerCase()}`, DEMO_PASSWORD);
    const reason = '<img src=x onerror="window.__xss=2"><a href="javascript:window.__xss=3">click</a>';
    const ref = await sup.post(`/api/supplier/orders/${orders[0].id}/refuse`, { reason });
    check('S13 setup: refusal stored', ref.status === 200, short(ref));

    browser = await launchChromium({ args: typeof process.getuid === 'function' && process.getuid() === 0 ? ['--no-sandbox'] : [] });
    const origin = `http://127.0.0.1:${h.port}`;
    const visit = async (sid, hash, needle) => {
      const context = await browser.newContext({ baseURL: origin });
      await context.addCookies([{ name: 'rs_sid', value: sid, url: origin, httpOnly: true, sameSite: 'Lax' }]);
      const page = await context.newPage();
      const events = { dialogs: 0, csp: [], errors: [] };
      page.on('dialog', (d) => { events.dialogs += 1; d.dismiss().catch(() => {}); });
      page.on('console', (m) => { if (/Content Security Policy/i.test(m.text())) events.csp.push(m.text()); });
      page.on('pageerror', (e) => events.errors.push(e.message));
      await page.goto(`/${hash}`);
      let shown = true;
      try {
        await page.waitForFunction((n) => document.body.textContent.includes(n), needle, { timeout: 15000 });
      } catch {
        shown = false;
      }
      await page.waitForTimeout(500);
      const state = await page.evaluate(() => ({
        xss: window.__xss ?? null,
        imgs: [...document.querySelectorAll('img')].map((i) => i.getAttribute('src')),
        jsLinks: [...document.querySelectorAll('a')].filter((a) => /^\s*javascript:/i.test(a.getAttribute('href') ?? '')).length,
      }));
      await context.close();
      return { shown, ...state, ...events };
    };
    const custSid = cust.cookies().rs_sid;
    const supSid = sup.cookies().rs_sid;
    const a = await visit(custSid, `#/requests/${pl.requestId}`, 'onerror="window.__xss=2"');
    check('S13 customer request page: the refusal reason appears as literal text; no script ran, no <img>, no javascript: link', a.shown && a.xss === null && a.imgs.length === 0 && a.jsLinks === 0 && a.dialogs === 0, JSON.stringify(a));
    const b = await visit(supSid, '#/supplier/orders', 'onerror="window.__xss=1"');
    check("S13 supplier orders page: the buyer's hostile display name appears as literal text; no script ran", b.shown && b.xss === null && b.imgs.length === 0 && b.dialogs === 0, JSON.stringify(b));
    check('S13 no CSP violation reported on either page', a.csp.length === 0 && b.csp.length === 0, [...a.csp, ...b.csp].join(' | '));
  } finally {
    if (browser) await browser.close();
    await h.close();
  }
}

const sections = { S1: s1, S2: s2, S3: s3, S4: s4, S5: s5, S6: s6, S7: s7, S8: s8, S9: s9, S10: s10, S11: s11, S12: s12, S13: s13 };
for (const [name, fn] of Object.entries(sections)) {
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
