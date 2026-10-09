// Deterministic grounding verifier (spec 5). Pure functions, no I/O, no input mutation.
import { normalize } from './normalize.js';
import { tokenize, canon, wordTokens, stem } from './tokens.js';
import { STOPSET } from './stopwords.js';
import { UNIT_AFTER_RE, NUMBER_RE_SRC, canonUnit } from './units.js';

export const MIN_SUPPORT = 0.5;
export const REASONS = Object.freeze([
  'NO_CITE', 'MISSING_LINE', 'TIME_NOT_IN_SOURCE', 'NUMBER_NOT_IN_SOURCE',
  'NAME_NOT_IN_SOURCE', 'WEAK_SUPPORT',
]);

const TIME_TOKEN = /\b\d{2}:\d{2}\b/gu;
const PURE_TIME = /^\d{1,2}:\d{2}(?::\d{2})?$/u;
const PURE_NUMBER = /^\d+(?:\.\d+)?$/u;
const ISO_TOKEN = /^\d{4}-\d{2}-\d{2}[t ]\d{2}:\d{2}/iu;

const isStop = (lower) => STOPSET.has(lower) || STOPSET.has(canon(lower));
const numKey = (s) => String(Number(s));

function extractNumbers(normText) {
  const bare = normText.replace(TIME_TOKEN, ' ');
  const re = new RegExp(NUMBER_RE_SRC, 'gu');
  const out = [];
  let m;
  while ((m = re.exec(bare)) !== null) {
    const end = m.index + m[0].length;
    const unitRe = new RegExp(UNIT_AFTER_RE.source, UNIT_AFTER_RE.flags);
    unitRe.lastIndex = end;
    const u = unitRe.exec(bare);
    out.push({ value: numKey(m[0]), unit: u ? canonUnit(u[1]) : null });
  }
  return out;
}

function indexLine(line) {
  const time = normalize(line.time ?? '');
  const parts = [line.author ?? '', line.text ?? '', line.time ?? '', line.ts ?? ''];
  const norm = normalize(parts.join(' '));
  const cased = normalize(parts.join(' '), { fold: false });
  const nums = extractNumbers(normalize(`${line.author ?? ''} ${line.text ?? ''}`));
  return {
    times: new Set([time, ...(norm.match(TIME_TOKEN) ?? [])].filter((t) => /^\d{2}:\d{2}$/.test(t))),
    numbers: new Set(nums.map((n) => n.value)),
    pairs: new Set(nums.filter((n) => n.unit).map((n) => `${n.value}|${n.unit}`)),
    tokens: new Set(tokenize(cased).map((t) => canon(t.tok))),
    stems: new Set(wordTokens(norm).map(stem)),
    words: new Set(wordTokens(norm).filter((w) => w.length >= 3 && !isStop(w))),
  };
}

/**
 * @param {{n:number,time?:string,ts?:string|null,author:string,text:string}[]} lines
 * @param {string[]} [extraNames]
 */
export function buildContext(lines, extraNames = []) {
  const byN = new Map();
  const known = new Set();
  const addName = (s) => {
    const text = String(s);
    // Only short, name-like author strings are split into parts; a long free-text "author" must not
    // make ordinary words count as known names. Ordinary stop words are never added as parts.
    if (text.trim().split(/\s+/u).length > 3) return;
    for (const w of text.split(/[^\p{L}\p{N}_.-]+/u)) {
      if (w.length >= 3 && !isStop(w.toLowerCase())) known.add(canon(w));
    }
  };
  for (const line of lines) {
    byN.set(line.n, indexLine(line));
    if (line.author) {
      known.add(canon(String(line.author).trim()));
      addName(line.author);
    }
  }
  for (const n of extraNames) addName(n);
  return { byN, known, count: lines.length };
}

function union(sets) {
  const out = new Set();
  for (const s of sets) for (const v of s) out.add(v);
  return out;
}

// Sentence-initial capitalised ordinary words ("Roughly", "Billing") carry no name evidence.
// Only adverbs in -ly and gerunds in -ing qualify; they are still checked by WEAK_SUPPORT.
const PLAIN_OPENER = /^\p{Lu}\p{Ll}{3,}(?:ly|ing)$/u;

function isNameToken({ tok, at, first }, known) {
  if (!/[\p{L}\p{N}]/u.test(tok)) return false;
  const lower = tok.toLowerCase();
  if (PURE_TIME.test(tok) || PURE_NUMBER.test(tok) || ISO_TOKEN.test(tok)) return false;
  if (known.has(canon(tok))) return true; // (i)
  if (isStop(lower)) return false;
  if (at) return true; // (ii)
  if (first && PLAIN_OPENER.test(tok)) return false;
  if (/\d|_/u.test(tok) || /[\p{L}\d][-.][\p{L}\d]/u.test(tok) || /\p{Ll}\p{Lu}/u.test(tok)) return true; // (iii)
  return /^\p{Lu}/u.test(tok); // (iv)
}

