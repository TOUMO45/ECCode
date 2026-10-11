// NFR3 / FU-37: both live scripts REFUSE without their flags, with exit 2 and the named message, before they do anything.
//   npm run test:live-model   -> test/live/run-live-model.js     needs RS_LIVE_MODEL=1 and a spending ceiling (billed to the user)
//   npm run test:live-paypal  -> test/live/paypal/run-live-paypal.js and each test/live/paypal/*.test.js
//                                                                needs RS_LIVE_PAYPAL=1 and Sandbox credentials
// Every child runs under the offline network guard with an environment that holds no RS_* variable, no API key and a PATH
// without `claude`, so even a bug in a refusal could not reach a model or a PayPal host. Neither flag is ever put into any
// process environment here: the cases that need a flag set go through the pure functions with plain objects. The test also
// asserts that its own environment does not carry a flag (running the suite with a live flag exported is refused loudly).
// Kept in addition to the copy in test/integration/rs20-two-process-execute.test.js (FU-37 allows both).
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LIVE_MESSAGES as MODEL_MESSAGES, evaluateLaunch } from '../live/run-live-model.js';
import { LIVE_MESSAGES as PAYPAL_MESSAGES, evaluateLiveLaunch } from '../live/paypal/live-support.js';
import { runLivePaypal } from '../live/paypal/run-live-paypal.js';
import { NET_GUARD_PATH, PROJECT_ROOT } from '../helpers/node-proc.js';

const MODEL_RUNNER = join(PROJECT_ROOT, 'test', 'live', 'run-live-model.js');
const PAYPAL_DIR = join(PROJECT_ROOT, 'test', 'live', 'paypal');
const PAYPAL_LAUNCHER = join(PAYPAL_DIR, 'run-live-paypal.js');
const PAYPAL_FILES = readdirSync(PAYPAL_DIR).filter((f) => f.endsWith('.test.js')).sort();
const scratch = mkdtempSync(join(tmpdir(), 'rs-live-refusal-'));
const emptyBin = join(scratch, 'empty-bin');
mkdirSync(emptyBin, { recursive: true });

// A child environment with nothing in it that could enable or reach a live service.
const cleanEnv = (extra = {}) => ({ PATH: `${emptyBin}:/usr/bin:/bin`, HOME: scratch, LANG: 'C.UTF-8', ...extra });
const runGuarded = (file, extra = {}, args = []) =>
  spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', `--import=${NET_GUARD_PATH}`, file, ...args], {
    cwd: PROJECT_ROOT, env: cleanEnv(extra), encoding: 'utf8', timeout: 30_000,
  });

const PAYPAL_CREDENTIALS = Object.freeze({ RS_PAYPAL_DEFAULT_CLIENT_ID: 'id-value-1', RS_PAYPAL_DEFAULT_CLIENT_SECRET: 'secret-value-2', RS_PAYPAL_DEFAULT_WEBHOOK_ID: 'hook-value-3' });
// Values that look like "on" but are not exactly 1, and a credential set without the flag.
const NOT_THE_FLAG = Object.freeze([{}, { RS_LIVE_PAYPAL: '0' }, { RS_LIVE_PAYPAL: '' }, { RS_LIVE_PAYPAL: 'true' }, { RS_LIVE_PAYPAL: 'yes' }, { ...PAYPAL_CREDENTIALS }]);
const MODEL_NOT_THE_FLAG = Object.freeze([{}, { RS_LIVE_MODEL: '0' }, { RS_LIVE_MODEL: '' }, { RS_LIVE_MODEL: 'true' }, { RS_LIVE_MODEL_CEILING_USD: '5' }]);

describe('NFR3: neither live flag is set in the environment that runs this suite', () => {
  test('NFR3: RS_LIVE_MODEL and RS_LIVE_PAYPAL are absent from this process (a suite run with a live flag exported is not an offline run)', () => {
    assert.equal(process.env.RS_LIVE_MODEL, undefined, 'RS_LIVE_MODEL must not be set when the offline suite runs');
    assert.equal(process.env.RS_LIVE_PAYPAL, undefined, 'RS_LIVE_PAYPAL must not be set when the offline suite runs');
  });
});

