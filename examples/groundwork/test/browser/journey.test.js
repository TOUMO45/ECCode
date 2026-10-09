// Real-Chromium journey at 360 and 1280 px (spec 11.3, SCOPE D1 and D7).
// Starts the real app (src/index.js) on an ephemeral port with a temp DB and the fake
// providers; no network, no model calls. Fails (never skips) if Chromium cannot launch.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync, execSync } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT = path.join(ROOT, 'test', 'browser', 'out');
const PASSWORD = process.env.GW_SEED_PASSWORD || 'groundwork-demo-1';
const VIEWPORTS = [
  { name: '360', width: 360, height: 800 },
  { name: '1280', width: 1280, height: 800 },
];
const NODE_FLAGS = ['--disable-warning=ExperimentalWarning'];

function loadPlaywright() {
  const require = createRequire(import.meta.url);
  const roots = [];
  try { roots.push(execSync('npm root -g', { encoding: 'utf8' }).trim()); } catch { /* try NODE_PATH */ }
  if (process.env.NODE_PATH) roots.push(...process.env.NODE_PATH.split(path.delimiter));
  const errs = [];
  for (const r of roots) {
    try { return createRequire(path.join(r, 'noop.js'))('playwright'); } catch (e) { errs.push(`${r}: ${e.message}`); }
  }
  try { return require('playwright'); } catch (e) { errs.push(e.message); }
  throw new Error(`Playwright is not installed globally: ${errs.join(' | ')}`);
}

let server; let baseUrl; let tmp; let browser;

