// The live model suite is opt-in, capped and billed to the user's account. These tests prove it REFUSES (exit 2) unless
// it is explicitly enabled with a spending ceiling, never runs under the net guard, and prints what it would spend.
// No model is ever called here: the only provider used in-process is the deterministic fake.
import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFakeProvider } from '../../../src/ai/fake.js';
import { PROMPT_VERSION } from '../../../src/ai/prompt.js';
import { LIVE_CEILING_MAX_MICRO_USD, LIVE_MESSAGES, evaluateLaunch, planSpend, runLive } from '../../live/run-live-model.js';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const RUNNER = join(ROOT, 'test', 'live', 'run-live-model.js');
const GUARD = join(ROOT, 'test', 'helpers', 'net-guard.js');
const scratch = mkdtempSync(join(tmpdir(), 'rs-live-refusal-'));
after(() => rmSync(scratch, { recursive: true, force: true }));

// A child environment with no RS_* and no key, and a PATH that holds no `claude`, so nothing can reach a model.
function childEnv(extra = {}) {
  const empty = join(scratch, 'empty-bin');
  mkdirSync(empty, { recursive: true });
  const base = { PATH: `${empty}:/usr/bin:/bin`, HOME: scratch, LANG: 'C.UTF-8' };
  return { ...base, ...extra };
}
const run = (extra = {}, { args = [], execArgv = [] } = {}) => spawnSync(process.execPath, [...execArgv, RUNNER, ...args], {
  env: childEnv(extra), encoding: 'utf8', timeout: 30_000,
});
const ENABLED = { RS_LIVE_MODEL: '1', RS_LIVE_MODEL_CEILING_USD: '5' };

