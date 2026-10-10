// technical-reviewer probe (phase C): the live route table against the spec's RBAC matrix, independent of c1's tests.
// For every registered route (router.list()) and every actor (anonymous, customer, supplier, admin) it sends one call
// with the actor's cookie and CSRF token (ids replaced by 999999, body {}), and classifies the answer:
//   denied-401 / denied-403 / passed (anything else). The expected class comes from the spec's matrix by path prefix.
// Also: a non-GET without the CSRF header and with a foreign Origin -> 403 CSRF_FAILED for each role-protected POST;
// a route declared 'signature' anywhere but POST /api/webhooks/paypal/:merchantKey is refused 403 (extra route
// injected through createApp's routes option); a route without a policy is refused at add(); no response carries an
// Access-Control-Allow-* header. Usage: node tr-phc-rbac.mjs   Exit 0 = matrix holds everywhere.
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const root = process.cwd();
const imp = (p) => import(pathToFileURL(join(root, p)));
const { DEMO_PASSWORD, startHarness } = await imp('test/helpers/app-harness.js');
const { createClient } = await imp('test/helpers/fixtures.js');
const { ensureAdmin } = await imp('src/services/users.js');

const ADMIN_PASSWORD = 'admin-password-for-review-0001';
const extraSignature = (router) => router.add('POST', '/api/review/hook', () => ({ status: 200, body: { reached: true } }), { policy: 'signature' });
const h = await startHarness({ seed: true, record: false, env: { RS_ADMIN_PASSWORD: ADMIN_PASSWORD }, routes: [extraSignature] });
await ensureAdmin({ db: h.db, config: h.config, clock: h.clock });
const failures = [];
let checks = 0;
const corsSeen = [];

const anon = createClient(h.request);
await anon.get('/api/auth/csrf');
const customer = createClient(h.request); await customer.signIn('cafe1', DEMO_PASSWORD);
const supplier = createClient(h.request); await supplier.signIn('supplier-a', DEMO_PASSWORD);
const admin = createClient(h.request); await admin.signIn('admin', ADMIN_PASSWORD);
const actors = { anonymous: anon, customer, supplier, admin };

const PUBLIC = new Set(['/api/health', '/api/config', '/api/auth/csrf', '/api/auth/session', '/api/auth/signin', '/api/auth/register']);
function expected(route, actor) {
  const p = route.template;
  if (PUBLIC.has(p)) return 'passed';
  if (p === '/api/review/hook') return 'denied-403';
  if (p.startsWith('/api/webhooks/')) return 'signature';
  if (actor === 'anonymous') return 'denied-401';
  if (p === '/api/auth/signout') return 'passed';
  if (p.startsWith('/api/admin/')) return actor === 'admin' ? 'passed' : 'denied-403';
  if (p.startsWith('/api/supplier/')) return actor === 'supplier' ? 'passed' : 'denied-403';
  if (/^\/api\/(requests|plans|orders|paypal)/.test(p)) return actor === 'customer' ? 'passed' : 'denied-403';
  return 'unknown-route';
}
const classify = (res) => (res.status === 401 ? 'denied-401' : res.status === 403 && res.json?.error?.code === 'FORBIDDEN' ? 'denied-403' : res.status === 403 ? `403-${res.json?.error?.code}` : 'passed');

const routes = h.app.router.list();
const table = [];
for (const route of routes) {
  const path = route.template.replace(/:[A-Za-z]+/g, '999999');
  for (const [name, client] of Object.entries(actors)) {
    if (route.template === '/api/auth/signout' || route.template === '/api/auth/signin' || route.template === '/api/auth/register') continue; // session-changing; covered below
    const res = await client.send({ method: route.method, path, jsonBody: route.method === 'GET' ? undefined : {} });
    checks++;
    for (const k of Object.keys(res.headers)) if (/^access-control-allow/i.test(k)) corsSeen.push(`${route.method} ${route.template}`);
    const want = expected(route, name);
    const got = classify(res);
    if (want === 'signature') continue;
    if (want === 'unknown-route') { failures.push(`route ${route.method} ${route.template} is not in the matrix (policy ${route.policy})`); continue; }
    if (want !== got) failures.push(`${route.method} ${route.template} as ${name}: ${got} (${res.status} ${res.json?.error?.code ?? ''}), expected ${want}`);
    table.push(`${route.policy.padEnd(9)} ${route.method.padEnd(5)} ${route.template.padEnd(40)} ${name.padEnd(9)} ${res.status} ${res.json?.error?.code ?? ''}`);
  }
}

