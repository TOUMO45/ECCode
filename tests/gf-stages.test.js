'use strict';
// G1 stage validators (rules GF-PRD-1..3, GF-ARC-1, GF-CON-1..5, GF-THR-1, GF-WBS-1..3, GF-EST-1, GF-ART-2).
// Positive: the sample bundle passes all three gates. Negative: every mutation row is refused with its rule id at
// its gate and accepted at the gates before it. The refusal assertions name the rule id, so removing a rule fails
// the row that exercises it.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const sample = require('./fixtures/gf/sample');
const { MUTATIONS } = require('./fixtures/gf/mutations');
const bundle = require('../lib/greenfield/bundle');
const ownership = require('../lib/greenfield/ownership');
const { DEFAULT_CONFIG } = require('../lib/config');

const GATES = ['architecture', 'design', 'plan'];
const STAGES = { architecture: ['prd', 'architecture'], design: ['contracts', 'threat'], plan: ['breakdown', 'estimates'] };
const EXPECTED_RULES = ['GF-PRD-1', 'GF-PRD-2', 'GF-PRD-3', 'GF-ARC-1', 'GF-CON-1', 'GF-CON-2', 'GF-CON-3', 'GF-CON-4', 'GF-CON-5', 'GF-THR-1', 'GF-WBS-1', 'GF-WBS-2', 'GF-WBS-3', 'GF-EST-1', 'GF-ART-2'];

function dirOf() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'eccode-gf-stages-'));
}

/** Validate a bundle gate by gate with earlier gates treated as approved. Returns { dir, written, results }. */
function runAll(art) {
  const dir = dirOf();
  const written = sample.write(dir, art);
  const results = {};
  for (const g of GATES) {
    const base = sample.approvedBase(dir, art, written, g);
    results[g] = bundle.validateGate(dir, g, written[g], base, DEFAULT_CONFIG);
  }
  return { dir, written, results };
}

