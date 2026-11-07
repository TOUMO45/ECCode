'use strict';
// Greenfield-Senior documentation rules (owner decisions of 2026-11-04):
//  - the limits register for the layer is a separate file with placeholder ids, so docs/limits.md (which the
//    v3-generalization line also edits) is never touched here;
//  - the word "prevent" never stands alone: where it appears, the same sentence says "managed" or "audit";
//  - the greenfield layer's limits are complete.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const WORDING_FILES = [
  'docs/design/greenfield-senior.md',
  'docs/limits-greenfield.md',
  'docs/build/gf-s1-evidence.md',
  'docs/superpowers/plans/2026-11-04-greenfield-senior-s1.md',
  'docs/superpowers/plans/2026-11-07-greenfield-senior-s2.md',
  'docs/build/gf-s2-evidence.md',
  'skills/orchestrate-greenfield/SKILL.md',
  'agents/integration-engineer.md',
  'agents/database-engineer.md',
  'agents/security-engineer.md',
  'bin/eccode-gf.js',
  'lib/greenfield',
];

function filesUnder(rel) {
  const abs = path.join(ROOT, rel);
  if (!fs.existsSync(abs)) return [];
  if (fs.statSync(abs).isFile()) return [rel];
  return fs.readdirSync(abs, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? filesUnder(path.join(rel, d.name)) : [path.join(rel, d.name)]));
}

/** Sentences of a text: split on line breaks and on ". " before a capital or a backtick/asterisk. */
function sentences(text) {
  return text.split(/\n+/).flatMap((line) => line.split(/(?<=[.!?])\s+(?=[A-Z`*|])/));
}

test('"prevent" never stands alone: the same sentence says managed or audit', () => {
  const offenders = [];
  for (const rel of WORDING_FILES.flatMap(filesUnder)) {
    for (const s of sentences(read(rel))) {
      if (/prevent/i.test(s) && !/managed|audit/i.test(s)) offenders.push(`${rel}: ${s.trim().slice(0, 140)}`);
    }
  }
  assert.deepStrictEqual(offenders, [], `bare "prevent" found:\n${offenders.join('\n')}`);
});

test('the wording check itself sees a bare use (the check is not vacuous)', () => {
  const bare = sentences('Enforcement is prevented at write time.\nIt is detected by audit.');
  assert.ok(bare.some((s) => /prevent/i.test(s) && !/managed|audit/i.test(s)));
  const ok = sentences('Prevention on the managed (MCP) path plus guaranteed detection by log-replay audit in all profiles.');
  assert.ok(ok.every((s) => !/prevent/i.test(s) || /managed|audit/i.test(s)));
});

test('the greenfield limits register has L-GF-1 to L-GF-20, each with a disposition and the owner\'s wording on L-GF-1', () => {
  const text = read('docs/limits-greenfield.md');
  for (let n = 1; n <= 20; n++) {
    const row = text.split('\n').find((l) => l.startsWith(`| L-GF-${n} |`));
    assert.ok(row, `row L-GF-${n} is missing`);
    assert.match(row, /\| (Open, named|Open, mitigated|By design) \|/, `L-GF-${n} needs a disposition`);
  }
  assert.match(text, /prevention on the managed \(MCP\) path plus guaranteed detection by log-replay audit in all profiles/i);
});

test('the limits register of the other line is not edited here: docs/limits.md equals the H-B3 tip\'s', (t) => {
  const show = spawnSync('git', ['show', '948a95b:docs/limits.md'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (show.status !== 0) return t.skip('948a95b is not in this clone');
  assert.strictEqual(read('docs/limits.md'), show.stdout);
});

test('the design doc records the owner decisions of 2026-11-04', () => {
  const text = read('docs/design/greenfield-senior.md');
  assert.match(text, /## 14\. Owner decisions of 2026-11-04/);
  assert.match(text, /v4 freeze[^\n]*deferred/i);
  assert.match(text, /process-level E2E/i);
  assert.match(text, /never merge/i);
});
