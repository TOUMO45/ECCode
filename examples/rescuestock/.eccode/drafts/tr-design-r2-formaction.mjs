// technical-reviewer check (design gate, revision 2, RS-31 / SEC-12): the spec's fake approval listener serves
// its checkout page with CSP "default-src 'none'; style-src 'self'; form-action 'self'" and answers the approve
// POST with a 303 to the app's return_url on another origin (http://localhost:<port>/api/paypal/return).
// Does Chromium (Playwright) follow that redirect, and does the SameSite=Lax session cookie arrive?
// Variants: (A) the spec's CSP; (B) control: form-action also lists the app origin; (C) control: no CSP;
// (D) SameSite=Strict cookie with CSP of (B), to show the return is cross-site (cookie must be absent).
// Exit 0 = all observations obtained; the result lines say what happened.
import http from 'node:http';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('/opt/node22/lib/node_modules/playwright');

const listen = (srv, host) => new Promise((r) => srv.listen(0, host, () => r(srv.address().port)));
let returnHits = [];
const app = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/setcookie') {
    const ss = u.searchParams.get('ss') || 'Lax';
    res.writeHead(200, { 'Set-Cookie': `rs_sid=abc; HttpOnly; SameSite=${ss}; Path=/`, 'Content-Type': 'text/html' });
    return res.end('<p>cookie set</p>');
  }
  if (u.pathname === '/api/paypal/return') {
    returnHits.push({ cookie: /rs_sid=abc/.test(req.headers.cookie || '') });
    res.writeHead(200, { 'Content-Type': 'text/html' });
    return res.end('<p id="r">RETURNED</p>');
  }
  res.writeHead(404); res.end();
});
const appPort = await listen(app, undefined);
const appOrigin = `http://localhost:${appPort}`;
let csp = null;
const fake = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (req.method === 'GET' && u.pathname === '/fake-paypal/checkout/FAKE-1') {
    const h = { 'Content-Type': 'text/html' };
    if (csp) h['Content-Security-Policy'] = csp;
    res.writeHead(200, h);
    return res.end('<h1>Simulated payment approval - not PayPal</h1><form method="POST" action="/fake-paypal/checkout/FAKE-1/approve"><button id="approve">Approve (simulated)</button></form>');
  }
  if (req.method === 'POST' && u.pathname === '/fake-paypal/checkout/FAKE-1/approve') {
    req.resume();
    res.writeHead(303, { Location: `${appOrigin}/api/paypal/return?token=FAKE-1&PayerID=FAKEPAYER` });
    return res.end();
  }
  res.writeHead(404); res.end();
});
const fakePort = await listen(fake, '127.0.0.1');
const fakeOrigin = `http://127.0.0.1:${fakePort}`;

const browser = await chromium.launch();
const variants = [
  ['A spec CSP (form-action \'self\'), Lax cookie', "default-src 'none'; style-src 'self'; form-action 'self'", 'Lax'],
  ['B form-action \'self\' + app origin, Lax cookie', `default-src 'none'; style-src 'self'; form-action 'self' ${appOrigin}`, 'Lax'],
  ['C no CSP, Lax cookie', null, 'Lax'],
  ['D form-action \'self\' + app origin, Strict cookie', `default-src 'none'; style-src 'self'; form-action 'self' ${appOrigin}`, 'Strict'],
];
for (const [name, policy, ss] of variants) {
  csp = policy; returnHits = [];
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const violations = [];
  page.on('console', (m) => { if (/Content Security Policy|form-action/i.test(m.text())) violations.push(m.text().slice(0, 160)); });
  await page.goto(`${appOrigin}/setcookie?ss=${ss}`);
  await page.goto(`${fakeOrigin}/fake-paypal/checkout/FAKE-1`);
  await page.click('#approve').catch(() => {});
  await page.waitForTimeout(1500);
  const url = page.url();
  console.log(`${name}: finalUrl=${url.replace(/\d{4,5}/g, '<port>')} returnHit=${returnHits.length > 0} cookieAtReturn=${returnHits.some((h) => h.cookie)}` +
    (violations.length ? ` cspConsole="${violations[0]}"` : ''));
  await ctx.close();
}
await browser.close();
app.close(); fake.close();
console.log(`chromium ${browser.version ? '' : ''}done`);
process.exit(0);