test('positive: the sample bundle passes every gate and registers the stages of each', () => {
  const { dir, results } = runAll(sample.build());
  for (const g of GATES) {
    assert.deepStrictEqual(results[g].problems, [], `${g}: ${JSON.stringify(results[g].problems)}`);
    assert.deepStrictEqual(results[g].registrations.map((r) => r.stage), STAGES[g]);
    for (const r of results[g].registrations) {
      assert.ok(r.files.length >= 1);
      assert.ok(r.files.every((f) => /^[0-9a-f]{64}$/.test(f.sha256) && f.path));
    }
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

test('every rule in the catalog has at least one mutation row', () => {
  const covered = new Set(MUTATIONS.map((m) => m.rule));
  assert.deepStrictEqual(EXPECTED_RULES.filter((r) => !covered.has(r)), []);
  assert.ok(MUTATIONS.length >= 55, `only ${MUTATIONS.length} rows`);
  assert.strictEqual(new Set(MUTATIONS.map((m) => `${m.rule}:${m.name}`)).size, MUTATIONS.length, 'row names are unique');
});

for (const m of MUTATIONS) {
  test(`negative ${m.rule}: refuses ${m.name}`, () => {
    const art = sample.build();
    m.apply(art);
    const { dir, results } = runAll(art);
    const at = GATES.indexOf(m.gate);
    for (const g of GATES.slice(0, at)) {
      assert.deepStrictEqual(results[g].problems, [], `${g} must still accept this bundle: ${JSON.stringify(results[g].problems)}`);
    }
    const problems = results[m.gate].problems;
    assert.ok(problems.length >= 1 && problems.every((p) => p.rule && typeof p.message === 'string' && p.message), `problems must carry a rule and a message: ${JSON.stringify(problems)}`);
    assert.ok(problems.some((p) => p.rule === m.rule), `${m.gate} must report ${m.rule}; got ${JSON.stringify(problems.map((p) => `${p.rule}: ${p.message}`))}`);
    // the same file set, unmutated, never reports this rule (the row exercises the rule, not noise)
    const clean = runAll(sample.build());
    assert.ok(!clean.results[m.gate].problems.some((p) => p.rule === m.rule));
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(clean.dir, { recursive: true, force: true });
  });
}

test('glob algebra: a glob is covered only when provably inside; escapes and broader globs are not', () => {
  const c = ownership.covered;
  assert.strictEqual(c('app/main.py', ['app/**']), true);
  assert.strictEqual(c('web/auth/**', ['web/**']), true);
  assert.strictEqual(c('app/**', ['app/**']), true);
  assert.strictEqual(c('Dockerfile', ['Dockerfile']), true);
  assert.strictEqual(c('**', ['app/**']), false);
  assert.strictEqual(c('app/../etc/passwd', ['app/**']), false);
  assert.strictEqual(c('application/x.py', ['app/**']), false);
  assert.strictEqual(c('app/db/**', ['app/auth/**']), false);
  assert.strictEqual(c('x', []), false);
});

test('disjointness: a nested glob needs the outer group\'s deny; identical globs never pass', () => {
  const g = (name, globs, denyGlobs = []) => ({ name, globs, denyGlobs });
  assert.deepStrictEqual(ownership.disjointProblems([g('a', ['app/**'], ['app/db/**']), g('b', ['app/db/**'])]), []);
  assert.ok(ownership.disjointProblems([g('a', ['app/**']), g('b', ['app/db/**'])]).length >= 1);
  assert.ok(ownership.disjointProblems([g('a', ['x/**']), g('b', ['x/**'])]).length >= 1);
  assert.ok(ownership.disjointProblems([g('a', ['x/*.js']), g('b', ['x/a*'])]).length >= 1, 'an overlap neither side contains is refused');
  assert.deepStrictEqual(ownership.disjointProblems([g('a', ['x/**']), g('b', ['y/**'])]), []);
});

test('hostile input: a path outside the project, an absolute path, a byte-order mark, invalid JSON and a huge file are refused or tolerated without a crash', () => {
  const art = sample.build();
  const dir = dirOf();
  const written = sample.write(dir, art);
  const base = sample.approvedBase(dir, art, written, 'architecture');
  const run = (files) => bundle.validateGate(dir, 'architecture', files, base, DEFAULT_CONFIG);

  const escape = run([...written.architecture, '../outside.json']);
  assert.ok(escape.problems.some((p) => p.rule === 'GF-ART-2' && /outside the project/.test(p.message)));
  const absolute = run([...written.architecture, '/etc/passwd']);
  assert.ok(absolute.problems.some((p) => p.rule === 'GF-ART-2'));

  const prdPath = path.join(dir, '.eccode/artifacts/prd.json');
  const text = fs.readFileSync(prdPath, 'utf8');
  fs.writeFileSync(prdPath, `﻿${text}`);
  assert.deepStrictEqual(run(written.architecture).problems, [], 'a byte-order mark is tolerated');

  fs.writeFileSync(prdPath, '{ not json');
  const invalid = run(written.architecture);
  assert.ok(invalid.problems.some((p) => p.rule === 'GF-PRD-1' && /JSON/.test(p.message)));

  fs.writeFileSync(prdPath, `${' '.repeat(9 * 1024 * 1024)}{}`);
  const huge = run(written.architecture);
  assert.ok(huge.problems.some((p) => p.rule === 'GF-ART-2' && /too large/.test(p.message)));

  const missing = run(written.architecture.filter((f) => !f.endsWith('prd.json')));
  assert.ok(missing.problems.some((p) => p.rule === 'GF-PRD-1' && /prd\.json is missing/.test(p.message)));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('approved bundles are re-validated and a changed approved file is GF-ART-DRIFT, not a silent pass', () => {
  const art = sample.build();
  const dir = dirOf();
  const written = sample.write(dir, art);
  const base = sample.approvedBase(dir, art, written, 'plan');
  assert.deepStrictEqual(bundle.validateApproved(dir, base, DEFAULT_CONFIG).problems, []);
  fs.appendFileSync(path.join(dir, 'contracts/openapi.json'), ' ');
  const drift = bundle.validateApproved(dir, base, DEFAULT_CONFIG).problems;
  assert.ok(drift.some((p) => p.rule === 'GF-ART-DRIFT' && /openapi\.json/.test(p.message)), JSON.stringify(drift));
  fs.rmSync(dir, { recursive: true, force: true });
});
