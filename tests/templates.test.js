'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { template, names } = require('../lib/templates');
const { validateNamed } = require('../lib/schema');
const { validatePlan } = require('../lib/tasks');
const { DEFAULT_CONFIG } = require('../lib/config');

test('every template validates against its schema exactly as printed', () => {
  assert.deepStrictEqual(names().sort(), ['handoff', 'lesson', 'plan', 'review']);
  assert.deepStrictEqual(validateNamed('review', template('review')), []);
  assert.deepStrictEqual(validatePlan(template('plan'), DEFAULT_CONFIG), []);
  assert.deepStrictEqual(validateNamed('handoff', { ...template('handoff') }), []);
  const lesson = template('lesson');
  assert.deepStrictEqual(validateNamed('memory-debugging', lesson.content), []);
});

test('an unknown template is a usage error that lists the available ones', () => {
  assert.throws(() => template('nope'), (e) => e.code === 'USAGE' && /review, plan, handoff, lesson/.test(e.message));
});

test('CLI: eccode template <name> prints JSON that validates, without a project', () => {
  const { spawnSync } = require('child_process');
  const os = require('os');
  const path = require('path');
  const bin = path.join(__dirname, '..', 'bin', 'eccode.js');
  const cwd = require('fs').mkdtempSync(path.join(os.tmpdir(), 'eccode-tpl-'));
  for (const n of names()) {
    const res = spawnSync(process.execPath, [bin, 'template', n], { cwd, encoding: 'utf8' });
    assert.strictEqual(res.status, 0, res.stderr);
    assert.doesNotThrow(() => JSON.parse(res.stdout));
  }
  const bad = spawnSync(process.execPath, [bin, 'template', 'nope'], { cwd, encoding: 'utf8' });
  assert.strictEqual(bad.status, 1);
});
