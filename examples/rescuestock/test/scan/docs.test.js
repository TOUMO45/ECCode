// Docs scan (task g2): the README names every npm script, the start line, the browser install line and the runbooks; the
// runbooks and submission drafts say what is unverified; the documented numbers match the code; and no document contains a
// secret-looking value. Reads files and calls pure functions only; opens no connection.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ConfigError, loadConfig } from '../../src/config.js';
import { LIVE_CEILING_MAX_MICRO_USD, parseCeilingMicroUsd } from '../live/run-live-model.js';
import { loadCorpus } from '../eval/lib/corpus.js';
import { WEBHOOK_EVENTS } from '../../src/services/webhooks.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');

const RULES_URL = 'https://paypalaihackathon.devpost.com/rules';
const RECHECK = `re-check at ${RULES_URL} before submitting`;
const START_LINE = 'node scripts/check-node.cjs && node --disable-warning=ExperimentalWarning src/index.js';

const SECRET_NAMES = [
  'ANTHROPIC_API_KEY',
  'RS_ADMIN_PASSWORD',
  'RS_DEMO_PASSWORD',
  'RS_FAKE_WEBHOOK_SECRET',
  ...['A', 'B', 'C', 'D', 'E', 'DEFAULT'].flatMap((k) => ['CLIENT_ID', 'CLIENT_SECRET', 'WEBHOOK_ID'].map((s) => `RS_PAYPAL_${k}_${s}`)),
];
// 32 or more characters of base64 or hex-like text with a lower-case letter and a digit or capital.
const TOKEN_SHAPED = /\b(?=[A-Za-z0-9_-]*[a-z])(?=[A-Za-z0-9_-]*[0-9A-Z])[A-Za-z0-9_-]{32,}\b/;

function markdownFiles(dir) {
  const out = [];
  const abs = join(ROOT, dir);
  if (!existsSync(abs)) return out;
  for (const name of readdirSync(abs)) {
    const rel = join(dir, name);
    if (statSync(join(ROOT, rel)).isDirectory()) out.push(...markdownFiles(rel));
    else if (name.endsWith('.md')) out.push(rel);
  }
  return out;
}

const RUNBOOKS = ['docs/runbooks/live-model.md', 'docs/runbooks/live-paypal.md', 'docs/runbooks/operations.md'];
const SUBMISSION = ['docs/submission/checklist.md', 'docs/submission/project-description.md', 'docs/submission/demo-video-script.md'];
const DOCS = ['README.md', ...markdownFiles('docs')];

const readme = read('README.md');
const pkg = JSON.parse(read('package.json'));

// ---- README: what a judge needs --------------------------------------------------------------------------------------

test('docs: the README opens with the problem, what RescueStock does and a one-command local demo with the fake provider', () => {
  const head = readme.split('\n').slice(0, 24).join('\n');
  assert.match(head, /cups/i);
  assert.match(head, /lids/i);
  assert.match(head, /\*\*The problem\.\*\*/);
  assert.match(head, /\*\*What RescueStock does\.\*\*/);
  const oneCommand = 'npm install && npm run seed && RS_MODEL_PROVIDER=fake npm start';
  assert.ok(head.includes(oneCommand), 'the one-command demo must be near the top');
  assert.ok(pkg.scripts.seed && pkg.scripts.start, 'the one-command demo uses the seed and start scripts');
  const config = loadConfig({ RS_MODEL_PROVIDER: 'fake' });
  assert.equal(config.paymentProvider, 'fake', 'the default payment provider is the fake one');
  assert.equal(config.modelProvider, 'fake');
});

test('docs: the README names every npm script, the start line, the browser install line and the runbooks', () => {
  for (const name of Object.keys(pkg.scripts)) {
    const forms = name === 'start' ? ['npm start'] : name === 'test' ? ['npm test'] : [`npm run ${name}`, name];
    assert.ok(forms.some((f) => readme.includes(f)), `README must name the npm script "${name}"`);
  }
  assert.equal(pkg.scripts.start, START_LINE);
  assert.ok(readme.includes(START_LINE), 'README must show the manual two-step start line');
  assert.ok(readme.includes('npx playwright install chromium'), 'README must show the Chromium install line');
  for (const rb of RUNBOOKS) {
    assert.ok(existsSync(join(ROOT, rb)), `${rb} must exist`);
    assert.ok(readme.includes(rb), `README must link ${rb}`);
  }
  assert.ok(readme.includes('docs/submission/'), 'README must point to the submission drafts');
  for (const heading of ['Architecture', 'Security model', 'Honest limits', 'Verified and not verified', 'Licence']) {
    assert.match(readme, new RegExp(`^## ${heading}$`, 'm'), `README needs a "${heading}" section`);
  }
});

