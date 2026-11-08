'use strict';
// GF-CLOSE-6 (S2.1, the owner's decision of 2026-11-08; design 18.5): the owner-acceptance event gf.slice.accepted.
// Narrow: it records every open finding of a scope as a numbered limit; it refuses any blocking finding; only the user
// records it, through the owner CLI (no MCP tool, and the hook asks the human); it carries the unbound-identity caveat
// (L-GF-17). A scope it covers is "accepted, not closed". Positive, negative and bypass rows.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const X = require('./fixtures/gf/close');
const closure = require('../lib/greenfield/closure');
const audit = require('../lib/greenfield/audit');
const { gfTools } = require('../lib/greenfield');
const { closeProject, battery, dispatch, review, resolve, F, LONG, put } = X;

const ROOT = path.join(__dirname, '..');
const GUARD = path.join(ROOT, 'scripts/hooks/guard.js');
const CLI = path.join(ROOT, 'bin/eccode-gf.js');
const rulesOf = (err) => ((err && err.details && err.details.problems) || []).map((p) => p.rule);
const REASON = 'accepted by the owner as a numbered limit, recorded in the limits file';
const FINDINGS = [
  { id: 'H1-1', severity: 'major', kind: 'documentation', summary: 'a major documentation finding left open' },
  { id: 'H2-1', severity: 'major', kind: 'defect', summary: 'a major defect left open, outside the threat model' },
  { id: 'H2-2', severity: 'minor', kind: 'defect', summary: 'a minor defect left open' },
];
/** A project with one comprehension and one critique review carrying `findings`, on a clean tree. */
function withFindings(findings = FINDINGS) {
  const ctx = closeProject();
  battery(ctx);
  const doc = findings.filter((f) => f.kind === 'documentation');
  const def = findings.filter((f) => f.kind === 'defect');
  if (doc.length) { const d = dispatch(ctx, 'comprehension', 'technical-reviewer'); review(ctx, 'technical-reviewer', { scope: 'S2', step: 'comprehension', dispatch: d.id, summary: LONG, findings: doc }); }
  if (def.length) { const d = dispatch(ctx, 'critique', 'security-reviewer'); review(ctx, 'security-reviewer', { scope: 'S2', step: 'critique', dispatch: d.id, summary: LONG, findings: def }); }
  return ctx;
}
const entries = (list) => list.map((f, i) => ({ finding: f.id, severity: f.severity, limit: `L-GF-${60 + i}`, reason: REASON }));
const accept = (ctx, actor, accepted = entries(FINDINGS), scope = 'S2') => closure.accept(ctx.store, ctx.config, actor, { scope, accepted }).event.data;
function refused(fn, re) {
  let err;
  try { fn(); } catch (e) { err = e; }
  assert.ok(rulesOf(err).includes('GF-CLOSE-6'), err ? err.message : 'not refused');
  if (re) assert.match(err.message, re);
}
const gf6 = (ctx) => audit.run(ctx.store, ctx.config).errors.filter((e) => e.rule === 'GF-CLOSE-6');