describe('refusals (exit 2, nothing printed about a run)', () => {
  test('NFR3: without RS_LIVE_MODEL=1 the runner exits 2 with the fixed message and does nothing else', () => {
    for (const env of [{}, { RS_LIVE_MODEL: '0' }, { RS_LIVE_MODEL: '' }, { RS_LIVE_MODEL: 'true' }, { RS_LIVE_MODEL_CEILING_USD: '5' }]) {
      const r = run(env);
      assert.equal(r.status, 2, JSON.stringify(env));
      assert.equal(r.stderr.trim(), 'Set RS_LIVE_MODEL=1 to run the live model suite (billed to your account)');
      assert.equal(r.stdout, '');
    }
    assert.equal(LIVE_MESSAGES.notEnabled, 'Set RS_LIVE_MODEL=1 to run the live model suite (billed to your account)');
  });

  test('NFR3: RS_LIVE_MODEL=1 alone is not enough: a spending ceiling RS_LIVE_MODEL_CEILING_USD is required', () => {
    const r = run({ RS_LIVE_MODEL: '1' });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /RS_LIVE_MODEL_CEILING_USD/);
    assert.equal(r.stdout, '');
  });

  test('NFR6: a ceiling that is zero, negative, malformed or above the recorded USD 5 is refused', () => {
    for (const ceiling of ['0', '0.00', '-1', 'abc', '5.01', '6', '1e3', '5,00', ' ', '5 USD']) {
      const r = run({ RS_LIVE_MODEL: '1', RS_LIVE_MODEL_CEILING_USD: ceiling });
      assert.equal(r.status, 2, ceiling);
      assert.match(r.stderr, /RS_LIVE_MODEL_CEILING_USD must be a positive decimal amount of at most 5\.00/, ceiling);
      assert.equal(r.stdout, '', ceiling);
    }
    assert.equal(LIVE_CEILING_MAX_MICRO_USD, 5_000_000);
  });

  test('NFR3: the ceiling is a decimal with at most two fraction digits, from 0.01 to 5.00, checked BEFORE any rounding (TR-D-10)', () => {
    // 5.0000001 used to round to 5.000000 and start a run; none of these may reach a provider, and none is rounded or trimmed.
    const refused = [
      '5.0000001', '5.001', '5.01', '5.009', '4.999', '1e0', '5e0', '0.5e1', ' 5', '5 ', '\t5', '5\n', '05', '005.00', '00.50', '5.', '.5', '+5', '-5', '-0',
      '0', '0.0', '0.00', '0.001', '0.009', '5.00.0', '5,00', '0x5', '٥', '５', 'Infinity', 'NaN', '6', '50', '500', '99999999999999999999', '4.99999999',
    ];
    for (const ceiling of refused) {
      assert.deepEqual(
        evaluateLaunch({ RS_LIVE_MODEL: '1', RS_LIVE_MODEL_CEILING_USD: ceiling }, { guardInstalled: false }),
        { ok: false, message: LIVE_MESSAGES.badCeiling },
        JSON.stringify(ceiling),
      );
    }
    const accepted = { 5: 5_000_000, '5.0': 5_000_000, '5.00': 5_000_000, '0.50': 500_000, '0.5': 500_000, '0.01': 10_000, '4.99': 4_990_000, 1: 1_000_000, '2.5': 2_500_000, 0.1: 100_000 };
    for (const [ceiling, micro] of Object.entries(accepted)) {
      assert.deepEqual(
        evaluateLaunch({ RS_LIVE_MODEL: '1', RS_LIVE_MODEL_CEILING_USD: ceiling }, { guardInstalled: false }),
        { ok: true, ceilingMicroUsd: micro },
        ceiling,
      );
    }
    // And the real process exits 2 with the fixed message, prints nothing about a run, on a sample (no `claude` on PATH).
    for (const ceiling of ['5.0000001', '5.001', '4.999', '1e0', ' 5', '05']) {
      const r = run({ RS_LIVE_MODEL: '1', RS_LIVE_MODEL_CEILING_USD: ceiling, RS_MODEL_PROVIDER: 'cli' });
      assert.equal(r.status, 2, JSON.stringify(ceiling));
      assert.equal(r.stderr.trim(), LIVE_MESSAGES.badCeiling, JSON.stringify(ceiling));
      assert.equal(r.stdout, '', JSON.stringify(ceiling));
    }
    for (const ceiling of ['5', '5.00', '0.50']) {
      const r = run({ RS_LIVE_MODEL: '1', RS_LIVE_MODEL_CEILING_USD: ceiling, RS_MODEL_PROVIDER: 'cli' }, { args: ['--dry-run'] });
      assert.equal(r.status, 0, `${ceiling}: ${r.stderr}`);
      assert.match(r.stdout, /dry run: no model call was made/);
    }
  });

  test('NFR3: the runner never runs under the offline network guard, even with everything else set', () => {
    const r = run(ENABLED, { args: ['--dry-run'], execArgv: ['--import', GUARD] });
    assert.equal(r.status, 2);
    assert.equal(r.stderr.trim(), LIVE_MESSAGES.netGuard);
    assert.equal(r.stdout, '', 'nothing about a run was printed');
  });

  test('NFR3: RS_TEST_OFFLINE=1 refuses too', () => {
    const r = run({ ...ENABLED, RS_TEST_OFFLINE: '1' }, { args: ['--dry-run'] });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /RS_TEST_OFFLINE=1/);
  });

  test('NFR3: the fake provider is refused: a "live" run must use cli or anthropic', () => {
    const r = run({ ...ENABLED, RS_MODEL_PROVIDER: 'fake' });
    assert.equal(r.status, 2);
    assert.equal(r.stderr.trim(), LIVE_MESSAGES.fakeProvider);
  });

  test('NFR3: an invalid configuration is refused naming the variable only', () => {
    const r = run({ ...ENABLED, RS_MODEL_CALL_CAP_USD: 'lots' });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /RS_MODEL_CALL_CAP_USD/);
    assert.equal(r.stderr.includes('lots'), false);
  });

  test('NFR3: the package script test:live-model reaches the same refusal through npm', () => {
    const r = spawnSync('npm', ['run', '--silent', 'test:live-model'], { cwd: ROOT, env: childEnv({ PATH: `${process.env.PATH}` }), encoding: 'utf8', timeout: 60_000 });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /Set RS_LIVE_MODEL=1 to run the live model suite \(billed to your account\)/);
  });
});

