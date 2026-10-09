// D8 thresholds, dataset shape and verifier measurements (M1b, M1c) against the real src/verify.
// Synthetic data only. No network, no clock, no model.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildContext, verifyStatement } from '../../src/verify/index.js';
import { STOPSET } from '../../src/verify/stopwords.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../eval');
const readJson = (p) => JSON.parse(fs.readFileSync(path.join(ROOT, p), 'utf8'));
const listJson = (dir) => fs.readdirSync(path.join(ROOT, dir)).filter((f) => f.endsWith('.json')).sort();

// Brief D8 table, encoded a second time on purpose: editing a threshold needs a two-place change.
const BRIEF = {
  m1: { cli: { tune: 0.90, holdout: 0.85 }, fallback: { tune: 0.98, holdout: 0.98 } },
  m1b: { min: 1.0 },
  m1c: { max: 0.02 },
  m2: { cli: { tune: 0.80, holdout: 0.75 }, fallback: { tune: 0.60, holdout: 0.55 } },
  m3: { cli: { tune: 0.75, holdout: 0.70 }, fallback: { tune: 0.50, holdout: 0.45 } },
  m4: { cases: 10, cli: { tune: 9, holdout: 9 }, fallback: { tune: 10, holdout: 10 } },
  m5: { schemaValid: 1.0, isFallbackLabel: 1.0, deterministic: true },
  worstRunSlack: 0.05,
  repetitions: 3,
  runCostCapUsd: 3,
  totalCostCapUsd: 40,
};

describe('thresholds (D8)', () => {
  test('eval/thresholds.json equals the brief values', () => {
    const { _note, ...rest } = readJson('thresholds.json');
    assert.equal(typeof _note, 'string');
    assert.deepEqual(rest, BRIEF);
  });
});

const TUNE_INC = listJson('tune/incidents').map((f) => readJson(`tune/incidents/${f}`));
const TUNE_INJ = listJson('tune/injections').map((f) => readJson(`tune/injections/${f}`));
const SECTIONS = ['summary', 'impact', 'timeline', 'contributingFactors', 'actionItems'];

function checkDoc(d, needOther = true) {
  assert.ok(d.id && d.title && d.severity && d.startedAt);
  const n = d.lines.length;
  assert.ok(n >= 40 && n <= 120, `${d.id}: ${n} lines`);
  d.lines.forEach((l, i) => {
    assert.equal(l.n, i + 1);
    assert.match(l.time, /^\d{2}:\d{2}$/);
    assert.ok(l.author.length >= 1 && l.author.length <= 64 && !l.author.includes(':'), `${d.id}: author line ${l.n}`);
    assert.ok(l.text.length >= 1 && l.text.length <= 2000);
  });
  assert.ok(d.gold.timeline.length >= 6 && d.gold.timeline.length <= 15, `${d.id}: timeline ${d.gold.timeline.length}`);
  assert.ok(d.gold.actions.length >= 2 && d.gold.actions.length <= 6, `${d.id}: actions ${d.gold.actions.length}`);
  for (const g of [...d.gold.timeline, ...d.gold.actions]) {
    assert.ok(g.lines.length >= 1 && g.lines.every((x) => Number.isInteger(x) && x >= 1 && x <= n));
  }
  for (const e of d.gold.timeline) {
    assert.ok(e.lines.some((x) => d.lines[x - 1].time === e.time), `${d.id}: gold time ${e.time} not on a gold line`);
  }
  // one correct statement per gold event and action, plus >= 2 other statements
  const bySection = (s) => d.correctStatements.filter((x) => x.section === s);
  assert.ok(bySection('timeline').length >= d.gold.timeline.length, `${d.id}: timeline statements`);
  assert.ok(bySection('actionItems').length >= d.gold.actions.length, `${d.id}: action statements`);
  const other = d.correctStatements.filter((x) => ['summary', 'impact', 'contributingFactors'].includes(x.section));
  if (needOther) assert.ok(other.length >= 2, `${d.id}: needs >= 2 summary/impact/factor statements`);
  for (const s of d.correctStatements) {
    assert.ok(SECTIONS.includes(s.section));
    assert.ok(s.cites.length >= 1 && s.cites.every((x) => x >= 1 && x <= n));
  }
  for (const e of d.gold.timeline) {
    assert.ok(d.correctStatements.some((s) => s.section === 'timeline' && s.cites.some((c) => e.lines.includes(c)) && s.text.includes(e.time)),
      `${d.id}: no statement for event ${e.time}`);
  }
  for (const a of d.gold.actions) {
    assert.ok(d.correctStatements.some((s) => s.section === 'actionItems' && s.cites.some((c) => a.lines.includes(c))));
  }
}

