// NFR4 scan: .env.example lists every environment variable the application reads,
// carries only placeholders and the listed non-secret defaults, and the README
// names variables without values. Reads files only; opens no connection.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ConfigError, isPlaceholder, loadConfig } from '../../src/config.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');

const PLACEHOLDER = /^<[a-z][a-z0-9-]*>$/;
// 32 or more characters of base64 or hex-like text with a lower-case letter and a digit or capital.
const TOKEN_SHAPED = /\b(?=[A-Za-z0-9_-]*[a-z])(?=[A-Za-z0-9_-]*[0-9A-Z])[A-Za-z0-9_-]{32,}\b/;

// Secrets: the only accepted value is a <placeholder>. The loader refuses
// placeholder-shaped secrets, so these lines must stay commented out.
const SECRET_NAMES = [
  'ANTHROPIC_API_KEY',
  'RS_ADMIN_PASSWORD',
  'RS_DEMO_PASSWORD',
  'RS_FAKE_WEBHOOK_SECRET',
  ...['A', 'B', 'C', 'D', 'E', 'DEFAULT'].flatMap((k) =>
    ['CLIENT_ID', 'CLIENT_SECRET', 'WEBHOOK_ID'].map((s) => `RS_PAYPAL_${k}_${s}`),
  ),
];

// Non-secret defaults of the spec's Deployment table (plus RS_REGISTER_PER_IP_PER_HOUR).
// A value of '' means "empty or unset by default". `active: false` means the
// line must stay commented out (the default is computed, not a literal).
const DEFAULTS = {
  PORT: '3000',
  HOST: '127.0.0.1',
  RS_PUBLIC_URL: { value: 'http://localhost:3000', active: false },
  RS_DB_PATH: 'data/app.db',
  RS_UPLOAD_DIR: 'data/uploads',
  RS_DB_BUSY_TIMEOUT_MS: '5000',
  RS_DEMO_DATE: { value: '', active: false },
  RS_TAX_BP: '0',
  RS_RESERVATION_TTL_MIN: '30',
  RS_AUTH_EXPIRY_MARGIN_MIN: '10',
  RS_SAGA_LEASE_MS: '60000',
  RS_PAYPAL_TIMEOUT_MS: '20000',
  RS_RECONCILE_INTERVAL_MS: '15000',
  RS_RETENTION_INTERVAL_MS: '3600000',
  RS_IMAGE_RETENTION_DAYS: '7',
  RS_UNKNOWN_ESCALATE_MIN: '15',
  RS_PENDING_ESCALATE_MIN: '1440',
  RS_PAYMENT_PROVIDER: 'fake',
  RS_PAYPAL_BASE_URL: 'https://api-m.sandbox.paypal.com',
  RS_FAKE_APPROVAL_HOST: '127.0.0.1',
  RS_FAKE_APPROVAL_PORT: '0',
  RS_MODEL_PROVIDER: 'cli',
  RS_MODEL: 'haiku',
  RS_MODEL_TIMEOUT_MS: '30000',
  RS_MODEL_CALL_CAP_USD: '0.05',
  RS_MODEL_DAILY_BUDGET_USD: '1.00',
  RS_FAKE_MODEL_COST_USD: '0',
  RS_ANTHROPIC_MODEL: 'claude-haiku-4-5-20251001',
  RS_ANTHROPIC_BASE_URL: 'https://api.anthropic.com',
  RS_ANTHROPIC_USD_PER_MTOK_IN: '1.00',
  RS_ANTHROPIC_USD_PER_MTOK_OUT: '5.00',
  RS_EXPLAIN_REPHRASE: '0',
  RS_ALLOW_SIGNUP: '1',
  RS_MAX_LIVE_RESERVATIONS_PER_CUSTOMER: '1',
  RS_MAX_REQUESTS_PER_CUSTOMER_PER_DAY: '10',
  RS_MODEL_CUSTOMER_DAILY_SHARE: '0.2',
  RS_REGISTER_PER_IP_PER_HOUR: '5',
  RS_ALLOWED_HOSTS: '',
  RS_OLD_NODE_BINS: '',
  RS_TRUST_PROXY: '0',
  RS_TEST_HOOKS: '0',
  RS_TEST_OFFLINE: '0',
  RS_LIVE_MODEL: { value: '', active: false },
  RS_LIVE_PAYPAL: { value: '', active: false },
};

