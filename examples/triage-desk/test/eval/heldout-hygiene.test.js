'use strict';
// Held-out hygiene test (spec E5 ARCH-12, DES-2; task t12).
//
// Fails if a held-out row of eval/holdout.json leaks into the rules source:
//   - the row's canary or url appears (case-insensitive) in a rules file, or
//   - a lower-cased 5-word sequence of the row's ticket appears in a rules file and does NOT also occur in
//     an eval/dataset.json row (dataset phrasing is what the rules author is allowed to use).
//
// Output hygiene (DES-2): every failure is raised ONLY as
//   assert.fail('held-out overlap: row <id> in <rules file path>')
// The message, the test titles and any diagnostics carry row ids and file paths only, never ticket text,
// a 5-word sequence, a canary or a url. Nothing compares held-out strings with strictEqual / deepStrictEqual /
// match / ok(<expr>), whose default messages would print them; conditions go through check(), which fails
// with a fixed message.
//
// This is the only test in `npm test` that reads the real eval/holdout.json. It is a binary overlap signal,
// not a metric: the fix for a failure is to remove the overlapping phrase from the rules file.
//
// Environment (used by this file's own self-check child process only):
//   HYGIENE_RULES_FILES  comma-separated rules files to scan instead of the real ones
//   HYGIENE_CHILD=1      skip the self-check suite (prevents recursion)
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const FIX = path.join(__dirname, 'hygiene-fixtures');
const HOLDOUT = path.join(ROOT, 'eval', 'holdout.json');
const DATASET = path.join(ROOT, 'eval', 'dataset.json');
const RULES_FILES = ['src/triage/injection.js', 'src/triage/fallback-provider.js'];
const MESSAGE_RE = /^held-out overlap: row [a-z]-\d{3} in \S+$/;
const N = 5;

function check(cond, message) {
  if (!cond) assert.fail(message);
}

// Reads a JSON eval file without ever echoing its content: JSON.parse errors can quote the input.
function loadRows(file, label) {
  let doc;
  try {
    doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    assert.fail(`hygiene: cannot read or parse ${label}`);
  }
  check(doc && Array.isArray(doc.rows), `hygiene: ${label} has no rows array`);
  for (const r of doc.rows) {
    check(r && typeof r.id === 'string' && /^[a-z]-\d{3}$/.test(r.id) && typeof r.ticket === 'string',
      `hygiene: ${label} has a malformed row`);
  }
  return doc.rows;
}

