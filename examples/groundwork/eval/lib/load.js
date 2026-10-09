// Dataset loading and strict validation (spec 8.1).
import fs from 'node:fs';
import path from 'node:path';
import { compile } from '../../src/lib/schema.js';

const INT_ARR = { type: 'array', minItems: 1, items: { type: 'integer', minimum: 1 } };
const SECTION = { type: 'string', enum: ['summary', 'impact', 'timeline', 'contributingFactors', 'actionItems'] };
export const INCIDENT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'title', 'severity', 'startedAt', 'lines', 'gold', 'correctStatements'],
  properties: {
    id: { type: 'string', minLength: 1, maxLength: 64 },
    title: { type: 'string', minLength: 1, maxLength: 300 },
    severity: { type: 'string', minLength: 1, maxLength: 16 },
    startedAt: { type: 'string', minLength: 1, maxLength: 40 },
    lines: {
      type: 'array', minItems: 1, maxItems: 2000,
      items: {
        type: 'object', additionalProperties: false, required: ['n', 'time', 'author', 'text'],
        properties: {
          n: { type: 'integer', minimum: 1 }, time: { type: 'string', minLength: 1, maxLength: 40 },
          author: { type: 'string', minLength: 1, maxLength: 64 }, text: { type: 'string', minLength: 1, maxLength: 2000 },
        },
      },
    },
    gold: {
      type: 'object', additionalProperties: false, required: ['timeline', 'actions'],
      properties: {
        timeline: { type: 'array', minItems: 1, items: { type: 'object', additionalProperties: false, required: ['time', 'lines'], properties: { time: { type: 'string', minLength: 1 }, lines: INT_ARR } } },
        actions: { type: 'array', minItems: 1, items: { type: 'object', additionalProperties: false, required: ['lines'], properties: { lines: INT_ARR } } },
      },
    },
    correctStatements: {
      type: 'array',
      items: { type: 'object', additionalProperties: false, required: ['section', 'text', 'cites'], properties: { section: SECTION, text: { type: 'string', minLength: 1 }, cites: INT_ARR } },
    },
    injection: {
      type: 'object', additionalProperties: false, required: ['canary', 'injectionLines'],
      properties: { canary: { type: 'string', minLength: 4 }, kind: { type: 'string' }, injectionLines: INT_ARR },
    },
  },
};
const check = compile(INCIDENT_SCHEMA);

function readDir(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort().map((f) => {
    let doc;
    try { doc = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { throw new Error(`${f}: invalid JSON`); }
    const r = check(doc);
    if (!r.valid) throw new Error(`${f}: ${r.errors.map((e) => `${e.path} ${e.message}`).join('; ')}`);
    const n = doc.lines.length;
    doc.lines.forEach((l, i) => { if (l.n !== i + 1) throw new Error(`${f}: line numbers must be 1..${n} in order`); });
    const refs = [...doc.gold.timeline, ...doc.gold.actions, ...doc.correctStatements.map((c) => ({ lines: c.cites })), ...(doc.injection ? [{ lines: doc.injection.injectionLines }] : [])];
    for (const g of refs) if (g.lines.some((x) => x > n)) throw new Error(`${f}: line reference beyond ${n}`);
    return doc;
  });
}

/** @returns {{incidents:object[], injections:object[]}} */
export function loadSet(evalDir, holdout) {
  const root = path.join(evalDir, holdout ? 'holdout' : 'tune');
  const incidents = readDir(path.join(root, 'incidents'));
  const injections = readDir(path.join(root, 'injections'));
  for (const d of injections) if (!d.injection) throw new Error(`${d.id}: injection case without injection block`);
  return { incidents, injections };
}

/** Verifier corpus: fabrications, correct statements and notes files, keyed by notes id. */
export function loadVerifierCorpus(evalDir) {
  const v = path.join(evalDir, 'verifier');
  const rd = (f) => JSON.parse(fs.readFileSync(path.join(v, f), 'utf8'));
  const notes = {};
  const nd = path.join(v, 'notes');
  for (const f of fs.readdirSync(nd).filter((x) => x.endsWith('.json')).sort()) {
    const d = JSON.parse(fs.readFileSync(path.join(nd, f), 'utf8'));
    notes[d.id] = d;
  }
  return { fabrications: rd('fabrications.json'), correct: rd('correct.json'), notes };
}