// Honest derivation of a place adjective/demonym from a source place name: European <- Europe,
// Canadian <- Canada. The token must be purely alphabetic, at least 6 letters, carry one of the
// suffixes below and its base (>= 5 letters) must be a prefix of a purely alphabetic source token
// (or the reverse). Identifiers with digits or hyphens never qualify, and an unrelated place does not.
const DEMONYM_SUFFIXES = ['ian', 'ean', 'ese', 'ish', 'an'];
function derivedFromSource(tok, sourceTokens) {
  if (!/^\p{Lu}\p{Ll}{5,}$/u.test(tok)) return false;
  const lower = tok.toLowerCase();
  for (const suf of DEMONYM_SUFFIXES) {
    if (!lower.endsWith(suf)) continue;
    const base = lower.slice(0, -suf.length);
    if (base.length < 5) continue;
    for (const s of sourceTokens) {
      if (/^\p{L}{5,}$/u.test(s) && (s.startsWith(base) || base.startsWith(s))) return true;
    }
  }
  return false;
}

/**
 * @param {{text:string,cites:number[]}} stmt
 * @param {ReturnType<typeof buildContext>} ctx
 */
export function verifyStatement(stmt, ctx) {
  const reasons = [];
  const raw = Array.isArray(stmt?.cites) ? stmt.cites : [];
  const cites = [...new Set(raw)];
  if (cites.length === 0) return { status: 'flagged', reasons: [{ code: 'NO_CITE' }] };

  const present = [];
  for (const c of cites) {
    const entry = Number.isInteger(c) ? ctx.byN.get(c) : undefined;
    if (entry) present.push(entry);
    else reasons.push({ code: 'MISSING_LINE', detail: String(c) });
  }
  if (present.length === 0) return { status: 'flagged', reasons };

  const text = String(stmt?.text ?? '');
  const norm = normalize(text);
  const times = union(present.map((p) => p.times));
  const numbers = union(present.map((p) => p.numbers));
  const pairs = union(present.map((p) => p.pairs));
  const tokens = union(present.map((p) => p.tokens));
  const stems = union(present.map((p) => p.stems));
  const words = union(present.map((p) => p.words));

  // 3. times
  for (const t of new Set(norm.match(TIME_TOKEN) ?? [])) {
    if (!times.has(t)) reasons.push({ code: 'TIME_NOT_IN_SOURCE', detail: t });
  }

  // 4. numbers
  const seenNum = new Set();
  for (const n of extractNumbers(norm)) {
    const key = `${n.value}|${n.unit ?? ''}`;
    if (seenNum.has(key)) continue;
    seenNum.add(key);
    const ok = n.unit ? pairs.has(`${n.value}|${n.unit}`) : numbers.has(n.value);
    if (!ok) reasons.push({ code: 'NUMBER_NOT_IN_SOURCE', detail: n.unit ? `${n.value} ${n.unit}` : n.value });
  }

  // 5. names
  const seenName = new Set();
  for (const t of tokenize(normalize(text, { fold: false }))) {
    if (!isNameToken(t, ctx.known)) continue;
    const c = canon(t.tok);
    if (seenName.has(c)) continue;
    seenName.add(c);
    if (!tokens.has(c) && !derivedFromSource(t.tok, tokens)) reasons.push({ code: 'NAME_NOT_IN_SOURCE', detail: t.tok });
  }

  // 6. weak support
  // Unit words ("seconds" vs "2.8s") are checked with their number (rule 4); they count as support
  // when present in the source but an unmatched unit word is not held against the statement.
  // A statement word also counts as supported when it extends a source word of 3+ letters by 3+ letters
  // (max -> maximum, config -> configuration).
  const content = new Map();
  for (const w of wordTokens(norm)) {
    if (w.length < 4 || PURE_NUMBER.test(w) || isStop(w)) continue;
    if (canonUnit(w) && !stems.has(stem(w))) continue;
    content.set(stem(w), w);
  }
  const extendsSource = (w) => {
    for (const v of words) if (w.length - v.length >= 3 && w.startsWith(v)) return true;
    return false;
  };
  if (content.size >= 1) {
    let hit = 0;
    for (const [s, w] of content) if (stems.has(s) || extendsSource(w)) hit += 1;
    if (hit / content.size < MIN_SUPPORT) {
      reasons.push({ code: 'WEAK_SUPPORT', detail: (hit / content.size).toFixed(2) });
    }
  }

  return { status: reasons.length === 0 ? 'verified' : 'flagged', reasons };
}

/** Verifies every statement of a draft-like object `{sections: {name: [stmt]}}`. */
export function verifyDraft(draft, ctx) {
  const sections = {};
  for (const [name, list] of Object.entries(draft?.sections ?? {})) {
    sections[name] = (Array.isArray(list) ? list : []).map((s) => verifyStatement(s, ctx));
  }
  return { sections };
}
