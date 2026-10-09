'use strict';
// Unit-level probe of lib/tasks.js filesChangedByTask / recordedFilesChanged on crafted event arrays:
// three completions, a plan re-import, other tasks' events, malformed events.
const path = require('path');
const assert = require('assert');
const T = require(path.resolve(__dirname, '../../../lib/tasks.js'));

const c = (task, filesChanged, extra = {}) => ({ type: 'task.completed', data: { task, filesChanged, ...extra } });
const results = [];
function check(name, fn) {
  try { fn(); results.push(`ok   ${name}`); } catch (e) { results.push(`FAIL ${name}: ${e.message}`); }
}

check('three completions union, order kept, duplicates collapsed', () => {
  const m = T.filesChangedByTask([c('a', ['x']), c('a', ['y', 'x']), c('a', ['z'])]);
  assert.deepStrictEqual([...m.get('a')], ['x', 'y', 'z']);
});
check('plan.imported resets the union (mirrors the reducer)', () => {
  const m = T.filesChangedByTask([c('a', ['x']), { type: 'plan.imported', data: {} }, c('a', ['y'])]);
  assert.deepStrictEqual([...m.get('a')], ['y']);
});
check('other tasks and other phases do not leak into a task', () => {
  const m = T.filesChangedByTask([c('a', ['x']), c('b', ['q']), c('other-phase-task', ['w'])]);
  assert.deepStrictEqual([...m.get('a')], ['x']);
  assert.deepStrictEqual(T.recordedFilesChanged([c('a', ['x']), c('b', ['q'])], [{ id: 'a', filesChanged: ['x'] }]), ['x']);
});
check('task.reset and task.claimed between completions change nothing', () => {
  const ev = [c('a', ['x']), { type: 'task.reset', data: { task: 'a' } }, { type: 'task.claimed', data: { task: 'a' } }, c('a', ['y'])];
  assert.deepStrictEqual([...T.filesChangedByTask(ev).get('a')], ['x', 'y']);
});
check('missing filesChanged / missing data / non-string task are tolerated', () => {
  const m = T.filesChangedByTask([{ type: 'task.completed', data: { task: 'a' } }, { type: 'task.completed' }, { type: 'task.completed', data: { task: 7, filesChanged: ['x'] } }]);
  assert.deepStrictEqual([...(m.get('a') || [])], []);
  assert.strictEqual(m.get(7), undefined);
});
check('a string filesChanged (not an array) is not iterated character by character', () => {
  const m = T.filesChangedByTask([c('a', 'src/x.js')]);
  assert.deepStrictEqual([...(m.get('a') || [])], [], 'reducer stores the raw value; the union must not spray characters');
});
check('__proto__ as a task id does not poison the map', () => {
  const m = T.filesChangedByTask([c('__proto__', ['evil'])]);
  assert.deepStrictEqual([...(m.get('__proto__') || [])], ['evil']);
  assert.deepStrictEqual(T.recordedFilesChanged([c('__proto__', ['evil'])], [{ id: 'a' }]), []);
});
check('snapshot field is unioned with the log (snapshot-only entry survives)', () => {
  assert.deepStrictEqual(T.recordedFilesChanged([], [{ id: 'a', filesChanged: ['s'] }]), ['s']);
});
check('performance: 200k events', () => {
  const ev = [];
  for (let i = 0; i < 200000; i++) ev.push(c(`t${i % 50}`, [`f${i % 500}`, `g${i}`]));
  const t0 = Date.now();
  const m = T.filesChangedByTask(ev);
  const ms = Date.now() - t0;
  assert.strictEqual(m.size, 50);
  results.push(`info 200k task.completed events unioned in ${ms} ms`);
});
console.log(results.join('\n'));
