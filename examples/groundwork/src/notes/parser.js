// Notes parser (spec 3.5). Pure; all-or-nothing; physical line numbers in errors.
export const NOTE_LIMITS = Object.freeze({ maxLines: 2000, maxText: 2000, maxAuthor: 64, maxErrors: 20 });

const LINE_RE = /^\[?(?<time>\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?|\d{1,2}:\d{2}(?::\d{2})?)\]?\s+(?<author>[^:\s][^:]{0,63}?):\s+(?<text>\S.*)$/u;
const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(?:Z|[+-](\d{2}):?(\d{2}))?$/u;
const CLOCK_RE = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/u;
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u0008\u000a-\u001f\u007f-\u009f]/u;

const pad = (n) => String(n).padStart(2, '0');

/** @returns {{time:string, ts:string|null}|{error:string}} */
export function parseTime(raw) {
  let m = ISO_RE.exec(raw);
  if (m) {
    const [, y, mo, d, h, mi, s, zh, zm] = m;
    const dt = new Date(Date.UTC(+y, +mo - 1, +d));
    if (dt.getUTCFullYear() !== +y || dt.getUTCMonth() !== +mo - 1 || dt.getUTCDate() !== +d) {
      return { error: 'Invalid date in timestamp' };
    }
    if (+h > 23 || +mi > 59 || (s !== undefined && +s > 59)) return { error: 'Invalid time of day' };
    if (zh !== undefined && (+zh > 23 || +zm > 59)) return { error: 'Invalid timezone offset' };
    return { time: `${pad(+h)}:${mi}`, ts: raw };
  }
  m = CLOCK_RE.exec(raw);
  if (m) {
    const [, h, mi, s] = m;
    if (+h > 23 || +mi > 59 || (s !== undefined && +s > 59)) return { error: 'Invalid time of day' };
    return { time: `${pad(+h)}:${mi}`, ts: null };
  }
  return { error: 'Unrecognised time' };
}

function checkFields(author, text) {
  if (author.length < 1 || author.length > NOTE_LIMITS.maxAuthor) return 'Author must be 1 to 64 characters';
  if (text.length < 1 || text.length > NOTE_LIMITS.maxText) return 'Text must be 1 to 2000 characters';
  if (CONTROL_RE.test(author) || CONTROL_RE.test(text)) return 'Control characters are not allowed';
  return null;
}

function parseText(content) {
  const lines = [];
  const errors = [];
  const physical = content.split('\n');
  let n = 0;
  for (let i = 0; i < physical.length; i += 1) {
    const rawLine = physical[i].endsWith('\r') ? physical[i].slice(0, -1) : physical[i];
    const line = rawLine.trim();
    if (line === '') continue;
    if (n >= NOTE_LIMITS.maxLines) {
      errors.push({ line: i + 1, message: 'Too many note lines (max 2000)' });
      break;
    }
    n += 1;
    if (CONTROL_RE.test(line)) { errors.push({ line: i + 1, message: 'Control characters are not allowed' }); continue; }
    const m = LINE_RE.exec(line);
    if (!m) { errors.push({ line: i + 1, message: 'Expected "HH:MM author: text"' }); continue; }
    const t = parseTime(m.groups.time);
    if (t.error) { errors.push({ line: i + 1, message: t.error }); continue; }
    const author = m.groups.author.trim();
    const text = m.groups.text.trim();
    const bad = checkFields(author, text);
    if (bad) { errors.push({ line: i + 1, message: bad }); continue; }
    lines.push({ n, time: t.time, ts: t.ts, author, text });
  }
  return { lines, errors };
}

function parseJson(content) {
  const lines = [];
  const errors = [];
  if (content.length > NOTE_LIMITS.maxLines) {
    errors.push({ line: NOTE_LIMITS.maxLines + 1, message: 'Too many note lines (max 2000)' });
    return { lines, errors };
  }
  content.forEach((item, i) => {
    const line = i + 1;
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      errors.push({ line, message: 'Each note must be an object' }); return;
    }
    const extra = Object.keys(item).filter((k) => !['time', 'author', 'text'].includes(k));
    if (extra.length) { errors.push({ line, message: 'Unknown field in note' }); return; }
    if (typeof item.time !== 'string' || typeof item.author !== 'string' || typeof item.text !== 'string') {
      errors.push({ line, message: 'time, author and text must be strings' }); return;
    }
    const t = parseTime(item.time.trim().replace(/^\[|\]$/gu, ''));
    if (t.error) { errors.push({ line, message: t.error }); return; }
    const author = item.author.trim();
    const text = item.text.trim();
    const bad = checkFields(author, text);
    if (bad) { errors.push({ line, message: bad }); return; }
    lines.push({ n: lines.length + 1, time: t.time, ts: t.ts, author, text });
  });
  return { lines, errors };
}

/**
 * @param {{format:'text',content:string}|{format:'json',content:object[]}} input
 * @returns {{ok:true, lines:object[]}|{ok:false, errors:{line:number,message:string}[], total:number}}
 */
export function parseNotes(input) {
  let res;
  if (input?.format === 'text' && typeof input.content === 'string') res = parseText(input.content);
  else if (input?.format === 'json' && Array.isArray(input.content)) res = parseJson(input.content);
  else return { ok: false, errors: [{ line: 0, message: 'Unsupported format or content type' }], total: 1 };
  if (res.errors.length > 0) {
    return { ok: false, errors: res.errors.slice(0, NOTE_LIMITS.maxErrors), total: res.errors.length };
  }
  if (res.lines.length === 0) return { ok: false, errors: [{ line: 0, message: 'At least one note line is required' }], total: 1 };
  return { ok: true, lines: res.lines };
}
