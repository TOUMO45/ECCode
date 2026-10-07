'use strict';
// t17 browser verification (AC6/AC15 inspection items, XSS rendering, 360px reflow).
// Starts `node src/server.js` with PORT=0 and no API key (fallback mode), drives headless Chromium,
// writes screenshots to .eccode/artifacts/verification/, stops the server. Exit 0 only if every check passes.
const { spawn } = require('node:child_process');
const path = require('node:path');
const { chromium } = require('/opt/node-tools/node_modules/playwright');

const root = path.resolve(__dirname, '..', '..');
const outDir = path.join(root, '.eccode', 'artifacts', 'verification');
const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: !!ok });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail !== undefined ? ' :: ' + detail : ''}`);
}

function startServer() {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, PORT: '0', HOST: '127.0.0.1' };
    delete env.ANTHROPIC_API_KEY;
    const child = spawn(process.execPath, ['src/server.js'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let buf = '';
    let done = false;
    const timer = setTimeout(() => reject(new Error('no listening line within 5s')), 5000);
    child.stdout.on('data', (d) => {
      if (done) return;
      buf += d;
      for (const line of buf.split('\n')) {
        try {
          const j = JSON.parse(line);
          if (j.event === 'listening' || j.msg === 'listening' || j.type === 'listening') {
            clearTimeout(timer);
            done = true;
            console.log('server listening line fields:', Object.keys(j).join(','), 'mode=' + j.mode);
            resolve({ child, port: j.port });
            return;
          }
        } catch (_) { /* partial line */ }
      }
    });
    child.stderr.on('data', (d) => process.stderr.write('[server stderr] ' + d));
    child.on('exit', (c) => reject(new Error('server exited ' + c)));
  });
}

async function run() {
  const { child, port } = await startServer();
  const base = `http://127.0.0.1:${port}/`;
  const browser = await chromium.launch();
  try {
    for (const width of [360, 1280]) {
      const ctx = await browser.newContext({ viewport: { width, height: 800 } });
      await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: base.slice(0, -1) });
      const page = await ctx.newPage();
      const dialogs = [];
      page.on('dialog', async (d) => { dialogs.push(d.message()); await d.dismiss(); });
      const t0 = Date.now();
      await page.goto(base);
      await page.waitForFunction(() => !document.getElementById('mode-badge').textContent.includes('Checking'));
      const badge = await page.textContent('#mode-badge');
      check(`[${width}] mode badge shows fallback`, /Fallback mode/.test(badge), badge);

      // Keyboard only: Tab until the textarea is focused, type, Ctrl+Enter.
      let tabs = 0;
      while (tabs < 10) {
        await page.keyboard.press('Tab');
        tabs++;
        if (await page.evaluate(() => document.activeElement && document.activeElement.id === 'ticket')) break;
      }
      check(`[${width}] textarea reached by keyboard`, tabs < 10, `${tabs} Tab press(es)`);
      await page.keyboard.type('Hi, I was charged twice for my subscription this month. Please refund the duplicate payment urgently.');
      const tSubmit = Date.now();
      await page.keyboard.press('Control+Enter');
      await page.waitForSelector('#result:not([hidden])', { timeout: 5000 });
      const latency = Date.now() - tSubmit;
      const label = await page.textContent('#source-label');
      check(`[${width}] result rendered with fallback label`, /Deterministic fallback — not AI-generated/.test(label), label);
      const status = await page.$eval('#status', (el) => ({ live: el.getAttribute('aria-live'), text: el.textContent }));
      check(`[${width}] aria-live status announces result`, status.live === 'polite' && /Analysis complete/.test(status.text), status.text);
      const cat = await page.textContent('#result-category');
      const urg = await page.textContent('#result-urgency');
      console.log(`[${width}] category=${cat} urgency=${urg} ctrl+enter->render ${latency}ms (page load+health ${tSubmit - t0}ms)`);

      // AC6: edit reply, copy, reset.
      await page.focus('#reply');
      await page.keyboard.press('End');
      await page.keyboard.type(' -- edited');
      await page.click('#copy');
      await page.waitForFunction(() => /copied|Copy failed/.test(document.getElementById('status').textContent));
      const copyStatus = await page.textContent('#status');
      let clip = null;
      try { clip = await page.evaluate(() => navigator.clipboard.readText()); } catch (_) { /* ignore */ }
      check(`[${width}] AC6 edited reply copied`, /copied/.test(copyStatus) && clip && clip.endsWith(' -- edited'), copyStatus);
      await page.click('#reset');
      const resetVal = await page.inputValue('#reply');
      check(`[${width}] AC6 reset restores suggestion`, !resetVal.endsWith(' -- edited'));

      // Reflow: no horizontal scroll.
      const sw = await page.evaluate(() => ({ s: document.documentElement.scrollWidth, c: document.documentElement.clientWidth }));
      check(`[${width}] no horizontal scroll`, sw.s <= sw.c, `scrollWidth=${sw.s} clientWidth=${sw.c}`);
      await page.screenshot({ path: path.join(outDir, `ui-${width}.png`), fullPage: true });

      // XSS: payload must render as text.
      const payload = '<img src=x onerror=alert(1)> my login page shows this <b>bold</b> text';
      await page.fill('#ticket', payload);
      await page.focus('#ticket');
      await page.keyboard.press('Control+Enter');
      await page.waitForFunction(() => /Analysis complete/.test(document.getElementById('status').textContent) && document.getElementById('status').textContent !== window.__lastStatus);
      await page.waitForTimeout(300);
      const imgs = await page.evaluate(() => document.querySelectorAll('main img, #result img').length);
      const bolds = await page.evaluate(() => document.querySelectorAll('#result b').length);
      const summaryText = await page.textContent('#result-summary');
      const ticketVal = await page.inputValue('#ticket');
      check(`[${width}] payload kept verbatim as text in the textarea`, ticketVal === payload);
      check(`[${width}] XSS payload creates no element and no dialog`, imgs === 0 && bolds === 0 && dialogs.length === 0,
        `img=${imgs} b=${bolds} dialogs=${dialogs.length}`);
      console.log(`[${width}] summary for payload ticket: ${JSON.stringify(summaryText)}`);
      await page.screenshot({ path: path.join(outDir, `ui-${width}-xss.png`), fullPage: true });
      await ctx.close();
    }
  } finally {
    await browser.close();
    child.kill('SIGTERM');
    await new Promise((r) => child.once('exit', (c, s) => { console.log(`server stopped (code=${c} signal=${s})`); r(); }));
  }
  const failed = results.filter((r) => !r.ok).length;
  console.log(`BROWSER_CHECK ${results.length - failed}/${results.length} passed`);
  process.exitCode = failed ? 1 : 0;
}

run().catch((e) => { console.error('browser check error:', e && e.message); process.exitCode = 2; });
