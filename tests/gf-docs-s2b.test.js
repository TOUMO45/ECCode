'use strict';
// Regression tests for the closing-round comprehension review of S2 (technical-reviewer, review on tree f7b3db2):
// one test per documentation finding, named by its id (node --test --test-name-pattern "^C1-7: " ...). Each failed
// before the documents were fixed.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const D = () => read('docs/design/greenfield-senior.md');
const PLAN = () => read('docs/superpowers/plans/2026-11-07-greenfield-senior-s2.md');
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

test('C1-1: the closing-round verdict is stated one way: findings on the closing tree only if each is withdrawn or deferred', () => {
  const s = section(D(), '### 18.5');
  assert.match(row(s, 'GF-CLOSE-1'), /may list findings only if each is withdrawn or deferred/);
  assert.doesNotMatch(section(D(), '### 16.8'), /clean and readiness go/);
});
test('C1-2: the paired-run proof\'s conditions are stated', () => {
  const d = D();
  assert.match(d, /the two commands are equal once whitespace is normalised/);
  assert.match(d, /a paired run is accepted only for a finding of kind documentation/);
});
test('C1-3: S2\'s own closure is described one way (inside the checkout), and round 1 is in the same record', () => {
  const d = D();
  assert.doesNotMatch(d, /kept beside a checkout/);
  assert.doesNotMatch(d, /### 16\.8 S2 exit \(the closure rule applied to S2 by hand\)/);
  assert.match(d, /round 1, its findings, their proofs and battery 1 are in the same record/);
});
test('C1-4: the plan names the engine battery as battery 1', () => {
  assert.match(PLAN(), /\*\*Step 1: Engine battery run 1\*\* \(`eccode-gf close battery`/);
});
test('C1-5: what a spoof does not buy is qualified by the recorded change paths', () => {
  assert.match(section(D(), '### 18.3'), /through a recorded change path/);
  assert.match(row(LIM(), 'L-GF-17'), /through a recorded change path/);
});
test('C1-6: the S2 gap in detecting cross-group file writes is a numbered limit', () => {
  assert.match(row(LIM(), 'L-GF-24'), /eccode-gf attribute/);
});
test('C1-7: one rule for who may withdraw a finding', () => {
  assert.match(row(section(D(), '### 18.5'), 'GF-CLOSE-2'), /withdrawn only by the reviewer role that raised it/);
});
test('C1-8: GF-FRZ-1\'s audit half is named and its points are stated', () => {
  assert.match(row(section(D(), '### 18.1'), 'GF-FRZ-1'), /audit half: GF-FRZ-2/);
});
test('C1-9: the 16.2 table states GF-OWN-3 as built', () => {
  assert.match(row(section(D(), '### 18.1'), 'GF-OWN-3'), /the completing actor is the task's owner/);
});
test('C1-10: the GF-OWN-1 audit is defined one way', () => {
  assert.match(D(), /\| GF-OWN-1 \(audit\) \| every engine task: its owner is in a group; pending and claimed tasks:/);
});
test('C1-11: where a role\'s group comes from is stated', () => {
  assert.match(D(), /the two agree in a sealed project/);
});
test('C1-12: the reviewer sets are named by their configuration keys', () => {
  const d = D();
  assert.match(d, /`config\.roles\.\*\.reviewers`/);
  assert.match(d, /`config\.roles\.\{design,verification,phase\}\.reviewers`/);
});
test('C1-13: where a survivor\'s reason is recorded is stated', () => {
  assert.match(D(), /the reasons are in `gf\.slice\.closed\.accepted`/);
});
test('C1-14: the GF-CLOSE-4 bypass names what the form check can catch', () => {
  assert.match(row(section(D(), '### 18.5'), 'GF-CLOSE-4'), /a number written as text/);
});
test('C1-15: the dispatch command and tool are named, and what the input hashes mean', () => {
  const d = D();
  assert.match(d, /`eccode-gf close dispatch` \(MCP `gf_dispatch_record`\)/);
  assert.match(d, /the hashes record what was given at dispatch time/);
});
test('C1-16: what a readiness citation must be is stated', () => {
  assert.match(D(), /at least one citation; a `path:line` resolves when that file exists in the review's tree and has that line/);
});
test('C1-17: who may mark a finding fixed is stated', () => {
  assert.match(D(), /any actor may record a fixed resolution/);
});
test('C1-18: finding ids are unique across the record', () => {
  assert.match(D(), /finding ids are unique across the whole record/);
});
test('C1-19: the residuals the design names are in the register, and the S4b item is listed', () => {
  const l = LIM();
  for (const id of ['L-GF-25', 'L-GF-26', 'L-GF-27']) assert.ok(row(l, id), id);
  assert.match(section(D(), '### 17.7'), /"cites an amendment" half of 3\.4 point 2/);
});
test('C1-20: section 18\'s preflight row cites what the design said before round 1', () => {
  assert.match(row(section(D(), '## 18. S2 as built'), 'Preflight'), /before round 1/);
});
test('C1-21: the basis of the 1.5 factor in 16.7 is stated', () => {
  assert.match(section(D(), '### 16.7'), /the factor was my judgment of rules and wrappers, not of lines/);
});
test('C1-22: S4a and S4b have a stated basis', () => {
  assert.match(section(D(), '### 17.7'), /S4a and S4b together: section 10's S4 build/);
});
test('C1-23: 17.5 and 17.8 agree on the secret scanner\'s hash', () => {
  const d = D();
  assert.doesNotMatch(section(d, '### 17.8'), /record both hashes/);
  assert.match(section(d, '### 17.8'), /the redacted report is the raw output/);
});
test('C1-24: GF-PRE-2 binds to things that exist at the seal', () => {
  const s = section(D(), '### 17.3');
  assert.match(s, /a test task of the breakdown/);
  assert.doesNotMatch(s, /a breakdown task, a test id;/);
});
test('C1-25: how an engine event cites a problem is defined', () => {
  assert.match(section(D(), '### 17.3'), /`gf\.obstacle\.cited \{seq, problem\}`/);
});
test('C1-26: whether events.json is sealed is stated', () => {
  assert.match(D(), /`contracts\/events\.json` is sealed when it is in the design submission/);
});
test('C1-27: the plan\'s policy interface states the pre-seal case, and the plan defers to section 18', () => {
  const p = PLAN();
  assert.match(p, /before the seal it returns no ownership denial/);
  assert.match(p, /superseded where design section 18 differs/);
});
