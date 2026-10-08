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
