'use strict';
// Probe F (reviewer): probe A showed a writeFileSync on a path ending in
// events.jsonl inside the lock during `risk add`; which code does it?
const path = require('path');
const fs = require('fs');
const root = path.resolve(__dirname, '..', '..', '..', '..', '..');
const real = fs.writeFileSync;
fs.writeFileSync = function (p, ...r) {
  if (/events\.jsonl$/.test(String(p))) console.log(`writeFileSync(${String(p).replace(root, '<root>')})\n` + new Error().stack.split('\n').slice(2, 6).join('\n'));
  return real.call(fs, p, ...r);
};
const { tmpProject } = require(path.join(root, 'tests', 'helpers'));
const runs = require(path.join(root, 'lib', 'runs'));
const ctx = tmpProject();
console.log('--- after tmpProject() ---');
runs.recordRisk(ctx.store, 'delivery-lead', { id: 'R1', title: 't', severity: 'low', status: 'open' });
