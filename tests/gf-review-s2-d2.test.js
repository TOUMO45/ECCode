'use strict';
// Regression tests for the round-3 critique of S2 (security-reviewer, tree 9fd568e), each named by its finding id
// (node --test --test-name-pattern "^D2-1" tests/gf-review-s2-d2.test.js). Each failed before its fix.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const audit = require('../lib/greenfield/audit');
const closure = require('../lib/greenfield/closure');
const X = require('./fixtures/gf/close');
const { closeProject, battery, dispatch, review, closeIt, put, commitAll, git, F, LONG, ORCH } = X;

const GUARD = path.join(__dirname, '..', 'scripts/hooks/guard.js');
const rulesOf = (err) => ((err.details && err.details.problems) || []).map((p) => p.rule);
function refuses(fn, rule, re) {
  let err;
  try { fn(); } catch (e) { err = e; }
  assert.ok(err, 'expected a refusal, but the call succeeded');
  assert.ok(rulesOf(err).includes(rule), `${rule} not in ${rulesOf(err).join(', ')}: ${err.message}`);
  assert.match(err.message, re);
}
function hook(ctx, role, tool, input) {
  const res = spawnSync(process.execPath, [GUARD], { input: JSON.stringify({ cwd: ctx.dir, tool_name: tool, ...(role ? { agent_type: `eccode:${role}` } : {}), tool_input: input }), encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: ctx.dir, ECCODE_ACTOR: '' } });
  if (!res.stdout) return { decision: 'allow', reason: '' };
  const o = JSON.parse(res.stdout).hookSpecificOutput;
  return { decision: o.permissionDecision, reason: o.permissionDecisionReason || '' };
}
function team() {
  const ctx = closeProject();
  require('../lib/greenfield/wrap').gateStart(ctx.store, ctx.config, 'phase:skeleton', 'orchestrator');
  F(ctx, 'task.claimed', 'backend-engineer', { task: 's0-app' });
  F(ctx, 'task.claimed', 'frontend-engineer', { task: 's0-web' });
  return ctx;
}

// ------------------------------------------------------------------ D2-1: a path that leads into the project through another route
const VIA = [
  ['frontend-engineer', 'app/main.py', /belongs to backend/],
  ['frontend-engineer', 'contracts/openapi.json', /GF-FRZ-1/],
  ['backend-engineer', '.eccode/security.json', /GF-CONF-1/],
  ['backend-engineer', '.eccode/events.jsonl', /ECCode record/],
];
for (const [role, rel, re] of VIA) {
  test(`D2-1: ${role} writing ${rel} through /proc/self/root is judged as the project path it is`, () => {
    const ctx = team();
    const r = hook(ctx, role, 'Write', { file_path: `/proc/self/root${fs.realpathSync(ctx.dir)}/${rel}` });
    assert.strictEqual(r.decision, 'deny', r.reason);
    assert.match(r.reason, re);
  });
}
test('D2-1: an absolute path elsewhere on the machine is still outside the project (no opinion)', () => {
  const ctx = team();
  const elsewhere = fs.mkdtempSync(path.join(require('os').tmpdir(), 'eccode-d2-'));
  assert.strictEqual(hook(ctx, 'frontend-engineer', 'Write', { file_path: path.join(elsewhere, 'x.js') }).decision, 'allow');
});

// ------------------------------------------------------------------ D2-2: the clean-tree check ignores the repository's git config
test('D2-2: status.showUntrackedFiles=no in the repository does not hide an untracked file from the clean-tree check', () => {
  const ctx = closeProject();
  git(ctx.dir, 'config', 'status.showUntrackedFiles', 'no');
  put(ctx, 'docs/extra.py', 'x = 1\n');
  refuses(() => dispatch(ctx, 'critique'), 'GF-CLOSE-5', /the tree is not clean \(docs\/extra\.py/);
});

// ------------------------------------------------------------------ D2-3: a no-go on the closing tree stands
test('D2-3: a readiness no-go on the closing tree is not overridden by a later go on the same tree', () => {
  const ctx = closeProject();
  battery(ctx);
  for (const [step, role] of [['comprehension', 'technical-reviewer'], ['critique', 'security-reviewer']]) {
    const d = dispatch(ctx, step, role);
    review(ctx, role, { scope: 'S2', step, dispatch: d.id, summary: LONG, findings: [] });
  }
  const d1 = dispatch(ctx, 'readiness', 'architecture-reviewer');
  review(ctx, 'architecture-reviewer', { scope: 'S2', step: 'readiness', dispatch: d1.id, summary: LONG, verdict: 'no-go', evidence: ['docs/design.md:1'] });
  const d2 = dispatch(ctx, 'readiness', 'architecture-reviewer');
  review(ctx, 'architecture-reviewer', { scope: 'S2', step: 'readiness', dispatch: d2.id, summary: LONG, verdict: 'go', evidence: ['docs/design.md:1'] });
  battery(ctx);
  refuses(() => closeIt(ctx), 'GF-CLOSE-1', /a readiness no-go was recorded on the closing tree/);
});

// ------------------------------------------------------------------ D2-4: dispatch inputs are judged where they land
test('D2-4: a dispatch input that reaches the working record through a committed symlink is refused', () => {
  const ctx = closeProject();
  fs.mkdirSync(path.join(ctx.dir, '.eccode/handoffs'), { recursive: true });
  fs.writeFileSync(path.join(ctx.dir, '.eccode/handoffs/ho-1.json'), '{}');
  fs.symlinkSync('../.eccode/handoffs', path.join(ctx.dir, 'docs/h'));
  commitAll(ctx, 'a link into the record');
  refuses(() => closure.recordDispatch(ctx.store, ctx.config, ORCH, { scope: 'S2', role: 'technical-reviewer', step: 'critique', inputs: ['docs/h/ho-1.json'] }), 'GF-CLOSE-5', /resolves to \.eccode\/handoffs\/ho-1\.json/);
});

// ------------------------------------------------------------------ D2-5: one malformed event does not stop the rest of the audit
test('D2-5: a forged rescope with a non-list of files does not stop the audit from reporting the other sections', () => {
  const ctx = closeProject();
  F(ctx, 'task.rescoped', 'user', { task: 's0-app', files: 5, command: null, reason: 'forged with a number for the files', from: [] });
  F(ctx, 'gf.config.pinned', 'backend-engineer', { id: 'pin-x', scope: 'S2', files: { '.eccode/security.json': 'a'.repeat(64) }, reason: 'forged by a group role' });
  F(ctx, 'gf.dispatch.recorded', 'backend-engineer', { id: 'disp-x', scope: 'S2', role: 'technical-reviewer', step: 'critique', treeHash: X.tree(ctx), inputs: [{ path: 'docs/design.md', sha256: 'a'.repeat(64) }] });
  const errs = audit.run(ctx.store, ctx.config).errors;
  assert.ok(errs.some((e) => e.rule === 'GF-CONF-1'), JSON.stringify(errs.map((e) => e.rule)));
  assert.ok(errs.some((e) => e.rule === 'GF-CLOSE-5'), JSON.stringify(errs.map((e) => e.rule)));
});