// signout: anonymous 401, signed-in passes (done last for one throwaway customer session)
{
  const throwaway = createClient(h.request); await throwaway.signIn('cafe2', DEMO_PASSWORD);
  const a = await anon.post('/api/auth/signout', {});
  const b = await throwaway.post('/api/auth/signout', {});
  checks += 2;
  if (a.status !== 401) failures.push(`signout anonymous answered ${a.status}`);
  if (b.status !== 200) failures.push(`signout signed-in answered ${b.status}`);
}

// CSRF on every role-protected non-GET route, for the role that may call it
for (const route of routes.filter((r) => r.method !== 'GET' && !['public', 'signature'].includes(r.policy))) {
  const who = route.policy === 'admin' ? admin : route.policy === 'supplier' ? supplier : customer;
  const path = route.template.replace(/:[A-Za-z]+/g, '999999');
  const noToken = await who.send({ method: route.method, path, jsonBody: {}, headers: { 'X-CSRF-Token': 'wrong-token-value' } });
  const badOrigin = await who.send({ method: route.method, path, jsonBody: {}, headers: { Origin: 'https://evil.example' } });
  checks += 2;
  if (noToken.status !== 403 || noToken.json?.error?.code !== 'CSRF_FAILED') failures.push(`${route.method} ${route.template}: wrong token answered ${noToken.status} ${noToken.json?.error?.code}`);
  if (badOrigin.status !== 403 || badOrigin.json?.error?.code !== 'CSRF_FAILED') failures.push(`${route.method} ${route.template}: foreign Origin answered ${badOrigin.status} ${badOrigin.json?.error?.code}`);
}
// pre-login routes without a token / with a foreign Origin
for (const p of ['/api/auth/signin', '/api/auth/register']) {
  const fresh = createClient(h.request);
  const noToken = await fresh.post(p, { username: 'x-user', password: 'whatever-pass', displayName: 'X' });
  await fresh.get('/api/auth/csrf');
  const badOrigin = await fresh.post(p, { username: 'x-user', password: 'whatever-pass', displayName: 'X' }, { headers: { Origin: 'http://evil.example' } });
  checks += 2;
  if (noToken.status !== 403 || noToken.json?.error?.code !== 'CSRF_FAILED') failures.push(`${p} without token answered ${noToken.status}`);
  if (badOrigin.status !== 403 || badOrigin.json?.error?.code !== 'CSRF_FAILED') failures.push(`${p} with foreign Origin answered ${badOrigin.status}`);
}

// a route without a policy cannot be added
{
  let refused = false;
  try { h.app.router.add('GET', '/api/review/nopolicy', () => ({}), {}); } catch { refused = true; }
  checks++;
  if (!refused) failures.push('a route without a policy was accepted');
}
const sigRoutes = routes.filter((r) => r.policy === 'signature').map((r) => `${r.method} ${r.template}`);
const publicNonGet = routes.filter((r) => r.policy === 'public' && r.method !== 'GET').map((r) => `${r.method} ${r.template}`);
await h.close();
console.log(`routes ${routes.length} (incl. 1 injected 'signature' route); checks ${checks}`);
console.log(`routes with policy 'signature': ${sigRoutes.join(', ') || 'none'}; public non-GET routes: ${publicNonGet.join(', ')}`);
console.log(table.join('\n'));
if (corsSeen.length) failures.push(`Access-Control-Allow-* on ${corsSeen.length} responses`);
console.log(failures.length ? `FAILURES:\n  ${failures.join('\n  ')}` : 'RBAC matrix, CSRF, signature restriction and no-CORS hold on every route');
process.exit(failures.length ? 1 : 0);
