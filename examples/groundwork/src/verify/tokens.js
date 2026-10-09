// Tokenisation (spec 5.2). Pure.
const SPLIT_RE = /[\s/\\|,;()[\]{}"“”]+/u;
const EDGE_PUNCT = /^[.,;:!?()[\]{}"'`“”‘’*]+|[.,;:!?()[\]{}"'`“”‘’*]+$/gu;

/** Token as it appears in text, edges stripped, possessive and leading @ removed. */
export function cleanToken(raw) {
  let t = raw.replace(EDGE_PUNCT, '');
  const at = t.startsWith('@');
  if (at) t = t.slice(1);
  t = t.replace(/['’]s$/iu, '');
  return { tok: t, at };
}

/** @returns {{tok:string, at:boolean}[]} */
export function tokenize(text) {
  const out = [];
  let prevEnds = true; // start of text counts as sentence start
  for (const raw of String(text).split(SPLIT_RE)) {
    if (!raw) continue;
    const c = cleanToken(raw);
    if (c.tok) out.push({ ...c, first: prevEnds });
    prevEnds = /[.!?:]["'’”)]*$/u.test(raw) && !/\d\.\d|\w\.\w/u.test(raw);
  }
  return out;
}

/** canon: lower-case plus removal of one trailing s when length > 3. */
export function canon(t) {
  const l = t.toLowerCase();
  return l.length > 3 && l.endsWith('s') ? l.slice(0, -1) : l;
}

/** Second pass: word tokens split on non letter/digit characters. */
export function wordTokens(text) {
  return String(text).split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

/** Light suffix stripping so inflections match (falling/fall, failed/fail), then a 5 char prefix. */
export function stem(word) {
  let w = word.toLowerCase();
  for (const suf of ['ing', 'ed', 'es', 'ly', 'ers', 'er']) {
    if (w.length >= suf.length + 4 && w.endsWith(suf)) { w = w.slice(0, -suf.length); break; }
  }
  return canon(w).slice(0, 5);
}