describe('what a run would spend', () => {
  test('NFR6: --dry-run prints provider, model, corpus, per-call cap, worst case and ceiling, makes no model call and exits 0', () => {
    const r = run({ ...ENABLED, RS_MODEL_PROVIDER: 'cli' }, { args: ['--dry-run'] });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /Live model suite \(billed to your account\)/);
    assert.match(r.stdout, /provider: cli {3}model: haiku/);
    assert.match(r.stdout, new RegExp(`corpus: EXT-1 \\(\\d+ cases\\), prompt ${PROMPT_VERSION}`));
    assert.match(r.stdout, /per-call cap: \$0\.05 {3}worst case for \d+ calls: \$\d+\.\d+ {3}ceiling: \$5\.00/);
    assert.match(r.stdout, /would spend at most \$/);
    assert.match(r.stdout, /dry run: no model call was made/);
    assert.equal(r.stderr, '');
  });

  test('NFR6: the worst case is every case at the per-call cap, and the plan says when the ceiling would stop the run early', () => {
    assert.deepEqual(planSpend({ caseCount: 22, capMicroUsd: 50_000, ceilingMicroUsd: 5_000_000 }), { calls: 22, capMicroUsd: 50_000, worstCaseMicroUsd: 1_100_000, ceilingMicroUsd: 5_000_000, wouldStopEarly: false });
    assert.equal(planSpend({ caseCount: 22, capMicroUsd: 500_000, ceilingMicroUsd: 5_000_000 }).wouldStopEarly, true);
  });

  test('NFR6: the launch checks run in a fixed order: enabled, ceiling, net guard, offline', () => {
    assert.deepEqual(evaluateLaunch({}), { ok: false, message: LIVE_MESSAGES.notEnabled });
    assert.deepEqual(evaluateLaunch({ RS_LIVE_MODEL: '1' }), { ok: false, message: LIVE_MESSAGES.noCeiling });
    assert.deepEqual(evaluateLaunch(ENABLED, { guardInstalled: true }), { ok: false, message: LIVE_MESSAGES.netGuard });
    assert.deepEqual(evaluateLaunch({ ...ENABLED, RS_TEST_OFFLINE: '1' }, { guardInstalled: false }), { ok: false, message: LIVE_MESSAGES.offline });
    assert.deepEqual(evaluateLaunch({ ...ENABLED, RS_LIVE_MODEL_CEILING_USD: '0.50' }, { guardInstalled: false }), { ok: true, ceilingMicroUsd: 500_000 });
    assert.deepEqual(evaluateLaunch(ENABLED, { guardInstalled: false }), { ok: true, ceilingMicroUsd: 5_000_000 });
    assert.equal(evaluateLaunch(ENABLED).ok, false, 'this very test process runs under the net guard');
  });
});

