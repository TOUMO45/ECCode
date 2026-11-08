'use strict';
// R: GF-ISO-0 selects the run mechanism by AVAILABILITY (sandbox.choose), not by the canary's per-mechanism verdict
// (selfTest().usable). So if Landlock is available but the canary found it NOT contained, while bubblewrap passes,
// group mode proceeds (aggregate ok=true) AND the run still uses the leaking Landlock.
const path = require('path');
const ROOT = '/tmp/claude-0/-home-user-ECCode/7061a3fb-d3e3-516a-8100-3a4a8e46689a/scratchpad/review-s24';
const sandbox = require(path.join(ROOT, 'lib/greenfield/sandbox'));
const H = require('./harness');

// 1) Unit: choose() ignores any canary verdict; with both mechanisms + no carve-outs it always returns landlock.
const pr = { mechanisms: ['landlock', 'bwrap'], landlock: { abi: 7 }, bwrap: { version: 'x' }, pidns: true, uid: 0 };
console.log('choose(both, no carveouts) =', sandbox.choose(pr, { carveouts: [] }), '(selfTest.usable is never consulted)');

// 2) End-to-end: simulate "Landlock leaks the canary, bubblewrap holds" by making the engine's self-test report
//    usable:['bwrap'] only, ok:true. The REAL probe/choose/argv are untouched. Observe which mechanism the run uses.
const realSelfTest = sandbox.selfTest(); // on THIS machine both pass; print for honesty
console.log('REAL selfTest.usable on this machine =', JSON.stringify(realSelfTest.usable));

sandbox.selfTest = () => ({ ok: true, platform: 'linux', usable: ['bwrap'], landlock: { abi: 7 }, bwrap: { version: 'x' }, pidns: true, reasons: ['landlock: the canary was not contained (SIMULATED)'] });
sandbox.groupModeProblems = () => []; // ok because aggregate ok=true (bwrap usable)

const ctx = H.project('python3 app/seed.py');
H.put(ctx, 'app/seed.py', 'import pathlib; pathlib.Path("app/ok.txt").write_text("own")\n');
H.commitAll(ctx, 'seed');
H.F(ctx, 'task.rescoped', 'user', { task: 's0-app', files: null, command: 'python3 app/seed.py', reason: 're-pin', from: ['app/main.py'] });
const r = H.run(ctx, 'python3 app/seed.py');
console.log('run proceeded; isolation.mechanism =', r.isolation.mechanism, '(selfTest said only bwrap is usable)');
console.log(r.isolation.mechanism === 'landlock'
  ? 'CONFIRMED: the run used Landlock although the canary marked Landlock NOT usable -> GF-ISO-0 does not bind the chosen mechanism to its per-mechanism verdict.'
  : 'not reproduced');