describe('NFR3: the live model script refuses without its flag', () => {
  test('NFR3: test/live/run-live-model.js without RS_LIVE_MODEL=1 exits 2 with the fixed message, prints nothing else, and calls no model', () => {
    assert.equal(MODEL_MESSAGES.notEnabled, 'Set RS_LIVE_MODEL=1 to run the live model suite (billed to your account)');
    for (const extra of MODEL_NOT_THE_FLAG) {
      const r = runGuarded(MODEL_RUNNER, extra);
      assert.equal(r.status, 2, `${JSON.stringify(Object.keys(extra))}: exit ${r.status}, stderr ${r.stderr}`);
      assert.equal(r.stderr.trim(), MODEL_MESSAGES.notEnabled);
      assert.equal(r.stdout, '');
    }
  });

  test('NFR3: the flag alone is not enough: the ceiling, the net guard and the offline switch each refuse by name (pure function, no flag in any environment)', () => {
    const noCeiling = evaluateLaunch({ RS_LIVE_MODEL: '1' }, { guardInstalled: false });
    assert.equal(noCeiling.ok, false);
    assert.equal(noCeiling.message, MODEL_MESSAGES.noCeiling);
    assert.equal(evaluateLaunch({ RS_LIVE_MODEL: '1', RS_LIVE_MODEL_CEILING_USD: '5.01' }, { guardInstalled: false }).message, MODEL_MESSAGES.badCeiling);
    assert.equal(evaluateLaunch({ RS_LIVE_MODEL: '1', RS_LIVE_MODEL_CEILING_USD: '5' }, { guardInstalled: true }).message, MODEL_MESSAGES.netGuard);
    assert.equal(evaluateLaunch({ RS_LIVE_MODEL: '1', RS_LIVE_MODEL_CEILING_USD: '5', RS_TEST_OFFLINE: '1' }, { guardInstalled: false }).message, MODEL_MESSAGES.offline);
  });

  test('NFR3: the package script is the runner behind the flag gate and keeps the Node version gate in front', () => {
    const scripts = JSON.parse(readFileSync(join(PROJECT_ROOT, 'package.json'), 'utf8')).scripts;
    assert.match(scripts['test:live-model'], /^node scripts\/check-node\.cjs && node .*test\/live\/run-live-model\.js$/);
    assert.equal(/live/.test(scripts.test), false, 'npm test never runs a live suite');
    assert.equal(/live/.test(scripts['test:browser']), false, 'npm run test:browser never runs a live suite');
  });
});

describe('NFR3: the live PayPal scripts refuse without their flag', () => {
  test('NFR3: the directory holds the launcher and the six live files', () => {
    assert.deepEqual(PAYPAL_FILES, [
      'journey-sandbox.test.js', 'rs18-cancel-abandon.test.js', 'rs19-amount.test.js', 'rs20-double-capture.test.js', 'rs23-webhook-duplicate.test.js', 'rs24-webhook-signature.test.js',
    ]);
  });

  for (const file of PAYPAL_FILES) {
    test(`NFR3: test/live/paypal/${file} without RS_LIVE_PAYPAL=1 exits 2 with the fixed message and prints nothing else`, () => {
      assert.equal(PAYPAL_MESSAGES.notEnabled, 'Set RS_LIVE_PAYPAL=1 to run the live PayPal Sandbox suite (it contacts the PayPal Sandbox)');
      for (const extra of NOT_THE_FLAG) {
        const r = runGuarded(join(PAYPAL_DIR, file), extra);
        assert.equal(r.status, 2, `${file} with ${JSON.stringify(Object.keys(extra))}: exit ${r.status}, stderr ${r.stderr}`);
        assert.equal(r.stderr.trim(), PAYPAL_MESSAGES.notEnabled);
        assert.equal(r.stdout, '');
      }
    });
  }

  test('NFR3: the launcher (npm run test:live-paypal) refuses the same way and never starts the test files', async () => {
    const r = runGuarded(PAYPAL_LAUNCHER, {}, ['test/live/paypal/**/*.test.js']);
    assert.equal(r.status, 2);
    assert.equal(r.stderr.trim(), PAYPAL_MESSAGES.notEnabled);
    assert.equal(r.stdout, '');
    // Injected, no flag in any environment: a refused launch never reaches spawnTests; an allowed one passes the patterns on.
    let spawned = 0;
    const errs = [];
    assert.equal(await runLivePaypal({ env: {}, guardInstalled: false, argv: [], err: (s) => errs.push(s), spawnTests: async () => { spawned += 1; return 0; } }), 2);
    assert.equal(spawned, 0);
    assert.deepEqual(errs, [`${PAYPAL_MESSAGES.notEnabled}\n`]);
  });

  test('NFR3: the flag alone is not enough: missing credentials are named (never a value); the net guard and the offline switch refuse', () => {
    const noCreds = evaluateLiveLaunch({ RS_LIVE_PAYPAL: '1' }, { guardInstalled: false });
    assert.equal(noCreds.ok, false);
    for (const name of Object.keys(PAYPAL_CREDENTIALS)) assert.match(noCreds.message, new RegExp(name));
    for (const value of Object.values(PAYPAL_CREDENTIALS)) assert.equal(noCreds.message.includes(value), false);
    assert.deepEqual(evaluateLiveLaunch({ RS_LIVE_PAYPAL: '1', ...PAYPAL_CREDENTIALS }, { guardInstalled: true }), { ok: false, message: PAYPAL_MESSAGES.netGuard });
    assert.deepEqual(evaluateLiveLaunch({ RS_LIVE_PAYPAL: '1', RS_TEST_OFFLINE: '1', ...PAYPAL_CREDENTIALS }, { guardInstalled: false }), { ok: false, message: PAYPAL_MESSAGES.offline });
  });

  test('NFR3: the package script is the launcher behind the flag gate; nothing in the offline scripts reaches a live file', () => {
    const scripts = JSON.parse(readFileSync(join(PROJECT_ROOT, 'package.json'), 'utf8')).scripts;
    assert.match(scripts['test:live-paypal'], /^node scripts\/check-node\.cjs && /);
    assert.match(scripts['test:live-paypal'], /test\/live\/paypal\/\*\*\/\*\.test\.js/);
    assert.doesNotMatch(scripts.test, /test\/live/);
    assert.doesNotMatch(scripts['test:browser'], /test\/live/);
  });
});

test('NFR3: cleanup of the scratch directory', () => {
  rmSync(scratch, { recursive: true, force: true });
});
