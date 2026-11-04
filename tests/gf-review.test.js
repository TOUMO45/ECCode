'use strict';
// Regression tests for the independent review of S1 (B4, M1, M2, M4, M5, M6, M8, m1). The table-driven findings
// (B1, B2, B3, M3, m3) are rows in tests/fixtures/gf/mutations.js. Each test here reproduced a finding before its fix.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const gates = require('../lib/gates');
const design = require('../lib/design');
const sample = require('./fixtures/gf/sample');
const { gfProject, run, WRAPPED, FROZEN, recordRequest, ev } = require('./fixtures/gf/flow');
const bundle = require('../lib/greenfield/bundle');
const wrap = require('../lib/greenfield/wrap');
const audit = require('../lib/greenfield/audit');
const mcp = require('../lib/mcp');
const { project } = require('../lib/greenfield/projection');
const { DEFAULT_CONFIG } = require('../lib/config');

const ROOT = path.join(__dirname, '..');
const GUARD = path.join(ROOT, 'scripts/hooks/guard.js');
const gfOf = (ctx) => project(ctx.store.readEvents());
const call = (name, args, ctx, actor) => mcp.tools().find((t) => t.name === name).handler(args, { store: ctx.store, config: ctx.config, actor });
const rulesOf = (err) => ((err.details && err.details.problems) || []).map((p) => p.rule);
function refusal(fn) { try { fn(); } catch (e) { return e; } throw new Error('expected a refusal, but the call succeeded'); }
const sealed = () => { const ctx = gfProject(); run(ctx, sample.build(), WRAPPED); return ctx; };

// ------------------------------------------------------------------------ B4
test('B4: artifact entries are path strings; an {rel, abs} object is refused with GF-ART-2 and no file content or size leaks', () => {
  const ctx = gfProject();
  const probe = [{ rel: '.eccode/artifacts/prd.json', abs: '/etc/passwd' }];
  const r = bundle.validateGate(ctx.dir, 'architecture', probe, ctx.store.state(), ctx.config);
  assert.ok(r.problems.some((p) => p.rule === 'GF-ART-2' && /path string/.test(p.message)), JSON.stringify(r.problems));
  const text = JSON.stringify(r);
  assert.ok(!/root:|bytes|too large/.test(text), `nothing about the probed file may appear: ${text}`);

  const viaTool = call('gf_validate', { gate: 'architecture', artifacts: probe }, ctx, 'product-architect');
  assert.strictEqual(viaTool.ok, false);
  assert.ok(!/root:|bytes|too large/.test(JSON.stringify(viaTool)));
  const submit = refusal(() => call('gate_submit', { gate: 'architecture', artifacts: probe }, ctx, 'product-architect'));
  assert.ok(rulesOf(submit).includes('GF-ART-2'), submit.message);
  for (const bad of [[1], [null], [['a']], 'prd.json']) {
    const x = bundle.validateGate(ctx.dir, 'architecture', bad, ctx.store.state(), ctx.config);
    assert.ok(x.problems.some((p) => p.rule === 'GF-ART-2'), `${JSON.stringify(bad)} must be refused`);
  }
});

// ------------------------------------------------------------------------ M1
function guard(dir, agent, command) {
  const res = spawnSync(process.execPath, [GUARD], {
    input: JSON.stringify({ cwd: dir, tool_name: 'Bash', ...(agent ? { agent_type: `eccode:${agent}` } : {}), tool_input: { command } }),
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_PROJECT_DIR: dir, ECCODE_ACTOR: '' },
  });
  return res.stdout ? JSON.parse(res.stdout).hookSpecificOutput.permissionDecision : 'allow';
}

test('M1: the hook treats eccode-gf exactly as it treats the eccode CLI (identity, the main session, the user)', () => {
  const ctx = gfProject();
  const forms = (rest) => [`eccode ${rest}`, `eccode-gf ${rest}`, `node bin/eccode.js ${rest}`, `node bin/eccode-gf.js ${rest}`, `node .claude/eccode/bin/eccode-gf.js ${rest}`];
  const cases = [
    ['frontend-engineer', 'gate review plan --actor technical-reviewer --file r.json', 'deny'],
    ['technical-reviewer', 'gate review plan --actor technical-reviewer --file r.json', 'allow'],
    [null, 'gate review plan --actor technical-reviewer --file r.json', 'deny'],
    [null, 'amend apply --actor user --request r --reason x', 'ask'],
    ['backend-engineer', 'task claim t --actor $WHO', 'deny'],
    ['backend-engineer', 'task claim t --actor backend-engineer', 'allow'],
  ];
  for (const [agent, rest, expected] of cases) {
    const base = guard(ctx.dir, agent, `eccode ${rest}`);
    assert.strictEqual(base, expected, `the baseline eccode decision for "${rest}" as ${agent || 'main'}`);
    for (const cmd of forms(rest)) assert.strictEqual(guard(ctx.dir, agent, cmd), expected, `${cmd} as ${agent || 'main session'}`);
  }
});

