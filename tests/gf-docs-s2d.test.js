'use strict';
// Regression tests for the round-4 comprehension review of S2 (technical-reviewer, review rev-mw6rvgc2-01f2b30b on
// tree bceec2c): one test per documentation finding, named by its id (node --test --test-name-pattern "^E1-7: " ...),
// plus the owner's round-5 decision that section 18 is the single as-built description. Each failed before the
// documents were changed.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

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

test('R5-doc: section 18 is the single as-built description; 16.2, 16.3, 16.5 and 16.6 only point to it', () => {
  const d = D();
  assert.match(d, /\*\*This section is the single description of S2 as built\*\*/);
  for (const h of ['### 16.2', '### 16.3', '### 16.5', '### 16.6']) assert.ok(section(d, h).trim().length < 300, `${h} still carries text`);
  for (const h of ['### 18.1', '### 18.2', '### 18.3', '### 18.4', '### 18.5', '### 18.6', '### 18.7']) assert.ok(section(d, h).length > 200, h);
});
test('E1-1: the as-built vector table has the shell-write row, and no row says the guard profile alone has a shell', () => {
  const s = section(D(), '### 18.3');
  assert.match(s, /\| A writes B's files from a shell/);
  assert.match(s, /GF-RUN-1/);
  assert.doesNotMatch(D(), /`guard` profile only \(the other profiles have no shell\)/);
});
test('E1-2: "an initialised record" and "cannot be opened" are defined', () => {
  assert.match(D(), /An initialised record is a record whose `\.eccode\/events\.jsonl` exists/);
});
test('E1-3: closure independence is stated to rest on the controls of L-GF-17', () => {
  assert.match(section(D(), '### 18.3'), /\*\*Closure independence rests on the same controls\.\*\*/);
  assert.doesNotMatch(D(), /over MCP or `eccode-gf`, with the actor locked/);
});
test('E1-4: what a spoof buys names the right reviewer-only events', () => {
  assert.match(section(D(), '### 18.3'), /A fixed resolution needs no role/);
  assert.doesNotMatch(D(), /\(`gf\.ownership\.amended`, finding resolutions, closure reviews\)/);
});
test('E1-5: the precedence places sections 2 to 15, and section 8 agrees with the rules as built', () => {
  const d = D();
  assert.match(d, /sections 2 to 15 describe the layer as designed at G0 and S1/);
  assert.doesNotMatch(row(section(d, '## 8.'), 'GF-FRZ-1'), /H,P,A/);
  assert.doesNotMatch(row(section(d, '## 8.'), 'GF-CONF-1'), /pinned per slice/);
});
test('E1-6: what makes a review valid is stated once', () => {
  const s = section(D(), '### 18.5');
  assert.match(s, /\*\*A valid review, stated once\.\*\*/);
  assert.match(s, /a mismatch is refused/);
});
test('E1-7: a survivor of the last battery is accepted with a reason; a killing test means a new last battery', () => {
  assert.doesNotMatch(D(), /needs an accepted reason or a test that kills it/);
  assert.match(D(), /a test that kills a survivor changes the tree/);
});
test('E1-8: the battery that counts is named, and S2\'s mutant cap is stated', () => {
  const d = D();
  assert.match(d, /S2's batteries used `--max 20`/);
  assert.match(d, /the last valid battery recorded for the scope/);
  assert.doesNotMatch(d, /\*\*engine battery run 2\*\*/);
  assert.doesNotMatch(d, /battery 2 on that tree/);
});
test('E1-9: GF-OWN-3 states how .eccode paths in a completion are judged', () => {
  assert.match(row(section(D(), '### 18.1'), 'GF-OWN-3'), /any other `\.eccode\/` path is owned by no group and is reported/);
});
test('E1-10: GF-OWN-5 states its conditions, and the unbuilt message citation of a rescope is a limit', () => {
  assert.match(row(section(D(), '### 18.1'), 'GF-OWN-5'), /a reason of 30 characters or more/);
  assert.match(row(LIM(), 'L-GF-31'), /cite a message/);
});
test('E1-11: a counter reset is stated correctly', () => {
  assert.match(D(), /A reset that later use hides behind a larger `end` is not detectable/);
});
test('E1-12: how P4, P5 and P7 are scored after the three-step split is stated', () => {
  assert.match(D(), /a pass is a review round; its code defects are its critique step's findings/);
});
test('E1-13: the paired run\'s command is not tied to the finding, and that is a limit', () => {
  assert.match(D(), /nor that the command is a test of the finding/);
  assert.ok(row(LIM(), 'L-GF-30'), 'L-GF-30');
});
test('E1-14: 17.8 and 17.5 agree on a raw output that could hold a secret', () => {
  assert.match(section(D(), '### 17.8'), /unless 17\.5 says it could hold a secret/);
});
