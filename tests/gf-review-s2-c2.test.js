'use strict';
// Regression tests for the closing-round critique of S2 (review rev of 2026-11-07 on tree f7b3db2, security-reviewer),
// each named by its finding id so that one finding's tests run alone
// (node --test --test-name-pattern "^C2-1" tests/gf-review-s2-c2.test.js). Each failed before its fix.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const audit = require('../lib/greenfield/audit');
const closure = require('../lib/greenfield/closure');
const X = require('./fixtures/gf/close');
const { closeProject, battery, dispatch, review, resolve, closeIt, threeSteps, forgeProof, put, commitAll, tree, git, F, LONG, ORCH } = X;

const GUARD = path.join(__dirname, '..', 'scripts/hooks/guard.js');
const rulesOf = (err) => ((err.details && err.details.problems) || []).map((p) => p.rule);
function refuses(fn, rule, re) {
  let err;
  try { fn(); } catch (e) { err = e; }
  assert.ok(err, 'expected a refusal, but the call succeeded');
  assert.ok(rulesOf(err).includes(rule), `${rule} not in ${rulesOf(err).join(', ')}: ${err.message}`);
  assert.match(err.message, re);
}
const closeErrs = (ctx) => audit.run(ctx.store, ctx.config).errors.filter((e) => /^GF-CLOSE/.test(e.rule));
const critiqueWith = (ctx, id = 'F-1') => { const d = dispatch(ctx, 'critique', 'security-reviewer'); review(ctx, 'security-reviewer', { scope: 'S2', step: 'critique', dispatch: d.id, summary: LONG, findings: [{ id, severity: 'blocking', kind: 'defect', summary: 'a real defect in the closing tree' }] }); };

// ------------------------------------------------------------------ C2-1: a fix is of the reviewed tree, and changes it
test('C2-1: a fix-verify proof whose pre-fix run was not on the tree the finding was raised on is refused', () => {
  const ctx = closeProject();
  const older = git(ctx.dir, 'rev-parse', 'HEAD');
  put(ctx, 'app/x.js', '//\n'); commitAll(ctx, 'the reviewed tree');
  battery(ctx);
  critiqueWith(ctx);
  const proof = forgeProof(ctx, 1, { base: older });
  refuses(() => resolve(ctx, ORCH, { finding: 'F-1', resolution: 'fixed', proof }), 'GF-CLOSE-2', /the pre-fix run of ev:ev-post-1 ran at .*, whose tree is not the tree finding F-1 was raised on/);
});
test('C2-1: a finding marked fixed on the very tree it was raised on cannot close: a fix changes the tree and needs a new round', () => {
  const ctx = closeProject();
  battery(ctx);
  critiqueWith(ctx);
  const proof = forgeProof(ctx, 2);
  resolve(ctx, ORCH, { finding: 'F-1', resolution: 'fixed', proof });
  const k = dispatch(ctx, 'comprehension', 'technical-reviewer'); const r = dispatch(ctx, 'readiness', 'architecture-reviewer');
  review(ctx, 'technical-reviewer', { scope: 'S2', step: 'comprehension', dispatch: k.id, summary: LONG, findings: [] });
  review(ctx, 'architecture-reviewer', { scope: 'S2', step: 'readiness', dispatch: r.id, summary: LONG, verdict: 'go', evidence: ['docs/design.md:1'] });
  battery(ctx);
  refuses(() => closeIt(ctx), 'GF-CLOSE-2', /finding F-1 was fixed, but the closing tree is the tree it was raised on/);
});
test('C2-1: the same case forged as a closure is reported by the audit', () => {
  const ctx = closeProject();
  battery(ctx);
  critiqueWith(ctx);
  const proof = forgeProof(ctx, 3);
  resolve(ctx, ORCH, { finding: 'F-1', resolution: 'fixed', proof });
  threeSteps(ctx);
  battery(ctx);
  F(ctx, 'gf.slice.closed', ORCH, { scope: 'S2', treeHash: tree(ctx), steps: { comprehension: 'a', critique: 'b', readiness: 'c' }, batteries: [], accepted: [], accounting: { unit: 'all-processed-tokens', start: 1, end: 2 } });
  assert.ok(closeErrs(ctx).some((e) => e.rule === 'GF-CLOSE-2' && /finding F-1 was fixed, but the closing tree is the tree it was raised on/.test(e.message)));
});

// ------------------------------------------------------------------ C2-2: the clean-tree check sees hidden index flags
for (const flag of ['--skip-worktree', '--assume-unchanged']) {
  test(`C2-2: a tracked file marked ${flag} and changed on disk makes the tree dirty for a dispatch, a review and a battery`, () => {
    const ctx = closeProject();
    git(ctx.dir, 'update-index', flag, 'docs/plan.md');
    fs.appendFileSync(path.join(ctx.dir, 'docs/plan.md'), 'changed on disk only\n');
    refuses(() => dispatch(ctx, 'critique'), 'GF-CLOSE-5', /marked (skip-worktree|assume-unchanged)/);
    refuses(() => battery(ctx), 'GF-CLOSE-3', /marked (skip-worktree|assume-unchanged)/);
  });
}

