'use strict';
// Documentation tests for S2.3 (the owner's decision of 2026-11-08, after the S2.2 review): the design describes the
// allowlist as built, and 18.5 matches the engine on acceptance (I1-1, the S2.2 comprehension review's finding,
// rev-mw7xa589-0141c8ab). Each failed before the documents were changed.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const D = () => read('docs/design/greenfield-senior.md');
function section(text, heading) {
  const i = text.indexOf(heading);
  assert.ok(i >= 0, `section ${heading} is missing`);
  const level = heading.match(/^#+/)[0].length;
  const rest = text.slice(i + heading.length);
  const next = rest.search(new RegExp(`\\n#{1,${level}} `));
  return next < 0 ? rest : rest.slice(0, next);
}
const row = (text, id) => (text.split('\n').find((l) => l.startsWith(`| ${id} |`)) || '');
const para = (text, label) => { const i = text.indexOf(label); assert.ok(i >= 0, `${label} is missing`); const j = text.indexOf('\n', i); return text.slice(i, j < 0 ? undefined : j); };

test('I1-1: 18.5 says what the engine does: an empty acceptance list is refused, and a scope with open findings is accepted even while a no-go stands', () => {
  const p = para(section(D(), '### 18.5'), '**Acceptance with limits (GF-CLOSE-6');
  assert.match(p, /[Aa]n empty list is refused/);
  assert.match(p, /a scope with no open finding cannot be accepted/);
  assert.match(p, /a scope with open findings is accepted even while a no-go stands/);
  assert.doesNotMatch(p, /cannot be accepted either/, 'the sentence I1-1 found false is gone');
});

test('I1-1 engine: a scope with an open finding and a standing readiness no-go is accepted; the empty list is refused', () => {
  const X = require('./fixtures/gf/close');
  const closure = require('../lib/greenfield/closure');
  const { closeProject, battery, dispatch, review, LONG } = X;
  const ctx = closeProject();
  battery(ctx);
  const k = dispatch(ctx, 'critique', 'security-reviewer');
  review(ctx, 'security-reviewer', { scope: 'S2', step: 'critique', dispatch: k.id, summary: LONG, findings: [{ id: 'I2-9', severity: 'minor', kind: 'defect', summary: 'a minor defect left open' }] });
  const r = dispatch(ctx, 'readiness', 'architecture-reviewer');
  review(ctx, 'architecture-reviewer', { scope: 'S2', step: 'readiness', dispatch: r.id, summary: LONG, verdict: 'no-go', evidence: ['docs/design.md:1'] });
  let err = null;
  try { closure.accept(ctx.store, ctx.config, 'user', { scope: 'S2', accepted: [] }); } catch (e) { err = e; }
  assert.ok(err && /lists at least one open finding/.test(err.message), err ? err.message : 'the empty list was accepted');
  const a = closure.accept(ctx.store, ctx.config, 'user', { scope: 'S2', accepted: [{ finding: 'I2-9', severity: 'minor', limit: 'L-GF-99', reason: 'accepted by the owner as a numbered limit of the register' }] }).event.data;
  assert.deepStrictEqual(a.accepted.map((x) => x.finding), ['I2-9']);
});

test('S2.3: the GF-RUN-2 row of 18.1 states the default deny: a group role may call only the allowlisted tools, every other tool of its server is refused', () => {
  const r = row(section(D(), '### 18.1'), 'GF-RUN-2');
  assert.match(r, /allowlist/);
  assert.match(r, /default deny|default-deny/);
  assert.match(r, /S2\.3/);
  assert.doesNotMatch(r, /the frozen command tools of a role-locked server are refused to a group role \(S2\.2\)/, 'the deny-list wording is gone');
});

test('S2.3: 18.4 describes the allowlist as built and names every allowed tool', () => {
  const s = section(D(), '### 18.4');
  const p = para(s, '**The runner is the only route');
  assert.match(p, /S2\.3/);
  assert.match(p, /default deny|default-deny/);
  assert.match(p, /tools added later/);
  const { GROUP_ROLE_TOOLS } = require('../lib/greenfield');
  assert.ok(Array.isArray(GROUP_ROLE_TOOLS), 'the engine exports the allowlist');
  for (const name of GROUP_ROLE_TOOLS) assert.ok(s.includes(`\`${name}\``), `18.4 names ${name}`);
  assert.match(s, /enumeration test/);
  assert.match(s, /tests\/gf-tool-allowlist\.test\.js/);
  assert.doesNotMatch(p, /eight tools named in a list|refuses eight tools/, 'the deny-list description is gone');
});

test('S2.3: 18.7 has a deviations row for S2.3 and 18.0 keeps the threat model unchanged', () => {
  const s7 = section(D(), '### 18.7');
  const r = s7.split('\n').find((l) => /^\| .*S2\.3/.test(l)) || '';
  assert.match(r, /allowlist/);
  assert.match(r, /I2-1/);
  assert.match(section(D(), '### 18.0'), /accidental and LLM-plausible cross-group writes/);
});