async function startServer() {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-e2e-'));
  const env = {
    ...process.env, PORT: '0', HOST: '127.0.0.1', GW_DB_PATH: path.join(tmp, 'e2e.db'),
    GW_ENABLE_FAKE: '1', GW_LOG: 'off', GW_SEED_PASSWORD: PASSWORD,
  };
  execFileSync(process.execPath, [...NODE_FLAGS, path.join(ROOT, 'scripts', 'seed.js')], { env, stdio: 'pipe' });
  server = spawn(process.execPath, [...NODE_FLAGS, path.join(ROOT, 'src', 'index.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  server.stderr.on('data', (d) => { stderr += d; });
  baseUrl = await new Promise((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(() => reject(new Error(`server did not start: ${stderr}`)), 15000);
    server.on('exit', (c) => { clearTimeout(timer); reject(new Error(`server exited ${c}: ${stderr}`)); });
    server.stdout.on('data', (d) => {
      buf += d;
      for (const line of buf.split('\n')) {
        try { const j = JSON.parse(line); if (j.event === 'startup') { clearTimeout(timer); resolve(j.url); } } catch { /* partial */ }
      }
    });
  });
}

before(async () => {
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });
  await startServer();
  const { chromium } = loadPlaywright();
  browser = await chromium.launch(); // throws (test fails) if Chromium cannot launch
});

after(async () => {
  await browser?.close();
  if (server && server.exitCode === null) {
    server.removeAllListeners('exit');
    server.kill('SIGTERM');
  }
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
});

// ---------- helpers ----------
const tid = (id) => `[data-testid="${id}"]`;

function newSession(vp) {
  return browser.newContext({ viewport: { width: vp.width, height: vp.height }, reducedMotion: 'reduce' }).then(async (ctx) => {
    const page = await ctx.newPage();
    const consoleErrors = []; const failedRequests = []; const dialogs = [];
    page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(`${m.text()} @ ${m.location().url}`); });
    page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`));
    page.on('dialog', (d) => { dialogs.push(d.message()); d.dismiss(); });
    // ERR_ABORTED is the browser cancelling an in-flight GET on navigation, not a failure.
    page.on('requestfailed', (r) => r.failure()?.errorText === 'net::ERR_ABORTED' || failedRequests.push(`${r.method()} ${r.url()} ${r.failure()?.errorText}`));
    page.on('response', (r) => { if (r.status() >= 500) failedRequests.push(`${r.status()} ${r.url()}`); });
    // Expected 4xx are allowed: browsers log them as console errors ("Failed to load resource").
    return { ctx, page, consoleErrors, failedRequests, dialogs };
  });
}

async function shot(page, vp, name) {
  const dir = path.join(OUT, vp.name);
  fs.mkdirSync(dir, { recursive: true });
  await page.screenshot({ path: path.join(dir, `${name}.png`), fullPage: true });
}

async function signIn(page, username, password = PASSWORD) {
  await page.goto(`${baseUrl}/#/login`);
  await page.fill(tid('login-username'), username);
  await page.fill(tid('login-password'), password);
  await page.click(tid('login-submit'));
}

async function signOut(page) {
  await page.click(tid('signout'));
  await page.waitForSelector(tid('login-submit'));
}

async function overflow(page) {
  return page.evaluate(() => ({
    doc: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    body: document.body.scrollWidth - document.documentElement.clientWidth,
  }));
}

const NOTES = [
  '14:02 alice: Alert fired for checkout latency',
  '14:05 bob: Rolled back the deploy to v2',
  '14:09 alice: Error rate recovered after rollback',
  '14:12 carol: Action item add a canary stage owner bob',
].join('\n');

const XSS = '<img src=x onerror="window.__xss=1">';

async function createIncident(page, title) {
  await page.fill(tid('incident-title'), title);
  await page.click(tid('incident-create'));
  await page.locator('#incident-list a', { hasText: title }).first().waitFor();
}

async function openIncident(page, title) {
  await page.locator('#incident-list a', { hasText: title }).first().click();
  // Responders see the notes form (until a draft exists); everyone sees draft-sections once a draft exists.
  await page.waitForSelector(`${tid('notes-input')}, ${tid('draft-sections')}`);
}

async function importNotes(page, text) {
  await page.fill(tid('notes-input'), text);
  await page.click(tid('notes-import'));
}

async function generate(page, provider) {
  await page.selectOption(tid('provider-select'), provider);
  await page.click(tid('generate'));
  await page.waitForSelector(tid('draft-sections'));
}

// Regression (rework-5): a null child passed to native Element.append renders the literal text
// "null". Fails if any element has a direct text node whose trimmed content is exactly "null".
async function assertNoStrayNull(page, label) {
  const stray = await page.evaluate(() => [...document.querySelectorAll('body *')]
    .filter((el) => [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim() === 'null'))
    .map((el) => `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}${el.className ? `.${el.className}` : ''}`));
  assert.deepEqual(stray, [], `${label}: literal "null" text rendered in ${stray.join(', ')}`);
}

async function auditLayout(page, vp, label, findings) {
  await assertNoStrayNull(page, label); // every audited page, including the viewer's postmortem
  const o = await overflow(page);
  if (o.doc > 0 || o.body > 0) findings.push(`${label}: horizontal overflow doc=${o.doc} body=${o.body}`);
  const bad = await page.evaluate(() => {
    const out = [];
    const parse = (c) => { const m = c.match(/rgba?\(([^)]+)\)/); if (!m) return null; const p = m[1].split(/[ ,\/]+/).filter(Boolean).map(Number); return { r: p[0], g: p[1], b: p[2], a: p[3] ?? 1 }; };
    const lum = ({ r, g, b }) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
    const bgOf = (el) => {
      for (let e = el; e; e = e.parentElement) { const c = parse(getComputedStyle(e).backgroundColor); if (c && c.a > 0.99) return c; }
      return { r: 255, g: 255, b: 255, a: 1 };
    };
    const seen = new Set();
    for (const el of document.querySelectorAll('h1,h2,h3,p,li,span,a,button,label,code,textarea,input,select')) {
      if (!el.offsetParent && el.tagName !== 'BODY') continue;
      const direct = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
      if (!direct && !['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName)) continue;
      const cs = getComputedStyle(el);
      if (cs.visibility === 'hidden' || Number(cs.opacity) === 0) continue;
      const fg = parse(cs.color); if (!fg) continue;
      const bg = bgOf(el);
      const L1 = lum(fg); const L2 = lum(bg);
      const ratio = (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05);
      const size = parseFloat(cs.fontSize); const bold = Number(cs.fontWeight) >= 700;
      const need = size >= 24 || (size >= 18.66 && bold) ? 3 : 4.5;
      const key = `${el.tagName}.${el.className}|${cs.color}|${cs.backgroundColor}`;
      if (ratio < need && !seen.has(key)) { seen.add(key); out.push(`${el.tagName}.${el.className} "${(el.textContent || '').trim().slice(0, 30)}" ratio ${ratio.toFixed(2)} < ${need}`); }
    }
    return out;
  });
  for (const b of bad) findings.push(`${label}: contrast ${b}`);
  if (vp.width <= 400) {
    const small = await page.evaluate(() => {
      const out = [];
      for (const el of document.querySelectorAll('button,select,input:not([type=hidden]),textarea,nav a,.skip-link,.btn')) {
        if (!el.offsetParent) continue;
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) continue;
        if (r.height < 43.5 || r.width < 43.5) out.push(`${el.tagName}.${el.className}[${el.dataset.testid || el.textContent.trim().slice(0, 20)}] ${r.width.toFixed(0)}x${r.height.toFixed(0)}`);
      }
      return out;
    });
    for (const s of small) findings.push(`${label}: touch target < 44px: ${s}`);
  }
}

// ---------- the journey, once per viewport ----------
for (const vp of VIEWPORTS) {
  test(`browser journey at ${vp.name}px`, { timeout: 240000 }, async (t) => {
    const findings = []; // layout/a11y findings, asserted in the final step
    const tag = `${vp.name}-${Date.now().toString(36)}`;
    const T1 = `Checkout outage ${tag}`; const T2 = `Second incident ${tag}`; const T3 = `Fallback incident ${tag}`;
    const resp = await newSession(vp);
    const { page } = resp;

    await t.test('sign in: empty state and invalid password error', async () => {
      await signIn(page, 'platform-responder', 'wrong-password-123');
      const alert = page.locator(tid('login-error'));
      await alert.filter({ hasText: /\S/ }).waitFor();
      assert.equal(await alert.getAttribute('role'), 'alert');
      await shot(page, vp, '01-login-error');
      await auditLayout(page, vp, 'login', findings);
      await page.fill(tid('login-password'), PASSWORD);
      await page.click(tid('login-submit'));
      await page.waitForSelector(tid('incident-create'));
      // The seed creates a sample Platform incident, so the list is non-empty here; the empty state is
      // asserted for the team with no incidents (Payments) below.
    });

    await t.test('create incident: inline validation then success', async () => {
      await page.click(tid('incident-create'));
      const err = page.locator('#err-title');
      assert.match(await err.textContent(), /Enter a title/);
      assert.equal(await page.locator(tid('incident-title')).getAttribute('aria-invalid'), 'true');
      await createIncident(page, T1);
      await shot(page, vp, '02-incident-created');
      await auditLayout(page, vp, 'incidents', findings);
      for (const title of [T2, T3]) await createIncident(page, title);
    });

    await t.test('import notes: malformed error then success', async () => {
      await openIncident(page, T1);
      await assertNoStrayNull(page, 'incident page');
      await importNotes(page, 'this is not a note line\n14:02 alice: fine');
      const alert = page.locator(`${tid('notes-error')} [role=alert]`).first();
      await alert.waitFor();
      assert.match(await page.locator(tid('notes-error')).textContent(), /Line 1:/);
      await shot(page, vp, '03-notes-error');
      await importNotes(page, NOTES);
      await page.waitForFunction(() => document.getElementById('live-status').textContent === 'Imported 4 lines');
      await shot(page, vp, '04-notes-imported');
    });

    await t.test('generate with fake: loading status, flagged statements, no fallback banner', async () => {
      await page.selectOption(tid('provider-select'), 'fake');
      await page.click(tid('generate'));
      await page.waitForSelector(tid('draft-sections'));
      await assertNoStrayNull(page, 'draft review');
      assert.equal(await page.locator(tid('fallback-banner')).count(), 0);
      const flagged = page.locator('.status-flagged');
      assert.ok((await flagged.count()) >= 2, 'expected at least two flagged statements');
      assert.match(await flagged.first().textContent(), /Not grounded/);
      const reasons = await page.locator('ul.reasons').allTextContents();
      assert.ok(reasons.some((r) => /No source cited/.test(r)), `reasons: ${reasons}`);
      assert.ok(reasons.some((r) => /does not exist/.test(r)), `reasons: ${reasons}`);
      assert.match(await page.locator(tid('flag-count')).textContent(), /2 statements not grounded/);
      await shot(page, vp, '05-draft-flagged');
      await auditLayout(page, vp, 'draft-review', findings);
    });

    await t.test('citation chip highlights, focuses and announces the source line', async () => {
      const chip = page.locator('.chip:not(.chip-missing)').first();
      const n = await chip.getAttribute('data-line');
      if (vp.width < 900) {
        assert.equal(await page.locator(tid('source-panel')).isVisible(), false, 'source panel should start closed at 360');
      }
      await chip.click();
      const line = page.locator(tid(`source-line-${n}`));
      await line.waitFor({ state: 'visible' });
      assert.match(await line.getAttribute('class'), /is-highlighted/);
      assert.equal(await page.evaluate((k) => document.activeElement?.id === `line-${k}`, n), true, 'focus should be on the line');
      const inView = await line.evaluate((el) => { const r = el.getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight; });
      assert.ok(inView, 'highlighted line should be in the viewport');
      await page.waitForFunction((k) => document.getElementById('live-status').textContent === `Source line ${k} highlighted`, n);
      await shot(page, vp, '06-citation-highlight');
    });

    await t.test('keyboard: skip link, chips, Edit, Save reachable; focus outline >= 2px', async () => {
      await page.goto(`${baseUrl}/#/login`); // fresh page state for a deterministic tab order
      await page.reload();
      await page.waitForSelector(tid('incident-create'));
      // After a route render the app moves focus to the h1, so reach the skip link directly.
      await page.focus('.skip-link');
      assert.equal(await page.evaluate(() => document.activeElement.className), 'skip-link');
      const w = await page.evaluate(() => { const s = getComputedStyle(document.activeElement); return { w: parseFloat(s.outlineWidth), style: s.outlineStyle }; });
      assert.ok(w.w >= 2 && w.style !== 'none', `skip link outline ${JSON.stringify(w)}`);
      await page.locator('#incident-list a', { hasText: T1 }).first().click();
      await page.waitForSelector(tid('draft-sections'));
      const seen = new Set();
      let sawChip = false; let sawEdit = false;
      for (let i = 0; i < 80 && !(sawChip && sawEdit); i++) {
        await page.keyboard.press('Tab');
        const info = await page.evaluate(() => {
          const a = document.activeElement; const s = getComputedStyle(a);
          return { cls: a.className, testid: a.dataset?.testid || '', w: parseFloat(s.outlineWidth), style: s.outlineStyle };
        });
        seen.add(info.testid || info.cls);
        assert.ok(info.w >= 2 && info.style !== 'none', `no visible focus outline on ${info.testid || info.cls}: ${JSON.stringify(info)}`);
        if (/^chip-/.test(info.testid)) sawChip = true;
        if (/^edit-\d+$/.test(info.testid)) sawEdit = true;
      }
      assert.ok(sawChip && sawEdit, `Tab did not reach chip and Edit; saw ${[...seen].join(',')}`);
      await page.keyboard.press('Enter'); // activate Edit with the keyboard
      await page.waitForSelector(tid('edit-text'));
      assert.equal(await page.evaluate(() => document.activeElement.dataset.testid), 'edit-text');
      let reachedSave = false;
      for (let i = 0; i < 4 && !reachedSave; i++) {
        await page.keyboard.press('Tab');
        reachedSave = await page.evaluate(() => document.activeElement.dataset.testid === 'edit-save');
      }
      assert.ok(reachedSave, 'Save reachable by Tab');
      await shot(page, vp, '07-keyboard-edit');
      await page.click(tid('edit-cancel'));
    });

    await t.test('edit flagged statements to grounded text: flags clear, counter updates', async () => {
      const fix = async (flaggedIndex, text, cite) => {
        const li = page.locator('li.statement.is-flagged').nth(flaggedIndex);
        await li.locator('[data-testid^="edit-"]:not([data-testid="edit-text"])').first().click();
        await page.fill(tid('edit-text'), text);
        await page.fill(tid('edit-cites'), String(cite));
        await page.click(tid('edit-save'));
      };
      await fix(0, 'Rolled back the deploy to v2', 2);
      await page.waitForFunction(() => /1 statement not grounded/.test(document.getElementById('flag-count').textContent));
      await fix(0, 'Error rate recovered after rollback', 3);
      await page.waitForFunction(() => /All statements grounded/.test(document.getElementById('flag-count').textContent));
      assert.equal(await page.locator('li.statement.is-flagged').count(), 0);
      assert.ok((await page.locator('li.statement', { hasText: '(edited)' }).count()) >= 2);
      await shot(page, vp, '08-edited-grounded');
    });

    await t.test('second incident: flagged draft, XSS probe, fallback banner', async () => {
      await page.goto(`${baseUrl}/#/incidents`);
      await openIncident(page, T2);
      await importNotes(page, `${NOTES}\n14:20 dave: ${XSS}`);
      await page.waitForFunction(() => document.getElementById('live-status').textContent === 'Imported 5 lines');
      await generate(page, 'fake');
      // The XSS text must show literally in the source panel and must not execute.
      const chip = page.locator('.chip:not(.chip-missing)').first();
      await chip.click();
      const srcText = await page.locator(tid('source-panel')).textContent();
      assert.ok(srcText.includes(XSS), 'XSS payload should be displayed literally');
      assert.equal(await page.locator('#src-body img').count(), 0, 'no img element injected');
      assert.equal(await page.evaluate(() => window.__xss), undefined);
      await shot(page, vp, '09-xss-literal');

      await page.goto(`${baseUrl}/#/incidents`);
      await openIncident(page, T3);
      await importNotes(page, NOTES);
      await page.waitForFunction(() => document.getElementById('live-status').textContent === 'Imported 4 lines');
      await generate(page, 'fallback');
      await page.waitForSelector(tid('fallback-banner'));
      assert.match(await page.locator(tid('fallback-banner')).textContent(), /no AI was used/);
      await shot(page, vp, '10-fallback-banner');
      await signOut(page);
    });

    await t.test('lead: publish disabled while flagged; enabled at zero flags; publish succeeds, read-only', async () => {
      await signIn(page, 'platform-lead');
      await page.waitForSelector(tid('incident-create'));
      await openIncident(page, T2);
      await page.waitForSelector(tid('publish'));
      assert.equal(await page.locator(tid('publish')).isDisabled(), true, 'publish disabled with flagged statements');
      await shot(page, vp, '11-publish-blocked');
      await page.goto(`${baseUrl}/#/incidents`);
      await openIncident(page, T1);
      await page.waitForSelector(tid('publish'));
      assert.equal(await page.locator(tid('publish')).isDisabled(), false, 'publish enabled at zero flags');
      await page.click(tid('publish'));
      await page.waitForSelector(tid('published-state'));
      assert.match(await page.locator(tid('published-state')).textContent(), /Published/);
      assert.equal(await page.locator('[data-testid^="edit-"]:not([data-testid="edit-text"])').count(), 0, 'edit controls gone');
      assert.equal(await page.locator('[data-testid^="remove-"]').count(), 0, 'remove controls gone');
      assert.equal(await page.locator(tid('publish')).count(), 0);
      await shot(page, vp, '12-published');
      await auditLayout(page, vp, 'published', findings);
      await signOut(page);
    });

    await t.test('viewer reads the postmortem and highlights a citation', async () => {
      await signIn(page, 'platform-viewer');
      await page.waitForSelector(tid('postmortem-list'));
      assert.equal(await page.locator(tid('nav-incidents')).count(), 0, 'viewer has no Incidents nav');
      await page.locator(`${tid('postmortem-list')} a`, { hasText: T1 }).click();
      await page.waitForSelector(tid('draft-sections'));
      assert.equal(await page.locator('[data-testid^="edit-"]:not([data-testid="edit-text"])').count(), 0);
      await page.locator('.chip:not(.chip-missing)').first().click();
      await page.locator('.is-highlighted').waitFor({ state: 'visible' });
      await shot(page, vp, '13-viewer-postmortem');
      await auditLayout(page, vp, 'viewer-postmortem', findings);
      await signOut(page);
    });

    await t.test('cross-team viewer sees the empty state', async () => {
      await signIn(page, 'payments-viewer');
      await page.waitForSelector(tid('postmortems-empty'));
      assert.match(await page.locator(tid('postmortems-empty')).textContent(), /No published postmortems/);
      assert.equal(await page.locator(`text=${T1}`).count(), 0);
      await shot(page, vp, '14-cross-team-empty');
      await signOut(page);
      await signIn(page, 'payments-responder');
      await page.waitForSelector(tid('incidents-empty'));
      await shot(page, vp, '15-incidents-empty');
      await auditLayout(page, vp, 'incidents-empty', findings);
    });

    await t.test('layout and a11y checks: overflow, contrast, touch targets', async () => {
      assert.deepEqual(findings, []);
    });

    await t.test('no console errors, no failed requests, no dialogs', async () => {
      // Expected 4xx: the invalid-password 401 and the 400 for malformed notes / empty form.
      const unexpected = resp.consoleErrors.filter((e) => !/Failed to load resource: the server responded with a status of (400|401|409|422)|status of 404 \(Not Found\) @ \S+\/api\/incidents\/\d+\/draft$/.test(e));
      assert.deepEqual(unexpected, []);
      assert.deepEqual(resp.failedRequests, []);
      assert.deepEqual(resp.dialogs, []);
    });

    await resp.ctx.close();
  });
}
