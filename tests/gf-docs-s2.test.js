'use strict';
// Regression tests for the round-1 comprehension review of S2 (review rev-mw6naux9-01e4eb6a, technical-reviewer):
// each documentation defect has one test, named by its finding id, that failed before the documents were fixed
// (node --test --test-name-pattern "^R1-7: " tests/gf-docs-s2.test.js runs one). They check that the clarification
// is written where a reader looks for it, and that the contradicted text is gone.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const DESIGN = 'docs/design/greenfield-senior.md';
const PLAN = 'docs/superpowers/plans/2026-11-07-greenfield-senior-s2.md';
const LIMITS = 'docs/limits-greenfield.md';
/** The text of one numbered section (## or ###) up to the next heading of the same or a higher level. */
function section(text, heading) {
  const i = text.indexOf(heading);
  assert.ok(i >= 0, `section ${heading} is missing`);
  const level = heading.match(/^#+/)[0].length;
  const rest = text.slice(i + heading.length);
  const next = rest.search(new RegExp(`\\n#{1,${level}} `));
  return next < 0 ? rest : rest.slice(0, next);
}
const has = (text, re, what) => assert.match(text, re, what);
const hasNot = (text, re, what) => assert.doesNotMatch(text, re, what);

test('R1-1: the plan describes the closure rule as built (GF-CLOSE-1..5, dispatches, steps), cites section 17, and its review steps follow 17.2', () => {
  const plan = read(PLAN);
  has(plan, /\*\*Goal:\*\*[^\n]*GF-CLOSE-1\.\.5/);
  has(plan, /gf\.dispatch\.recorded \{id, scope, role, step, treeHash, inputs/);
  has(plan, /\*\*Spec:\*\*[^\n]*section 17/);
  hasNot(plan, /\*\*Step 3: Review pass 1:\*\* a fresh general-purpose agent, given the code/);
});
test('R1-2: GF-CLOSE-5 has its own row, with its condition and its bypasses, in the 16.5 rule table', () => {
  has(section(read(DESIGN), '### 18.5'), /\| GF-CLOSE-5 \| each step is its own dispatch[^\n]*\|[^\n]*\|/);
});
test('R1-3: the closing-round condition is stated once, with the verdict values per step and what a fixed finding means for the round', () => {
  const s = section(read(DESIGN), '### 18.5');
  has(s, /A fixed finding changes the tree, so a closing round cannot carry one/);
  has(s, /verdict values: comprehension and critique `clean` or `findings`, readiness `go` or `no-go`/);
});
test('R1-4: how S2 itself is closed is stated one way: a record in the checkout it closes, and what the authorship condition shows there', () => {
  const d = read(DESIGN);
  hasNot(d, /follows the rule by hand and records each element in the evidence file/);
  has(d, /the record lives in the checkout it closes/);
  has(d, /in a fresh record the authorship condition holds trivially/);
});
test('R1-5: the three things called a battery are told apart, and which one satisfies GF-CLOSE-3', () => {
  const d = read(DESIGN);
  has(d, /\*\*Three things are called a battery\.\*\*/);
  has(d, /the rule-removal battery[^\n]*does not satisfy GF-CLOSE-3/);
});
test('R1-6: GF-OWN-3 is stated as reading the completing actor and the task\'s owner; F1 is corrected', () => {
  const d = read(DESIGN);
  has(d, /GF-OWN-3 reads the completing actor and the task's owner/);
  hasNot(d, /\(F1\) Make the S2 ownership rules \*\*path-first\*\*: GF-OWN-3 and GF-OWN-4 judge paths against the sealed map, not actor strings/);
});
test('R1-7: group roles before the seal, and the gate authors that are group roles, are stated; the plan\'s contradicting line is gone', () => {
  has(read(DESIGN), /Before the seal, group roles hold no claim/);
  hasNot(read(PLAN), /the hook fails closed with the reason \(GF-OWN-1 hash mismatch\), and the audit reports it/);
});
test('R1-8: GF-FRZ-1 binds group roles only, "open" is defined, and its audit half is named', () => {
  const d = read(DESIGN);
  has(d, /GF-FRZ-1 binds group roles only/);
  has(d, /An amendment request is open from `gf\.contract\.amendment\.requested` until a `gf\.contract\.amended` cites it/);
});
test('R1-9: re-pin semantics are stated and the orchestrator\'s re-pin is a named limit', () => {
  has(read(DESIGN), /the latest pin, whatever its scope, is the reference/);
  has(read(LIMITS), /\| L-GF-22 \|[^\n]*re-pin/);
});
test('R1-10: the unit of a delegated agent\'s figure and what GF-CLOSE-4 does not check are stated', () => {
  const d = read(DESIGN);
  has(d, /`subagent_tokens`[^\n]*unit is not stated by the harness/);
  has(d, /GF-CLOSE-4 checks the form of the numbers, not their truth/);
});
test('R1-11: who closes, what authoring means, who may withdraw, and what a limit id is checked against are stated', () => {
  has(read(DESIGN), /\*\*Who closes, and what authoring means\.\*\*/);
});
test('R1-12: fix-verify, the paired run and purpose reproduction are defined where the closure rule uses them', () => {
  const d = read(DESIGN);
  has(d, /\*\*fix-verify\*\*/);
  has(d, /\*\*paired run\*\*/);
  has(d, /`purpose: reproduction`/);
});
test('R1-13: a table says which map version each ownership rule is judged against', () => {
  has(read(DESIGN), /\| Rule \| Map it is judged against \|/);
});
test('R1-14: the disjointness decision is described and an amendment\'s reach is stated', () => {
  const s = section(read(DESIGN), '### 18.2');
  has(s, /an amendment cannot change denyGlobs/);
  has(s, /provably inside/);
});
test('R1-15: L-GF-4 says in what sense drafts are namespaced, and which .eccode paths group roles do not write', () => {
  has(read(LIMITS), /\| L-GF-4 \|[^\n]*per group/);
  has(read(DESIGN), /other `\.eccode\/` paths are left to the hook's record rules/);
});
test('R1-16: the clean-tree definition and what a closure means after the tree moves are stated', () => {
  const d = read(DESIGN);
  has(d, /A closure is a record of the tree it names/);
  has(d, /untracked files that are not ignored count as dirty/);
});
test('R1-17: section 7 lists the S2 events and the ownership amendment with its real fields', () => {
  const s = section(read(DESIGN), '## 7. Event reference');
  for (const t of ['gf.config.pinned', 'gf.dispatch.recorded', 'gf.review.recorded', 'gf.finding.resolved', 'gf.battery.recorded', 'gf.slice.closed']) has(s, new RegExp(`\\| \`${t.replace(/\./g, '\\.')}\` \\|`), t);
  has(s, /\| `gf\.ownership\.amended` \| `id`, `group`, `from`, `to`, `reason`, `message`/);
});
test('R1-18: the preflight is described as computed, not recorded; the plan\'s "unknown" profile is gone', () => {
  has(read(DESIGN), /computed from the current settings each time; it is not a log event/);
  hasNot(read(PLAN), /'guard'\|'unknown'/);
});
test('R1-19: 16.8 names all fourteen remaining skips', () => {
  has(section(read(DESIGN), '### 16.8'), /14 remain/);
});
test('R1-20: the estimate bases are stated so they reproduce', () => {
  const d = read(DESIGN);
  has(d, /factors of about one quarter to two thirds/);
  has(d, /`cost_usd`/);
  has(d, /5 if two rounds suffice, and 3 more for every further round/);
});
test('R1-21: the limit numbering of section 15 and section 11 agrees with the register', () => {
  const d = read(DESIGN);
  has(d, /L-GF-1 to L-GF-18 at the end of S1/);
  has(section(d, '## 11.'), /The register `docs\/limits-greenfield\.md` is authoritative/);
});
test('R1-22: there is an S2 as-built section', () => {
  has(read(DESIGN), /\n## 18\. S2 as built/);
});
test('R1-23: GF-UX-1 states which states every screen needs and when denied is needed; the redundant reserved-path step is gone', () => {
  const s = section(read(DESIGN), '### 17.4');
  has(s, /loading, empty and error are required on every screen/);
  hasNot(s, /S4a adds that reserved path to GF-WBS-2/);
});
test('R1-24: what rawSha256 means for Gitleaks is defined', () => {
  has(section(read(DESIGN), '### 17.5'), /for Gitleaks, `rawSha256` is the hash of the redacted report/);
});
test('R1-25: the refused dispatch inputs are listed by path, and the tree carrying the authors\' conclusions is a named limit', () => {
  has(read(DESIGN), /`\.eccode\/drafts\/`, `\.eccode\/handoffs\/`, `\.eccode\/memory\/`, `\.eccode\/runs\/`, `\.eccode\/lab\/`, `\.eccode\/improvements\/`, `\.eccode\/events\.jsonl`, `\.eccode\/state\.json`/);
  has(read(LIMITS), /\| L-GF-23 \|[^\n]*conclusions/);
});
test('R1-26: section 3.4 point 2 is assigned: what S2 covers and what is not built', () => {
  has(read(DESIGN), /the "cites an amendment" half of 3\.4 point 2 is not built/);
});
