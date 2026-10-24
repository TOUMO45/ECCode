#!/usr/bin/env node
'use strict';
// The Part A report: one row per pre-registered criterion (spec section 8),
// computed from results/*.json and the hand labels in labels/*.json, with the
// verdict met / missed, or none when a result or a label is missing.
// usage: node report.js [--results dir] [--labels dir] [--out file.md]
const fs = require('fs');
const path = require('path');

const FILES = { a1: 'a1-index', a2: 'a2-impact', a3: 'a3-compat', a4: 'a4-fixverify', a5: 'a5-mutate', a6: 'a6-bugs', a7: 'a7-stack' };

function readDir(dir, names) {
  const out = {};
  for (const [key, name] of Object.entries(names)) {
    const f = path.join(dir, `${name}.json`);
    if (fs.existsSync(f)) out[key] = JSON.parse(fs.readFileSync(f, 'utf8'));
  }
  return out;
}

/** Labelled share of `ids` marked true, or null with the count of unlabelled ids. */
function labelledShare(ids, labels, truthy) {
  const unlabelled = ids.filter((id) => !labels[id]);
  if (!ids.length) return { value: null, note: 'nothing to label' };
  if (unlabelled.length) return { value: null, note: `${unlabelled.length} of ${ids.length} unlabelled` };
  return { value: ids.filter((id) => truthy(labels[id].label)).length / ids.length, note: `${ids.length} labelled` };
}

const at = (o, p) => p.split('.').reduce((x, k) => (x === undefined || x === null ? undefined : x[k]), o);

