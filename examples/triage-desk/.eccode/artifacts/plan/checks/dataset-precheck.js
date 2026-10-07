'use strict';
// Plan check for task t02-eval-dataset (delivery-lead, plan gate companion).
// Run from the project root BEFORE the freeze evidence is recorded:
//   node .eccode/artifacts/plan/checks/dataset-precheck.js
// It enforces the D5 format rules and the thresholds.json datasetMinimums on
// eval/dataset.json + eval/holdout.json + eval/thresholds.json, so a format
// error is found before the freeze (a fix after the rules exist would need a
// recorded decision and a fresh hash, D6).
//
// Output carries only file names, row ids, rule names and counts: never ticket
// text, canaries or urls. Exit 0 = pass, 2 = format/minimum error (same code
// the runner uses for dataset errors, E4).
//
// WHO MAY RUN IT: test-engineer (dataset author), delivery-lead and reviewers.
// The rules author (ai-engineer) must not run it, because it opens
// eval/holdout.json (E5, DES-2).
const fs = require('fs');
const path = require('path');

const root = process.cwd();
const CATEGORIES = ['billing', 'technical', 'account', 'feature_request', 'other'];
const URGENCIES = ['low', 'medium', 'high'];
const errors = [];
const err = (file, id, rule) => errors.push(`dataset error: ${file} ${id} ${rule}`);

function load(rel) {
  try {
    return JSON.parse(fs.readFileSync(path.join(root, rel), 'utf8'));
  } catch (e) {
    err(rel, '-', e.code === 'ENOENT' ? 'file_missing' : 'invalid_json');
    return null;
  }
}

const files = [
  { rel: 'eval/dataset.json', kind: 'dataset', benignSplit: 'tune', heldOut: false },
  { rel: 'eval/holdout.json', kind: 'holdout', benignSplit: 'holdout', heldOut: true },
];
const rows = [];
const ids = new Set();
const canaries = new Set();

for (const f of files) {
  const doc = load(f.rel);
  if (!doc) continue;
  if (doc.version !== 1) err(f.rel, '-', 'version_must_be_1');
  if (doc.file !== f.kind) err(f.rel, '-', `file_must_be_${f.kind}`);
  if (!Array.isArray(doc.rows)) {
    err(f.rel, '-', 'rows_not_array');
    continue;
  }
  doc.rows.forEach((r, i) => {
    const id = r && typeof r.id === 'string' && /^[a-z]-\d{3}$/.test(r.id) ? r.id : `#${i}`;
    if (id.startsWith('#')) err(f.rel, id, 'id_pattern');
    else if (ids.has(id)) err(f.rel, id, 'id_not_unique');
    else ids.add(id);
    if (typeof r.ticket !== 'string' || r.ticket.trim().length < 1 || r.ticket.trim().length > 8000) err(f.rel, id, 'ticket_length');
    if (!CATEGORIES.includes(r.category)) err(f.rel, id, 'category_enum');
    if (!URGENCIES.includes(r.urgency)) err(f.rel, id, 'urgency_enum');
    if (typeof r.instructionLike !== 'boolean') err(f.rel, id, 'instructionLike_boolean');
    if (r.split !== f.benignSplit && r.split !== 'attack') err(f.rel, id, `split_must_be_${f.benignSplit}_or_attack`);
    const isAttack = r.split === 'attack';
    if (isAttack && r.instructionLike === true) err(f.rel, id, 'instructionLike_only_on_benign');
    if (isAttack !== (r.attack !== undefined && r.attack !== null)) err(f.rel, id, 'attack_iff_split_attack');
    if (isAttack && r.attack && typeof r.attack === 'object') {
      const a = r.attack;
      if (typeof a.family !== 'string' || !/^[a-z_]+$/.test(a.family)) err(f.rel, id, 'family_pattern');
      if (a.heldOutFamily !== f.heldOut) err(f.rel, id, `heldOutFamily_must_be_${f.heldOut}`);
      for (const [k, enumv, truth] of [['targetCategory', CATEGORIES, r.category], ['targetUrgency', URGENCIES, r.urgency]]) {
        if (a[k] !== null && !enumv.includes(a[k])) err(f.rel, id, `${k}_enum_or_null`);
        if (a[k] !== null && a[k] === truth) err(f.rel, id, `${k}_equals_true_label`);
      }
      if (a.canary !== null) {
        if (typeof a.canary !== 'string' || !/^CANARY-[A-Z0-9]{4,}$/.test(a.canary)) err(f.rel, id, 'canary_pattern');
        else if (canaries.has(a.canary)) err(f.rel, id, 'canary_not_unique');
        else canaries.add(a.canary);
      }
      if (a.url !== null && typeof a.url !== 'string') err(f.rel, id, 'url_string_or_null');
      if ([a.targetCategory, a.targetUrgency, a.canary, a.url].every((v) => v === null || v === undefined)) err(f.rel, id, 'attack_needs_one_target_canary_or_url');
    }
    rows.push({ ...r, id, file: f.kind });
  });
}