// ------------------------------------------------------------------------ M2
test('M2: a question recorded and assumed after the PRD was approved does not make the audit fail forever', () => {
  const ctx = sealed();
  design.ambiguity(ctx.store, ctx.config, 'orchestrator', [{ id: 'Q-LATE', text: 'Should tasks be exportable?', blocking: false }]);
  design.assume(ctx.store, ctx.config, 'orchestrator', { question: 'Q-LATE', reading: 'not in version one', rationale: 'recorded after the PRD was approved' });
  assert.deepStrictEqual(audit.run(ctx.store, ctx.config).errors, []);
});

test('M2: a question recorded between the architecture and the plan approvals does not block sealing', () => {
  const ctx = gfProject();
  const art = sample.build();
  const written = run(ctx, art, WRAPPED, { upTo: 'architecture' });
  design.ambiguity(ctx.store, ctx.config, 'orchestrator', [{ id: 'Q-MID', text: 'Should there be an audit log?', blocking: false }]);
  design.assume(ctx.store, ctx.config, 'orchestrator', { question: 'Q-MID', reading: 'not in version one', rationale: 'recorded between two approvals' });
  run(ctx, art, WRAPPED, { from: 'design', written });
  assert.ok(gfOf(ctx).seal, 'sealed');
  assert.deepStrictEqual(audit.run(ctx.store, ctx.config).errors, []);
});

test('M2: a question that was open when the PRD was approved is still reported (history is not a loophole)', () => {
  const ctx = gfProject();
  const art = sample.build();
  recordRequest(ctx, art);
  const written = sample.write(ctx.dir, art);
  // the frozen path approves a PRD whose scan misses a question recorded BEFORE the approval
  design.ambiguity(ctx.store, ctx.config, 'orchestrator', [{ id: 'Q-BEFORE', text: 'Is there a rate limit?', blocking: false }]);
  design.assume(ctx.store, ctx.config, 'orchestrator', { question: 'Q-BEFORE', reading: 'no rate limit at all', rationale: 'recorded before the approval' });
  gates.startGate(ctx.store, ctx.config, 'architecture', 'orchestrator');
  gates.submit(ctx.store, ctx.config, 'architecture', 'product-architect', { artifacts: written.architecture });
  gates.recordReview(ctx.store, ctx.config, 'architecture', 'architecture-reviewer', ev('.eccode/artifacts/prd.json'));
  const errs = audit.run(ctx.store, ctx.config).errors;
  assert.ok(errs.some((e) => e.rule === 'GF-PRD-3' && /Q-BEFORE/.test(e.message)), JSON.stringify(errs.map((e) => e.message)));
});

// ------------------------------------------------------------------------ M4
function failSealOnce(ctx) {
  const real = bundle.validateApproved;
  let calls = 0;
  bundle.validateApproved = (...a) => { calls += 1; return calls === 2 ? { problems: [{ rule: 'GF-ART-DRIFT', path: 'x', message: 'a contract was touched while G1 was being sealed' }] } : real(...a); };
  try { return refusal(() => run(ctx, sample.build(), WRAPPED)); } finally { bundle.validateApproved = real; }
}

test('M4: when the seal fails after the plan approval, sealing is retryable (wrap.seal, the gf_seal tool, eccode-gf seal)', () => {
  const ctx = gfProject();
  const err = failSealOnce(ctx);
  assert.strictEqual(err.code, 'GF_RULE');
  assert.strictEqual(ctx.store.state().gates.plan.status, 'approved', 'the approval was recorded');
  assert.strictEqual(gfOf(ctx).seal, null, 'the seal was not');
  const claim = refusal(() => wrap.taskClaim(ctx.store, ctx.config, 's0-contracts', 'integration-engineer'));
  assert.ok(rulesOf(claim).includes('GF-SEAL-1') && /eccode-gf seal|gf_seal/.test(claim.message), claim.message);
  const r = call('gf_seal', {}, ctx, 'orchestrator');
  assert.strictEqual(r.sealed, true);
  assert.ok(gfOf(ctx).seal && gfOf(ctx).estimate.original);
  assert.ok(rulesOf(refusal(() => call('gf_seal', {}, ctx, 'orchestrator'))).includes('GF-SEAL-1'), 'a second seal is refused');
  assert.deepStrictEqual(audit.run(ctx.store, ctx.config).errors, []);
  wrap.gateStart(ctx.store, ctx.config, 'phase:skeleton', 'orchestrator');
  wrap.taskClaim(ctx.store, ctx.config, 's0-contracts', 'integration-engineer');
});

