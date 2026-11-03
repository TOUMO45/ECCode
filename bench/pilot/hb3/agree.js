'use strict';
// The arithmetic of the second blind labeller (owner decision 4 of 2026-11-03): a seeded, stratified sample of the misses to relabel,
// percent agreement and Cohen's kappa on the capability/configuration label, and the agreement on the blocker codes. It reads no seed
// and no result; its inputs are the two sets of labels. The packets given to the labeller are made by hand outside the repository
// because they contain the seed authors' descriptions.
//   node bench/pilot/hb3/agree.js sample --labels <first labels.json> --capability 5 --configuration 5 --seed <text>
//   node bench/pilot/hb3/agree.js agree  --first <labels.json> --second <labels.json> [--ids <comma list>]
// labels.json: { "<id>": { "label": "capability" | "configuration", "blockers": ["C1", ...] (optional), "reason": "..." } }
const fs = require('fs');

/** mulberry32 seeded from a text (FNV-1a), so a sample is reproducible from its seed text. */
function rng(text) {
  let h = 2166136261;
  for (const ch of String(text)) { h ^= ch.codePointAt(0); h = Math.imul(h, 16777619) >>> 0; }
  let a = h >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

/** ids chosen without replacement from each label group, in the order drawn then sorted; throws when a group is too small. */
function sample(labels, perLabel, seedText) {
  const rand = rng(seedText);
  const picked = [];
  for (const label of Object.keys(perLabel).sort()) {
    const pool = Object.keys(labels).filter((id) => labels[id] === label || (labels[id] && labels[id].label === label)).sort();
    if (pool.length < perLabel[label]) throw new Error(`only ${pool.length} item(s) labelled ${label}, ${perLabel[label]} requested`);
    for (let i = 0; i < perLabel[label]; i++) picked.push(pool.splice(Math.floor(rand() * pool.length), 1)[0]);
  }
  return picked.sort();
}

function cohenKappa(a, b) {
  if (a.length !== b.length) throw new Error('both labellers must label the same items');
  if (!a.length) throw new Error('no items');
  const cats = [...new Set([...a, ...b])].sort();
  const table = Object.fromEntries(cats.map((x) => [x, Object.fromEntries(cats.map((y) => [y, 0]))]));
  a.forEach((x, i) => { table[x][b[i]]++; });
  const n = a.length;
  const observed = cats.reduce((s, c) => s + table[c][c], 0) / n;
  const expected = cats.reduce((s, c) => s + (a.filter((x) => x === c).length / n) * (b.filter((x) => x === c).length / n), 0);
  const kappa = expected === 1 ? null : (observed - expected) / (1 - expected);
  return { n, observed, expected, kappa, table };
}

const labelOf = (x) => (typeof x === 'string' ? x : x.label);
const blockersOf = (x) => (x && Array.isArray(x.blockers) ? [...x.blockers].sort() : []);

function summary(first, second) {
  const ids = Object.keys(first).sort();
  if (ids.join() !== Object.keys(second).sort().join()) throw new Error('both labellers must label the same items');
  const label = cohenKappa(ids.map((i) => labelOf(first[i])), ids.map((i) => labelOf(second[i])));
  const disagreements = ids.filter((i) => labelOf(first[i]) !== labelOf(second[i]));
  const exact = ids.filter((i) => blockersOf(first[i]).join() === blockersOf(second[i]).join()).length;
  const perClass = {};
  for (const c of Object.keys(label.table)) {
    const of = ids.filter((i) => labelOf(first[i]) === c);
    perClass[c] = { n: of.length, agreed: of.filter((i) => labelOf(second[i]) === c).length };
  }
  return { n: ids.length, label: { observed: label.observed, expected: label.expected, kappa: label.kappa, table: label.table }, perClass, disagreements, blockers: { n: ids.length, exactMatch: exact } };
}

if (require.main === module) {
  const argv = process.argv.slice(2);
  const arg = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
  const read = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
  if (argv[0] === 'sample') {
    const per = {};
    for (const k of ['capability', 'configuration']) if (arg(`--${k}`)) per[k] = Number(arg(`--${k}`));
    process.stdout.write(`${JSON.stringify(sample(read(arg('--labels')), per, arg('--seed')))}\n`);
  } else if (argv[0] === 'agree') {
    const first = read(arg('--first')); const second = read(arg('--second'));
    const ids = arg('--ids') ? arg('--ids').split(',') : Object.keys(second);
    const pick = (o) => Object.fromEntries(ids.map((i) => [i, o[i]]));
    process.stdout.write(`${JSON.stringify(summary(pick(first), pick(second)), null, 2)}\n`);
  } else { process.stderr.write('usage: agree.js sample|agree ...\n'); process.exit(2); }
}

module.exports = { cohenKappa, sample, summary, rng };
