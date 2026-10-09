// Design probe (technical-designer, design rev 3, F-TR-14): with the REVISED Content-Security-Policy that the
// fake approval listener (and the paypal-stub approval page) send, do the approve and cancel form submissions
// on http://127.0.0.1:<fakePort> reach the app's /api/paypal/return and /api/paypal/cancel on
// http://localhost:<appPort> carrying the SameSite=Lax session cookie, in Playwright's Chromium?
// The listener sends exactly ONE CSP header (it does not inherit the app's CSP), built by
// approvalCsp(appOrigin) below, which is the exact string the spec pins for the [D] header test.
// Variants:
//   R3-fake   : fake listener page, revised single CSP, approve then cancel
//   R3-stub   : paypal-stub approval page, same revised CSP, approve then cancel
//   NEG-two   : revised page CSP PLUS the app's CSP inherited as a second header (must be refused: both enforced)
// Exit 0 when R3-fake and R3-stub reach both routes with the cookie AND NEG-two is refused.
import http from 'node:http';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require('playwright')); } catch { ({ chromium } = require('/opt/node22/lib/node_modules/playwright')); }

// Optional argument: path to spec.md. When given, both CSP strings are taken from the spec TEXT (the listener's
// pinned value from "Fake approval listener", with <appOrigin> substituted, and the app CSP from "Security
// headers"), so the evidence is bound to the revised header text; the spec's sha256 is printed.
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const specPath = process.argv[2];
let LISTENER_TEMPLATE = "default-src 'none'; style-src 'self'; form-action 'self' <appOrigin>; frame-ancestors 'none'; base-uri 'none'";
let APP_CSP = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";
if (specPath) {
  const text = readFileSync(specPath, 'utf8');
  console.log(`spec ${specPath} sha256=${createHash('sha256').update(text).digest('hex')}`);
  const l = text.match(/`(default-src 'none'; style-src 'self'; form-action 'self' <appOrigin>;[^`]*)`/);
  const a = text.match(/`Content-Security-Policy: (default-src 'self';[^`]*)`/);
  if (!l || !a) { console.log('could not find the CSP strings in the spec'); process.exit(1); }
  LISTENER_TEMPLATE = l[1]; APP_CSP = a[1];
  console.log(`listener CSP from spec: ${LISTENER_TEMPLATE}`);
  console.log(`app CSP from spec: ${APP_CSP}`);
}
export const approvalCsp = (appOrigin) => LISTENER_TEMPLATE.replace('<appOrigin>', appOrigin);

const listen = (srv, host) => new Promise((r) => srv.listen(0, host, () => r(srv.address().port)));
let hits = [];
const app = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/setcookie') {
    res.writeHead(200, { 'Set-Cookie': 'rs_sid=abc; HttpOnly; SameSite=Lax; Path=/', 'Content-Type': 'text/html' });
    return res.end('<p>cookie set</p>');
  }
  if (u.pathname === '/api/paypal/return' || u.pathname === '/api/paypal/cancel') {
    hits.push({ route: u.pathname, cookie: /rs_sid=abc/.test(req.headers.cookie || ''), token: u.searchParams.get('token') });
    res.writeHead(200, { 'Content-Type': 'text/html' });
    return res.end('<p>LANDED</p>');
  }
  res.writeHead(404); res.end();
});
const appPort = await listen(app, undefined);
const appOrigin = `http://localhost:${appPort}`;

let headerMode = 'single';
const pageCsp = () => approvalCsp(appOrigin);
const fake = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  const m = u.pathname.match(/^\/(fake-paypal\/checkout|stub-paypal\/approve)\/([A-Z0-9-]+)(\/(approve|cancel))?$/);
  if (!m) { res.writeHead(404); return res.end(); }
  const [, base, id, , action] = m;
  if (req.method === 'GET' && !action) {
    const csp = headerMode === 'two' ? [APP_CSP, pageCsp()] : pageCsp();
    res.writeHead(200, { 'Content-Type': 'text/html', 'Content-Security-Policy': csp });
    return res.end(`<h1>Simulated payment approval - not PayPal</h1>
<form method="POST" action="/${base}/${id}/approve"><button id="approve">Approve (simulated)</button></form>
<form method="POST" action="/${base}/${id}/cancel"><button id="cancel">Cancel</button></form>`);
  }
  if (req.method === 'POST' && action) {
    req.resume();
    const target = action === 'approve' ? `${appOrigin}/api/paypal/return?token=${id}&PayerID=FAKEPAYER` : `${appOrigin}/api/paypal/cancel?token=${id}`;
    res.writeHead(303, { Location: target });
    return res.end();
  }
  res.writeHead(405); res.end();
});
const fakePort = await listen(fake, '127.0.0.1');
const fakeOrigin = `http://127.0.0.1:${fakePort}`;

const browser = await chromium.launch();
async function attempt(path, button) {
  hits = [];
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const violations = [];
  page.on('console', (msg) => { if (/Content Security Policy|form-action/i.test(msg.text())) violations.push(msg.text().slice(0, 140)); });
  await page.goto(`${appOrigin}/setcookie`);
  await page.goto(`${fakeOrigin}${path}`);
  await page.click(button).catch(() => {});
  await page.waitForTimeout(1200);
  const r = { landed: hits[0]?.route ?? null, cookie: hits[0]?.cookie ?? false, violation: violations[0] ?? null };
  await ctx.close();
  return r;
}
const results = {};
headerMode = 'single';
for (const [name, path] of [['R3-fake', '/fake-paypal/checkout/FAKE-0123ABCD'], ['R3-stub', '/stub-paypal/approve/STUB-0123ABCD']]) {
  const a = await attempt(path, '#approve');
  const c = await attempt(path, '#cancel');
  results[name] = a.landed === '/api/paypal/return' && a.cookie && c.landed === '/api/paypal/cancel' && c.cookie;
  console.log(`${name}: approve -> ${a.landed} cookie=${a.cookie} | cancel -> ${c.landed} cookie=${c.cookie} | ${results[name] ? 'OK' : 'FAIL'}`);
}
headerMode = 'two';
{
  const a = await attempt('/fake-paypal/checkout/FAKE-0123ABCD', '#approve');
  results['NEG-two'] = a.landed === null;
  console.log(`NEG-two (app CSP inherited as a second header): approve -> ${a.landed} | refused=${results['NEG-two']}${a.violation ? ' | console: ' + a.violation : ''}`);
}
console.log(`pinned listener CSP: ${approvalCsp('http://localhost:<PORT>')}`);
console.log(`chromium ${browser.version()}`);
await browser.close();
app.close(); fake.close();
const ok = Object.values(results).every(Boolean);
console.log(ok ? 'F-TR-14 fix confirmed' : 'F-TR-14 fix NOT confirmed');
process.exit(ok ? 0 : 1);
