'use strict';
// Plan P-4, bare arm: interventions counted from the session transcript, checked against the operator log (C5).
const test = require('node:test');
const assert = require('node:assert');
const { count, typedText, FIXED } = require('../tools/count-transcript-interventions');

const human = (text, ts) => ({ type: 'user', timestamp: ts, origin: { kind: 'human' }, message: { role: 'user', content: text } });
const toolResult = () => ({ type: 'user', toolUseResult: { stdout: 'ok' }, message: { role: 'user', content: [{ type: 'tool_result', content: 'ok' }] } });
const assistant = (text) => ({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } });
const [CLARIFY, UNBLOCK] = Object.keys(FIXED);
const MASTER = 'Build Meterline.\n';

test('a run with no operator action counts zero: the master prompt is not an intervention', () => {
  const r = count([human(MASTER, 't0'), assistant('working'), toolResult(), assistant('Done.')]);
  assert.strictEqual(r.total, 0);
  assert.strictEqual(r.typedPrompts, 1);
  assert.strictEqual(r.masterPrompt.bytes, Buffer.byteLength(MASTER.trim()));
  assert.deepStrictEqual(r.methods, { 'M4-A3': 0, 'M4-6.1': 0 });
});

test('the two fixed operator texts are classified by the decision table', () => {
  const r = count([human(MASTER), assistant('Which unit?'), human(CLARIFY, 't1'), assistant('stopping'), human(UNBLOCK, 't2'), human(UNBLOCK, 't3')]);
  assert.strictEqual(r.counted['clarification-answer'], 1);
  assert.strictEqual(r.counted.unblock, 2);
  assert.strictEqual(r.total, 3);
  assert.deepStrictEqual(r.deviations, []);
});

test('any other text is a correction and a deviation, recorded by hash, not by content', () => {
  const r = count([human(MASTER), human('Use Postgres 16 and fix the worker.', 't1')]);
  assert.strictEqual(r.counted.correction, 1);
  assert.strictEqual(r.deviations.length, 1);
  assert.ok(!JSON.stringify(r).includes('Postgres 16'));
  assert.match(r.deviations[0].sha256, /^[0-9a-f]{64}$/);
});

test('tool results, subagent traffic, meta records and harness notices are not typed prompts', () => {
  const noise = [
    toolResult(),
    { type: 'user', isSidechain: true, message: { role: 'user', content: 'subagent brief' } },
    { type: 'user', isMeta: true, message: { role: 'user', content: 'meta' } },
    { type: 'user', origin: { kind: 'task-notification' }, message: { role: 'user', content: 'agent finished' } },
    { type: 'user', message: { role: 'user', content: '<task-notification>done</task-notification>' } },
    { type: 'user', message: { role: 'user', content: 'Stop hook feedback: push' } },
    { type: 'user', message: { role: 'user', content: '<system-reminder>x</system-reminder>' } },
  ];
  for (const n of noise) assert.strictEqual(typedText(n), null);
  assert.strictEqual(count([human(MASTER), ...noise]).total, 0);
});

test('C5: the transcript count must equal the operator log; a restart is taken from the log', () => {
  const records = [human(MASTER), human(UNBLOCK), human(CLARIFY)];
  const agree = count(records, [{ type: 'unblock' }, { type: 'clarification-answer' }, { type: 'restart' }]);
  assert.strictEqual(agree.agreement.agrees, true);
  assert.strictEqual(agree.counted.restart, 1);
  assert.strictEqual(agree.total, 3);
  const differ = count(records, [{ type: 'unblock' }]);
  assert.strictEqual(differ.agreement.agrees, false);
  assert.deepStrictEqual(differ.agreement.differences, [{ kind: 'clarification-answer', transcript: 1, operatorLog: 0 }]);
  const odd = count(records, [{ type: 'coffee' }, { type: 'unblock' }, { type: 'clarification-answer' }]);
  assert.strictEqual(odd.deviations.length, 1);
});
