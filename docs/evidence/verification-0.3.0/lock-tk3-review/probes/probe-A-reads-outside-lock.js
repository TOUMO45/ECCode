'use strict';
// Probe A (reviewer): during `risk add`, which fs calls touch state.json /
// events.jsonl OUTSIDE withLock? Wraps fs and tags each call with whether a
// withLock frame is on the stack. Run from the worktree root.
const path = require('path');
const fs = require('fs');
const root = path.resolve(__dirname, '..', '..', '..', '..', '..');
const { tmpProject } = require(path.join(root, 'tests', 'helpers'));
const runs = require(path.join(root, 'lib', 'runs'));

const log = [];
function wrap(name) {
  const real = fs[name];
  fs[name] = function (p, ...rest) {
    const s = String(p);
    if (/state\.json|events\.jsonl/.test(s)) {
      const inLock = new Error().stack.includes('withLock');
      log.push(`${name}(${path.basename(s).replace(/\.\d+\.[0-9a-f]+\.tmp$/, '.<tmp>')}${name === 'renameSync' ? ' -> ' + path.basename(String(rest[0])) : ''}) ${inLock ? 'inside lock' : 'OUTSIDE LOCK'}`);
    }
    return real.call(fs, p, ...rest);
  };
}
['readFileSync', 'renameSync', 'appendFileSync', 'writeFileSync', 'truncateSync'].forEach(wrap);

const ctx = tmpProject();
log.length = 0;
runs.recordRisk(ctx.store, 'delivery-lead', { id: 'R1', title: 'risk 1', severity: 'low', status: 'open' });
console.log(log.join('\n'));
const outside = log.filter((l) => l.includes('OUTSIDE')).length;
console.log(`\n${outside} read(s) of the record outside the lock; ${log.filter((l) => l.startsWith('renameSync')).length} rename(s) over state.json inside the lock`);
