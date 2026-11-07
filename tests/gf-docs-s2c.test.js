'use strict';
// Regression tests for the round-3 comprehension review of S2 (technical-reviewer, review rev-mw6phfb2-01c87621):
// one test per documentation finding, named by its id (node --test --test-name-pattern "^D1-7: " ...). Each failed
// before the documents were fixed.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const D = () => read('docs/design/greenfield-senior.md');
const PLAN = () => read('docs/superpowers/plans/2026-11-07-greenfield-senior-s2.md');
function section(text, heading) {
  const i = text.indexOf(heading);
  assert.ok(i >= 0, `section ${heading} is missing`);
  const level = heading.match(/^#+/)[0].length;
  const rest = text.slice(i + heading.length);
  const next = rest.search(new RegExp(`\\n#{1,${level}} `));
  return next < 0 ? rest : rest.slice(0, next);
}
const row = (text, id) => (text.split('\n').find((l) => l.startsWith(`| ${id} |`)) || '');

test('D1-1: when and where S2\'s closure record is set up is stated, and the plan says inside, not beside', () => {
  assert.match(D(), /initialised at the start of round 1 inside a separate checkout of the build tree/);
  assert.doesNotMatch(PLAN(), /beside a checkout/);
});
test('D1-2: which reviews count when a step has several on the closing tree is stated', () => {
  assert.match(section(D(), '### 18.5'), /every valid review of a step on the closing tree counts/);
});
test('D1-3: the precedence covers the plan\'s interfaces, and the plan\'s clean-only refusal is gone', () => {
  assert.match(D(), /the plan's interfaces are superseded by section 7 and section 18/);
  assert.doesNotMatch(PLAN(), /verdict findings \(GF-CLOSE-1\);/);
});
test('D1-4: GF-OWN-1 lists its hook point', () => {
  assert.match(row(section(D(), '### 18.1'), 'GF-OWN-1'), /\| P \(seal\), H \(fail closed\), A \|/);
});
test('D1-5: the closed-is-closed row names its rules, and the closure rule is GF-CLOSE-1 to 5 everywhere', () => {
  const d = D();
  assert.match(row(section(d, '### 18.5'), 'closed is closed (GF-CLOSE-1, 2, 3 and 5)'), /dispatch/);
  assert.doesNotMatch(d, /### 16\.5 The closure rule \(owner condition 1\): GF-CLOSE-1 to 4/);
  assert.doesNotMatch(section(d, '### 16.1'), /Implemented as GF-CLOSE-1 to 4/);
});
test('D1-6: what F1 adds against a forged actor is stated', () => {
  assert.match(section(D(), '### 18.3'), /a forger must name the task's owner/);
});
test('D1-7: "managed path" is defined once and GF-OWN-2\'s strength is stated', () => {
  assert.match(D(), /\*\*The managed path\*\* is the role-locked MCP servers together with the PreToolUse hook/);
});
test('D1-8: GF-CONF-1 without a pin, the pin\'s scope, and the reason minimum are stated', () => {
  assert.match(D(), /with no pin the audit has no GF-CONF-1 opinion/);
});
test('D1-9: "was recorded" is defined for a readiness citation', () => {
  assert.match(D(), /status `recorded` \(the mutation tool's evidence\)/);
});
test('D1-10: a paired run\'s tree condition is stated', () => {
  assert.match(D(), /a paired run has no tree condition of its own/);
});
test('D1-11: the tree identity includes a tracked .eccode; only the clean-tree check excludes it', () => {
  assert.match(D(), /the tree hash still includes the tracked `\.eccode\/` files/);
});
test('D1-12: the test count is defined one way, and the plan scores P7 too', () => {
  assert.match(section(D(), '### 16.7'), /the `# tests` count of `node --test`, in which each table row is a test/);
  assert.match(PLAN(), /P4 to P7/);
});
test('D1-13: the 146 k context figure has its source', () => {
  assert.match(section(D(), '### 16.7'), /`context_usage\.used_tokens`/);
});
test('D1-14: how the hook decides that a project is Greenfield-Senior, and what it does when it cannot, is stated', () => {
  assert.match(D(), /a `gf\.project\.initialized` event in the record makes a project Greenfield-Senior for the hook/);
});