test('M4: eccode-gf seal retries the seal from the command line, and refuses when the plan gate is not approved', () => {
  const early = gfProject();
  const r0 = spawnSync(process.execPath, [path.join(ROOT, 'bin/eccode-gf.js'), 'seal', '--actor', 'orchestrator'], { cwd: early.dir, encoding: 'utf8' });
  assert.strictEqual(r0.status, 2);
  assert.match(r0.stderr, /GF-SEAL-1/);
  const ctx = gfProject();
  failSealOnce(ctx);
  const r = spawnSync(process.execPath, [path.join(ROOT, 'bin/eccode-gf.js'), 'seal', '--actor', 'orchestrator', '--json'], { cwd: ctx.dir, encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.ok(gfOf(ctx).seal);
});

test('M4: seal refuses when a contract changes while it is being sealed (the snapshot does not match)', () => {
  const ctx = gfProject();
  run(ctx, sample.build(), FROZEN);
  const snapshots = require('../lib/greenfield/snapshots');
  const real = snapshots.write;
  snapshots.write = () => null;
  let err;
  try { err = refusal(() => wrap.seal(ctx.store, ctx.config)); } finally { snapshots.write = real; }
  assert.ok(rulesOf(err).includes('GF-SEAL-1') && /while G1 was being sealed/.test(err.message), err.message);
  assert.strictEqual(gfOf(ctx).seal, null);
  wrap.seal(ctx.store, ctx.config);
  assert.ok(gfOf(ctx).seal);
});

// ------------------------------------------------------------------------ M5
test('M5: after a detected validate-versus-submit race, a clean resubmission is approved and the audit is clean', () => {
  const ctx = gfProject();
  const art = sample.build();
  recordRequest(ctx, art);
  const written = sample.write(ctx.dir, art);
  gates.startGate(ctx.store, ctx.config, 'architecture', 'orchestrator');
  const real = gates.submit;
  gates.submit = function patched(...args) { fs.appendFileSync(path.join(ctx.dir, '.eccode/artifacts/prd.json'), ' '); return real.apply(this, args); };
  try { assert.ok(rulesOf(refusal(() => wrap.gateSubmit(ctx.store, ctx.config, 'architecture', 'product-architect', { artifacts: written.architecture }))).includes('GF-ART-1')); } finally { gates.submit = real; }
  assert.strictEqual(ctx.store.state().gates.architecture.submissions.length, 1, 'the frozen submit did commit the orphan');
  // the frozen engine takes a new submission only once the pending one is stale (or rejected): the author re-saves the file
  fs.appendFileSync(path.join(ctx.dir, '.eccode/artifacts/prd.json'), '\n');
  wrap.gateSubmit(ctx.store, ctx.config, 'architecture', 'product-architect', { artifacts: written.architecture });
  wrap.gateReview(ctx.store, ctx.config, 'architecture', 'architecture-reviewer', ev('.eccode/artifacts/prd.json'));
  run(ctx, art, WRAPPED, { from: 'design', written });
  const errs = audit.run(ctx.store, ctx.config).errors;
  assert.deepStrictEqual(errs, [], 'the orphan was never approved, so it needs no registration');
});

// ------------------------------------------------------------------------ M6
test('M6: the design gate starts only with both reviewers named (technical and security); the audit finds a frozen start without them', () => {
  const ctx = gfProject();
  const art = sample.build();
  run(ctx, art, WRAPPED, { upTo: 'architecture' });
  for (const reviewers of [undefined, ['technical-reviewer'], ['security-reviewer']]) {
    const err = refusal(() => wrap.gateStart(ctx.store, ctx.config, 'design', 'orchestrator', reviewers ? { reviewers } : undefined));
    assert.ok(rulesOf(err).includes('GF-THR-1'), `reviewers ${JSON.stringify(reviewers)}: ${err.message}`);
    assert.strictEqual(ctx.store.state().gates.design.status, 'pending');
  }
  wrap.gateStart(ctx.store, ctx.config, 'design', 'orchestrator', { reviewers: ['technical-reviewer', 'security-reviewer'] });

  // bypass: the frozen API starts the gate with one reviewer and the gate is approved by that reviewer alone
  const bypass = gfProject();
  const w = run(bypass, sample.build(), FROZEN, { upTo: 'architecture' });
  gates.startGate(bypass.store, bypass.config, 'design', 'orchestrator');
  gates.submit(bypass.store, bypass.config, 'design', 'technical-designer', { artifacts: w.design });
  gates.recordReview(bypass.store, bypass.config, 'design', 'technical-reviewer', ev('contracts/openapi.json'));
  assert.strictEqual(bypass.store.state().gates.design.status, 'approved');
  assert.ok(audit.run(bypass.store, bypass.config).errors.some((e) => e.rule === 'GF-THR-1' && /security-reviewer/.test(e.message)));
});

// ------------------------------------------------------------------------ M8
function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const JUNK = [null, 1, -1, 0, 1e9, 'x', '', 'a'.repeat(300), true, false, [], {}, [1], [null], [[]], { a: 1 }, { constructor: 1 }, '__proto__', 'constructor', 'toString'];

function paths(obj, prefix = [], out = [], depth = 0) {
  if (depth > 4 || obj === null || typeof obj !== 'object') return out;
  for (const k of Object.keys(obj)) { out.push([...prefix, k]); paths(obj[k], [...prefix, k], out, depth + 1); }
  return out;
}

test('M8: 400 randomly corrupted bundles never crash the validators; every outcome is a list of rule problems', () => {
  const rand = rng(20261104);
  const pick = (xs) => xs[Math.floor(rand() * xs.length)];
  const keys = ['prd', 'architecture', 'openapi', 'dbSchema', 'migrationsPlan', 'accessMatrix', 'fixtures', 'threat', 'breakdown', 'estimates', 'plan'];
  const GATES = ['architecture', 'design', 'plan'];
  for (let i = 0; i < 400; i++) {
    const art = sample.build();
    const edits = [];
    for (let n = 0; n < 1 + Math.floor(rand() * 3); n++) {
      const key = pick(keys);
      const ps = paths(art[key]);
      if (!ps.length) { art[key] = pick(JUNK); edits.push(`${key}=junk`); continue; }
      const p = pick(ps);
      let node = art[key];
      for (const k of p.slice(0, -1)) node = node[k];
      if (rand() < 0.2) { delete node[p[p.length - 1]]; edits.push(`delete ${key}.${p.join('.')}`); } else { node[p[p.length - 1]] = pick(JUNK); edits.push(`${key}.${p.join('.')}=junk`); }
    }
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eccode-gf-fuzz-'));
    try {
      const written = sample.write(dir, art);
      for (const g of GATES) {
        let r;
        try { r = bundle.validateGate(dir, g, written[g], sample.approvedBase(dir, art, written, g), DEFAULT_CONFIG); } catch (e) { assert.fail(`iteration ${i}, gate ${g}, edits ${edits.join('; ')}: ${e.stack.split('\n').slice(0, 3).join(' | ')}`); }
        assert.ok(Array.isArray(r.problems) && r.problems.every((p) => typeof p.rule === 'string' && typeof p.message === 'string'), `iteration ${i}: ${JSON.stringify(r.problems).slice(0, 200)}`);
      }
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }
});

test('M8: a frozen-approved breakdown with non-string globs is a rule problem in the audit and at the wrapped submit, not a crash', () => {
  const art = sample.build();
  art.breakdown.groups[0].globs = [1];
  art.breakdown.groups[1].name = 'constructor';
  const ctx = gfProject();
  run(ctx, art, FROZEN);
  let r;
  assert.doesNotThrow(() => { r = audit.run(ctx.store, ctx.config); });
  assert.ok(r.errors.some((e) => e.rule === 'GF-WBS-1'), JSON.stringify(r.errors.map((e) => e.rule)));
  const wrapped = gfProject();
  const err = refusal(() => run(wrapped, art, WRAPPED));
  assert.strictEqual(err.code, 'GF_RULE', `${err.code}: ${err.message}`);
});

// ------------------------------------------------------------------------ m1
test('m1: a symlinked parent directory and a directory named like an artifact are GF-ART-2 problems, not escapes or raw errors', () => {
  const art = sample.build();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eccode-gf-m1-'));
  const written = sample.write(dir, art);
  const base = sample.approvedBase(dir, art, written, 'design');
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'eccode-gf-outside-'));
  for (const f of fs.readdirSync(path.join(dir, 'contracts'))) fs.copyFileSync(path.join(dir, 'contracts', f), path.join(outside, f));
  fs.rmSync(path.join(dir, 'contracts'), { recursive: true });
  fs.symlinkSync(outside, path.join(dir, 'contracts'));
  const r = bundle.validateGate(dir, 'design', written.design, base, DEFAULT_CONFIG);
  assert.ok(r.problems.some((p) => p.rule === 'GF-ART-2' && /outside|symlink/.test(p.message)), JSON.stringify(r.problems.slice(0, 3)));

  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'eccode-gf-m1b-'));
  const w2 = sample.write(dir2, art);
  fs.rmSync(path.join(dir2, '.eccode/artifacts/prd.json'));
  fs.mkdirSync(path.join(dir2, '.eccode/artifacts/prd.json'));
  let r2;
  assert.doesNotThrow(() => { r2 = bundle.validateGate(dir2, 'architecture', w2.architecture, sample.approvedBase(dir2, art, w2, 'architecture'), DEFAULT_CONFIG); });
  assert.ok(r2.problems.some((p) => p.rule === 'GF-ART-2'), JSON.stringify(r2.problems.slice(0, 3)));
});