test('GF-CLOSE-6 positive: the user accepts every open finding as a numbered limit; the scope is accepted, not closed', () => {
  const ctx = withFindings();
  const a = accept(ctx, 'user');
  assert.deepStrictEqual(a.accepted.map((x) => x.finding), ['H1-1', 'H2-1', 'H2-2']);
  assert.match(a.caveat, /L-GF-17/);
  assert.match(a.treeHash, /^[0-9a-f]{40,64}$/);
  assert.deepStrictEqual(gf6(ctx), []);
  const r = audit.run(ctx.store, ctx.config);
  assert.ok(r.accepted.some((x) => x.scope === 'S2' && x.closed === false), JSON.stringify(r.accepted));
  const p = closure.preview(ctx.store, ctx.config, 'S2');
  assert.strictEqual(p.ok, false, 'an acceptance is not a closure');
  assert.strictEqual(p.accepted.scope, 'S2');
});
test('GF-CLOSE-6 positive: a finding already resolved is not open, so the acceptance does not list it', () => {
  const ctx = withFindings();
  resolve(ctx, 'user', { finding: 'H2-2', resolution: 'deferred', limit: 'L-GF-70', reason: REASON });
  assert.deepStrictEqual(accept(ctx, 'user', entries(FINDINGS.slice(0, 2))).accepted.length, 2);
});
test('GF-CLOSE-6 negative: only the user records an acceptance', () => {
  for (const actor of ['orchestrator', 'security-reviewer', 'backend-engineer']) refused(() => accept(withFindings(), actor), /only the user/);
});
test('GF-CLOSE-6 negative: a blocking finding cannot be accepted', () => {
  const list = [...FINDINGS, { id: 'H2-3', severity: 'blocking', kind: 'defect', summary: 'a blocking defect against a prevention rule' }];
  refused(() => accept(withFindings(list), 'user', entries(list)), /blocking/);
});
test('GF-CLOSE-6 negative: the list is every open finding once, each with its recorded severity, a numbered limit and a reason', () => {
  const rows = [
    [entries(FINDINGS.slice(0, 2)), /H2-2 is open and not listed/],
    [[...entries(FINDINGS), { finding: 'H9-9', severity: 'minor', limit: 'L-GF-90', reason: REASON }], /H9-9 is not an open finding/],
    [[...entries(FINDINGS), entries(FINDINGS)[0]], /H1-1 is listed twice/],
    [entries(FINDINGS).map((x, i) => (i === 0 ? { ...x, limit: 'L-17' } : x)), /limit id/],
    [entries(FINDINGS).map((x, i) => (i === 0 ? { ...x, reason: 'too short' } : x)), /30 characters/],
    [entries(FINDINGS).map((x, i) => (i === 1 ? { ...x, severity: 'minor' } : x)), /severity/],
    [[], /at least one/],
  ];
  for (const [list, re] of rows) refused(() => accept(withFindings(), 'user', list), re);
});
test('GF-CLOSE-6 negative: a scope is accepted once, and not after it is closed', () => {
  const ctx = withFindings();
  accept(ctx, 'user');
  refused(() => accept(ctx, 'user'), /already accepted/);
  const c = withFindings();
  F(c, 'gf.slice.closed', 'orchestrator', { scope: 'S2', treeHash: X.tree(c), steps: { comprehension: 'a', critique: 'b', readiness: 'c' }, batteries: [], accounting: { unit: 'all-processed-tokens', start: 0, end: 0 } });
  refused(() => accept(c, 'user'), /closed/);
});
test('GF-CLOSE-6 negative: an acceptance is bound to a clean tree', () => {
  const ctx = withFindings();
  put(ctx, 'docs/design.md', '# Design\nchanged and not committed\n');
  refused(() => accept(ctx, 'user'), /not clean/);
});
test('GF-CLOSE-6 bypass: a forged acceptance (by the orchestrator, of a blocking finding) is reported by the audit', () => {
  const list = [{ id: 'H2-3', severity: 'blocking', kind: 'defect', summary: 'a blocking defect against a prevention rule' }];
  const ctx = withFindings(list);
  F(ctx, 'gf.slice.accepted', 'orchestrator', { id: 'acc-forged', scope: 'S2', treeHash: X.tree(ctx), accepted: entries(list), caveat: closure.CAVEAT });
  const errs = gf6(ctx).map((e) => e.message).join(' | ');
  assert.match(errs, /only the user/);
  assert.match(errs, /blocking/);
  assert.ok(!audit.run(ctx.store, ctx.config).accepted.some((x) => x.scope === 'S2'), 'a forged acceptance stands for nothing');
});
test('GF-CLOSE-6 bypass: an acceptance without the L-GF-17 caveat is malformed', () => {
  const ctx = withFindings();
  F(ctx, 'gf.slice.accepted', 'user', { id: 'acc-forged', scope: 'S2', treeHash: X.tree(ctx), accepted: entries(FINDINGS), caveat: 'the owner accepted this' });
  assert.ok(audit.run(ctx.store, ctx.config).errors.some((e) => /gf\.slice\.accepted is malformed/.test(e.message)));
});
test('GF-CLOSE-6: no MCP tool records an acceptance; the owner CLI does, as the user only', () => {
  assert.deepStrictEqual(gfTools().map((t) => t.name).filter((n) => /accept/.test(n)), []);
  const ctx = withFindings();
  const file = path.join(ctx.dir, '..', `accepted-${path.basename(ctx.dir)}.json`);
  fs.writeFileSync(file, JSON.stringify(entries(FINDINGS)));
  const cli = (actor) => spawnSync(process.execPath, [CLI, 'close', 'accept', '--scope', 'S2', '--accepted', file, '--actor', actor, '--root', ctx.dir], { encoding: 'utf8', env: { ...process.env, ECCODE_ACTOR: '' } });
  const no = cli('orchestrator');
  assert.notStrictEqual(no.status, 0);
  assert.match(`${no.stdout}${no.stderr}`, /GF-CLOSE-6/);
  const yes = cli('user');
  assert.strictEqual(yes.status, 0, `${yes.stdout}${yes.stderr}`);
  assert.ok(ctx.store.readEvents().some((e) => e.type === 'gf.slice.accepted' && e.actor === 'user'));
});
test('GF-CLOSE-6: the hook denies the acceptance to every subagent and asks the human in the main session', () => {
  const ctx = withFindings();
  const command = 'node bin/eccode-gf.js close accept --scope S2 --accepted accepted.json --actor user';
  const hook = (role) => {
    const res = spawnSync(process.execPath, [GUARD], { input: JSON.stringify({ cwd: ctx.dir, tool_name: 'Bash', ...(role ? { agent_type: `eccode:${role}` } : {}), tool_input: { command } }), encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: ctx.dir, ECCODE_ACTOR: '', ECCODE_SEQUENTIAL_ROLES: '' } });
    return res.stdout ? JSON.parse(res.stdout).hookSpecificOutput.permissionDecision : 'allow';
  };
  for (const role of ['security-reviewer', 'technical-reviewer', 'orchestrator']) assert.strictEqual(hook(role), 'deny', role);
  assert.strictEqual(hook(null), 'ask');
});
