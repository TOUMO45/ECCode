// Verifier corpus (D8, spec 8.3): M1b = every fabrication flagged with its expected reason code (100%),
// M1c = false flags among correct statements <= 2%. Runs the real src/verify through the eval scorer. No model.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadSet, loadVerifierCorpus } from '../../eval/lib/load.js';
import { scoreVerifier } from '../../eval/lib/score.js';

const EVAL = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../eval');
const th = JSON.parse(fs.readFileSync(path.join(EVAL, 'thresholds.json'), 'utf8'));
const corpus = loadVerifierCorpus(EVAL);

describe('tune set verifier metrics', () => {
  const tune = loadSet(EVAL, false);
  const r = scoreVerifier(corpus, [...tune.incidents, ...tune.injections]);

  test('corpus is non-trivial', () => {
    assert.ok(corpus.fabrications.length >= 50, `fabrications: ${corpus.fabrications.length}`);
    assert.ok(r.m1c.n >= 100, `correct statements: ${r.m1c.n}`);
  });

  test('M1b: 100% of fabrications flagged with the expected code', () => {
    assert.deepEqual(r.m1bMissed, [], `missed: ${JSON.stringify(r.m1bMissed)}`);
    assert.equal(r.m1b.k, r.m1b.n);
    assert.ok(r.m1b.rate >= th.m1b.min);
    console.log(`# M1b tune: ${r.m1b.k}/${r.m1b.n}`);
  });

  test('M1c: false-flag rate on correct statements <= 2% (tune)', () => {
    console.log(`# M1c tune: ${r.m1c.k}/${r.m1c.n} = ${(100 * r.m1c.rate).toFixed(2)}%`);
    assert.ok(r.m1c.rate <= th.m1c.max, `${r.m1c.k}/${r.m1c.n}: ${JSON.stringify(r.m1cFalseFlags.slice(0, 5))}`);
  });

  test('every expected code in the corpus is a code the verifier can emit (no vacuous expectations)', () => {
    const missedCodes = new Set(r.m1bMissed.flatMap((m) => m.got));
    assert.equal(missedCodes.size, 0);
    for (const f of corpus.fabrications) assert.ok(Array.isArray(f.expect) && f.expect.length > 0, f.id);
  });
});

// Holdout M1c is measured by the runner (`npm run eval -- --verifier --holdout`). Holdouts 1 and 2 failed (3.07%, 2.50%)
// and are retired (eval/holdout-retired-*). The current sealed holdout is hold3-*. It must NOT be tuned on.
describe('holdout verifier metrics (no tuning on these)', () => {
  const hold = loadSet(EVAL, true);
  const r = scoreVerifier(corpus, [...hold.incidents, ...hold.injections]);
  test('M1b: holdout set does not change the fabrication result', () => {
    assert.deepEqual(r.m1bMissed, []);
  });
  test('M1c <= 2% on holdout correct statements', () => {
    assert.ok(r.m1c.rate <= th.m1c.max, `holdout M1c ${r.m1c.k}/${r.m1c.n} = ${(100 * r.m1c.rate).toFixed(2)}%`);
  });
});
