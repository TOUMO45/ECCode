// Fallback extractor on the tune set, in-process (spec 8.2/8.3/11.5): M1, M3, M4, M5 at the fallback tune
// thresholds, determinism and injection 10/10, plus M2.
// No network, no clock, no model: the fallback is a pure function.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadSet } from '../../eval/lib/load.js';
import { scoreIncident, scoreInjection } from '../../eval/lib/score.js';
import { wilson } from '../../eval/lib/wilson.js';
import { createFallbackProvider } from '../../src/ai/fallback.js';
import { validateDraft } from '../../src/ai/schema.js';

const EVAL = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../eval');
const th = JSON.parse(fs.readFileSync(path.join(EVAL, 'thresholds.json'), 'utf8'));
const { incidents, injections } = loadSet(EVAL, false);
const provider = createFallbackProvider();

async function runAll() {
  const res = {};
  for (const d of [...incidents, ...injections]) {
    const out = await provider.generate({ incident: { title: d.title, severity: d.severity, startedAt: d.startedAt }, lines: d.lines });
    const v = validateDraft(out.draft);
    res[d.id] = { draft: v.ok ? v.draft : null, schemaValid: v.ok, serialized: JSON.stringify(out.draft) };
  }
  return res;
}

const first = await runAll();
const second = await runAll();

const pooled = {};
{
  let ver = 0; let st = 0; let tm = 0; let tt = 0; let am = 0; let at = 0;
  for (const d of incidents) {
    const s = scoreIncident(d, first[d.id].draft);
    ver += s.verified; st += s.statements; tm += s.timelineMatched; tt += s.timelineTotal; am += s.actionsMatched; at += s.actionsTotal;
  }
  pooled.m1 = wilson(ver, st); pooled.m2 = wilson(tm, tt); pooled.m3 = wilson(am, at);
}
const pct = (w) => `${(100 * w.rate).toFixed(1)}% (${w.k}/${w.n})`;
console.log(`# fallback tune: M1 ${pct(pooled.m1)} M2 ${pct(pooled.m2)} M3 ${pct(pooled.m3)}`);

describe('fallback on the tune set', () => {
  test('data set is the expected shape', () => {
    assert.ok(incidents.length >= 10, `incidents: ${incidents.length}`);
    assert.equal(injections.length, th.m4.cases);
  });

  test('M5: every output is schema valid and labelled isFallback', () => {
    assert.equal(provider.isFallback, true);
    for (const [id, r] of Object.entries(first)) assert.equal(r.schemaValid, true, id);
  });

  test('M5: determinism, a second run is byte-identical for every incident and injection case', () => {
    for (const id of Object.keys(first)) {
      assert.ok(first[id].serialized, id);
      assert.equal(second[id].serialized, first[id].serialized, id);
    }
  });

  test(`M1 pooled verified rate >= ${th.m1.fallback.tune}`, () => {
    assert.ok(pooled.m1.rate >= th.m1.fallback.tune, `M1 ${pct(pooled.m1)}`);
  });

  test(`M3 pooled action recall >= ${th.m3.fallback.tune}`, () => {
    assert.ok(pooled.m3.rate >= th.m3.fallback.tune, `M3 ${pct(pooled.m3)}`);
  });

  test(`M2 pooled timeline recall >= ${th.m2.fallback.tune}`, () => {
    assert.ok(pooled.m2.rate >= th.m2.fallback.tune, `M2 ${pct(pooled.m2)}`);
  });

  test('M2 floor guard: measured value does not regress below the currently known level', () => {
    assert.ok(pooled.m2.rate >= 0.47, `M2 ${pct(pooled.m2)} regressed below the known 47.5%`);
  });

  test(`M4 injection: ${th.m4.fallback.tune} of ${th.m4.cases} cases pass all three checks`, () => {
    const failed = [];
    let passes = 0;
    for (const d of injections) {
      const r = scoreInjection(d, first[d.id].draft, first[d.id].schemaValid);
      if (r.pass) passes += 1; else failed.push({ id: d.id, c1: r.c1, c2: r.c2, c3: r.c3, recall: r.timelineRecall });
    }
    assert.ok(passes >= th.m4.fallback.tune, `${passes}/${injections.length}; failed: ${JSON.stringify(failed)}`);
  });

  test('injection text is never obeyed: canary appears only in statements that quote an injection line', () => {
    for (const d of injections) {
      const canary = d.injection.canary.toLowerCase();
      const inj = new Set(d.injection.injectionLines);
      for (const section of ['summary', 'impact', 'timeline', 'contributingFactors', 'actionItems']) {
        for (const s of first[d.id].draft[section]) {
          if (s.text.toLowerCase().includes(canary)) assert.ok(s.cites.some((n) => inj.has(n)), `${d.id}: ${section}`);
        }
      }
    }
  });
});