function criteria(results, labels) {
  const r = results;
  const rows = [];
  const add = (id, capability, measure, criterion, value, test, note = '') => {
    const has = value !== undefined && value !== null;
    rows.push({ id, capability, measure, criterion, result: has ? value : null, met: has ? test(value) : null, note });
  };
  const ge = (t) => (v) => v >= t;
  const le = (t) => (v) => v <= t;
  add('index-py-resolution', 'Index (A1)', 'Python intra-project imports resolved', '≥ 95%', at(r, 'a1.imports.python.rate'), ge(0.95));
  add('index-ts-resolution', 'Index (A1)', 'TS/JS intra-project imports resolved', '≥ 90%', at(r, 'a1.imports.ts.rate'), ge(0.9));
  add('index-cold', 'Index (A1)', 'onboard cold, ms', '≤ 120,000', at(r, 'a1.coldMs'), le(120000));
  add('index-warm', 'Index (A1)', 'onboard warm, ms', '≤ 10,000', at(r, 'a1.warmMs'), le(10000));
  add('index-edit', 'Index (A1)', 'onboard after a one-file edit, ms', '≤ 10,000', at(r, 'a1.editMs'), le(10000));
  add('impact-static-recall', 'Impact (A2)', 'median recall against coverage, static', '≥ 0.90', at(r, 'a2.medians.staticRecall'), ge(0.9));
  add('impact-trace-recall', 'Impact (A2)', 'median recall against coverage, with --trace', '≥ 0.95', at(r, 'a2.medians.traceRecall'), ge(0.95));
  add('impact-selected-share', 'Impact (A2)', 'median share of all test files selected', '≤ 0.5', at(r, 'a2.medians.staticSelectedShare'), le(0.5));
  const faults = at(r, 'a2.backend.faults');
  const pooled = Array.isArray(faults) && faults.length ? (() => {
    const tp = faults.reduce((s, f) => s + f.tp, 0);
    const truth = faults.reduce((s, f) => s + f.tp + f.fn, 0);
    return truth ? tp / truth : null;
  })() : undefined;
  add('impact-fault-recall', 'Impact (A2)', 'recall against injected faults, pooled over the fault runs', '≥ 0.90', pooled, ge(0.9));
  const det = (at(r, 'a3.detections') || []).map((d) => d.id);
  const compat = r.a3 ? labelledShare(det, labels.compat || {}, (l) => l === 'true') : { value: undefined, note: '' };
  add('compat-precision', 'Compat (A3)', 'precision of detections over the window', '≥ 0.90', compat.value, ge(0.9), compat.note);
  add('compat-route-recall', 'Compat (A3)', "recall against FastAPI's route table", '≥ 0.90', at(r, 'a3.routeRecall.recall'), ge(0.9));
  // A disagreement with the direct run is a defect of the engine unless its hand
  // label says the regex oracle misjudged the failure (labels/fixverify.json, by sha).
  const fvRows = at(r, 'a4.rows');
  let fv = { value: undefined, note: '' };
  if (Array.isArray(fvRows) && fvRows.length) {
    const fvLabels = labels.fixverify || {};
    const disagreements = fvRows.filter((x) => !x.agree);
    const unlabelled = disagreements.filter((x) => !fvLabels[x.sha]);
    const raw = `raw agreement ${fmt(r.a4.agreement)}`;
    fv = unlabelled.length
      ? { value: null, note: `${raw}; ${unlabelled.length} of ${disagreements.length} disagreements unlabelled` }
      : { value: (fvRows.length - disagreements.filter((x) => fvLabels[x.sha].label === 'engine-wrong').length) / fvRows.length, note: `${raw}; ${disagreements.length} disagreements labelled` };
  }
  add('fixverify-agreement', 'fix verify (A4)', 'agreement with running the tests directly, each disagreement labelled engine-wrong or oracle-wrong', '100%', fv.value, (v) => v === 1, fv.note);
  add('mutate-completed', 'mutate (A5)', 'runs completing', '≥ 90%', at(r, 'a5.completedShare'), ge(0.9));
  const hits = (at(r, 'a6.hits') || []).map((h) => h.id);
  const bugLabels = labels.bugs || {};
  const unlabelledBugs = hits.filter((id) => !bugLabels[id]).length;
  const fpRate = r.a6 && !unlabelledBugs && r.a6.changedLines ? (hits.filter((id) => bugLabels[id].label === 'false-positive').length / r.a6.changedLines) * 10000 : undefined;
  add('bugs-fp-rate', 'Bug rules (A6)', 'false positives per 10,000 changed lines', '≤ 1', fpRate, le(1), r.a6 ? `${hits.length} hits, ${unlabelledBugs} unlabelled` : '');
  const stacks = at(r, 'a7.stacks');
  add('stack-detect', 'Stack (A7)', 'stacks detected at the pin', 'Python and Node', Array.isArray(stacks) ? stacks.join(', ') : undefined, () => ['python', 'node'].every((x) => stacks.includes(x)));
  const checks = at(r, 'a7.checks');
  add('stack-checks', 'Stack (A7)', 'detected checks runnable, result equal to the tool run directly', 'all', Array.isArray(checks) ? `${checks.filter((c) => c.available && c.equal !== false).length}/${checks.length}` : undefined, () => checks.every((c) => c.available && c.equal !== false));
  const secretIds = (at(r, 'a7.secrets.hits') || []).filter((h) => h.where === 'code').map((h) => h.id);
  const secretLabels = labels.secrets || {};
  const secretFp = r.a7 && secretIds.every((id) => secretLabels[id]) ? secretIds.filter((id) => secretLabels[id].label === 'false-positive').length : undefined;
  add('secrets-fp', 'Secrets (A7)', 'error-level false positives at the pin', '≤ 5', secretFp, le(5), r.a7 ? `${secretIds.length} error-level hits` : '');
  return rows;
}

function fmt(v) {
  if (v === null || v === undefined) return '—';
  if (typeof v === 'number') return v <= 1 && !Number.isInteger(v) ? v.toFixed(3) : String(Math.round(v * 1000) / 1000);
  return String(v);
}

function markdown(rows, { title = 'Mealie pilot, Part A: model-free measurements' } = {}) {
  const lines = [`# ${title}`, '', '| Capability | Measure | Criterion | Result | Met |', '|---|---|---|---|---|'];
  for (const r of rows) lines.push(`| ${r.capability} | ${r.measure} | ${r.criterion} | ${fmt(r.result)}${r.note ? ` (${r.note})` : ''} | ${r.met === null ? '—' : r.met ? 'met' : 'missed'} |`);
  return `${lines.join('\n')}\n`;
}

module.exports = { criteria, markdown, labelledShare };

if (require.main === module) {
  const argv = process.argv.slice(2);
  const opt = (n, d) => (argv.includes(`--${n}`) ? argv[argv.indexOf(`--${n}`) + 1] : d);
  const results = readDir(opt('results', path.join(__dirname, 'results')), FILES);
  const labelsDir = opt('labels', path.join(__dirname, 'labels'));
  const labels = readDir(labelsDir, { compat: 'compat', bugs: 'bugs', secrets: 'secrets', fixverify: 'fixverify' });
  const md = markdown(criteria(results, labels));
  const out = opt('out', null);
  if (out) fs.writeFileSync(out, md);
  process.stdout.write(md);
}
