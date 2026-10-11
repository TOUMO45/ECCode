// Static scan of the shipped frontend assets (public/**): no secrets or client ids, one API module, the RS-34 labels,
// no markup parsing, no inline handlers, and compatibility with the app's Content-Security-Policy. Reads files only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PUBLIC = path.join(ROOT, 'public');

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir).sort()) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

const files = walk(PUBLIC);
const rel = (f) => path.relative(PUBLIC, f).split(path.sep).join('/');
const text = new Map(files.map((f) => [rel(f), readFileSync(f, 'utf8')]));
const jsFiles = [...text.keys()].filter((f) => f.endsWith('.js'));
const allJs = jsFiles.map((f) => text.get(f)).join('\n');
const html = text.get('index.html');
const css = text.get('css/app.css');

// Source with comments removed, so prose in a comment cannot trip or hide a check.
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
}
const code = new Map(jsFiles.map((f) => [f, stripComments(text.get(f))]));
const allCode = [...code.values()].join('\n');

test('RS-35: the SPA ships the files the design lists: one page, one stylesheet, the modules, views and components', () => {
  const expected = [
    'index.html', 'css/app.css',
    'js/main.js', 'js/router.js', 'js/api.js', 'js/store.js', 'js/dom.js', 'js/format.js', 'js/poll.js',
    'js/views/signin.js', 'js/views/register.js', 'js/views/requests-list.js', 'js/views/request-new.js', 'js/views/request-detail.js',
    'js/views/supplier-orders.js', 'js/views/supplier-inventory.js', 'js/views/admin.js',
    'js/components/banner.js', 'js/components/badges.js', 'js/components/status.js', 'js/components/fields-table.js',
    'js/components/plan-card.js', 'js/components/rejections.js', 'js/components/totals.js', 'js/components/commitments.js',
    'js/components/payments.js', 'js/components/compensation.js', 'js/components/notice.js',
  ];
  for (const f of expected) assert.ok(text.has(f), `missing public/${f}`);
});

test('NFR2: index.html has one main#app, a persistent #banner, an aria-live polite #announcer, a skip link and landmarks', () => {
  assert.match(html, /^<!doctype html>/i);
  assert.match(html, /<html lang="en">/);
  assert.match(html, /<meta name="viewport" content="width=device-width, initial-scale=1">/);
  assert.equal((html.match(/<main\b/g) ?? []).length, 1);
  assert.match(html, /<main id="app"/);
  assert.equal((html.match(/id="banner"/g) ?? []).length, 1);
  assert.match(html, /<div id="announcer"[^>]*aria-live="polite"/);
  assert.match(html, /<a class="skip-link" href="#app">/);
  assert.match(html, /<header\b/);
  assert.match(html, /<nav aria-label="[^"]+"/);
  assert.equal((html.match(/id="(app|banner|announcer)"/g) ?? []).length, 3, 'no duplicate ids for the three anchors');
});

test('NFR2: the stylesheet gives visible focus, 44 px targets, a 360 px single column and a two-column layout from 1024 px', () => {
  assert.match(css, /:focus-visible\s*\{[^}]*outline:\s*3px solid/);
  assert.match(css, /min-height:\s*44px/);
  assert.match(css, /min-width:\s*44px/);
  assert.match(css, /@media \(min-width: 1024px\)/);
  assert.match(css, /\.table-scroll\s*\{[^}]*overflow-x:\s*auto/);
  // the only places that remove an outline are the programmatic-focus targets, and they draw a ring on focus-visible
  const removals = [...css.matchAll(/([^{}]+)\{[^}]*outline:\s*none/g)].map((m) => m[1].trim());
  assert.deepEqual(removals, ['main:focus, h1:focus']);
  assert.match(css, /h1:focus-visible\s*\{[^}]*outline:\s*3px solid/);
});