test('docs: the README states the operator facts the plan requires (FU-9, FU-29, FU-25, FU-27, F-TR-15, F-TR-17, SEC-5)', () => {
  assert.match(readme, /umask 077/, 'backup command runs under umask 077');
  assert.match(readme, /npm start` tightens an existing `data\/` and `data\/uploads\/`.*0700/s);
  assert.match(readme, /EXIF/, 'privacy statement: a photo is stored and sent byte for byte, with metadata');
  assert.match(readme, /7 days/);
  assert.match(readme, /RS_ALLOW_SIGNUP` to 0/);
  assert.match(readme, /RS_MODEL_CUSTOMER_DAILY_SHARE` at its default 0\.2/);
  assert.match(readme, /RS_REGISTER_PER_IP_PER_HOUR/);
  assert.match(readme, /Abandon purchase/);
  assert.match(readme, /RS_DEMO_PASSWORD/);
  assert.match(readme, /RS_EXPLAIN_REPHRASE` is reserved/);
  assert.match(readme, /RS_MODEL_TIMEOUT_MS` is bounded to 1\.\.40000/);
  for (const name of ['RS_PLAN_RATE_LIMIT', 'RS_PLAN_RATE_WINDOW_MIN', 'RS_GENERAL_RATE_LIMIT', 'RS_GENERAL_RATE_WINDOW_SEC']) {
    assert.ok(readme.includes(name), `README must list ${name}`);
  }
  assert.match(readme, /Node\.js 22\.13 or newer/);
  assert.ok(readme.includes('22.5') && readme.includes('--experimental-sqlite'), 'Q9 branch note');
  assert.match(readme, /MIT/);
  assert.match(readme, /Test prices, not market prices/);
  assert.match(readme, /Simulated payment approval — not PayPal/);
  assert.match(readme, /Test mode — local stubs, nothing is real/);
});

test('docs: the documented defaults and bounds match the configuration loader', () => {
  const c = loadConfig({});
  assert.equal(c.planRateLimit, 10);
  assert.equal(c.planRateWindowMin, 10);
  assert.equal(c.generalRateLimit, 300);
  assert.equal(c.generalRateWindowSec, 60);
  assert.equal(c.modelCustomerDailyShare, 0.2);
  assert.equal(c.registerPerIpPerHour, 5);
  assert.equal(c.modelCallCapUsd, 0.05);
  assert.equal(c.modelDailyBudgetUsd, 1);
  assert.doesNotThrow(() => loadConfig({ RS_MODEL_TIMEOUT_MS: '40000' }));
  assert.throws(() => loadConfig({ RS_MODEL_TIMEOUT_MS: '40001' }), ConfigError);
  assert.match(readme, /\(default 300\)/);
  assert.match(readme, /\(default 10\)/);
  assert.match(readme, /USD 1\.00 daily model budget/);
});

test('docs: the internal links and anchors of the documents resolve', () => {
  const slug = (h) => h.toLowerCase().replace(/[^a-z0-9 -]/g, '').trim().replace(/ /g, '-');
  const anchors = new Set([...readme.matchAll(/^#{1,6} (.+)$/gm)].map((m) => slug(m[1].replace(/`/g, ''))));
  for (const file of DOCS) {
    const text = read(file);
    for (const m of text.matchAll(/\]\(([^)\s]+)\)/g)) {
      const target = m[1];
      if (/^[a-z]+:/i.test(target)) continue;
      const [path, anchor] = target.split('#');
      if (path === '') {
        if (file === 'README.md') assert.ok(anchors.has(anchor), `${file}: anchor #${anchor} has no heading`);
        continue;
      }
      assert.ok(existsSync(resolve(ROOT, dirname(file), path)), `${file}: link target ${target} does not exist`);
    }
  }
});

// ---- runbooks ---------------------------------------------------------------------------------------------------------