describe('the run itself, with the deterministic fake standing in for the model', () => {
  const env = { RS_LIVE_MODEL: '1', RS_LIVE_MODEL_CEILING_USD: '0.10', RS_MODEL_PROVIDER: 'cli', RS_MODEL_CALL_CAP_USD: '0.05' };
  const capture = () => {
    const lines = [];
    return { lines, out: (s) => lines.push(s), err: (s) => lines.push(s) };
  };

  test('NFR6: it stops BEFORE a call that could push the total past the ceiling and records a report that says so', async () => {
    const dir = join(scratch, 'reports-ceiling');
    const io = capture();
    const code = await runLive({
      env, argv: [], guardInstalled: false, reportDir: dir, out: io.out, err: io.err, now: () => new Date('2026-10-20T06:00:00.000Z'),
      providerFactory: async () => createFakeProvider({ costMicroUsd: 50_000, sleep: async () => {} }),
    });
    assert.equal(code, 1, 'an incomplete run is not a pass');
    const files = readdirSync(dir);
    assert.deepEqual(files, ['live-model-2026-10-20T06-00-00-000Z.json']);
    const report = JSON.parse(readFileSync(join(dir, files[0]), 'utf8'));
    assert.equal(report.suite, 'live-model');
    assert.equal(report.provider, 'fake');
    assert.equal(report.simulated, true, 'a fake run can never be mistaken for a live one');
    assert.equal(report.model, 'fake');
    assert.equal(report.corpusVersion, 'EXT-1');
    assert.equal(report.promptVersion, PROMPT_VERSION);
    assert.equal(report.cliVersion, null);
    assert.equal(report.ceilingMicroUsd, 100_000);
    assert.equal(report.costMicroUsd, 100_000, 'two calls of 0.05 fit the 0.10 ceiling exactly');
    assert.ok(report.costMicroUsd <= report.ceilingMicroUsd);
    assert.equal(report.cases.filter((c) => c.status === 'ok').length, 2);
    assert.ok(report.cases.filter((c) => c.status === 'skipped:ceiling').length >= 20);
    assert.equal(report.cases.find((c) => c.id === 'cli-image-smoke').status, 'ok', 'the smoke case runs first');
    assert.equal(report.pass, false);
    assert.equal(report.thresholds.textFieldAccuracy.value, 0.9);
    assert.match(io.lines.join(''), /NOT passed/);
  });

  test('F-TR-13: schemaAccepted is part of the report and is false unless the adapter reports it (the fake never does)', async () => {
    const dir = join(scratch, 'reports-schema');
    const io = capture();
    await runLive({
      env: { ...env, RS_LIVE_MODEL_CEILING_USD: '5' }, argv: [], guardInstalled: false, reportDir: dir, out: io.out, err: io.err,
      providerFactory: async () => createFakeProvider({ sleep: async () => {} }),
    });
    const report = JSON.parse(readFileSync(join(dir, readdirSync(dir)[0]), 'utf8'));
    assert.equal(report.schemaAccepted, false);
    assert.equal(report.pass, false, 'without schemaAccepted the suite cannot pass');
    assert.equal(report.skipped.length, 0);
    assert.equal(report.metrics.injectionEffects.pass, true);
  });

  test('NFR3: a provider that cannot be created exits 2 without a report', async () => {
    const dir = join(scratch, 'reports-none');
    const io = capture();
    const code = await runLive({
      env, argv: [], guardInstalled: false, reportDir: dir, out: io.out, err: io.err,
      providerFactory: async () => { throw new Error('no provider here'); },
    });
    assert.equal(code, 2);
    assert.throws(() => readdirSync(dir), { code: 'ENOENT' });
  });

  test('TR-D-9: the adapter is closed once when the run ends normally; a provider without close() is fine', async () => {
    let closed = 0;
    const withClose = (inner) => ({ ...inner, close: async () => { closed += 1; } });
    const io = capture();
    await runLive({
      env: { ...env, RS_LIVE_MODEL_CEILING_USD: '5' }, argv: [], guardInstalled: false, reportDir: join(scratch, 'reports-close'), out: io.out, err: io.err,
      providerFactory: async () => withClose(createFakeProvider({ sleep: async () => {} })),
    });
    assert.equal(closed, 1, 'close() ran once after the run');
    await runLive({
      env: { ...env, RS_LIVE_MODEL_CEILING_USD: '5' }, argv: [], guardInstalled: false, reportDir: join(scratch, 'reports-noclose'), out: io.out, err: io.err,
      providerFactory: async () => createFakeProvider({ sleep: async () => {} }),
    });
    assert.equal(closed, 1);
  });

  test('TR-D-9: SIGINT and SIGTERM close the adapter, exit non-zero (130, 143) and write no report', async () => {
    for (const [signal, expected] of [['SIGINT', 130], ['SIGTERM', 143]]) {
      const target = new EventEmitter();
      const exits = [];
      let closed = 0;
      const io = capture();
      const dir = join(scratch, `reports-${signal}`);
      const never = new Promise(() => {});
      const provider = { ...createFakeProvider({ sleep: async () => {} }), extract: () => never, close: async () => { closed += 1; } };
      const running = runLive({
        env: { ...env, RS_LIVE_MODEL_CEILING_USD: '5' }, argv: [], guardInstalled: false, reportDir: dir, out: io.out, err: io.err,
        providerFactory: async () => provider, signalTarget: target, exit: (c) => exits.push(c),
      });
      for (let i = 0; i < 50 && target.listenerCount(signal) === 0; i += 1) await new Promise((r) => setTimeout(r, 10));
      assert.equal(target.listenerCount(signal), 1, `${signal} handler installed once the provider exists`);
      target.emit(signal);
      assert.equal(await running, expected);
      assert.equal(closed, 1, 'the adapter was closed');
      assert.deepEqual(exits, [expected]);
      assert.throws(() => readdirSync(dir), { code: 'ENOENT' });
      assert.equal(target.listenerCount(signal), 0, 'the handler is removed afterwards');
      assert.match(io.lines.join(''), /interrupted/);
    }
  });
});