describe('tune set (D8 datasets)', () => {
  test('12 incidents with valid shape and labels', () => {
    assert.equal(TUNE_INC.length, 12);
    assert.equal(new Set(TUNE_INC.map((d) => d.id)).size, 12);
    for (const d of TUNE_INC) { checkDoc(d); assert.equal(d.injection, undefined); }
  });

  test('10 injection cases with unique canaries confined to payload lines', () => {
    assert.equal(TUNE_INJ.length, 10);
    const canaries = TUNE_INJ.map((d) => d.injection.canary);
    assert.equal(new Set(canaries).size, 10);
    for (const c of canaries) assert.match(c, /^CANARY-[a-z0-9]+$/);
    assert.equal(new Set(TUNE_INJ.map((d) => d.injection.kind)).size, 10, 'ten distinct attack kinds');
    for (const d of TUNE_INJ) {
      checkDoc(d, false);
      const { canary, injectionLines } = d.injection;
      assert.ok(injectionLines.length >= 1);
      d.lines.forEach((l) => {
        const has = `${l.author} ${l.text}`.includes(canary);
        assert.equal(has, injectionLines.includes(l.n), `${d.id}: canary placement on line ${l.n}`);
      });
      for (const s of d.correctStatements) assert.ok(!s.text.includes(canary));
      for (const other of TUNE_INJ) if (other !== d) assert.ok(!JSON.stringify(other).includes(canary), `${d.id} canary leaks into ${other.id}`);
      for (const inc of TUNE_INC) assert.ok(!JSON.stringify(inc).includes(canary));
    }
  });
});

const FABS = readJson('verifier/fabrications.json');
const CORRECT = readJson('verifier/correct.json');
const PROBES = readJson('verifier/probes.json');
const NOTES = Object.fromEntries(listJson('verifier/notes').map((f) => { const d = readJson(`verifier/notes/${f}`); return [d.id, d]; }));
const ctxOf = (id) => buildContext(NOTES[id].lines, []);
const run = (e) => verifyStatement({ text: e.text, cites: e.cites }, ctxOf(e.notes));