test('docs: the live model runbook gives the exact command, the ceiling rules, the report location and the exit codes', () => {
  const rb = read('docs/runbooks/live-model.md');
  assert.match(rb, /NOT VERIFIED/);
  assert.ok(rb.includes('RS_LIVE_MODEL=1 RS_LIVE_MODEL_CEILING_USD=5 npm run test:live-model -- --dry-run'));
  assert.ok(rb.includes('RS_LIVE_MODEL=1 RS_LIVE_MODEL_CEILING_USD=5 npm run test:live-model\n'));
  assert.match(rb, /reports\/live-model-<UTC>\.json/);
  for (const phrase of ['5.0000001', '1e0', '05', '0.01 to 5.00', 'exit 2', '130', '143', 'cli: claude <version>', 'ANTHROPIC_API_KEY', 'pgrep -af "claude -p"']) {
    assert.ok(rb.includes(phrase), `live-model runbook must mention ${phrase}`);
  }
  assert.match(rb, /Never use `kill -9`/);
});

test('docs: the live model runbook numbers match the runner and the corpus', () => {
  assert.equal(LIVE_CEILING_MAX_MICRO_USD, 5_000_000);
  assert.equal(parseCeilingMicroUsd('5'), 5_000_000);
  assert.equal(parseCeilingMicroUsd('0.01'), 10_000);
  assert.equal(parseCeilingMicroUsd('0.50'), 500_000);
  for (const bad of ['5.0000001', '1e0', '05', '0', '5.01', '', ' 5']) assert.equal(parseCeilingMicroUsd(bad), null, `"${bad}" must be refused`);
  const { cases } = loadCorpus();
  const rb = read('docs/runbooks/live-model.md');
  assert.ok(rb.includes(`${cases.length} cases`) || rb.includes(`${cases.length}-case`), 'the runbook states the corpus size');
  const worst = (cases.length * loadConfig({}).modelCallCapUsd).toFixed(2);
  assert.ok(rb.includes(`USD ${worst}`), `the runbook states the worst case USD ${worst}`);
});

test('docs: the live PayPal runbook covers credentials, hosts, merchant modes, webhooks and the two Sandbox journeys', () => {
  const rb = read('docs/runbooks/live-paypal.md');
  assert.match(rb, /NOT VERIFIED/);
  for (const phrase of [
    'RS_LIVE_PAYPAL=1',
    'RS_PAYPAL_DEFAULT_CLIENT_ID',
    'RS_PAYPAL_DEFAULT_CLIENT_SECRET',
    'RS_PAYPAL_DEFAULT_WEBHOOK_ID',
    'RS_PAYPAL_A_CLIENT_ID',
    'api-m.sandbox.paypal.com',
    'www.sandbox.paypal.com',
    'single-credential',
    'per-supplier',
    'RS_LIVE_PAYPAL_HEADED=1',
    'RS_LIVE_PAYPAL_WEBHOOK_SAMPLE',
    'RS_PAYPAL_WEBHOOK_ALGOS',
    'RS-31(b)',
    'RS-32(b)',
    'RS-18',
    'RS-19',
    'RS-20',
    'RS-23',
    'RS-24',
    'Sandbox buyer',
    'environment secrets',
    'npm run test:live-paypal',
    'test/live/paypal/run-live-paypal.js',
    'OQ-D5',
    'LIVE-P1',
    'LIVE-P2',
    'EVENT_TYPE_NOT_MAPPED',
    'cross-merchant',
  ]) {
    assert.ok(rb.includes(phrase), `live-paypal runbook must mention ${phrase}`);
  }
  // The seven mapped event types are listed, and are the ones the webhook route maps.
  const mapped = Object.keys(WEBHOOK_EVENTS);
  assert.equal(mapped.length, 7, 'the webhook route maps seven event types');
  for (const event of mapped) assert.ok(rb.includes(event), `live-paypal runbook must list ${event}`);
  // The live files it names exist.
  for (const f of ['rs18-cancel-abandon', 'rs19-amount', 'rs20-double-capture', 'rs23-webhook-duplicate', 'rs24-webhook-signature', 'journey-sandbox']) {
    assert.ok(rb.includes(`${f}.test.js`), `live-paypal runbook must name ${f}.test.js`);
    assert.ok(existsSync(join(ROOT, 'test/live/paypal', `${f}.test.js`)), `${f}.test.js must exist`);
  }
  // Credentials are set by a hidden prompt or a secret store, never on a command line.
  assert.match(rb, /stty -echo/);
  assert.doesNotMatch(rb, /RS_PAYPAL_[A-Z]+_(CLIENT_ID|CLIENT_SECRET|WEBHOOK_ID)=\S/, 'no credential is set with NAME=value');
  // Not verified by any live file.
  for (const phrase of ['DENIED or PENDING', 'RS-22', 'EXPIRED']) assert.ok(rb.includes(phrase), `live-paypal runbook must list "${phrase}" as uncovered`);
});