test('RS-29: no secret, client id, token or credential-shaped value is in public/', () => {
  const patterns = [
    [/client[_-]?id/i, 'client id'],
    [/client[_-]?secret/i, 'client secret'],
    [/merchant[_-]?id/i, 'merchant id'],
    [/api[_-]?key\s*[:=]/i, 'api key'],
    [/secret\s*[:=]\s*['"`][^'"`]+['"`]/i, 'secret literal'],
    [/(?:password|passwd|pwd)\s*[:=]\s*['"`][^'"`\s]{3,}['"`]/i, 'password literal'],
    [/bearer\s+[A-Za-z0-9._~+/=-]{12,}/i, 'bearer token'],
    [/-----BEGIN [A-Z ]*(?:PRIVATE|CERTIFICATE)/, 'key material'],
    [/\bsk-[A-Za-z0-9_-]{16,}/, 'API key'],
    [/\bA[A-Za-z0-9_-]{70,}\b/, 'PayPal-style client id'],
    [/\b[A-Za-z0-9+/_-]{40,}={0,2}(?![A-Za-z0-9+/_-])/, 'long token-like value'],
    [/\b[0-9a-f]{32,}\b/i, 'long hex value'],
    [/\bEC[A-Z0-9_-]{30,}/, 'PayPal secret'],
  ];
  for (const [name, source] of text) {
    for (const [pattern, label] of patterns) assert.doesNotMatch(source, pattern, `${label} in public/${name}`);
  }
  assert.doesNotMatch(allCode, /\b(localStorage|document\.cookie|indexedDB)\b/, 'nothing is persisted in the browser except the reserve key in sessionStorage');
  const sessionUses = [...allCode.matchAll(/sessionStorage/g)].length;
  assert.ok(sessionUses >= 1);
  assert.match(text.get('js/reserve-key.js'), /reserve:\$\{planVersionId\}/);
});

test('RS-29: the page names no payment-provider SDK and loads nothing from a PayPal host', () => {
  assert.doesNotMatch(html, /paypal/i);
  assert.doesNotMatch(allCode, /paypal\.com|paypalobjects|sdk\/js/i);
});

test('NFR2: every network call goes through js/api.js', () => {
  for (const [name, source] of code) {
    if (name === 'js/api.js') continue;
    assert.doesNotMatch(source, /\bfetch\s*\(/, `fetch in public/${name}`);
    assert.doesNotMatch(source, /\bXMLHttpRequest\b|\bsendBeacon\b|\bEventSource\b|\bWebSocket\b|\bnavigator\.serviceWorker\b/, `other transport in public/${name}`);
    assert.doesNotMatch(source, /\bimport\s*\(/, `dynamic import in public/${name}`);
  }
  const apiSource = code.get('js/api.js');
  assert.equal((apiSource.match(/globalThis\.fetch/g) ?? []).length, 1, 'api.js reaches the network through one call site');
  assert.match(apiSource, /X-CSRF-Token/);
  assert.match(apiSource, /AbortController/);
  assert.match(apiSource, /API_TIMEOUT_MS\s*=\s*15000/);
  // navigation to the approval page is the only use of location.assign, and it lives in main.js
  assert.match(code.get('js/main.js'), /location\.assign\(url\)/);
});

test('NFR2: every route path api.js calls has a contract fixture, and every api method the views call exists', () => {
  const apiSource = text.get('js/api.js');
  const routes = new Set();
  for (const m of apiSource.matchAll(/\b(send|mutate)\(\s*'([A-Z]+)',\s*([`'])(.*?)\3/g)) {
    let p = m[4].replace(/\$\{id\([^)]*\)\}/g, ':id');
    const cut = p.indexOf('${');
    if (cut >= 0) p = p.slice(0, cut);
    routes.add(`${m[2]} /api${p}`);
  }
  assert.ok(routes.size >= 28, `found ${routes.size} routes in api.js`);
  const fixtureDir = path.join(ROOT, 'test', 'fixtures', 'contracts');
  const fixtureRoutes = new Set(readdirSync(fixtureDir).filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(readFileSync(path.join(fixtureDir, f), 'utf8')))
    .filter((fx) => fx.status < 400).map((fx) => fx.route));
  for (const r of routes) assert.ok(fixtureRoutes.has(r), `no contract fixture for ${r}`);

  const defined = new Set([...apiSource.matchAll(/^ {4}(\w+)(?::|\()/gm)].map((m) => m[1]));
  for (const [name, source] of code) {
    if (name === 'js/api.js') continue;
    for (const m of source.matchAll(/\bapi\.(\w+)\(/g)) assert.ok(defined.has(m[1]), `public/${name} calls api.${m[1]}, which api.js does not define`);
  }
});

test('RS-34: the labels the UI must show are all present in the shipped code', () => {
  const required = [
    'Simulated payments and/or AI — nothing here is real',
    'Test mode — local stubs, nothing is real',
    'PayPal Sandbox — no real money',
    'Simulated',
    'Demo data',
    'Test prices, not market prices',
    'All demo suppliers are paid to one Sandbox account',
    'Text read from the photo',
    'Reservation expired — no money was taken; re-plan with current stock',
    'Automatic reading unavailable — please enter the details',
    'Finding a new plan with current stock…',
    'Cancelled — payment did not complete',
    'The server is taking too long.',
    'No rescue requests yet',
    'Start a rescue request',
    'You already hold stock for another request — finish or abandon it first',
    'Not yet confirmed',
    'Catalog offer',
    'Supplier confirmed',
    'What you need',
    'Why this plan',
    'What was rejected',
    'Supplier commitments',
    'If something fails',
    'Not a match for your cups (capacity or size)',
    'Describe what you need, in Arabic or English',
    'Try approval again',
    'Abandon purchase',
    'Complete purchase',
    'Record receipt',
    'Delete request',
    'Approve with PayPal',
    'PayPal approvals:',
    'From your text',
    'From the photo',
    'Entered by you',
    'Not found',
    'This request contains text addressed to an AI; it was ignored.',
    'Original wording',
  ];
  for (const label of required) assert.ok(allCode.includes(label), `label missing from public/js: ${label}`);
});

test('RS-35: the data-testid hooks of the spec are all present', () => {
  const hooks = [
    'approve-plan', 'reserve', 'paypal-approve-', 'execute', 'rescue-status', 'field-', 'rejection-', 'total-overall',
    'commit-', 'compensation', 'degraded-notice', 'banner-simulated', 'badge-demo', 'price-notice',
    // phase D (extraction)
    'ai-addressed-notice', 'badge-simulated', 'extraction-', 'question-', 'input-', 'manual-form', 'delete-request',
  ];
  for (const hook of hooks) assert.ok(allCode.includes(`'${hook}`) || allCode.includes(`\`${hook}`) || allCode.includes(`"${hook}`), `data-testid ${hook} not found`);
  // and the dom helper is the only place that writes the attribute
  assert.match(code.get('js/dom.js'), /'data-testid'/);
});

test('T11: DOM is built with textContent and attribute setters only — no markup parsing anywhere', () => {
  const banned = [
    /\.\s*innerHTML\b/, /\bouterHTML\b/, /\binsertAdjacentHTML\b/, /\bdocument\.write(ln)?\b/, /\bcreateContextualFragment\b/,
    /\bDOMParser\b/, /\bsrcdoc\b(?!.*REFUSED)/, /\.setHTML\b/, /\bexecCommand\b/, /\bcreateRange\b/,
  ];
  for (const [name, source] of code) {
    for (const pattern of banned) {
      const hit = source.split('\n').find((line) => pattern.test(line) && !/REFUSED_ATTRS/.test(line));
      assert.equal(hit, undefined, `${pattern} in public/${name}: ${hit}`);
    }
  }
  assert.doesNotMatch(html, /innerHTML/);
  assert.match(code.get('js/dom.js'), /\.textContent\s*=/);
  assert.match(code.get('js/dom.js'), /createTextNode/);
});

test('T11: no inline script, inline style or inline event handler in the page or in the code', () => {
  assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>/i, 'every script tag has a src');
  assert.doesNotMatch(html, /<script[^>]*>\s*(?!<\/script>)\S/i, 'no script body');
  assert.doesNotMatch(html, /<style\b/i);
  assert.doesNotMatch(html, /\sstyle\s*=/i);
  assert.doesNotMatch(html, /\son[a-z]+\s*=/i);
  assert.doesNotMatch(html, /href\s*=\s*["']\s*ja/i);
  for (const [name, source] of code) {
    assert.doesNotMatch(source, /\.\s*on[a-z]+\s*=[^=]/, `handler property in public/${name}`);
    assert.doesNotMatch(source, /setAttribute\(\s*['"`](on[a-z]+|style)['"`]/i, `inline handler or style in public/${name}`);
    assert.doesNotMatch(source, /\.style\s*[.[=]|\.cssText\b|\.style\.setProperty/, `style written from script in public/${name}`);
    assert.doesNotMatch(source, /\bon(click|change|submit|load|error|input|keydown|keyup)\s*:\s*['"`]/, `string handler in public/${name}`);
  }
  // events are attached with addEventListener through the "on" prop of el(); the helper refuses on* attributes
  assert.match(code.get('js/dom.js'), /name\.startsWith\('on'\)/);
  assert.match(code.get('js/dom.js'), /addEventListener/);
  assert.match(code.get('js/dom.js'), /REFUSED_ATTRS = new Set\(\['style', 'srcdoc'\]\)/);
});

test('T11: nothing evaluates a string: no eval, no Function constructor, no string timers', () => {
  for (const [name, source] of code) {
    assert.doesNotMatch(source, /\beval\s*\(/, `eval in public/${name}`);
    assert.doesNotMatch(source, /\bnew\s+Function\b|\bFunction\s*\(/, `Function constructor in public/${name}`);
    assert.doesNotMatch(source, /\bset(Timeout|Interval)\s*\(\s*['"`]/, `string timer in public/${name}`);
    assert.doesNotMatch(source, /\bwith\s*\(/, `with statement in public/${name}`);
  }
});

test('T11: the page is compatible with CSP default-src \'self\'; script-src \'self\'; style-src \'self\'; connect-src \'self\'', () => {
  const allowedNamespace = 'http://www.w3.org/2000/svg';
  for (const [name, source] of text) {
    const withoutAllowed = source.split(allowedNamespace).join('');
    // a literal URL with an origin would be an external dependency; regexes that mention the scheme are not URLs
    const urls = [...withoutAllowed.matchAll(/https?:\/\/[A-Za-z0-9[]/g)];
    assert.equal(urls.length, 0, `external origin in public/${name}: ${urls.map((u) => u[0]).join(', ')}`);
    assert.doesNotMatch(withoutAllowed, /(^|[^A-Za-z:])\/\/[A-Za-z0-9.-]+\.[a-z]{2,}\//, `protocol-relative URL in public/${name}`);
  }
  assert.doesNotMatch(css, /@import/);
  assert.doesNotMatch(css, /url\(\s*['"]?(?!#)/, 'the stylesheet loads no images or fonts');
  assert.doesNotMatch(html, /<(iframe|object|embed|base|form)\b/i);
  assert.doesNotMatch(html, /<link[^>]+href\s*=\s*["'](?!\/)/i, 'link tags point inside the app');
  assert.doesNotMatch(html, /<script[^>]+src\s*=\s*["'](?!\/js\/)/i, 'script tags point at /js/');
  assert.match(html, /<script type="module" src="\/js\/main\.js"><\/script>/);
  // scripts and styles are same-origin files; the SVG icon has no script or external reference
  const svg = text.get('favicon.svg');
  assert.doesNotMatch(svg, /<script|<style|href|onload|<image|<foreignObject/i);
});

test('SEC-C-4: dom.js refuses unsafe hrefs by the shared character check, and no source file holds an invisible control or separator character', () => {
  const dom = code.get('js/dom.js');
  assert.match(dom, /export function isAllowedUrl/);
  assert.match(dom, /hasUnsafeUrlChars\(value\)/);
  assert.doesNotMatch(dom, /\.trim\(\)/, 'a URL is refused, never repaired by trimming');
  assert.match(code.get('js/format.js'), /export function hasUnsafeUrlChars/);
  assert.match(code.get('js/format.js'), /hasUnsafeUrlChars\(value\)\) return false/, 'the PayPal approval link is checked too');
  // a source file with U+2028 or U+0085 in a regex or string broke a module once; allow only tab, LF and CR below U+0020
  for (const [name, source] of text) {
    for (let i = 0; i < source.length; i += 1) {
      const c = source.charCodeAt(i);
      const bad = (c < 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0d) || c === 0x7f || (c >= 0x80 && c <= 0x9f) || c === 0x2028 || c === 0x2029 || c === 0xfeff;
      assert.equal(bad, false, `invisible character U+${c.toString(16).padStart(4, '0')} at offset ${i} in public/${name}`);
    }
  }
});

test('TR-C-6: the "What you need" table is stacked below 640 px and is not wrapped in a scroll region', () => {
  assert.match(css, /@media \(max-width: 639px\)/);
  assert.match(css, /content:\s*attr\(data-label\)/);
  const fields = code.get('js/components/fields-table.js');
  assert.doesNotMatch(fields, /tableRegion/, 'the clipped scroll region is gone');
  assert.match(fields, /'Original wording'/);
  assert.match(fields, /data: \{ label: colWording \}/);
});

test('TR-C-4: "Delete request" is offered only through the capability flag', () => {
  const payments = code.get('js/components/payments.js');
  assert.match(payments, /deleteRequestAvailable\(view, config\) \? \{ label: 'Delete request'/);
  assert.match(code.get('js/view-helpers.js'), /capabilities\?\.deleteRequest/);
});

test('NFR2: every relative import resolves to a file under public/js, and no module imports from outside', () => {
  for (const [name, source] of code) {
    const specifiers = [...source.matchAll(/\bfrom\s+'([^']+)'/g)].map((m) => m[1]);
    for (const spec of specifiers) {
      assert.match(spec, /^\.\.?\//, `public/${name} imports ${spec}`);
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(name), spec));
      assert.ok(text.has(target), `public/${name} imports ${spec}, which does not exist`);
      assert.ok(target.startsWith('js/'), `public/${name} reaches outside js/`);
    }
  }
});

test('NFR2: modules can be imported without a browser (no DOM access at load time)', async () => {
  for (const f of jsFiles.filter((n) => n !== 'js/main.js')) {
    await import(path.join(PUBLIC, f));
  }
});

test('NFR2: every button is created with an explicit type, and every form control is created with a label or aria-label', () => {
  for (const [name, source] of code) {
    for (const m of source.matchAll(/el\(\s*'button'\s*,\s*\{([\s\S]{0,300}?)\}/g)) {
      assert.match(m[1], /\btype:/, `button without type in public/${name}`);
    }
  }
  const form = code.get('js/components/form.js');
  assert.match(form, /el\('label', \{ for: id/);
  assert.match(form, /'aria-describedby'/);
  assert.match(form, /'aria-invalid'/);
  const fields = code.get('js/components/fields-table.js');
  assert.match(fields, /el\('label', \{ for: spec\.inputId/);
  // free-standing inputs elsewhere are made by the form helpers, not by hand
  for (const [name, source] of code) {
    if (name === 'js/components/form.js' || name === 'js/components/fields-table.js') continue;
    assert.doesNotMatch(source, /el\(\s*'(input|select|textarea)'/, `unlabelled control built by hand in public/${name}`);
  }
});

test('NFR2: the router declares the eight hash routes and main.js moves focus to the h1 and announces the title', () => {
  const router = code.get('js/router.js');
  for (const name of ['signin', 'register', 'requests', 'request-new', 'request', 'supplier-orders', 'supplier-inventory', 'admin']) {
    assert.match(router, new RegExp(`name: '${name}'`), name);
  }
  const main = code.get('js/main.js');
  assert.match(main, /querySelector\('h1'\)/);
  assert.match(main, /heading\?\.focus\(\)/);
  assert.match(main, /announce\(parsed\.title\)/);
  assert.match(main, /hashchange/);
  assert.match(main, /getElementById\('announcer'\)/);
});

// ---- phase E (e5): payments ---------------------------------------------------------------------------------------

test('RS-18: the buyer reaches the approval page by navigation only: one location.assign, no form post, no window.open', () => {
  for (const [name, source] of code) {
    if (name !== 'js/main.js') assert.doesNotMatch(source, /\blocation\.(assign|replace)\b|\blocation\.href\s*=|\bwindow\.open\b/, `navigation call in public/${name}`);
    assert.doesNotMatch(source, /\.requestSubmit\s*\(|\.submit\s*\(\s*\)/, `programmatic form submit in public/${name}`);
    if (name === 'js/dom.js') continue; // dom.js only lists action/formaction among the URL attributes it validates
    assert.doesNotMatch(source, /el\(\s*'form'\s*,\s*\{[^}]*\baction\b/, `a form action set in public/${name}`);
    assert.doesNotMatch(source, /setAttr\([^)]*'(action|formaction)'/, `an action attribute set in public/${name}`);
    assert.doesNotMatch(source, /\bformaction\b/i, `formaction in public/${name}`);
  }
  assert.equal((code.get('js/main.js').match(/location\.assign\(/g) ?? []).length, 1, 'main.js has the one call site');
  // the page asks for the link, checks it with isNavigableUrl, and only then hands it to assignLocation
  const detail = code.get('js/views/request-detail.js');
  assert.match(detail, /isNavigableUrl\(answer\.approvalUrl\)/);
  assert.match(detail, /ctx\.assignLocation\(answer\.approvalUrl\)/);
  assert.ok(detail.indexOf('isNavigableUrl(answer.approvalUrl)') < detail.indexOf('ctx.assignLocation(answer.approvalUrl)'));
  assert.match(code.get('js/api.js'), /\/orders\/\$\{id\(orderId\)\}\/paypal\/create/);
});

test('NFR2: poll.js refreshes every 2 s, backs off to 10 s after 2 minutes and pauses while the page is hidden', () => {
  const poll = code.get('js/poll.js');
  assert.match(poll, /POLL_FAST_MS\s*=\s*2000/);
  assert.match(poll, /POLL_SLOW_MS\s*=\s*10000/);
  assert.match(poll, /POLL_BACKOFF_AFTER_MS\s*=\s*120000/);
  assert.match(poll, /document\?\.hidden/);
  assert.match(code.get('js/views/request-detail.js'), /addEventListener\?\.\('visibilitychange'/);
  assert.match(code.get('js/views/request-detail.js'), /removeEventListener\?\.\('visibilitychange'/);
  // a timer is always one of the injected ones: no setInterval that could outlive the page
  assert.doesNotMatch(poll, /\bsetInterval\b/);
});

test('RS-34: every payment element carries its provider badge, and the payment-state test hooks exist', () => {
  for (const file of ['js/components/payments.js', 'js/components/compensation.js', 'js/views/supplier-orders.js']) {
    assert.match(code.get(file), /providerBadgeModels\(/, `public/${file} labels its payment elements`);
  }
  for (const hook of ['single-credential-notice', 'success-', 'abandon', 'receipt-', 'ready-', 'handover-', 'error-link-', 'action-done']) {
    assert.ok(allCode.includes(`'${hook}`) || allCode.includes(`\`${hook}`), `data-testid ${hook} not found`);
  }
});

test('NFR2: the payment cards wrap at 360 px and a running action is marked aria-disabled', () => {
  assert.match(css, /\.paypal-approvals\s*\{[^}]*flex:\s*1 1 100%/);
  assert.match(css, /\.paypal-approvals \.card p\s*\{[^}]*overflow-wrap:\s*anywhere/);
  assert.match(code.get('js/views/request-detail.js'), /setAttribute\('aria-disabled', 'true'\)/);
});

test('RS-35: payment and supplier-order views build text with el(...text) only, never markup', () => {
  for (const file of ['js/components/payments.js', 'js/components/compensation.js', 'js/views/supplier-orders.js', 'js/views/request-detail.js']) {
    assert.doesNotMatch(code.get(file), /innerHTML|outerHTML|insertAdjacentHTML|document\.write|createContextualFragment/, `markup parsing in public/${file}`);
  }
});

// ---- phase F (f3): recovery ---------------------------------------------------------------------------------------

test('RS-32: the recovery sentences of the brief are in the shipped code, word for word', () => {
  const required = [
    'Finding a new plan with current stock…',
    'Review the new plan',
    'Re-plan with current stock',
    'Re-plan or try another PayPal account',
    'Reservation expired — no money was taken; re-plan with current stock',
    'Contact the organiser',
    'All payments were refunded by the organiser',
    'PayPal did not confirm the approval; try again',
    'Cancelled — payment did not complete',
  ];
  for (const sentence of required) assert.ok(code.get('js/texts.js').includes(sentence), `public/js/texts.js: ${sentence}`);
  assert.match(code.get('js/texts.js'), /Prices changed: review plan v\$\{version\}/);
});

test('RS-32: the recovery test hooks exist, and none is built twice under one name on a page', () => {
  for (const hook of ['replanning', 'reservation-expired', 'contact-organiser', 'compensation-summary', 'paypal-not-confirmed', 'fault-form', 'reset-form', 'reset-stranded', 'fault-done', 'next-step-action']) {
    assert.ok(allCode.includes(`'${hook}'`) || allCode.includes(`testid: \`${hook}`) || allCode.includes(`'${hook}`), `data-testid ${hook} not found`);
  }
  // the admin screen holds two forms with a "reason": each control has its own input-<name> hook
  const admin = code.get('js/views/admin.js');
  assert.match(admin, /name: 'reason', label: 'Reason \(10 to 500 characters, needed to force\)'/);
  assert.match(admin, /name: 'refusalReason'/);
});

test('NFR2: a hidden form row stays hidden, a section heading can take focus, and the refuse form states its limits', () => {
  assert.match(css, /\[hidden\]\s*\{\s*display:\s*none\s*!important/);
  assert.match(css, /h2:focus-visible\s*\{[^}]*outline:\s*3px solid/);
  const supplier = code.get('js/views/supplier-orders.js');
  assert.match(supplier, /maxlength: '300'/);
  assert.match(supplier, /1 to 300 characters/);
  assert.match(supplier, /The buyer sees this reason\./);
  assert.match(code.get('js/views/admin.js'), /faultFieldsFor\(chosen\)|faultFieldsFor\(kind\)/);
});

test('RS-32: the recovery views never claim a result the server has not given', () => {
  // "refunded" and "no money was taken" are written only in the sentences that depend on the payment's own status
  const compensation = code.get('js/components/compensation.js');
  for (const m of compensation.matchAll(/text: '([^']*(?:Refunded|returned|no money)[^']*)'/g)) {
    assert.match(m[1], /^(Refunded in full|Authorization voided|Cancelled before authorization|PayPal declined|Void queued|Refund queued)/, m[1]);
  }
  const admin = code.get('js/views/admin.js');
  assert.doesNotMatch(admin, /has been refunded|was refunded|were refunded/, 'a refund request is called a request');
  assert.match(admin, /A refund was requested for supplier order/);
});

// ---- phase G, g1: contrast, targets, focus, isolation, labels -----------------------------------------------------------------

function hexToRgb(hex) {
  const h = hex.replace('#', '');
  const full = h.length === 3 ? [...h].map((c) => c + c).join('') : h;
  return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16));
}
function luminance(hex) {
  const [r, g, b] = hexToRgb(hex).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}
const cssVars = Object.fromEntries([...css.matchAll(/(--[a-z-]+):\s*(#[0-9a-fA-F]{3,6})\s*;/g)].map((m) => [m[1], m[2]]));
function colorOf(value) {
  if (!value) return null;
  const v = /^var\((--[a-z-]+)\)$/.exec(value.trim());
  if (v) return cssVars[v[1]] ?? null;
  return /^#[0-9a-fA-F]{3,6}$/.test(value.trim()) ? value.trim() : null;
}
// Every rule of app.css that sets a text colour: [selector, colour, background or null]
function colourRules() {
  const out = [];
  for (const m of css.matchAll(/([^{}@]+)\{([^{}]*)\}/g)) {
    const selector = m[1].trim().replace(/\s+/g, ' ');
    const decl = Object.fromEntries(m[2].split(';').map((d) => d.split(/:(.*)/s).map((s) => s?.trim())).filter((p) => p[0] && p[1]).map(([k, v]) => [k, v]));
    const fg = colorOf(decl.color);
    if (!fg) continue;
    const bg = colorOf(decl.background) ?? colorOf(decl['background-color']);
    out.push({ selector, fg, bg });
  }
  return out;
}

test('NFR2: text contrast is at least 4.5:1 for every colour rule, on its own background or on the page and panel colours', () => {
  const rules = colourRules();
  assert.ok(rules.length >= 20, `read ${rules.length} colour rules`);
  assert.ok(Object.keys(cssVars).length >= 8, 'the custom properties were read');
  const failures = [];
  for (const { selector, fg, bg } of rules) {
    for (const against of bg ? [bg] : [cssVars['--bg'], cssVars['--panel']]) {
      const ratio = contrast(fg, against);
      if (ratio < 4.5) failures.push(`${selector}: ${fg} on ${against} is ${ratio.toFixed(2)}:1`);
    }
  }
  assert.deepEqual(failures, []);
  // the disabled look keeps readable text too
  assert.ok(contrast(cssVars['--muted'], '#e9ecef') >= 4.5);
});

test('NFR2: the 3 px focus ring has at least 3:1 against the page, the panel and the filled primary button', () => {
  assert.match(css, /:focus-visible\s*\{[^}]*outline:\s*3px solid var\(--link\)/);
  const ring = cssVars['--link'];
  for (const against of [cssVars['--bg'], cssVars['--panel'], '#ffffff']) assert.ok(contrast(ring, against) >= 3, `ring on ${against}`);
  // a filled button is ringed through the 2 px white gap of box-shadow, so the ring never sits on its own fill
  assert.match(css, /:focus-visible\s*\{[^}]*box-shadow:\s*0 0 0 2px #ffffff/);
  assert.match(css, /\.button-primary\s*\{[^}]*background:\s*var\(--link\)/);
  // A date-time field moves keyboard focus onto the calendar button inside it; the field then no longer matches :focus,
  // and the browser draws its own dark ring on the button (seen in Chromium at 5x, ev recorded by g1), so no rule is needed.
});

test('NFR2: a disabled button keeps full-strength text and shows it by a dashed border, never by opacity alone', () => {
  assert.doesNotMatch(css, /aria-disabled="true"\][^{]*\{[^}]*opacity/);
  assert.doesNotMatch(css, /\.button\[aria-disabled="true"\]\s*\{[^}]*opacity/);
  assert.match(css, /\.button\[aria-disabled="true"\]\s*\{[^}]*border-style:\s*dashed/);
});

test('NFR2: links that stand alone (table rows, error and notice links) are 44 px targets', () => {
  assert.match(css, /\.data-table a[^{]*\{[^}]*min-height:\s*44px/);
  assert.match(css, /\.state a[^{]*\{[^}]*min-height:\s*44px/);
  assert.match(css, /\.notice a[^{]*\{[^}]*min-height:\s*44px/);
});

test('FU-58: a refusal reason is never joined into a sentence as plain text; the views go through isolate.js', () => {
  const isolate = code.get('js/isolate.js');
  assert.match(isolate, /el\('bdi', \{ dir: 'auto'/);
  // every place that shows the reason or the server's message imports the isolation helpers
  for (const [file, names] of [
    ['js/components/status.js', 'messageNodes'],
    ['js/components/compensation.js', 'messageNodes, reasonNodes'],
    ['js/components/commitments.js', 'reasonNodes'],
    ['js/views/supplier-orders.js', 'reasonNodes'],
  ]) assert.match(code.get(file), new RegExp(`import \\{ ${names} \\} from '(\\.\\./)?(\\.\\./)?isolate\\.js'`), file);
  // no template string builds a sentence around a reason field
  for (const [file, source] of code) {
    assert.doesNotMatch(source, /`[^`]*\$\{[^}]*(refusalReason|confirmed\.reason|\.reason)\}[^`]*`/, `${file}: a reason is interpolated into a string`);
  }
  // the web page treats a <bdi> as an isolate on its own
  assert.doesNotMatch(css, /unicode-bidi:\s*(bidi-override|embed)/);
});

test('FU-54: the forced-reset clean-up text names the PayPal Sandbox dashboard only in the Sandbox adapter\'s branch', () => {
  const admin = code.get('js/views/admin.js');
  const branches = [...admin.matchAll(/^\s{2}('?[a-z-]+'?): '([^\n]*)',$/gm)].filter((m) => /dashboard/.test(m[2]));
  assert.equal(branches.length, 2, 'two texts mention a dashboard');
  assert.deepEqual(branches.map((m) => m[1].replace(/'/g, '')).sort(), ['sandbox', 'unknown']);
  assert.match(admin, /fake: 'The forced reset cleared the simulated provider\\'s records, so there is nothing to check outside RescueStock/);
  assert.match(admin, /adapterOf\(config\)/);
});

test('RS-34: every admin section that deals with payments carries the adapter badge line', () => {
  const admin = code.get('js/views/admin.js');
  for (const section of ['admin-reset', 'admin-faults', 'admin-timeline', 'admin-metrics']) {
    assert.match(admin, new RegExp(`sectionEl\\('${section}', '[^']+', \\[providerLine\\(ctx\\.config, '${section}'\\)`), section);
  }
});
