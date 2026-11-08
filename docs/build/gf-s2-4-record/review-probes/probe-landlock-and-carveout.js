'use strict';
const path = require('path');
const ROOT = '/tmp/claude-0/-home-user-ECCode/7061a3fb-d3e3-516a-8100-3a4a8e46689a/scratchpad/review-s24';
const sandbox = require(path.join(ROOT, 'lib/greenfield/sandbox'));
const H = require('./harness');

// ---- 1) In-model kernel rows under LANDLOCK: frontend group owns web/** with no denyGlobs -> no carve-out -> landlock.
function frontendRun(name, seed, check) {
  const ctx = H.project('x');
  // give the frontend task a plan-pinned command; frontend owns web/**
  H.F(ctx, 'task.rescoped', 'user', { task: 's0-web', files: null, command: 'python3 web/seed.py', reason: 'p', from: ['web/index.html'] });
  H.put(ctx, 'web/seed.py', seed);
  H.commitAll(ctx, 'seed');
  H.F(ctx, 'task.rescoped', 'user', { task: 's0-web', files: null, command: 'python3 web/seed.py', reason: 're-pin', from: ['web/index.html'] });
  const r = H.call('gf_run', { label: 'c', command: 'python3 web/seed.py', task: 's0-web' }, ctx, 'frontend-engineer');
  console.log(`[landlock][${name}] mech=${r.isolation.mechanism} status=${r.status} tail=${(r.outputTail||'').replace(/\n/g,' | ').slice(0,200)}`);
  console.log(`          ${check(ctx)}`);
}
frontendRun('A-5 hardlink->realtree (app/main.py of another group)', [
  'import os, pathlib',
  'real = os.path.realpath(os.path.join(os.getcwd(), "..", "..", "app", "main.py"))',
  'res=[]',
  'try: os.link(real, "web/hl"); res.append("LINKED"); open("web/hl","a").write("X"); res.append("WROTE")',
  'except OSError as e: res.append("refused:"+e.strerror)',
  'pathlib.Path("web/ok.txt").write_text("own"); print(" ".join(res))',
].join('\n'), (ctx) => `app/main.py = ${JSON.stringify(H.read(ctx,'app/main.py'))}`);
frontendRun('A-2 symlink->app (another group)', [
  'import os, pathlib',
  'res=[]',
  'try: os.symlink("../app", "web/esc"); (pathlib.Path("web/esc/evil.py").write_text("x")); res.append("WROTE")',
  'except OSError as e: res.append("refused:"+e.strerror)',
  'pathlib.Path("web/ok.txt").write_text("own"); print(" ".join(res))',
].join('\n'), (ctx) => `app/evil.py exists = ${H.exists(ctx,'app/evil.py')}`);

// ---- 2) Carve-out under LANDLOCK (backend owns app/**, denies app/db + app/auth). Suppress bwrap so choose->landlock.
const realProbe = sandbox.probe();
sandbox.probe = () => ({ ...realProbe, bwrap: null, bwrapError: 'SUPPRESSED for test', mechanisms: ['landlock'] });
sandbox._reset(); // drop cached probe/selftest so the override takes effect
sandbox.selfTest = () => ({ ok: true, platform: 'linux', usable: ['landlock'], landlock: realProbe.landlock, bwrap: null, pidns: true, reasons: [] });
sandbox.groupModeProblems = () => [];
{
  const ctx = H.project('python3 app/seed.py');
  H.put(ctx, 'app/seed.py', [
    'import pathlib, os',
    'res=[]',
    'for p in ["app/db/evil.py","app/auth/evil.py","app/own.py"]:',
    '    os.makedirs(os.path.dirname(p), exist_ok=True) if os.path.dirname(p) else None',
    '    try: pathlib.Path(p).write_text("x"); res.append(p+":WROTE")',
    '    except OSError as e: res.append(p+":"+e.strerror)',
    'print(" ".join(res))',
  ].join('\n'));
  H.commitAll(ctx, 'seed');
  H.F(ctx, 'task.rescoped', 'user', { task: 's0-app', files: null, command: 'python3 app/seed.py', reason: 're-pin', from: ['app/main.py'] });
  const r = H.run(ctx, 'python3 app/seed.py', 'backend-engineer');
  console.log(`\n[carveout-under-landlock] mech=${r.isolation.mechanism} status=${r.status}`);
  console.log(`   in-sandbox result: ${(r.outputTail||'').replace(/\n/g,' | ').slice(0,200)}`);
  console.log(`   widened recorded: ${JSON.stringify(r.isolation.widened)}`);
  console.log(`   copiedBack: ${JSON.stringify(r.copiedBack)}  discarded: ${JSON.stringify(r.discarded)}`);
  console.log(`   REAL TREE: app/db/evil.py=${H.exists(ctx,'app/db/evil.py')} app/auth/evil.py=${H.exists(ctx,'app/auth/evil.py')}`);
}

// ---- 3) Divergence: canary says only LANDLOCK usable (bwrap leaks), but backend has carve-outs so run uses bwrap.
sandbox.probe = () => realProbe; sandbox._reset();
sandbox.selfTest = () => ({ ok: true, platform: 'linux', usable: ['landlock'], landlock: realProbe.landlock, bwrap: realProbe.bwrap, pidns: true, reasons: ['bwrap: the canary was not contained (SIMULATED)'] });
sandbox.groupModeProblems = () => [];
{
  const ctx = H.project('python3 app/seed.py');
  H.put(ctx, 'app/seed.py', 'import pathlib; pathlib.Path("app/ok.txt").write_text("own")\n');
  H.commitAll(ctx, 'seed');
  H.F(ctx, 'task.rescoped', 'user', { task: 's0-app', files: null, command: 'python3 app/seed.py', reason: 're-pin', from: ['app/main.py'] });
  const r = H.run(ctx, 'python3 app/seed.py', 'backend-engineer');
  console.log(`\n[divergence] canary usable=['landlock'] but run mech=${r.isolation.mechanism}`);
  console.log(r.isolation.mechanism === 'bwrap'
    ? "CONFIRMED: carve-outs forced bwrap although the canary marked only landlock usable -> the chosen mechanism is not required to have passed its canary."
    : 'not reproduced');
}
