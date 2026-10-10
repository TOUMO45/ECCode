// Rework-1 regression hypothesis (security-reviewer): can a cross-site page spend a signed-in victim's general
// budget? SameSite=Lax sends rs_sid on cross-site TOP-LEVEL GET navigations, and the general limit counts every
// authenticated call, GETs included. A page on attacker.example (served by Playwright routing) opens popups that
// navigate to the app's /api/requests. The limit is lowered to 20 to keep the run short; the default 300 only
// needs more popups. REPRO expectations: the victim is locked out of its own API and of sign-out for one window.
import { startHarness, DEMO_PASSWORD } from '../../test/helpers/app-harness.js';
import { createClient } from '../../test/helpers/fixtures.js';
import { launchChromium } from '../../test/helpers/playwright.js';

let failures = 0;
const check = (label, cond, info = '') => { if (!cond) failures += 1; console.log(`${cond ? 'PASS' : 'FAIL'} ${label}${info ? ` | ${info}` : ''}`); };
const short = (r) => `${r.status} ${r.json?.error?.code ?? ''}`.trim();

const h = await startHarness({ seed: true, record: false, env: { RS_GENERAL_RATE_LIMIT: '20' } });
let browser;
try {
  const victim = createClient(h.request);
  await victim.signIn('cafe1', DEMO_PASSWORD);
  const uid = victim.user.id;
  const rows = () => h.db.prepare("SELECT COUNT(*) AS n FROM rate_events WHERE kind = 'general' AND user_key = ?").get(`u:${uid}`).n;
  const origin = `http://127.0.0.1:${h.port}`;
  browser = await launchChromium({ args: typeof process.getuid === 'function' && process.getuid() === 0 ? ['--no-sandbox'] : [] });
  const context = await browser.newContext();
  await context.addCookies([{ name: 'rs_sid', value: victim.cookies().rs_sid, url: origin, httpOnly: true, sameSite: 'Lax' }]);
  const html = `<!doctype html><title>cat pictures</title><script>
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    window.fresh = async (t, n, gap) => { for (let i = 0; i < n; i++) { window.open(t + '?f=' + i, 'w' + i); await sleep(gap); } };
    window.fetchy = async (t, n) => { for (let i = 0; i < n; i++) { try { await fetch(t + '?x=' + i, { credentials: 'include', mode: 'no-cors' }); } catch {} } };
  </script>`;
  await context.route('http://attacker.example/**', (route) => route.fulfill({ status: 200, contentType: 'text/html', body: html }));
  const page = await context.newPage();
  await page.goto('http://attacker.example/');
  const target = `${origin}/api/requests`;
  const r0 = rows();
  await page.evaluate(([t]) => window.fetchy(t, 10), [target]);
  const r1 = rows();
  check('control: cross-site fetch (no-cors, credentials include) x10 carries no cookie, nothing counted (SameSite=Lax holds for subresources)', r1 - r0 === 0, `counted ${r1 - r0}`);
  await page.evaluate(([t]) => window.fresh(t, 25, 150), [target]);
  await page.waitForTimeout(1500);
  const r2 = rows();
  const own = await victim.get('/api/requests');
  const out = await victim.post('/api/auth/signout', {});
  check('REPRO: 25 cross-site top-level popup navigations from attacker.example carry rs_sid and are counted; the victim\'s own API call and sign-out are then 429 general', r2 - r1 >= 20 && own.status === 429 && own.json.error.details.limit === 'general' && out.status === 429, `counted ${r2 - r1} (limit 20); victim GET ${short(own)} retry-after=${own.headers['retry-after']}; sign-out ${short(out)}`);
  h.clock.advance(61 * 1000);
  const back = await victim.get('/api/requests');
  check('the lock-out ends with the window (61 s later the victim is served; no lasting effect)', back.status === 200, short(back));
  await context.close();
} finally {
  if (browser) await browser.close();
  await h.close();
}
console.log(failures === 0 ? 'ALL EXPECTATIONS MET' : `${failures} EXPECTATION(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
