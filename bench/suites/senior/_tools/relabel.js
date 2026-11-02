#!/usr/bin/env node
'use strict';
// Blind re-labelling of the screening runs under the Round 1-lite taxonomy (protocol amendment 1, 2026-11-02).
//   node relabel.js prepare --save <runs.jsonl> --out-dir <dir> [--seed 7]
//       writes <dir>/packets.json (what the labeller sees: opaque ids, shuffled, the question and its readings, the patch
//       summary and the final answer; no arm, no task id, no run index, no pinned reading) and <dir>/key.json (the
//       private map back, which the labeller never opens).
//   node relabel.js apply --labels <labels.json> --key <key.json> --hand <screening-labels.json> --out <relabel.json>
//       checks the labeller's output (every packet once, a registered label, a reason), joins it with the key, and
//       compares the 16 earlier hand labels with the new ones.
const fs = require('fs');
const path = require('path');
const bench = require('../../../../lib/bench');

const LABELS = ['ASKED', 'DECLARED_ASSUMPTION', 'SILENT_GUESS', 'NEITHER'];
// An earlier screening label constrains the new one: guessed covers two of the new labels.
const COMPATIBLE = { asked: ['ASKED'], guessed: ['SILENT_GUESS', 'DECLARED_ASSUMPTION'], neither: ['NEITHER'] };

function patchSummary(patch) {
  const files = [...String(patch || '').matchAll(/^diff --git a\/(\S+)/gm)].map((m) => m[1]);
  const added = (String(patch || '').match(/^\+(?!\+\+)/gm) || []).length;
  const removed = (String(patch || '').match(/^-(?!--)/gm) || []).length;
  return `${files.length} file(s) changed (+${added}/−${removed} lines): ${files.join(', ') || 'none'}`;
}

function questionOf(suite, taskId) {
  for (const d of fs.readdirSync(suite)) {
    const tj = path.join(suite, d, 'task.json');
    if (!fs.existsSync(tj) || JSON.parse(fs.readFileSync(tj, 'utf8')).id !== taskId) continue;
    const f = path.join(suite, d, 'question.json');
    return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null;
  }
  return null;
}

/** Packets for the labeller and the private key. Deterministic for a seed. */
function prepare(runs, suite, seed = 7) {
  const rand = bench.mulberry32(seed);
  const order = runs.map((r, i) => i);
  for (let i = order.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [order[i], order[j]] = [order[j], order[i]]; }
  const packets = [];
  const key = {};
  order.forEach((idx, n) => {
    const run = runs[idx];
    const q = questionOf(suite, run.task);
    if (!q) throw new Error(`no registered question for ${run.task}`);
    const id = `p${String(n + 1).padStart(2, '0')}`;
    packets.push({ id, question: q.question, readings: q.readings, patchSummary: patchSummary(run.patch), finalAnswer: (run.usage && run.usage.answer) || '(the run printed no final answer)' });
    key[id] = { task: run.task, variant: run.variant, runIndex: run.runIndex };
  });
  return { packets, key };
}

/** Validate the labeller's output against the packets; returns the labels by packet id. */
function checkLabels(labels, packets) {
  if (!Array.isArray(labels)) throw new Error('the labels must be an array of { id, label, reason }');
  const byId = new Map();
  for (const l of labels) {
    if (!l || typeof l.id !== 'string') throw new Error('a label without an id');
    if (byId.has(l.id)) throw new Error(`packet ${l.id} is labelled twice`);
    if (!LABELS.includes(l.label)) throw new Error(`packet ${l.id}: ${l.label} is not one of ${LABELS.join(', ')}`);
    if (typeof l.reason !== 'string' || l.reason.trim().length < 5) throw new Error(`packet ${l.id}: a reason is required`);
    byId.set(l.id, l);
  }
  const missing = packets.filter((p) => !byId.has(p.id)).map((p) => p.id);
  if (missing.length) throw new Error(`unlabelled packets: ${missing.join(', ')}`);
  const unknown = [...byId.keys()].filter((id) => !packets.some((p) => p.id === id));
  if (unknown.length) throw new Error(`labels for unknown packets: ${unknown.join(', ')}`);
  return byId;
}

