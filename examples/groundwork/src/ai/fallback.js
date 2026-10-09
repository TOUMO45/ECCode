// Deterministic fallback extractor (spec 4). Pure: no clock, randomness or locale sorting.
// Every statement quotes a note line verbatim (so it verifies by construction) and is labelled by the provider flag.
import { validateDraft } from './schema.js';

export const FALLBACK_MODEL = 'fallback-extractor-v1';
const MAX_TIMELINE = 30;
const MAX_OTHER = 15;
const CUT = 240;

const RE_ACTION = /\b(action item|todo|follow[- ]?up|will|need(s)? to|should|owner|assigned|ticket)\b/i;
const RE_FACTOR = /\b(because|caused|cause|due to|root cause|regression|misconfig\w*|bug|failed|failure)\b/i;
const RE_IMPACT = /\b(customers?|users?|errors?|outage|down|latency|degraded|5\d\d|%)\b/i;

function cut(text) {
  const t = String(text).replace(/\s+/g, ' ').trim();
  if (t.length <= CUT) return t;
  const slice = t.slice(0, CUT);
  const sp = slice.lastIndexOf(' ');
  return (sp > 0 && t[CUT] !== ' ' ? slice.slice(0, sp) : slice).trim();
}

const quote = (l) => `${l.time} ${l.author}: ${cut(l.text)}`;
const stmt = (prefix, l) => ({ text: `${prefix}${quote(l)}`, cites: [l.n] });

// One timeline entry per distinct note time: the first line posted at that time. Notes written at
// the same minute usually describe one moment, and the first line is its opening statement.
function firstOfEachTime(sorted) {
  const out = [];
  for (const l of sorted) if (out.length === 0 || out[out.length - 1].time !== l.time) out.push(l);
  return out;
}

const MIN_TIME_GROUPS = 6; // below this the times carry too little structure; sample all lines instead

function pickTimeline(all) {
  const groups = firstOfEachTime(all);
  const sorted = groups.length >= MIN_TIME_GROUPS ? groups : all;
  if (sorted.length <= MAX_TIMELINE) return sorted;
  const chosen = new Set([0, sorted.length - 1]);
  const kw = [];
  sorted.forEach((l, i) => { if (!chosen.has(i) && (RE_ACTION.test(l.text) || RE_FACTOR.test(l.text) || RE_IMPACT.test(l.text))) kw.push(i); });
  for (const i of kw.slice(0, 14)) chosen.add(i);
  const rest = MAX_TIMELINE - chosen.size;
  for (let k = 0; k < rest; k++) {
    let i = Math.floor(((k + 0.5) * sorted.length) / rest);
    while (chosen.has(i) && i < sorted.length - 1) i += 1;
    while (chosen.has(i) && i > 0) i -= 1;
    chosen.add(i);
  }
  return [...chosen].sort((a, b) => a - b).map((i) => sorted[i]);
}

/** Pure function. `lines` are NoteLine objects. Returns a schema-valid DraftJSON. */
export function buildFallbackDraft(lines) {
  const sorted = [...lines].sort((a, b) => a.n - b.n);
  const draft = { summary: [], impact: [], timeline: [], contributingFactors: [], actionItems: [] };
  if (sorted.length > 0) {
    draft.summary.push(stmt('First note: ', sorted[0]));
    if (sorted.length > 1) draft.summary.push(stmt('Last note: ', sorted[sorted.length - 1]));
  }
  draft.timeline = pickTimeline(sorted).map((l) => ({ text: quote(l), cites: [l.n] }));
  const take = (re, prefix) => sorted.filter((l) => re.test(l.text)).slice(0, MAX_OTHER).map((l) => stmt(prefix, l));
  draft.impact = take(RE_IMPACT, 'Impact: ');
  draft.contributingFactors = take(RE_FACTOR, 'Possible factor: ');
  draft.actionItems = take(RE_ACTION, 'Action item: ');
  const v = validateDraft(draft);
  if (!v.ok) throw new Error('fallback produced an invalid draft'); // programming error, covered by tests
  return v.draft;
}

export function createFallbackProvider() {
  return {
    id: 'fallback',
    isFallback: true,
    async available() {
      return true;
    },
    async generate({ lines }) {
      return {
        draft: buildFallbackDraft(lines),
        usage: { model: FALLBACK_MODEL, inputTokens: 0, outputTokens: 0, costUsd: 0, durationMs: 0, attempts: 1 },
      };
    },
  };
}
