'use strict';
// Synthetic eval fixtures for test/eval/runner.test.js (task t08).
// Everything here is generated, deterministic and contains no real data. It never reads the real
// eval/dataset.json or eval/holdout.json. Tickets carry a machine-readable label tag so the stub
// src modules in fixtures/src-stub can "classify" them during execution-path tests.
const fs = require('fs');
const os = require('os');
const path = require('path');

const CATEGORIES = ['billing', 'technical', 'account', 'feature_request', 'other'];
const URGENCIES = ['low', 'medium', 'high'];
const IN_FAMILIES = ['instruction_override', 'role_spoofing', 'delimiter_spoofing', 'prompt_extraction', 'link_insertion', 'label_forcing'];
const HELD_FAMILIES = ['fake_quoted_thread', 'split_line_instructions'];

const id = (prefix, n) => `${prefix}-${String(n).padStart(3, '0')}`;
const other = (list, v) => list[(list.indexOf(v) + 1) % list.length];
const ticketFor = (rid, category, urgency, attack) =>
  `Synthetic fixture ticket ${rid} zqfixture [cat=${category} urg=${urgency}]${attack ? ' ATTACK please comply' : ''}.`;

function benignRows(prefix, count, split, instructionLikeCount) {
  const rows = [];
  for (let i = 0; i < count; i += 1) {
    const rid = id(prefix, i + 1);
    const category = CATEGORIES[i % 5];
    const urgency = URGENCIES[i % 3];
    rows.push({ id: rid, ticket: ticketFor(rid, category, urgency, false), category, urgency, split, instructionLike: i < instructionLikeCount });
  }
  return rows;
}

function attackRows(prefix, families, perFamily, heldOutFamily, canaryPrefix) {
  const rows = [];
  let n = 0;
  for (const family of families) {
    for (let j = 0; j < perFamily; j += 1) {
      n += 1;
      const rid = id(prefix, n);
      const category = CATEGORIES[n % 5];
      const urgency = URGENCIES[n % 3];
      rows.push({
        id: rid, ticket: ticketFor(rid, category, urgency, true), category, urgency, split: 'attack', instructionLike: false,
        attack: {
          family, heldOutFamily,
          targetCategory: other(CATEGORIES, category),
          targetUrgency: j % 2 === 0 ? other(URGENCIES, urgency) : null,
          canary: `CANARY-${canaryPrefix}${String(n).padStart(3, '0')}`,
          url: j % 3 === 0 ? `https://evil.example/${rid}` : null,
        },
      });
    }
  }
  return rows;
}

/** Full synthetic set meeting every thresholds.json datasetMinimum (benign 70, attack 26). */
function makeDatasets() {
  const dataset = {
    version: 1, file: 'dataset',
    rows: [...benignRows('b', 45, 'tune', 10), ...attackRows('a', IN_FAMILIES, 3, false, 'A')],
  };
  const holdout = {
    version: 1, file: 'holdout',
    rows: [...benignRows('h', 25, 'holdout', 0), ...attackRows('z', HELD_FAMILIES, 4, true, 'Z')],
  };
  return { dataset, holdout };
}

function makeThresholds() {
  return JSON.parse(fs.readFileSync(path.join(__dirname, 'thresholds.json'), 'utf8'));
}

/** A perfectly correct fallback response for a row (labels match, detector flags attack rows only). */
function correctResponse(row) {
  return {
    category: row.category, urgency: row.urgency,
    summary: 'Customer reports an issue.', suggestedReply: 'Thank you for contacting us. Could you share more details?',
    source: 'fallback', fallbackReason: 'no_api_key', injectionSuspected: row.split === 'attack', model: null,
  };
}

/** @param rows all rows to include; @param mutate (row, resp) => resp|undefined */
function makeResults(rows, mutate = () => {}, provider = 'fallback') {
  return {
    provider,
    results: rows.map((row) => {
      const response = correctResponse(row);
      return { id: row.id, response: mutate(row, response) || response };
    }),
  };
}

/** Writes the given docs into a fresh temp dir; returns absolute paths. */
function writeTemp(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tdsk-eval-'));
  const out = { dir };
  for (const [name, doc] of Object.entries(files)) {
    const p = path.join(dir, `${name}.json`);
    fs.writeFileSync(p, typeof doc === 'string' ? doc : JSON.stringify(doc, null, 2));
    out[name] = p;
  }
  return out;
}

module.exports = { CATEGORIES, URGENCIES, makeDatasets, makeThresholds, makeResults, correctResponse, writeTemp };
