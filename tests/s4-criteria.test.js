'use strict';
// Plan section 6, M1: a criterion passes iff all its tests pass; the scorer fails closed.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const TOOL = path.join(__dirname, '..', 'tools', 'criteria.py');
const HAVE_PY = spawnSync('python3', ['--version']).status === 0;
const skip = HAVE_PY ? false : 'needs python3';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 's4-criteria-'));
const write = (name, text) => { const f = path.join(dir, name); fs.writeFileSync(f, text); return f; };
const junit = (cases) => `<?xml version="1.0"?><testsuites><testsuite>${cases.map(([cls, name, inner]) => `<testcase classname="${cls}" name="${name}">${inner || ''}</testcase>`).join('')}</testsuite></testsuites>`;
const run = (...args) => { const r = spawnSync('python3', [TOOL, ...args], { encoding: 'utf8' }); return { status: r.status, out: r.stdout ? JSON.parse(r.stdout || 'null') : null, err: r.stderr }; };

const RUN1 = write('j1.xml', junit([
  ['tests.test_ingest', 'test_good_file'], ['tests.test_ingest', 'test_duplicate_file'],
  ['tests.test_usage', 'test_daily', '<failure message="x"/>'], ['tests.test_usage', 'test_backwards'],
  ['tests.test_scope', 'test_manager', '<skipped message="unmapped"/>'],
]));

test('a criterion passes only when every one of its tests passed', { skip }, () => {
  const c = write('c.json', JSON.stringify({
    C1: ['tests/test_ingest.py::test_good_file', 'tests.test_ingest::test_duplicate_file'],
    C2: ['test_daily', 'test_backwards'],
    C3: ['test_manager'],
  }));
  const r = run(RUN1, c);
  assert.strictEqual(r.status, 0, r.err);
  assert.strictEqual(r.out.criteria_passed, 1);
  assert.strictEqual(r.out.criteria_total, 3);
  assert.strictEqual(r.out.criteria.C1.passed, true);
  assert.strictEqual(r.out.criteria.C2.passed, false);          // one failed test fails the criterion
  assert.strictEqual(r.out.criteria.C3.passed, false);          // a skipped test is not a pass
  assert.deepStrictEqual(r.out.raw, { passed: 3, failed: 1, skipped: 1, total: 5 });
});

test('a test named in criteria.json but absent from the run fails its criterion and is reported', { skip }, () => {
  const c = write('c2.json', JSON.stringify({ C1: ['test_good_file', 'test_never_written'], C2: [] }));
  const r = run(RUN1, c);
  assert.strictEqual(r.status, 2);
  assert.strictEqual(r.out.criteria.C1.passed, false);
  assert.deepStrictEqual(r.out.unmatched, ['C1: test_never_written']);
  assert.strictEqual(r.out.criteria.C2.passed, false);          // an empty criterion proves nothing
});

test('two runs: differing tests are listed and C3 (98% agreement) is evaluated', { skip }, () => {
  const c = write('c3.json', JSON.stringify({ C1: ['test_good_file'] }));
  const run2 = write('j2.xml', junit([
    ['tests.test_ingest', 'test_good_file'], ['tests.test_ingest', 'test_duplicate_file'],
    ['tests.test_usage', 'test_daily'], ['tests.test_usage', 'test_backwards'],
    ['tests.test_scope', 'test_manager', '<skipped message="unmapped"/>'],
  ]));
  const r = run(RUN1, c, '--second', run2);
  assert.deepStrictEqual(r.out.stability.differing, ['tests.test_usage::test_daily']);
  assert.strictEqual(r.out.stability.agreement, 0.8);
  assert.strictEqual(r.out.stability.meets_C3, false);
  assert.strictEqual(run(RUN1, c, '--second', RUN1).out.stability.meets_C3, true);
});

test('unreadable input is a clean error, not a traceback', { skip }, () => {
  const r = spawnSync('python3', [TOOL, path.join(dir, 'none.xml'), path.join(dir, 'none.json')], { encoding: 'utf8' });
  assert.strictEqual(r.status, 1);
  assert.doesNotMatch(r.stderr, /Traceback/);
  assert.strictEqual(spawnSync('python3', [TOOL], { encoding: 'utf8' }).status, 1);
});