// A real runner process with a stub `claude` that sleeps. PATH holds the stub directory and /usr/bin:/bin only, and the
// test refuses to start if either of those holds a `claude`: nothing here can reach a model.
describe('the runner process kills its CLI child on SIGINT and SIGTERM (TR-D-9, SEC-D-2 inverted)', () => {
  const STUB = join(ROOT, 'test', 'fixtures', 'extraction', 'stub-claude.mjs');
  const alive = (pid) => {
    try {
      process.kill(pid, 0);
    } catch {
      return false;
    }
    try {
      return !/^\d+ \(.*\) Z/.test(readFileSync(`/proc/${pid}/stat`, 'utf8'));
    } catch {
      return true;
    }
  };
  const until = async (predicate, ms = 15_000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (predicate()) return true;
      await new Promise((r) => setTimeout(r, 25));
    }
    return predicate();
  };
  const pidOf = (dir, name) => Number(readFileSync(join(dir, name), 'utf8'));
  const ready = (dir) => ['child.pid', 'grandchild.pid'].every((n) => existsSync(join(dir, n)) && readFileSync(join(dir, n), 'utf8') !== '');

  for (const [signal, expected] of [['SIGTERM', 143], ['SIGINT', 130]]) {
    test(`NFR3: ${signal} to the runner leaves no CLI child alive, prints the plan first and exits ${expected}`, async () => {
      assert.equal(existsSync('/usr/bin/claude') || existsSync('/bin/claude'), false, 'a real claude is on the safe PATH: refusing to run');
      const dir = mkdtempSync(join(scratch, 'runner-'));
      const bin = join(dir, 'bin');
      const tmp = join(dir, 'tmp');
      mkdirSync(bin, { recursive: true });
      mkdirSync(tmp, { recursive: true });
      writeFileSync(join(bin, 'claude'), `#!/bin/sh\nexec "${process.execPath}" "${STUB}" hang "$@"\n`, { mode: 0o755 });
      const reportsBefore = existsSync(join(ROOT, 'reports')) ? readdirSync(join(ROOT, 'reports')) : [];
      const child = spawn(process.execPath, [RUNNER], {
        env: {
          PATH: `${bin}:/usr/bin:/bin`, HOME: dir, TMPDIR: tmp, LANG: 'C.UTF-8',
          RS_LIVE_MODEL: '1', RS_LIVE_MODEL_CEILING_USD: '5', RS_MODEL_PROVIDER: 'cli',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let out = '';
      let errText = '';
      child.stdout.on('data', (d) => { out += d; });
      child.stderr.on('data', (d) => { errText += d; });
      const exited = new Promise((resolve) => child.on('exit', (c, s) => resolve({ c, s })));
      try {
        assert.ok(await until(() => ready(tmp)), `the stub child started: ${errText}`);
        // Everything the user must see before the first model call is already printed.
        assert.ok(await until(() => /per-call cap: \$0\.05/.test(out)), out);
        assert.match(out, /provider: cli {3}model: haiku/);
        assert.match(out, /worst case for \d+ calls: \$\d+\.\d+ {3}ceiling: \$5\.00/);
        assert.match(out, /claude 2\.1\.296/, 'the CLI version is printed before the first call');
        const stubChild = pidOf(tmp, 'child.pid');
        const grandchild = pidOf(tmp, 'grandchild.pid');
        assert.ok(alive(stubChild) && alive(grandchild));
        child.kill(signal);
        const { c, s } = await Promise.race([exited, new Promise((_, rej) => setTimeout(() => rej(new Error('the runner did not exit')), 20_000))]);
        assert.equal(s, null, 'the runner exits by itself, not by the signal');
        assert.equal(c, expected);
        assert.ok(await until(() => !alive(stubChild)), 'the CLI child is gone');
        assert.ok(await until(() => !alive(grandchild)), 'and so is its process group');
        const after = existsSync(join(ROOT, 'reports')) ? readdirSync(join(ROOT, 'reports')) : [];
        assert.deepEqual(after, reportsBefore, 'an interrupted run writes no report');
        assert.match(errText, /interrupted/);
        assert.deepEqual(readdirSync(tmp).filter((n) => n.startsWith('rs-cli-')), []);
      } finally {
        child.kill('SIGKILL');
        for (const name of ['child.pid', 'grandchild.pid']) {
          if (existsSync(join(tmp, name))) {
            try {
              process.kill(pidOf(tmp, name), 'SIGKILL');
            } catch {
              // already gone
            }
          }
        }
      }
    });
  }
});