test('docs: the operations runbook covers stop, orphan check, backup, rollback and reset', () => {
  const rb = read('docs/runbooks/operations.md');
  for (const phrase of ['kill -9', 'pgrep -af "claude -p"', 'umask 077', 'VACUUM INTO', 'Roll back', 'RESET_BLOCKED', '/api/health', 'FU-50']) {
    assert.ok(rb.includes(phrase), `operations runbook must mention ${phrase}`);
  }
});

// ---- .env.example documentation of the variables only the live suites read -----------------------------------------------

test('docs: .env.example lists the live-suite variables, the reserved rephrase flag and the model timeout bound', () => {
  const env = read('.env.example');
  for (const name of ['RS_LIVE_MODEL_CEILING_USD', 'RS_LIVE_PAYPAL_HEADED', 'RS_LIVE_PAYPAL_WEBHOOK_SAMPLE', 'RS_PAYPAL_WEBHOOK_ALGOS', 'RS_LIVE_MODEL', 'RS_LIVE_PAYPAL']) {
    assert.ok(env.includes(name), `.env.example must list ${name}`);
  }
  assert.match(env.replace(/\n#\s*/g, ' ').replace(/ {2,}/g, ' '), /an exact decimal from 0\.01 to 5\.00 with at most two decimals/);
  assert.match(env, /Reserved\. Parsed, but it has no effect in version one/);
  assert.match(env, /1 to 40000/);
});

// ---- no invented names, no secrets -------------------------------------------------------------------------------------

function sourceFiles(dir, out = []) {
  const abs = join(ROOT, dir);
  for (const name of readdirSync(abs)) {
    if (name === 'node_modules' || name === 'out' || name === '.out') continue;
    const rel = join(dir, name);
    if (statSync(join(ROOT, rel)).isDirectory()) sourceFiles(rel, out);
    else if (/\.(js|cjs|mjs|sh|json)$/.test(name) && rel !== 'test/scan/docs.test.js') out.push(rel);
  }
  return out;
}

test('docs: every RS_ variable a document names exists in the code or in .env.example', () => {
  const known = new Set();
  for (const f of [...sourceFiles('src'), ...sourceFiles('scripts'), ...sourceFiles('test'), ...sourceFiles('public')]) {
    for (const m of read(f).matchAll(/\b(RS_[A-Z0-9_]+)\b/g)) known.add(m[1]);
  }
  for (const m of read('.env.example').matchAll(/\b(RS_[A-Z0-9_]+)\b/g)) known.add(m[1]);
  for (const k of ['A', 'B', 'C', 'D', 'E', 'DEFAULT']) for (const s of ['CLIENT_ID', 'CLIENT_SECRET', 'WEBHOOK_ID']) known.add(`RS_PAYPAL_${k}_${s}`);
  for (const file of [...DOCS, '.env.example']) {
    for (const m of read(file).matchAll(/\b(RS_[A-Z0-9_]+)\b/g)) {
      const name = m[1];
      if (name === 'RS_PAYPAL_' || /^RS_PAYPAL_(KEY|<KEY>)_/.test(name)) continue;
      assert.ok(known.has(name), `${file} names ${name}, which nothing in the code reads`);
    }
  }
});

test('docs: no document contains a secret-looking value', () => {
  const files = [...DOCS, '.env.example'];
  for (const file of files) {
    const text = read(file);
    assert.doesNotMatch(text, /sk-[A-Za-z0-9_-]{10,}/, `${file}: API-key-shaped value`);
    assert.doesNotMatch(text, TOKEN_SHAPED, `${file}: long token-shaped value`);
    assert.doesNotMatch(text, /Bearer\s+[A-Za-z0-9._~+/-]{8,}/, `${file}: bearer token`);
    assert.doesNotMatch(text, /Basic\s+[A-Za-z0-9+/]{12,}={0,2}/, `${file}: basic-auth value`);
    assert.doesNotMatch(text, /[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s/@]+:[^\s/@]+@/, `${file}: URL with credentials`);
    assert.doesNotMatch(text, /-----BEGIN [A-Z ]*PRIVATE KEY-----/, `${file}: private key`);
    assert.doesNotMatch(text, /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/, `${file}: e-mail address (personal data)`);
    assert.doesNotMatch(text, /\b(client_secret|api[_-]?key|webhook[_-]?id)\b["']?\s*[:=]\s*["']?[A-Za-z0-9+/_-]{12,}/i, `${file}: credential assigned a value`);
    // A secret variable may be assigned only a <placeholder> or a shell variable, never a literal.
    for (const name of SECRET_NAMES) {
      for (const m of text.matchAll(new RegExp(`\\b${name}\\s*=\\s*(\\S*)`, 'g'))) {
        const value = m[1].replace(/^["']|["']$/g, '');
        assert.ok(value === '' || /^<[a-z][a-z0-9 -]*>$/.test(value) || value.startsWith('$'), `${file}: ${name} is assigned a literal value`);
      }
    }
  }
});

// ---- submission drafts -------------------------------------------------------------------------------------------------

test('docs: every submission draft is marked a draft and marks hackathon facts as unverified with the re-check line', () => {
  for (const file of SUBMISSION) {
    assert.ok(existsSync(join(ROOT, file)), `${file} must exist`);
    const text = read(file);
    assert.match(text, /DRAFT/, `${file} must say it is a draft`);
    assert.match(text, /not (yet )?(recorded, not )?submitted|has been submitted|Nothing .* submitted/i, `${file} must say nothing was submitted`);
    assert.ok(text.includes('unverified against the primary source'), `${file} must say hackathon facts are unverified against the primary source`);
    assert.ok(text.toLowerCase().includes(RECHECK), `${file} must carry the line "${RECHECK}"`);
  }
  const checklist = read('docs/submission/checklist.md');
  for (const fact of ['12 Nov 2026', 'under 3 minutes', 'YouTube', 'technical implementation', 'open-source licence', 'Sandbox']) {
    assert.ok(checklist.includes(fact), `checklist must list the reported fact "${fact}" for re-checking`);
  }
  assert.match(checklist, /\| Done \|/);
  assert.match(checklist, /\[ \]/, 'the checklist has unticked boxes for the user');
  assert.doesNotMatch(checklist, /\[x\]/i, 'no box is ticked on the user\'s behalf');
  assert.match(checklist, /Nothing here is a claim that RescueStock complies/);
});

test('docs: the project description states the contribution in the first person and does not overclaim', () => {
  const text = read('docs/submission/project-description.md');
  assert.match(text, /I directed this build/);
  assert.match(text, /AI agent team/);
  assert.match(text, /ECCode/);
  assert.match(text, /independent/i);
  assert.match(text, /I did not write the application by hand/);
  assert.match(text, /Update after live runs/);
  assert.match(text, /I have not yet run the live Sandbox checks/);
  assert.match(text, /I have not yet run the live model evaluation/);
  assert.match(text, /Test prices, not market prices|test prices, not market prices/);
  for (const banned of [/\b\d[\d,]*\s+(active\s+)?(users|customers|cafes|cafés)\b/i, /\bsav(es|ed|ing)\s+(cafes\s+)?\$?\d/i, /\bwon\b/i, /\b(is|are|fully)\s+(compliant|eligible)\b/i, /\bin production\b/i]) {
    assert.doesNotMatch(text, banned, `project description must not contain an unverifiable claim matching ${banned}`);
  }
});

test('docs: the video script shows PayPal hosted Sandbox approval (user-run) and labels everything simulated, demo or Sandbox', () => {
  const text = read('docs/submission/demo-video-script.md');
  assert.match(text, /PayPal's hosted Sandbox approval page/);
  assert.match(text, /I \(not an agent\) log in/);
  assert.match(text, /Simulated payment approval — not PayPal/);
  assert.match(text, /Test prices, not market prices/);
  assert.match(text, /Version B: fake provider only/);
  assert.match(text, /Keep secrets off screen/);
  assert.match(text, /label everything that is simulated, demo or Sandbox/i);
  assert.match(text, /no claims about users, savings or confirmations/i);
});

test('docs: the README and the drafts say plainly that the live integrations are not verified', () => {
  assert.match(readme, /never talked to PayPal or to a real model/);
  assert.match(readme, /LIVE-P1, LIVE-P2/);
  assert.match(readme, /LIVE-M1/);
  assert.match(readme, /No claim is made/);
  const description = read('docs/submission/project-description.md');
  assert.match(description, /exercised only against a local stub and the built-in fake/);
  const rel = relative(ROOT, join(ROOT, 'LICENSE'));
  assert.match(read(rel), /^MIT License\n/);
});