function apply(labels, key, hand) {
  const packets = Object.keys(key).map((id) => ({ id }));
  const byId = checkLabels(labels, packets);
  const runs = {};
  for (const [id, k] of Object.entries(key)) runs[`${k.task}|${k.variant}|${k.runIndex}`] = { task: k.task, variant: k.variant, runIndex: k.runIndex, label: byId.get(id).label, reason: byId.get(id).reason };
  const counts = Object.fromEntries(LABELS.map((l) => [l, Object.values(runs).filter((r) => r.label === l).length]));
  const comparison = [];
  for (const [k, v] of Object.entries(hand || {})) {
    if (k.startsWith('_')) continue;
    const [task, runIndex] = k.split('|');
    const now = runs[`${task}|without|${runIndex}`];
    if (!now) { comparison.push({ key: k, old: v.label, now: null, consistent: false, note: 'no re-labelled run' }); continue; }
    const consistent = (COMPATIBLE[v.label] || []).includes(now.label);
    comparison.push({ key: k, old: v.label, now: now.label, consistent, refined: v.label === 'guessed' && now.label === 'DECLARED_ASSUMPTION', reason: now.reason });
  }
  const summary = { handLabels: comparison.length, consistent: comparison.filter((c) => c.consistent).length, refinedToDeclared: comparison.filter((c) => c.refined).length, nowSilentGuess: comparison.filter((c) => c.now === 'SILENT_GUESS').length, inconsistent: comparison.filter((c) => !c.consistent).map((c) => c.key) };
  return { runs, counts, comparison, summary };
}

/** Cohen's kappa, the confusion table and the disagreements of two labellers over the same runs (relabel.json files). */
function agreement(a, b) {
  const ka = Object.keys(a.runs).sort(); const kb = Object.keys(b.runs).sort();
  if (ka.join('|') !== kb.join('|')) throw new Error('agreement needs the same runs in both label sets');
  const n = ka.length;
  const confusion = Object.fromEntries(LABELS.map((x) => [x, Object.fromEntries(LABELS.map((y) => [y, 0]))]));
  const disagreements = [];
  let agree = 0;
  for (const k of ka) {
    const x = a.runs[k].label; const y = b.runs[k].label;
    confusion[x][y]++;
    if (x === y) agree++; else disagreements.push({ run: k, a: x, b: y });
  }
  const observed = n ? agree / n : null;
  let expected = 0;
  for (const l of LABELS) expected += (LABELS.reduce((s, y) => s + confusion[l][y], 0) / n) * (LABELS.reduce((s, x) => s + confusion[x][l], 0) / n);
  const kappa = expected >= 1 - 1e-12 ? 1 : (observed - expected) / (1 - expected);
  return { n, observed, expected, kappa, confusion, disagreements };
}

function main(argv) {
  const cmd = argv[0];
  const flag = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
  const suite = path.resolve(flag('--suite') || path.join(__dirname, '..'));
  if (cmd === 'prepare') {
    const runs = bench.loadRuns(fs.readFileSync(path.resolve(flag('--save')), 'utf8'));
    const { packets, key } = prepare(runs, suite, Number(flag('--seed') || 7));
    const dir = path.resolve(flag('--out-dir'));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'packets.json'), JSON.stringify(packets, null, 1) + '\n');
    fs.writeFileSync(path.join(dir, 'key.json'), JSON.stringify(key, null, 1) + '\n');
    process.stdout.write(`${packets.length} packets -> ${path.join(dir, 'packets.json')}; key -> ${path.join(dir, 'key.json')}\n`);
    return 0;
  }
  if (cmd === 'apply') {
    const r = apply(JSON.parse(fs.readFileSync(flag('--labels'), 'utf8')), JSON.parse(fs.readFileSync(flag('--key'), 'utf8')), flag('--hand') ? JSON.parse(fs.readFileSync(flag('--hand'), 'utf8')).ambiguous : {});
    const out = { rubric: 'bench/suites/senior/_tools/rubric-r1lite.md', labeller: flag('--labeller') || 'an independent model labeller, blind to arm and to every earlier label', ...r };
    fs.writeFileSync(path.resolve(flag('--out')), JSON.stringify(out, null, 1) + '\n');
    process.stdout.write(`labels ${JSON.stringify(r.counts)}; hand labels: ${r.summary.consistent}/${r.summary.handLabels} consistent, ${r.summary.refinedToDeclared} refined to DECLARED_ASSUMPTION, ${r.summary.nowSilentGuess} SILENT_GUESS${r.summary.inconsistent.length ? `; INCONSISTENT: ${r.summary.inconsistent.join(', ')}` : ''}\n`);
    return 0;
  }
  if (cmd === 'agree') {
    const r = agreement(JSON.parse(fs.readFileSync(flag('--a'), 'utf8')), JSON.parse(fs.readFileSync(flag('--b'), 'utf8')));
    if (flag('--out')) fs.writeFileSync(path.resolve(flag('--out')), JSON.stringify(r, null, 1) + '\n');
    process.stdout.write(`n ${r.n}; observed agreement ${r.observed.toFixed(3)}; Cohen's kappa ${r.kappa.toFixed(3)}; disagreements ${r.disagreements.length}\n`);
    return 0;
  }
  process.stderr.write('usage: relabel.js prepare --save <runs.jsonl> --out-dir <dir> | apply --labels <json> --key <json> --hand <json> --out <json>\n');
  return 2;
}

module.exports = { prepare, apply, agreement, checkLabels, patchSummary, LABELS };

if (require.main === module) process.exit(main(process.argv.slice(2)));