const defaultOf = (name) => {
  const d = DEFAULTS[name];
  return typeof d === 'string' ? { value: d, active: true } : d;
};

// A variable line is "NAME=value" or "# NAME=value" (a commented-out variable).
// Prose comments never start with an upper-case name followed by "=".
function parseEnvExample(text) {
  const entries = [];
  for (const [i, line] of text.split('\n').entries()) {
    const m = /^(#\s?)?([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
    if (m) entries.push({ line: i + 1, active: !m[1], name: m[2], value: m[3] });
  }
  return entries;
}

// Every name loadConfig reads: recorded through a Proxy over the environment
// (covers names built from templates), plus every quoted env-shaped name in the source.
function namesReadByConfig() {
  const names = new Set();
  const env = new Proxy(
    {},
    {
      get(_t, prop) {
        if (typeof prop === 'string') names.add(prop);
        return undefined;
      },
    },
  );
  loadConfig(env);
  const source = read('src/config.js');
  for (const m of source.matchAll(/['`]((?:RS_[A-Z0-9_]+)|PORT|HOST|ANTHROPIC_API_KEY)['`]/g)) names.add(m[1]);
  for (const m of source.matchAll(/`(RS_PAYPAL_)\$\{key\}(_[A-Z_]+)`/g)) {
    for (const k of ['A', 'B', 'C', 'D', 'E', 'DEFAULT']) names.add(`${m[1]}${k}${m[2]}`);
  }
  return [...names].sort();
}

const entries = parseEnvExample(read('.env.example'));
const byName = new Map(entries.map((e) => [e.name, e]));

test('NFR4: .env.example has no duplicate variable and every line is a comment, blank or NAME=value', () => {
  const seen = new Set();
  for (const e of entries) {
    assert.ok(!seen.has(e.name), `${e.name} appears twice`);
    seen.add(e.name);
  }
  for (const [i, line] of read('.env.example').split('\n').entries()) {
    const ok = line === '' || line.startsWith('#') || /^[A-Z][A-Z0-9_]*=\S*$/.test(line);
    assert.ok(ok, `.env.example line ${i + 1} is not a comment, blank or NAME=value without spaces`);
  }
});

test('NFR4: every process.env name read by src/config.js appears in .env.example', () => {
  const read_ = namesReadByConfig();
  // Sanity floor: proves the recording worked (config reads 66 names today).
  assert.ok(read_.length >= 60, `expected at least 60 names, found ${read_.length}`);
  const missing = read_.filter((n) => !byName.has(n));
  assert.deepEqual(missing, [], `missing from .env.example: ${missing.join(', ')}`);
  // Names that must be in because the spec's Deployment table and the register limit say so.
  for (const n of [...Object.keys(DEFAULTS), ...SECRET_NAMES]) {
    assert.ok(byName.has(n), `${n} is not in .env.example`);
    assert.ok(read_.includes(n), `${n} is in the table but src/config.js does not read it`);
  }
});

test('NFR4: every value is a placeholder or a listed non-secret default, nothing real-looking', () => {
  for (const e of entries) {
    if (SECRET_NAMES.includes(e.name)) {
      assert.match(e.value, PLACEHOLDER, `${e.name} must be a <placeholder>`);
      assert.ok(isPlaceholder(e.value), `${e.name}: the loader must recognise the placeholder shape`);
      continue;
    }
    const d = defaultOf(e.name);
    assert.ok(d, `${e.name} has no listed default in this test; add it to the spec table first`);
    assert.equal(e.value, d.value, `${e.name} must equal its listed default`);
  }
  // Defence in depth: no token-shaped string anywhere in the file.
  const text = read('.env.example');
  assert.doesNotMatch(text, /sk-[A-Za-z0-9_-]{10,}/, 'API-key-shaped value');
  assert.doesNotMatch(text, /[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s/@]+:[^\s/@]+@/, 'URL with credentials');
  for (const e of entries) assert.doesNotMatch(e.value, TOKEN_SHAPED, `${e.name}: token-shaped value`);
});

test('NFR4: secret lines are commented out, because the loader refuses placeholder-shaped secrets', () => {
  for (const name of SECRET_NAMES) {
    assert.equal(byName.get(name).active, false, `${name} must stay commented out`);
  }
  for (const name of Object.keys(DEFAULTS)) {
    assert.equal(byName.get(name).active, defaultOf(name).active, `${name} active state differs from the listed default`);
  }
});

test('NFR4: the active lines of .env.example, copied verbatim, load into a valid configuration', () => {
  const env = {};
  for (const e of entries) if (e.active) env[e.name] = e.value;
  const config = loadConfig(env);
  assert.equal(config.paymentProvider, 'fake');
  assert.equal(config.modelProvider, 'cli');
  assert.equal(config.registerPerIpPerHour, 5);
  assert.equal(config.modelCustomerDailyShare, 0.2);
  assert.equal(config.testOffline, false);
  assert.equal(config.adminPassword, null);
});

test('NFR4: uncommenting a placeholder secret is refused by name, never by value', () => {
  const env = {};
  for (const e of entries) if (e.active) env[e.name] = e.value;
  env.RS_ADMIN_PASSWORD = byName.get('RS_ADMIN_PASSWORD').value;
  assert.throws(
    () => loadConfig(env),
    (err) => err instanceof ConfigError && err.variables.includes('RS_ADMIN_PASSWORD') && !err.message.includes(env.RS_ADMIN_PASSWORD),
  );
});

test('NFR4: README documents the clean-checkout steps, the Node floor, the licence and the labels', () => {
  const readme = read('README.md');
  const pkg = JSON.parse(read('package.json'));
  const startLine = 'node scripts/check-node.cjs && node --disable-warning=ExperimentalWarning src/index.js';
  assert.equal(pkg.scripts.start, startLine, 'package.json start script differs from the documented two-step line');
  assert.ok(readme.includes(startLine), 'README must show the manual two-step start line');
  for (const cmd of ['npm install', 'npm run seed', 'npm start', 'npm test']) {
    assert.ok(readme.includes(cmd), `README must show ${cmd}`);
  }
  assert.ok(readme.includes('22.13'), 'README must state the Node floor 22.13');
  assert.ok(readme.includes('22.5') && readme.includes('--experimental-sqlite'), 'README must carry the Q9 22.5 branch note');
  assert.match(readme, /npm registry/i, 'README must say npm install uses the npm registry only');
  assert.match(readme, /MIT/, 'README must name the MIT licence');
  assert.match(readme, /simulated/i, 'README must say what is simulated');
  assert.match(readme, /Sandbox/, 'README must say PayPal is Sandbox only');
  assert.match(readme, /no real money/i, 'README must say no real money moves');
  assert.ok(readme.includes('RS_REGISTER_PER_IP_PER_HOUR'), 'README must explain RS_REGISTER_PER_IP_PER_HOUR');
  assert.ok(readme.includes('Abandon purchase'), 'README must carry the demo retake operator note');
});

test('NFR4: README names variables only; no secret variable is assigned a value and nothing is token-shaped', () => {
  const readme = read('README.md');
  for (const name of SECRET_NAMES) {
    assert.doesNotMatch(readme, new RegExp(`\\b${name}\\s*=\\s*\\S`), `${name} must not be assigned a value in the README`);
  }
  assert.doesNotMatch(readme, /sk-[A-Za-z0-9_-]{10,}/, 'API-key-shaped value');
  assert.doesNotMatch(readme, TOKEN_SHAPED, 'long token-shaped value');
  // Every upper-case env-shaped name the README mentions is a real variable.
  const known = new Set([...byName.keys()]);
  for (const m of readme.matchAll(/\b(RS_[A-Z0-9_]+|ANTHROPIC_API_KEY)\b/g)) {
    const name = m[1];
    if (/^RS_PAYPAL_(<KEY>|KEY)_/.test(name) || name === 'RS_PAYPAL_') continue;
    assert.ok(known.has(name), `README mentions ${name}, which is not in .env.example`);
  }
});

test('NFR4: LICENSE is MIT and names the project, with no personal data', () => {
  const text = read('LICENSE');
  assert.match(text, /^MIT License\n/);
  assert.match(text, /Copyright \(c\) \d{4} RescueStock contributors\n/);
  assert.doesNotMatch(text, /@/);
});
