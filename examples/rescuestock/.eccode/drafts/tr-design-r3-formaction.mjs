// technical-reviewer check (design gate, revision 3, F-TR-14 / RS-31 / RS-32 / NFR2): read the listener CSP
// (approvalPageCsp, under Interface Contracts > Fake approval listener) and the app CSP (Security > Security headers)
// FROM THE SPEC TEXT, then drive a stand-in of the fake approval listener in Playwright's Chromium:
//   GET checkout page on http://127.0.0.1:<p2> -> click Approve (POST) -> 303 to http://localhost:<p1>/api/paypal/return
//   and the same for Cancel -> /api/paypal/cancel, with a SameSite=Lax session cookie set on localhost first.
// The listener sends the app's other security headers (nosniff, no-referrer, DENY, COOP, Permissions-Policy) and
// exactly one CSP = the spec's listener CSP with <appOrigin> replaced by the app origin.
// Negative control: the app CSP added as a second CSP header must make Chromium refuse the approve submission.
// Exit 0 = approve and cancel land on the app routes with the session and no CSP console error under the spec's
// listener CSP, AND the negative control is refused.  Usage: node tr-design-r3-formaction.mjs <spec.md>
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const spec = readFileSync(process.argv[2], 'utf8');
const listenerSection = spec.slice(spec.indexOf('### Fake approval listener'), spec.indexOf('### RBAC matrix'));
const lm = listenerSection.match(/`(default-src 'none'; style-src 'self'; form-action 'self' <appOrigin>;[^`]*)`/);
const am = spec.match(/`Content-Security-Policy: (default-src 'self';[^`]*form-action 'self')`/);
if (!lm || !am) { console.log(`could not read CSP strings from the spec: listener=${!!lm} app=${!!am}`); process.exit(1); }
console.log(`listener CSP (spec): ${lm[1]}`);
console.log(`app CSP (spec): ${am[1]}`);

const require = createRequire(import.meta.url);
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const listen = (srv, host) => new Promise((r) => srv.listen(0, host, () => r(srv.address().port)));
let hits = [];
const app = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/setcookie') {
    res.writeHead(200, { 'Set-Cookie': 'rs_sid=abc; HttpOnly; SameSite=Lax; Path=/', 'Content-Type': 'text/html', 'Content-Security-Policy': am[1] });
    return res.end('<p>signed in</p>');
  }
  if (u.pathname === '/api/paypal/return' || u.pathname === '/api/paypal/cancel') {
    hits.push({ path: u.pathname, cookie: /rs_sid=abc/.test(req.headers.cookie || '') });
    res.writeHead(200, { 'Content-Type': 'text/html', 'Content-Security-Policy': am[1] });
    return res.end('<p>back in app</p>');
  }
  res.writeHead(404); res.end();
});
const appPort = await listen(app, undefined);
const appOrigin = `http://localhost:${appPort}`;
const listenerCsp = lm[1].replace('<appOrigin>', appOrigin);
let extraCsp = null;
const common = { 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY',
  'Cross-Origin-Opener-Policy': 'same-origin', 'Permissions-Policy': 'camera=(), microphone=(), geolocation=()', 'Cache-Control': 'no-store' };
const fake = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  const csp = extraCsp ? [listenerCsp, extraCsp] : listenerCsp;
  if (req.method === 'GET' && u.pathname === '/fake-paypal/checkout/FAKE-1') {
    res.writeHead(200, { ...common, 'Content-Type': 'text/html', 'Content-Security-Policy': csp });
    return res.end('<h1>Simulated payment approval - not PayPal</h1>' +
      '<form method="POST" action="/fake-paypal/checkout/FAKE-1/approve"><button id="approve">Approve (simulated)</button></form>' +
      '<form method="POST" action="/fake-paypal/checkout/FAKE-1/cancel"><button id="cancel">Cancel</button></form>');
  }
  if (req.method === 'POST' && /^\/fake-paypal\/checkout\/FAKE-1\/(approve|cancel)$/.test(u.pathname)) {
    req.resume();
    const to = u.pathname.endsWith('approve') ? `/api/paypal/return?token=FAKE-1&PayerID=FAKEPAYER` : `/api/paypal/cancel?token=FAKE-1`;
    res.writeHead(303, { ...common, 'Content-Security-Policy': csp, Location: appOrigin + to });
    return res.end();
  }
  res.writeHead(404); res.end();
});
const fakePort = await listen(fake, '127.0.0.1');
const fakeOrigin = `http://127.0.0.1:${fakePort}`;

const browser = await chromium.launch();
const run = async (button) => {
  hits = [];
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const cspMsgs = [];
  page.on('console', (m) => { if (/Content Security Policy/i.test(m.text())) cspMsgs.push(m.text().slice(0, 140)); });
  await page.goto(`${appOrigin}/setcookie`);
  await page.goto(`${fakeOrigin}/fake-paypal/checkout/FAKE-1`);
  await page.click(button).catch(() => {});
  await page.waitForTimeout(1500);
  const r = { finalPath: new URL(page.url()).pathname, hits: hits.slice(), cspMsgs };
  await ctx.close();
  return r;
};
let fails = 0;
const check = (name, ok, extra) => { if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name} | ${extra}`); };
const a = await run('#approve');
check('spec listener CSP: Approve lands on /api/paypal/return with the Lax session, no CSP console error',
  a.finalPath === '/api/paypal/return' && a.hits.length === 1 && a.hits[0].cookie && a.cspMsgs.length === 0, JSON.stringify(a));
const c = await run('#cancel');
check('spec listener CSP: Cancel lands on /api/paypal/cancel with the Lax session, no CSP console error',
  c.finalPath === '/api/paypal/cancel' && c.hits.length === 1 && c.hits[0].cookie && c.cspMsgs.length === 0, JSON.stringify(c));
extraCsp = am[1];
const n = await run('#approve');
check('negative control: app CSP inherited as a second header -> Chromium refuses the approve submission',
  n.hits.length === 0 && n.cspMsgs.length > 0, JSON.stringify({ finalPath: n.finalPath, hits: n.hits.length, csp: n.cspMsgs[0] }));
await browser.close(); app.close(); fake.close();
console.log(`chromium ${browser.version()}; failures: ${fails}`);
process.exit(fails ? 1 : 0);
