'use strict';
// t02 supplementary check (test-engineer). Run from the project root.
// 1) eval/thresholds.json deep-equals the JSON block in spec D5.
// 2) Synthetic-data scan: every email/url host is a reserved example domain,
//    every card-like number is a known test card, every phone-like number is a 555 number.
// 3) Prints counts per file/split/category/urgency/family. Never prints ticket text.
const fs = require('fs');
const assert = require('assert');

const spec = fs.readFileSync('.eccode/artifacts/design/spec.md', 'utf8');
const d5 = spec.slice(spec.indexOf('### D5 Evaluation dataset files'), spec.indexOf('### D6 Storage'));
const blocks = [...d5.matchAll(/```json\n([\s\S]*?)```/g)].map((m) => m[1]);
const specThresholds = JSON.parse(blocks.find((b) => b.includes('datasetMinimums')));
const thresholds = JSON.parse(fs.readFileSync('eval/thresholds.json', 'utf8'));
let failures = 0;
try {
  assert.deepStrictEqual(thresholds, specThresholds);
  console.log('thresholds.json deep-equals spec D5 block: PASS');
} catch {
  failures++;
  console.log('thresholds.json deep-equals spec D5 block: FAIL');
}
for (const [k, v] of Object.entries(thresholds.fallback)) {
  if ('holdoutMin' in v && Math.abs(v.min - 0.1 - v.holdoutMin) > 1e-9 && v.min !== 1) {
    failures++;
    console.log(`holdout floor rule FAIL ${k}`);
  }
}

const TEST_CARDS = new Set(['4111111111111111', '5500005555555559', '378282246310005']);
const exampleHost = (h) => /(^|\.)example(\.(com|net|org))?$/i.test(h.replace(/\.$/, ''));
const counts = {};
const inc = (k) => { counts[k] = (counts[k] || 0) + 1; };
for (const rel of ['eval/dataset.json', 'eval/holdout.json']) {
  const doc = JSON.parse(fs.readFileSync(rel, 'utf8'));
  for (const r of doc.rows) {
    const t = r.ticket;
    inc(`${doc.file} split=${r.split}`);
    if (r.split !== 'attack') {
      inc(`${doc.file} ${r.split} category=${r.category}`);
      inc(`${doc.file} ${r.split} urgency=${r.urgency}`);
      if (r.instructionLike) inc(`${doc.file} ${r.split} instructionLike`);
    } else {
      inc(`${doc.file} attack family=${r.attack.family}`);
    }
    for (const m of t.matchAll(/[A-Za-z0-9._%+-]+@([A-Za-z0-9.-]+)/g)) if (!exampleHost(m[1])) { failures++; console.log(`non-example email host in ${r.id}`); }
    for (const m of t.matchAll(/(?:https?:\/\/|www\.)([A-Za-z0-9.-]+)/g)) if (!exampleHost(m[1].replace(/^www\./, ''))) { failures++; console.log(`non-example url host in ${r.id}`); }
    for (const m of t.matchAll(/\b[a-z0-9-]+(?:\.[a-z0-9-]+)+\b/gi)) {
      const h = m[0];
      if (/^\d+(\.\d+)*$/.test(h) || /^(e\.g|i\.e)$/i.test(h)) continue;
      if (/\.(com|net|org|io|co|ru|uk|de)$/i.test(h) && !exampleHost(h.replace(/^www\./, ''))) { failures++; console.log(`non-example domain in ${r.id}`); }
    }
    const digitRuns = t.match(/\d[\d \-()]{8,}\d/g) || [];
    for (const run of digitRuns) {
      const d = run.replace(/\D/g, '');
      if (d.length >= 13 && !TEST_CARDS.has(d)) { failures++; console.log(`card-like number not a test card in ${r.id}`); }
      if (d.length >= 7 && d.length <= 12 && !/555/.test(d)) { failures++; console.log(`phone-like number without 555 in ${r.id}`); }
    }
  }
}
for (const k of Object.keys(counts).sort()) console.log(`COUNT ${k}=${counts[k]}`);
console.log(failures ? `t02-extra-check FAIL ${failures}` : 't02-extra-check PASS');
process.exit(failures ? 1 : 0);