// ------------------------------------------------------------------ C2-3: the audit never throws on the settings it reads
const BAD = [
  ['invalid JSON in .claude/settings.json', (d) => { fs.mkdirSync(path.join(d, '.claude'), { recursive: true }); fs.writeFileSync(path.join(d, '.claude/settings.json'), '{nope'); }],
  ['a JSON null as .claude/settings.json', (d) => { fs.mkdirSync(path.join(d, '.claude'), { recursive: true }); fs.writeFileSync(path.join(d, '.claude/settings.json'), 'null'); }],
  ['a PreToolUse that is not an array', (d) => { fs.mkdirSync(path.join(d, '.claude'), { recursive: true }); fs.writeFileSync(path.join(d, '.claude/settings.json'), '{"hooks":{"PreToolUse":{"matcher":"x"}}}'); }],
  ['invalid JSON in .mcp.json', (d) => fs.writeFileSync(path.join(d, '.mcp.json'), '{nope')],
  ['server args that are not an array', (d) => fs.writeFileSync(path.join(d, '.mcp.json'), '{"mcpServers":{"eccode_backend-engineer":{"args":"--actor backend-engineer"}}}')],
  ['an mcpServers that is null', (d) => fs.writeFileSync(path.join(d, '.mcp.json'), '{"mcpServers":null}')],
];
for (const [name, make] of BAD) {
  test(`C2-3: ${name} does not make the audit throw; the managed-path section says it could not read the settings`, () => {
    const ctx = closeProject();
    make(ctx.dir);
    let r;
    assert.doesNotThrow(() => { r = audit.run(ctx.store, ctx.config); });
    assert.ok(r.managedPath, 'the section is present');
    assert.strictEqual(r.managedPath.regime, 'text-level');
    assert.ok(r.warnings.some((w) => /L-GF-17/.test(w)), JSON.stringify(r.warnings));
  });
}

// ------------------------------------------------------------------ C2-4: a symlink in the drafts namespace does not lead out of it
function hook(ctx, role, tool, input) {
  const res = spawnSync(process.execPath, [GUARD], { input: JSON.stringify({ cwd: ctx.dir, tool_name: tool, agent_type: `eccode:${role}`, tool_input: input }), encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: ctx.dir, ECCODE_ACTOR: '' } });
  if (!res.stdout) return { decision: 'allow', reason: '' };
  const o = JSON.parse(res.stdout).hookSpecificOutput;
  return { decision: o.permissionDecision, reason: o.permissionDecisionReason || '' };
}
function sealedTeam() {
  const ctx = closeProject();
  require('../lib/greenfield/wrap').gateStart(ctx.store, ctx.config, 'phase:skeleton', 'orchestrator');
  F(ctx, 'task.claimed', 'backend-engineer', { task: 's0-app' });
  return ctx;
}
test('C2-4: a symlinked directory inside the group\'s drafts that points into another group\'s files is judged where it points', () => {
  const ctx = sealedTeam();
  fs.mkdirSync(path.join(ctx.dir, 'web'), { recursive: true });
  fs.mkdirSync(path.join(ctx.dir, '.eccode/drafts/backend'), { recursive: true });
  fs.symlinkSync(path.join(ctx.dir, 'web'), path.join(ctx.dir, '.eccode/drafts/backend/w'), 'dir');
  const r = hook(ctx, 'backend-engineer', 'Write', { file_path: path.join(ctx.dir, '.eccode/drafts/backend/w/evil.js') });
  assert.strictEqual(r.decision, 'deny');
  assert.match(r.reason, /web\/evil\.js belongs to frontend|resolves/);
});
test('C2-4: a symlink inside the group\'s drafts that points at the event log is denied', () => {
  const ctx = sealedTeam();
  fs.mkdirSync(path.join(ctx.dir, '.eccode/drafts/backend'), { recursive: true });
  fs.symlinkSync(path.join(ctx.dir, '.eccode/events.jsonl'), path.join(ctx.dir, '.eccode/drafts/backend/log'));
  const r = hook(ctx, 'backend-engineer', 'Write', { file_path: path.join(ctx.dir, '.eccode/drafts/backend/log') });
  assert.strictEqual(r.decision, 'deny');
  assert.match(r.reason, /resolves .*\.eccode\/events\.jsonl/);
});
test('C2-4: a plain draft in the group\'s own namespace is still allowed', () => {
  const ctx = sealedTeam();
  assert.strictEqual(hook(ctx, 'backend-engineer', 'Write', { file_path: path.join(ctx.dir, '.eccode/drafts/backend/notes.md') }).decision, 'allow');
});

// ------------------------------------------------------------------ C2-5: the shell writes the hook did not model
const SHELL = [
  ['ln -sf', 'ln -sf /tmp/x app/main.py'],
  ['install', 'install /tmp/x app/main.py'],
  ['dd of=', 'dd if=/tmp/x of=app/main.py'],
  ['perl -pi', "perl -pi -e 's/a/b/' app/main.py"],
  ['perl -i -pe', "perl -i -pe 's/a/b/' app/main.py"],
  ['touch', 'touch app/main.py'],
  ['git checkout --', 'git checkout -- app/main.py'],
  ['git restore', 'git restore app/main.py'],
  ['patch', 'patch app/main.py /tmp/d.diff'],
];
for (const [name, command] of SHELL) {
  test(`C2-5: ${name} into another group's path is denied for a group role`, () => {
    const ctx = sealedTeam();
    const r = hook(ctx, 'frontend-engineer', 'Bash', { command });
    assert.strictEqual(r.decision, 'deny', `${command}: ${r.reason}`);
    assert.match(r.reason, /app\/main\.py/);
  });
}
test('C2-5: the same commands on the role\'s own claimed path are allowed', () => {
  const ctx = sealedTeam();
  for (const [, command] of SHELL.filter(([n]) => !/^git/.test(n))) assert.strictEqual(hook(ctx, 'backend-engineer', 'Bash', { command }).decision, 'allow', command);
});
void closure;