// Lower-cased word tokens. Apostrophes inside words are dropped ("don't" -> "dont") so prose and
// string-literal spellings ("don\'t") tokenize alike.
function words(text) {
  const t = text.toLowerCase().replace(/(?<=[\p{L}\p{N}])\\?['’](?=[\p{L}\p{N}])/gu, '');
  return t.match(/[\p{L}\p{N}]+/gu) || [];
}

// Rules source: drop regex/string escapes (\s, \b, \w, \n, ...) so /ignore\s+previous\s+orders/ tokenizes
// like the prose "ignore previous orders".
function rulesWords(src) {
  return words(src.replace(/\\+[a-zA-Z]/g, ' '));
}

function grams(tokens) {
  const out = new Set();
  for (let i = 0; i + N <= tokens.length; i++) out.add(tokens.slice(i, i + N).join(' '));
  return out;
}

function datasetGrams(datasetRows) {
  const out = new Set();
  for (const r of datasetRows) for (const g of grams(words(r.ticket))) out.add(g);
  return out;
}

function displayPath(abs) {
  const rel = path.relative(ROOT, abs);
  return rel.startsWith('..') || path.isAbsolute(rel) ? abs : rel.split(path.sep).join('/');
}

// Returns the ids of held-out rows that overlap the given rules source. Pure; never returns text.
function overlappingRowIds(src, holdoutRows, allowedGrams) {
  const lower = src.toLowerCase();
  const unescaped = lower.replace(/\\/g, '');
  const ruleGrams = grams(rulesWords(src));
  const ids = [];
  for (const row of holdoutRows) {
    let hit = false;
    const a = row.attack || {};
    for (const s of [a.canary, a.url]) {
      if (typeof s === 'string' && s.trim() !== '') {
        const needle = s.toLowerCase();
        if (lower.includes(needle) || unescaped.includes(needle)) hit = true;
      }
    }
    if (!hit) {
      for (const g of grams(words(row.ticket))) {
        if (ruleGrams.has(g) && !allowedGrams.has(g)) { hit = true; break; }
      }
    }
    if (hit) ids.push(row.id);
  }
  return ids;
}

// Raises the first overlap as the spec's id-only failure; returns the list of overlapping ids otherwise
// empty. Additional overlapping ids (ids only) go to the diagnostic callback before the failure.
function assertNoOverlap(rulesFile, holdoutRows, allowedGrams, diagnostic = () => {}) {
  const shown = displayPath(rulesFile);
  let src;
  try {
    src = fs.readFileSync(rulesFile, 'utf8');
  } catch {
    assert.fail(`hygiene: cannot read rules file ${shown}`);
  }
  const ids = overlappingRowIds(src, holdoutRows, allowedGrams);
  if (ids.length > 1) diagnostic(`held-out overlap: rows ${ids.join(',')} in ${shown}`);
  if (ids.length > 0) assert.fail(`held-out overlap: row ${ids[0]} in ${shown}`);
}

// Captures the failure message assertNoOverlap would raise, or null when it passes.
function failureMessage(rulesFile, holdoutRows, allowedGrams) {
  try {
    assertNoOverlap(rulesFile, holdoutRows, allowedGrams);
    return null;
  } catch (err) {
    check(err instanceof assert.AssertionError, 'self-check: expected an AssertionError');
    return err.message;
  }
}

const isChild = process.env.HYGIENE_CHILD === '1';
const targets = process.env.HYGIENE_RULES_FILES
  ? process.env.HYGIENE_RULES_FILES.split(',').filter(Boolean).map((f) => path.resolve(ROOT, f))
  : RULES_FILES.map((f) => path.join(ROOT, f));

test('held-out hygiene: rules files share no canary, url or held-out-only 5-word sequence with eval/holdout.json', async (t) => {
  const holdoutRows = loadRows(HOLDOUT, 'eval/holdout.json');
  const allowed = datasetGrams(loadRows(DATASET, 'eval/dataset.json'));
  check(holdoutRows.length > 0, 'hygiene: eval/holdout.json has no rows');
  for (const file of targets) {
    await t.test(displayPath(file), () => {
      assertNoOverlap(file, holdoutRows, allowed, (d) => t.diagnostic(d));
    });
  }
});

test('held-out hygiene self-check', { skip: isChild ? 'self-check child run' : false }, async (t) => {
  await t.test('synthetic fixtures: seeded 5-word sequence, canary and url are detected with id-only messages', () => {
    const rows = loadRows(path.join(FIX, 'holdout.json'), 'fixture holdout.json');
    const allowed = datasetGrams(loadRows(path.join(FIX, 'dataset.json'), 'fixture dataset.json'));
    const expect = [
      ['rules-seeded-phrase.js', 'q-901'],
      ['rules-seeded-canary.js', 'q-902'],
      ['rules-seeded-url.js', 'q-902'],
    ];
    for (const [name, id] of expect) {
      const msg = failureMessage(path.join(FIX, name), rows, allowed);
      // Synthetic data only: printing these values on failure is harmless.
      assert.strictEqual(msg, `held-out overlap: row ${id} in test/eval/hygiene-fixtures/${name}`);
      assert.match(msg, MESSAGE_RE);
    }
    // The template shares a 5-word sequence with synthetic row q-903 that also occurs in the synthetic
    // dataset, so it is allowed; it shares nothing else.
    assert.strictEqual(failureMessage(path.join(FIX, 'rules-template.js'), rows, allowed), null);
    // Without the dataset allowance the shared sequence counts.
    assert.strictEqual(failureMessage(path.join(FIX, 'rules-template.js'), rows, new Set()),
      'held-out overlap: row q-903 in test/eval/hygiene-fixtures/rules-template.js');
  });

  await t.test('mutation: a real held-out 5-word sequence copied into a rules-like file fails, printing only id and path', () => {
    const holdoutRows = loadRows(HOLDOUT, 'eval/holdout.json');
    const allowed = datasetGrams(loadRows(DATASET, 'eval/dataset.json'));
    const template = fs.readFileSync(path.join(FIX, 'rules-template.js'), 'utf8');
    check(template.includes('__HYGIENE_SEED__'), 'self-check: template placeholder missing');
    const templateGrams = grams(rulesWords(template));

    // Deterministic seed: the first held-out row (attack rows first) with a 5-word sequence that is
    // neither in the dataset nor in the template.
    const ordered = [...holdoutRows.filter((r) => r.attack), ...holdoutRows.filter((r) => !r.attack)];
    let seed = null;
    for (const row of ordered) {
      for (const g of grams(words(row.ticket))) {
        if (!allowed.has(g) && !templateGrams.has(g)) { seed = { id: row.id, gram: g }; break; }
      }
      if (seed) break;
    }
    check(seed !== null, 'self-check: no held-out-only 5-word sequence found to seed');

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hygiene-selfcheck-'));
    try {
      const clean = path.join(dir, 'clean-rules.js');
      const seeded = path.join(dir, 'seeded-rules.js');
      fs.writeFileSync(clean, template);
      fs.writeFileSync(seeded, template.replace('__HYGIENE_SEED__', seed.gram.split(' ').join('\\s+')));

      // Unseeded template is clean against the real holdout, so the seed alone causes the failure.
      check(failureMessage(clean, holdoutRows, allowed) === null,
        'self-check: unseeded template already overlaps the real holdout');

      // In-process: exact id-only message.
      const msg = failureMessage(seeded, holdoutRows, allowed);
      check(msg !== null, 'self-check: seeded rules file was not detected');
      check(MESSAGE_RE.test(msg), 'self-check: failure message does not match the id-only format');
      check(msg === `held-out overlap: row ${seed.id} in ${displayPath(seeded)}`,
        'self-check: failure message names the wrong row or file');

      // End to end: run this test file on the seeded file; it must fail and its whole output must carry
      // the id-only message and no held-out text.
      const r = spawnSync(process.execPath, ['--test', __filename], {
        cwd: ROOT,
        encoding: 'utf8',
        env: { PATH: process.env.PATH, HYGIENE_CHILD: '1', HYGIENE_RULES_FILES: seeded },
      });
      const out = `${r.stdout}\n${r.stderr}`;
      check(r.status !== 0, 'self-check: hygiene run on a seeded rules file did not fail');
      check(out.includes(msg), 'self-check: child output lacks the id-only failure message');
      const outWords = ` ${words(out).join(' ')} `;
      check(!outWords.includes(` ${seed.gram} `), 'self-check: child output contains the seeded held-out sequence');
      const lowerOut = out.toLowerCase();
      for (const row of holdoutRows) {
        const a = row.attack || {};
        for (const s of [a.canary, a.url]) {
          if (typeof s === 'string' && s.trim() !== '') {
            check(!lowerOut.includes(s.toLowerCase()), `self-check: child output contains a canary or url of row ${row.id}`);
          }
        }
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