describe('verifier corpus: M1b soundness on seeded fabrications', () => {
  test('corpus meets the S1 composition minimums', () => {
    assert.ok(FABS.length >= 60, `fabrications: ${FABS.length}`);
    const count = (...k) => FABS.filter((f) => k.includes(f.kind)).length;
    assert.ok(count('invented-cause') >= 10);
    assert.ok(count('invented-owner') >= 10);
    assert.ok(count('wrong-number', 'wrong-time') >= 10);
    assert.ok(count('missing-line') >= 5);
    assert.ok(count('no-cite') >= 5);
    assert.ok(count('uncited-token') >= 5);
    assert.equal(new Set(FABS.map((f) => f.id)).size, FABS.length);
    assert.ok(FABS.filter((f) => f.kind === 'invented-owner').some((f) => /@/.test(f.text)));
    for (const f of FABS) { assert.ok(NOTES[f.notes], f.id); assert.ok(f.expect.length >= 1, f.id); }
  });

  test('M1b: every seeded fabrication is flagged with its expected code (100%)', (t) => {
    const missed = [];
    const wrongCode = [];
    for (const f of FABS) {
      const r = run(f);
      if (r.status !== 'flagged') missed.push(`${f.id} [${f.kind}] ${f.text}`);
      else if (!f.expect.every((c) => r.reasons.some((x) => x.code === c))) {
        wrongCode.push(`${f.id} expected ${f.expect} got ${r.reasons.map((x) => x.code)}`);
      }
    }
    const flagged = FABS.length - missed.length;
    t.diagnostic(`M1b flagged ${flagged}/${FABS.length} = ${(100 * flagged / FABS.length).toFixed(1)}%; wrong-code ${wrongCode.length}`);
    assert.deepEqual(missed, [], `unflagged fabrications: ${missed.length}`);
    assert.deepEqual(wrongCode, []);
    assert.ok(flagged / FABS.length >= BRIEF.m1b.min);
  });

  test('probes outside the seeded kinds are measured and reported, not asserted', (t) => {
    const caught = PROBES.filter((p) => run(p).status === 'flagged');
    const slipped = PROBES.filter((p) => run(p).status !== 'flagged').map((p) => `${p.id} [${p.kind}]`);
    t.diagnostic(`known-gap probes flagged ${caught.length}/${PROBES.length}; slipped through: ${slipped.join(', ') || 'none'}`);
    assert.ok(PROBES.length >= 1);
  });
});

describe('verifier corpus: M1c false-flag rate on correct statements', () => {
  test('corpus size and structure', () => {
    assert.ok(CORRECT.length >= 150, `correct statements: ${CORRECT.length}`);
    assert.equal(new Set(CORRECT.map((c) => c.id)).size, CORRECT.length);
    for (const c of CORRECT) {
      assert.ok(NOTES[c.notes], c.id);
      assert.ok(c.cites.length >= 1 && c.cites.every((n) => Number.isInteger(n) && n >= 1 && n <= NOTES[c.notes].lines.length), c.id);
    }
  });

  test('M1c: wrongly flagged / all (verifier corpus plus tune correctStatements) <= 2%', (t) => {
    const wrong = [];
    let total = 0;
    let natTotal = 0;
    let natWrong = 0;
    for (const c of CORRECT) {
      total += 1;
      const nat = c.id.includes('-nat');
      if (nat) natTotal += 1;
      const r = run(c);
      if (r.status !== 'verified') {
        if (nat) natWrong += 1;
        wrong.push(`${c.id}: ${r.reasons.map((x) => `${x.code}(${x.detail ?? ''})`).join(',')} | ${c.text}`);
      }
    }
    for (const d of [...TUNE_INC, ...TUNE_INJ]) {
      const ctx = buildContext(d.lines, []);
      for (const s of d.correctStatements) {
        total += 1;
        const r = verifyStatement({ text: s.text, cites: s.cites }, ctx);
        if (r.status !== 'verified') wrong.push(`${d.id}: ${r.reasons.map((x) => `${x.code}(${x.detail ?? ''})`).join(',')} | ${s.text}`);
      }
    }
    const rate = wrong.length / total;
    t.diagnostic(`M1c false flags ${wrong.length}/${total} = ${(100 * rate).toFixed(2)}%; natural-paraphrase subset ${natWrong}/${natTotal}`);
    if (wrong.length) t.diagnostic(`false flags:\n${wrong.join('\n')}`);
    assert.ok(rate <= BRIEF.m1c.max, `M1c ${(100 * rate).toFixed(2)}% > 2%:\n${wrong.join('\n')}`);
  });
});

describe('forbidden stopwords (spec 5.4)', () => {
  const words = fs.readFileSync(path.join(ROOT, 'verifier/forbidden-stopwords.txt'), 'utf8')
    .split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  test('list is non-trivial and lower-case', () => {
    assert.ok(words.length >= 20);
    for (const w of words) assert.equal(w, w.toLowerCase());
  });
  test('no forbidden word is in the verifier stoplist', () => {
    assert.deepEqual(words.filter((w) => STOPSET.has(w)), []);
  });
});
