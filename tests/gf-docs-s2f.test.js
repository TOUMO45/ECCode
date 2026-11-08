'use strict';
// Regression tests for the round-6 comprehension review of S2 (technical-reviewer, tree 067cb70): one test per major
// documentation finding fixed in S2.1 (G1-1 to G1-5), named by its id; each failed before the documents were changed.
// G1-6 to G1-13 were deferred by the owner's S2.1 decision with limit ids (L-GF-41 to 48). Also the S2.1 threat model
// and its two limits (L-GF-39, L-GF-40), and the facts G1-5's text states, pinned on the engine.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const X = require('./fixtures/gf/close');
const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const D = () => read('docs/design/greenfield-senior.md');
const LIM = () => read('docs/limits-greenfield.md');
function section(text, heading) {
  const i = text.indexOf(heading);
  assert.ok(i >= 0, `section ${heading} is missing`);
  const level = heading.match(/^#+/)[0].length;
  const rest = text.slice(i + heading.length);
  const next = rest.search(new RegExp(`\\n#{1,${level}} `));
  return next < 0 ? rest : rest.slice(0, next);
}
const row = (text, id) => (text.split('\n').find((l) => l.startsWith(`| ${id} |`)) || '');
const para = (text, label) => { const i = text.indexOf(label); assert.ok(i >= 0, `${label} is missing`); return text.slice(i, text.indexOf('\n', i) < 0 ? undefined : text.indexOf('\n', i)); };

test('S2.1: section 18 states the owner\'s threat model, and the register numbers it and the OS-isolation limit', () => {
  const s = section(D(), '### 18.0');
  assert.match(s, /accidental and LLM-plausible cross-group writes/);
  assert.match(s, /detected by content-hash comparison at integration/);
  assert.match(s, /recorded as limits, not fixed/);
  assert.match(row(LIM(), 'L-GF-39'), /threat model/i);
  assert.match(row(LIM(), 'L-GF-40'), /OS-level isolation/);
});
test('G1-1: section 18 says what holds when a run deletes or changes the record', () => {
  assert.doesNotMatch(D(), /for a group role it would need the shell that GF-RUN-1 denies\./);
  const s = section(D(), '### 18.1');
  assert.match(s, /the runner's copy holds no `\.eccode\/`/);
  assert.match(s, /put back by the frozen record window, which fails the run/);
});
test('G1-2: the sequential-roles mode is stated where it is read, that it is not recorded, and what it leaves of independence', () => {
  const s = section(D(), '### 18.3');
  assert.doesNotMatch(s, /a mode that must be disclosed to the person\. So the orchestrator cannot/);
  const id = para(s, '**The hook\'s identity check, stated precisely.**');
  assert.match(id, /in the hook's own environment/);
  assert.match(id, /not recorded in the log, the preflight does not report it/);
  assert.match(id, /can record a closing review under a reviewer role/);
  assert.match(para(s, '**Closure independence rests on the same controls.**'), /ECCODE_SEQUENTIAL_ROLES/);
});
test('G1-3: section 18 says how a plan-pinned command is matched and run', () => {
  const s = section(D(), '### 18.4');
  const p = para(s, '**Plan-pinned commands.**');
  assert.match(p, /is not parsed by the word grammar/);
  assert.match(p, /runs through `sh -c` in the copy/);
});
test('G1-4: a valid battery and the last valid battery are defined, and what is not checked is said', () => {
  const s = section(D(), '### 18.5');
  const p = para(s, '**A valid battery, stated once.**');
  assert.match(p, /--test false/);
  assert.match(p, /total 0/);
  assert.match(p, /L-GF-26/);
  assert.match(p, /highest seq/);
});
test('G1-5: section 18 says what happens to a review that is not independent', () => {
  const p = para(section(D(), '### 18.5'), '**A review that is not independent.**');
  assert.match(p, /is refused when it is recorded/);
  assert.match(p, /its no-go does not stand/);
  assert.match(p, /findings still need a resolution/);
  assert.match(p, /blocks the close/);
});
test('G1-5 (pinned on the engine): a forged review by a role that is not independent counts for nothing, but its findings must be resolved', () => {
  const ctx = X.closeProject();
  X.validClosure(ctx);
  const d = X.dispatch(ctx, 'readiness', 'architecture-reviewer');
  X.F(ctx, 'gf.review.recorded', 'backend-engineer', { id: 'rev-forged-1', scope: 'S2', step: 'readiness', dispatch: d.id, treeHash: X.tree(ctx), summary: X.LONG, verdict: 'no-go', evidence: ['docs/design.md:1'] });
  const ok = require('../lib/greenfield/closure').preview(ctx.store, ctx.config, 'S2', { accounting: { unit: 'all-processed-tokens', start: 1, end: 2 } });
  assert.deepStrictEqual(ok.problems, [], 'a forged no-go does not stand');
  const k = X.dispatch(ctx, 'critique', 'security-reviewer');
  X.F(ctx, 'gf.review.recorded', 'backend-engineer', { id: 'rev-forged-2', scope: 'S2', step: 'critique', dispatch: k.id, treeHash: X.tree(ctx), summary: X.LONG, verdict: 'findings', findings: [{ id: 'FG-1', severity: 'minor', kind: 'defect', summary: 'a finding of a forged review' }] });
  const no = require('../lib/greenfield/closure').preview(ctx.store, ctx.config, 'S2', { accounting: { unit: 'all-processed-tokens', start: 1, end: 2 } });
  assert.ok(no.problems.some((p) => /FG-1 .* is unresolved/.test(p.message)), JSON.stringify(no.problems));
});
test('G1-6 to G1-13: each deferral is a numbered limit with its finding id and a reason', () => {
  for (let n = 6; n <= 13; n++) {
    const r = row(LIM(), `L-GF-${35 + n}`);
    assert.match(r, new RegExp(`Deferred, round 6, G1-${n} \\(documentation only, the owner's S2\\.1 decision\\)`), `L-GF-${35 + n}`);
  }
});
