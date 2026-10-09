// DraftJSON: the strict shape every provider must return (spec 3.10).
// Also passed to `claude --json-schema`. The model output is never trusted:
// every provider result is re-validated here.
import { compile } from '../lib/schema.js';

export const DRAFT_SECTIONS = Object.freeze(['summary', 'impact', 'timeline', 'contributingFactors', 'actionItems']);
export const MAX_STATEMENTS_TOTAL = 100;

const STATEMENT = {
  type: 'object',
  additionalProperties: false,
  required: ['text', 'cites'],
  properties: {
    text: { type: 'string', minLength: 1, maxLength: 600 },
    cites: { type: 'array', maxItems: 20, items: { type: 'integer', minimum: 1, maximum: 2147483647 } },
  },
};

export const DRAFT_JSON_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: [...DRAFT_SECTIONS],
  properties: Object.fromEntries(
    DRAFT_SECTIONS.map((s) => [s, { type: 'array', maxItems: 30, items: STATEMENT }]),
  ),
});

const check = compile(DRAFT_JSON_SCHEMA);

/**
 * @returns {{ok:true, draft:object}|{ok:false, errors:{path:string,message:string}[]}}
 * On success the draft is a fresh copy containing only schema fields.
 */
export function validateDraft(value) {
  const r = check(value);
  if (!r.valid) return { ok: false, errors: r.errors };
  let total = 0;
  for (const s of DRAFT_SECTIONS) total += value[s].length;
  if (total > MAX_STATEMENTS_TOTAL) {
    return { ok: false, errors: [{ path: '', message: `must have at most ${MAX_STATEMENTS_TOTAL} statements in total` }] };
  }
  const draft = {};
  for (const s of DRAFT_SECTIONS) draft[s] = value[s].map((x) => ({ text: x.text, cites: [...x.cites] }));
  return { ok: true, draft };
}

/** Parses model text into a JSON value: plain JSON, fenced JSON, or the outermost {...}. Returns undefined if none. */
export function parseJsonText(text) {
  if (typeof text !== 'string') return undefined;
  let s = text.trim();
  const fence = /^```[A-Za-z0-9_-]*\s*\n?([\s\S]*?)\n?```$/.exec(s);
  if (fence) s = fence[1].trim();
  const tries = [s];
  const a = s.indexOf('{');
  const b = s.lastIndexOf('}');
  if (a >= 0 && b > a && (a > 0 || b < s.length - 1)) tries.push(s.slice(a, b + 1));
  for (const t of tries) {
    try {
      return JSON.parse(t);
    } catch {
      /* try next */
    }
  }
  return undefined;
}
