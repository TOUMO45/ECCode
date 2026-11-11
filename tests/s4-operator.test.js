'use strict';
// The S4 operator tool prepares each arm exactly as the plan and its addenda fix it, and refuses changed inputs.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const op = require('../tools/s4-operator');

const REPO = path.join(__dirname, '..');
const haveBase = spawnSync('git', ['-C', REPO, 'cat-file', '-e', `${op.BASE}^{commit}`]).status === 0;
const skipNoBase = haveBase ? false : `base commit ${op.BASE.slice(0, 7)} not in this checkout (shallow clone)`;
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 's4-op-'));

test('order: a seed gives one fixed permutation of the three arms; another seed can give another', () => {
  const first = op.order('2026-11-11 stage 1');
  assert.deepStrictEqual([...first].sort(), ['a', 'b', 'c']);
  assert.deepStrictEqual(op.order('2026-11-11 stage 1'), first);
  const seen = new Set(['s1', 's2', 's3', 's4', 's5', 's6', 's7', 's8'].map((s) => op.order(s).join('')));
  assert.ok(seen.size > 1, 'the order depends on the seed');
  assert.throws(() => op.order(''), op.OperatorError);
});

test('the registered sha256 of the three frozen inputs still match the files', () => {
  const inputs = op.frozenInputs(REPO);
  assert.deepStrictEqual(Object.keys(inputs).sort(), Object.keys(op.FILES).sort());
});

test('arm a: an empty workspace with the attachment only, no ECCode, prompt kept outside it', () => {
  const { runDir, workspace, record } = op.prepare({ arm: 'a', out: tmp(), repo: REPO });
  assert.deepStrictEqual(fs.readdirSync(workspace), ['sample_readings.csv']);
  assert.strictEqual(record.base, null);
  assert.strictEqual(record.gf, null);
  assert.ok(fs.readFileSync(path.join(runDir, 'prompt.md')).equals(fs.readFileSync(path.join(REPO, 'docs/build/gf-s4-plan-record/meterline/master-prompt-v2-stage1.md'))));
});

test('arms b and c: same export, same init, and they differ only in gf.runtime.enforce', { skip: skipNoBase }, () => {
  const out = tmp();
  const b = op.prepare({ arm: 'b', out, repo: REPO });
  const c = op.prepare({ arm: 'c', out, repo: REPO });
  for (const arm of [b, c]) {
    assert.ok(!fs.existsSync(path.join(arm.workspace, 'docs')), 'docs/ is not exported');
    assert.ok(fs.existsSync(path.join(arm.workspace, 'bin', 'eccode-gf.js')));
    assert.deepStrictEqual(arm.record.gf.approval, { auto: op.AUTO });
    assert.strictEqual(arm.record.gf.stackProfile, 'python-fastapi-postgres-worker-compose');
    assert.strictEqual(arm.record.deviations.length, 1);
  }
  assert.strictEqual(b.record.gf.runtime, undefined);
  assert.deepStrictEqual(c.record.gf.runtime, { enforce: true });
  const { runtime, ...cRest } = c.record.gf;
  assert.deepStrictEqual(cRest, b.record.gf);
  // the idea recorded by init is the v2 prompt byte for byte, trailing newline included
  const idea = fs.readFileSync(path.join(REPO, 'docs/build/gf-s4-plan-record/meterline/master-prompt-v2-stage1.md'), 'utf8');
  const stored = fs.readFileSync(path.join(b.workspace, '.eccode', 'events.jsonl'), 'utf8') + fs.readFileSync(path.join(b.workspace, '.eccode', 'state.json'), 'utf8');
  assert.ok(stored.includes(JSON.stringify(idea).slice(1, -1)), 'init kept the prompt verbatim');
});

test('a changed frozen input stops preparation before anything is written', () => {
  const repo = tmp();
  const rec = path.join(repo, 'docs/build/gf-s4-plan-record/meterline');
  fs.mkdirSync(rec, { recursive: true });
  for (const name of Object.keys(op.FILES)) fs.copyFileSync(path.join(REPO, 'docs/build/gf-s4-plan-record/meterline', name), path.join(rec, name));
  fs.appendFileSync(path.join(rec, 'sample_readings.csv'), 'x');
  const out = tmp();
  assert.throws(() => op.prepare({ arm: 'a', out, repo }), /sha256 mismatch for sample_readings\.csv/);
  assert.deepStrictEqual(fs.readdirSync(out), []);
});

test('an arm is never prepared twice into the same directory', () => {
  const out = tmp();
  op.prepare({ arm: 'a', out, repo: REPO });
  assert.throws(() => op.prepare({ arm: 'a', out, repo: REPO }), /already exists/);
});
