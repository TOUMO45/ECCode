// NFR1 / ARCH-24: node-proc.js passes only the allow-listed execArgv and merges the
// sqlite flags into NODE_OPTIONS (keeping an existing value) on Node < 22.13.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import {
  NET_GUARD_PATH,
  SQLITE_NODE_OPTIONS,
  allowedExecArgv,
  childEnv,
  mergeNodeOptions,
  needsSqliteFlag,
  nodeArgs,
  runNode,
} from '../../helpers/node-proc.js';

const PROBE = fileURLToPath(new URL('../../helpers/print-proc.js', import.meta.url));

test('NFR1: needsSqliteFlag is true below 22.13 and false from 22.13', () => {
  for (const v of ['20.20.0', '21.7.3', '22.5.0', '22.12.9', 'v22.12.0', 'not-a-version']) assert.equal(needsSqliteFlag(v), true, v);
  for (const v of ['22.13.0', 'v22.13.1', '22.22.0', '23.0.0', '24.1.2']) assert.equal(needsSqliteFlag(v), false, v);
});

test('NFR1: mergeNodeOptions keeps an existing value and adds the sqlite flags only below 22.13', () => {
  assert.equal(mergeNodeOptions(undefined, '22.22.0'), '');
  assert.equal(mergeNodeOptions('--max-old-space-size=8192', '22.13.0'), '--max-old-space-size=8192');
  assert.equal(mergeNodeOptions(undefined, '22.5.0'), SQLITE_NODE_OPTIONS);
  assert.equal(mergeNodeOptions('', '22.12.0'), SQLITE_NODE_OPTIONS);
  assert.equal(mergeNodeOptions('--max-old-space-size=8192', '22.12.0'), `--max-old-space-size=8192 ${SQLITE_NODE_OPTIONS}`);
  // Idempotent: flags already present are not repeated.
  const once = mergeNodeOptions('--max-old-space-size=8192', '22.12.0');
  assert.equal(mergeNodeOptions(once, '22.12.0'), once);
  assert.equal(mergeNodeOptions('--experimental-sqlite', '22.12.0'), SQLITE_NODE_OPTIONS);
});

test('NFR1: allowedExecArgv keeps sqlite, disable-warning and the net guard import, and drops the rest', () => {
  const parent = [
    '--disable-warning=ExperimentalWarning',
    '--import',
    './test/helpers/net-guard.js',
    '--test-concurrency=4',
    '--test',
    '--inspect=9229',
    '--experimental-sqlite',
    '--import=./other-preload.js',
    '--disable-warning=DEP0040',
    '--test-name-pattern=x',
    '--watch',
  ];
  const kept = allowedExecArgv(parent, { cwd: fileURLToPath(new URL('../../..', import.meta.url)) });
  assert.deepEqual(kept, [
    '--disable-warning=ExperimentalWarning',
    `--import=${NET_GUARD_PATH}`,
    '--experimental-sqlite',
    '--disable-warning=DEP0040',
  ]);
  assert.deepEqual(allowedExecArgv([]), []);
  // `--import=<abs net guard>` is recognised and not duplicated.
  assert.deepEqual(allowedExecArgv([`--import=${NET_GUARD_PATH}`, '--import', NET_GUARD_PATH]), [`--import=${NET_GUARD_PATH}`]);
});

test('NFR1: nodeArgs always adds the net guard, once, before the script', () => {
  const args = nodeArgs('/x/server.js', ['--flag'], { execArgv: ['--test-concurrency=4', '--disable-warning=ExperimentalWarning'] });
  assert.deepEqual(args, ['--disable-warning=ExperimentalWarning', `--import=${NET_GUARD_PATH}`, '/x/server.js', '--flag']);
  const off = nodeArgs('/x/server.js', [], { execArgv: [], netGuard: false });
  assert.deepEqual(off, ['/x/server.js']);
});

test('NFR1: childEnv overrides, removes names, drops the test-runner marker and merges NODE_OPTIONS', () => {
  const base = { PATH: '/bin', NODE_TEST_CONTEXT: 'child-v8', KEEP: '1', GONE: 'x', NODE_OPTIONS: '--max-old-space-size=8192' };
  const env = childEnv({ A: 1, GONE: undefined }, { base, version: '22.22.0' });
  assert.equal(env.A, '1');
  assert.equal('GONE' in env, false);
  assert.equal('NODE_TEST_CONTEXT' in env, false);
  assert.equal(env.KEEP, '1');
  assert.equal(env.NODE_OPTIONS, '--max-old-space-size=8192');
  const old = childEnv({}, { base, version: '22.12.0' });
  assert.equal(old.NODE_OPTIONS, `--max-old-space-size=8192 ${SQLITE_NODE_OPTIONS}`);
  const explicit = childEnv({ NODE_OPTIONS: '--stack-trace-limit=50' }, { base, version: '22.5.0' });
  assert.equal(explicit.NODE_OPTIONS, `--stack-trace-limit=50 ${SQLITE_NODE_OPTIONS}`);
  assert.equal('NODE_OPTIONS' in childEnv({}, { base: { PATH: '/bin' }, version: '22.22.0' }), false);
  assert.equal(base.NODE_OPTIONS, '--max-old-space-size=8192', 'the input environment is not modified');
});

test('NFR1: a real child gets the net guard, the allow-listed flags and no test-runner flags', async () => {
  const result = await runNode(PROBE, ['one'], { RS_PROBE: 'x' }, {
    execArgv: ['--test-concurrency=4', '--test', '--disable-warning=ExperimentalWarning', '--experimental-sqlite'],
  });
  assert.equal(result.code, 0, result.stderr);
  const seen = JSON.parse(result.stdout);
  assert.equal(seen.guard, true);
  assert.deepEqual(seen.execArgv, ['--disable-warning=ExperimentalWarning', '--experimental-sqlite', `--import=${NET_GUARD_PATH}`]);
  assert.deepEqual(seen.argv, ['one']);
  assert.equal(seen.pick, 'x');
  assert.equal(seen.testContext, null);
});

test('NFR1: a real child started as if on Node 22.12 gets the sqlite flags in NODE_OPTIONS next to the existing value', async () => {
  const result = await runNode(PROBE, [], { NODE_OPTIONS: '--max-old-space-size=4096' }, { execArgv: [], version: '22.12.0' });
  assert.equal(result.code, 0, result.stderr);
  const seen = JSON.parse(result.stdout);
  assert.equal(seen.nodeOptions, `--max-old-space-size=4096 ${SQLITE_NODE_OPTIONS}`);
  assert.equal(seen.guard, true);
});