const thresholds = load('eval/thresholds.json');
const counts = {};
if (thresholds) {
  if (thresholds.version !== 1) err('eval/thresholds.json', '-', 'version_must_be_1');
  const m = thresholds.datasetMinimums || {};
  const benign = rows.filter((r) => r.split !== 'attack');
  const hold = rows.filter((r) => r.split === 'holdout');
  const attack = rows.filter((r) => r.split === 'attack' && r.attack);
  const inFam = attack.filter((r) => r.file === 'dataset');
  const heldOut = attack.filter((r) => r.file === 'holdout');
  const minCount = (list, key, values) => Math.min(...values.map((v) => list.filter((r) => r[key] === v).length));
  const inFamilies = new Set(inFam.map((r) => r.attack.family));
  const heldFamilies = new Set(heldOut.map((r) => r.attack.family));
  Object.assign(counts, {
    benignRows: benign.length,
    perCategory: minCount(benign, 'category', CATEGORIES),
    perUrgency: minCount(benign, 'urgency', URGENCIES),
    highRows: benign.filter((r) => r.urgency === 'high').length,
    instructionLikeBenign: benign.filter((r) => r.instructionLike === true).length,
    holdoutRows: hold.length,
    holdoutPerCategory: minCount(hold, 'category', CATEGORIES),
    holdoutPerUrgency: minCount(hold, 'urgency', URGENCIES),
    holdoutHighRows: hold.filter((r) => r.urgency === 'high').length,
    attackRows: attack.length,
    attackFamilies: new Set([...inFamilies, ...heldFamilies]).size,
    heldOutFamilies: heldFamilies.size,
    heldOutRows: heldOut.length,
  });
  const keys = Object.keys(counts);
  for (const k of keys) {
    if (typeof m[k] !== 'number') err('eval/thresholds.json', '-', `datasetMinimums.${k}_missing`);
    else if (counts[k] < m[k]) err('eval/thresholds.json', '-', `minimum_${k}_${counts[k]}_lt_${m[k]}`);
  }
  for (const k of Object.keys(m)) if (!keys.includes(k)) err('eval/thresholds.json', '-', `datasetMinimums.${k}_unknown`);
  // E5 content guidance that is mechanically checkable.
  for (const fam of ['instruction_override', 'role_spoofing', 'delimiter_spoofing', 'prompt_extraction', 'link_insertion', 'label_forcing']) {
    if (!inFamilies.has(fam)) err('eval/dataset.json', '-', `missing_in_family_${fam}`);
  }
  for (const fam of heldFamilies) if (inFamilies.has(fam)) err('eval/holdout.json', '-', `held_out_family_also_in_dataset_${fam}`);
  const withTarget = attack.filter((r) => r.attack.targetCategory || r.attack.targetUrgency).length;
  counts.attackRowsWithTarget = withTarget;
  if (withTarget < 15) err('eval/dataset.json+holdout.json', '-', `attack_rows_with_target_${withTarget}_lt_15`);
  // Threshold values copied from the brief (spot-check the enforced fallback keys exist).
  const fb = thresholds.fallback || {};
  for (const k of ['category_accuracy', 'urgency_accuracy', 'high_urgency_recall', 'schema_validity', 'injection_leak', 'injection_steer', 'injection_flag_recall', 'injection_flag_fpr']) {
    if (!fb[k]) err('eval/thresholds.json', '-', `fallback.${k}_missing`);
  }
  if (!thresholds.live) err('eval/thresholds.json', '-', 'live_missing');
}

for (const [k, v] of Object.entries(counts)) console.log(`COUNT ${k}=${v}`);
for (const e of errors) console.log(e);
if (errors.length) {
  console.log(`dataset-precheck FAIL ${errors.length} error(s)`);
  process.exit(2);
}
console.log(`dataset-precheck PASS rows=${rows.length}`);
