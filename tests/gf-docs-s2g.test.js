'use strict';
// Regression tests for S2.2 (the owner's narrow fix of 2026-11-08): the S2.1 comprehension review (technical-reviewer,
// rev-mw7pbs2f-01ca0b71, tree 9340a06) findings that contradict the engine or that a reader needs to use the
// acceptance event, and the S2.1 critique's H2-3, named by finding id; each failed before the documents were changed.
// The other R1 findings were deferred by the owner's S2.2 decision with limit ids (L-GF-52 to L-GF-60).
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
const para = (text, label) => { const i = text.indexOf(label); assert.ok(i >= 0, `${label} is missing`); const j = text.indexOf('\n', i); return text.slice(i, j < 0 ? undefined : j); };

test('H2-3: 18.5 lists the refusal of an empty acceptance and its real reason', () => {
  const p = para(section(D(), '### 18.5'), '**Acceptance with limits (GF-CLOSE-6');
  assert.match(p, /[Aa]n empty list is refused/);
  assert.match(p, /records open findings as numbered limits and nothing else/);
  assert.match(p, /a standing no-go, a missing review step, a battery or the accounting is not a finding/);
});
test('H1-1: the battery\'s round field is stated once, as the engine checks it', () => {
  const s = section(D(), '### 18.5');
  assert.doesNotMatch(s, /the event's `round` field is the orchestrator's label and is not checked/);
  assert.match(para(s, '**Three things are called a battery.**'), /the event's `round` field is checked/);
});
test('H1-2: the closer\'s own closing review blocks the close, in 18.5 and in 18.7 alike', () => {
  assert.doesNotMatch(section(D(), '### 18.7'), /a closing review recorded by the closer does not count/);
  assert.match(section(D(), '### 18.7'), /a closing review recorded by the closer blocks the close \(D3-1\)/);
});
test('H1-3: 18.4 says what the real tree holds when the integrity window fails a run after the copy-back', () => {
  const p = para(section(D(), '### 18.4'), '**The copy and the real tree (S2.1).**');
  assert.match(p, /the files already copied back stay in the real tree and `copiedBack` lists them/);
});
test('H1-5: 18.5 says what an accepted scope can still receive, and when an acceptance is judged', () => {
  const p = para(section(D(), '### 18.5'), '**Acceptance with limits (GF-CLOSE-6');
  assert.match(p, /An accepted scope stays open: it can still receive dispatches, reviews, resolutions and batteries, and it can still be closed/);
  assert.match(p, /judged at its own seq: a finding raised after it is not in it/);
});
test('H1-6: 18.0 says how a finding outside the threat model becomes a limit', () => {
  const s = section(D(), '### 18.0');
  assert.match(s, /R2 is the closing critique \(18\.5\)/);
  assert.match(s, /the reviewer lists it in its summary, not as a finding, and the orchestrator registers it as a numbered limit/);
});
test('H1-7: 18.4 and 18.7 say which files of `.eccode/` the real-tree check leaves to the frozen record window', () => {
  assert.doesNotMatch(D(), /the frozen record window puts back and fails a change there\) and the tools' caches/);
  assert.match(para(section(D(), '### 18.4'), '**The copy and the real tree (S2.1).**'), /`\.eccode\/` included except the three files the frozen record window restores/);
});
test('H1-13: 18.3 says that the sequential-roles mode still asks the person before `--actor user`, and that the hidden-CLI route reaches the acceptance too', () => {
  const p = para(section(D(), '### 18.3'), '**The hook\'s identity check, stated precisely.**');
  assert.match(p, /the person is still asked before the main session acts as `user`/);
  assert.match(p, /an owner acceptance \(GF-CLOSE-6\) included/);
});
test('H1-4, H1-8 to H1-12, H1-14 to H1-16: each deferral is a numbered limit with its finding id', () => {
  const ids = ['H1-4', 'H1-8', 'H1-9', 'H1-10', 'H1-11', 'H1-12', 'H1-14', 'H1-15', 'H1-16'];
  ids.forEach((id, i) => assert.match(row(LIM(), `L-GF-${52 + i}`), new RegExp(`Deferred, S2\\.1 R1, ${id} \\(documentation only, the owner's S2\\.2 decision\\)`), `L-GF-${52 + i}`));
});
