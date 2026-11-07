'use strict';
// Regression tests for the round-5 comprehension review of S2 (technical-reviewer, review rev-mw6yqhwr-01ef5af4 on tree
// 154055e): one test per documentation finding fixed in round 6, named by its id. Each failed before the documents
// were changed. F1-7 to F1-11 were deferred by the owner with limit ids (L-GF-34 to 38), and have no test here.
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
test('F1-1: the hook\'s identity check is stated precisely, and its residual is a limit', () => {
  assert.match(section(D(), '### 18.3'), /\*\*The hook's identity check, stated precisely\.\*\*/);
  assert.match(row(LIM(), 'L-GF-33'), /hides the CLI/);
});
test('F1-2: the hooks-off row claims only what the preflight reads', () => {
  assert.doesNotMatch(D(), /nothing; the preflight reports the hooks switched off \(F0\)/);
  assert.match(D(), /it cannot see the variable in another process/);
});
test('F1-3: what the closer writes after a counter reset is stated', () => {
  assert.match(D(), /the closer writes `start` as the number and `end` as `unmeasurable`/);
});
test('F1-4: the cost figures and "$0 on the meter" are reconciled', () => {
  assert.match(D(), /"\$0 on the meter" \(16\.1\) is the benchmark meter/);
});
test('F1-5: which pin governs the runner is stated', () => {
  assert.match(D(), /The pinned forms here govern the runner; 17\.5's invocations are S4a's adapters/);
});
test('F1-6: the owner\'s tool list is in the documents', () => {
  assert.match(D(), /listed in the round-5 decision \(pytest, alembic, uvicorn, ruff, semgrep, gitleaks, trivy, playwright\)/);
});
test('F1-12: the clean-tree definition states the tree\'s own .gitignore files', () => {
  assert.match(section(D(), '### 18.5'), /`git ls-files --others --exclude-per-directory=\.gitignore`/);
});
test('F1-13: the deviations table cites the pre-build closure design, not 18.5', () => {
  assert.match(row(section(D(), '### 18.7'), 'Closure'), /16\.5 as registered/);
});
test('F1-14: GF-ACC-2 is not named as built', () => {
  assert.match(D(), /GF-ACC-2 once S3 builds it/);
});
test('F1-15: no as-built text says a group role\'s shell writes are judged on their text', () => {
  assert.doesNotMatch(D(), /group roles have a shell in the `sandbox` and `guard` profiles/);
  assert.doesNotMatch(row(LIM(), 'L-GF-24'), /a shell write is judged on its command text/);
});
