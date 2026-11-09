'use strict';
// S3.1 I4 (L-GF-89): the engine's rejection log. Every Greenfield-Senior rule refusal raised through a managed entry
// point (wrap.js, the action->role matrix, the hidden-suite read allowlist in the PreToolUse guard) is appended to
// <project>/.eccode/rejections.jsonl, one entry per refusal: { seq, ts, actor, action, rule, reason, data?, prevHash,
// hash }, hash-chained the same way as events.jsonl (hash = sha256(prevHash + JSON of the entry without its hash)).
// .eccode/rejections.head holds the last { seq, hash }, so a removed tail is detected too. Both files are record files
// for the guard (written only by the engine).
//
// Redaction happens before anything is written: values under keys that name a secret are replaced, and every secret
// value (the ECCODE_SEED_KEY value, the value of any environment variable whose name names a secret, and the values
// found under secret keys of the data) is scrubbed from every string, the reason included.
const fs = require('fs');
const path = require('path');
const { sha256, withLock, ensureDir, isoNow } = require('../util');

const GENESIS = '0'.repeat(64);
const SECRET_KEY = /pass(word)?|secret|token|key|authorization/i;
const REDACTED = '[redacted]';
const MIN_SECRET = 4;
const MAX_STRING = 2000;

const dirOf = (root) => path.join(path.resolve(root), '.eccode');
const fileOf = (root) => path.join(dirOf(root), 'rejections.jsonl');
const headOf = (root) => path.join(dirOf(root), 'rejections.head');
const lockOf = (root) => path.join(dirOf(root), 'rejections.lock');

/** The secret values of the environment: ECCODE_SEED_KEY and any variable whose name names a secret. */
function envSecrets(env = process.env) {
  const out = [];
  for (const [k, v] of Object.entries(env)) {
    if ((k === 'ECCODE_SEED_KEY' || SECRET_KEY.test(k)) && typeof v === 'string' && v.length >= MIN_SECRET) out.push(v);
  }
  return out;
}

/** Values found under secret keys anywhere in `data` (strings and numbers). */
function dataSecrets(data, out = [], depth = 0) {
  if (depth > 20 || data === null || typeof data !== 'object') return out;
  for (const [k, v] of Object.entries(data)) {
    if (SECRET_KEY.test(k) && (typeof v === 'string' || typeof v === 'number') && String(v).length >= MIN_SECRET) out.push(String(v));
    else if (SECRET_KEY.test(k) && v && typeof v === 'object') collectLeaves(v, out, depth + 1);
    else dataSecrets(v, out, depth + 1);
  }
  return out;
}
function collectLeaves(v, out, depth) {
  if (depth > 20) return;
  if (typeof v === 'string' || typeof v === 'number') { if (String(v).length >= MIN_SECRET) out.push(String(v)); return; }
  if (v && typeof v === 'object') for (const x of Object.values(v)) collectLeaves(x, out, depth + 1);
}

function scrub(text, secrets) {
  let s = String(text);
  // Longest first, so a secret containing another is replaced whole.
  for (const v of [...secrets].sort((a, b) => b.length - a.length)) if (v) s = s.split(v).join(REDACTED);
  return s.length > MAX_STRING ? `${s.slice(0, MAX_STRING)}...` : s;
}

/** A copy of `value` with secret keys' values replaced and every secret value scrubbed from every string. */
function redact(value, secrets, depth = 0) {
  if (depth > 20) return REDACTED;
  if (typeof value === 'string') return scrub(value, secrets);
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.slice(0, 100).map((v) => redact(v, secrets, depth + 1));
  const out = {};
  for (const [k, v] of Object.entries(value)) out[scrub(k, secrets)] = SECRET_KEY.test(k) ? REDACTED : redact(v, secrets, depth + 1);
  return out;
}

function readLines(root) {
  let text = '';
  try { text = fs.readFileSync(fileOf(root), 'utf8'); } catch { return []; }
  return text.split('\n').filter((l) => l.trim());
}

/**
 * Append one entry under the log's lock. `entry`: { actor, action, rule, reason, data? }. Returns the written entry.
 * Only for a project root (a directory holding .eccode/); elsewhere nothing is written and null is returned.
 */
function record(root, { actor, action, rule, reason, data } = {}, { env = process.env } = {}) {
  if (!fs.existsSync(dirOf(root))) return null;
  const secrets = [...envSecrets(env), ...dataSecrets(data)];
  return withLock(lockOf(root), () => {
    ensureDir(dirOf(root));
    const lines = readLines(root);
    let last = null;
    for (let i = lines.length - 1; i >= 0 && !last; i--) { try { last = JSON.parse(lines[i]); } catch { /* torn tail */ } }
    const prevHash = (last && last.hash) || GENESIS;
    const body = {
      seq: ((last && last.seq) || 0) + 1,
      ts: isoNow(),
      actor: scrub(actor || 'unknown', secrets),
      action: scrub(action || 'unknown', secrets),
      rule: scrub(rule || 'unknown', secrets),
      reason: scrub(reason || '', secrets),
      ...(data === undefined ? {} : { data: redact(data, secrets) }),
      prevHash,
    };
    const entry = { ...body, hash: sha256(prevHash + JSON.stringify(body)) };
    fs.appendFileSync(fileOf(root), `${JSON.stringify(entry)}\n`);
    fs.writeFileSync(headOf(root), `${JSON.stringify({ seq: entry.seq, hash: entry.hash })}\n`);
    return entry;
  });
}

/**
 * Log a refusal error (a GF_RULE EccodeError) once: the error is marked, so an outer managed entry point that sees
 * the same error again does not write a second entry. A failure to write is reported on stderr and on the error; the
 * refusal itself always stands.
 */
function recordError(root, { actor, action, data }, err) {
  if (!err || err.code !== 'GF_RULE' || err.rejectionLogged) return null;
  const problems = (err.details && err.details.problems) || [];
  const rules = [...new Set(problems.map((p) => p.rule).filter(Boolean))];
  try {
    const entry = record(root, { actor, action, rule: rules[0] || 'GF-UNKNOWN', reason: problems.length ? problems.map((p) => `${p.rule}: ${p.message}`).join('\n') : err.message, data: { ...(data || {}), ...(rules.length > 1 ? { rules } : {}) } });
    try { Object.defineProperty(err, 'rejectionLogged', { value: true, enumerable: false, configurable: true }); } catch { /* frozen error */ }
    return entry;
  } catch (e) {
    process.stderr.write(`eccode: the rejection log could not be written: ${e.message}\n`);
    return null;
  }
}

/** Run `fn`; a GF rule refusal it raises is logged once, then the same error is rethrown. */
function logged(root, ctx, fn) {
  try { return fn(); } catch (err) { recordError(root, ctx, err); throw err; }
}

/** Verify the chain and the head: { ok, errors, count }. */
function verify(root) {
  const errors = [];
  let prev = GENESIS;
  let seq = 0;
  const lines = readLines(root);
  lines.forEach((line, i) => {
    let ev;
    try { ev = JSON.parse(line); } catch { errors.push(`line ${i + 1}: not valid JSON`); return; }
    const { hash, ...body } = ev;
    if (ev.seq !== seq + 1) errors.push(`entry ${ev.seq}: expected seq ${seq + 1} (an entry was removed or reordered)`);
    if (ev.prevHash !== prev) errors.push(`entry ${ev.seq}: prevHash does not link to the previous entry`);
    if (sha256(ev.prevHash + JSON.stringify(body)) !== hash) errors.push(`entry ${ev.seq}: content hash mismatch (rewritten after the fact)`);
    prev = hash;
    seq = ev.seq;
  });
  let head = null;
  try { head = JSON.parse(fs.readFileSync(headOf(root), 'utf8')); } catch { /* none */ }
  if (lines.length && !head) errors.push('rejections.head is missing');
  if (head && (head.seq !== seq || head.hash !== prev)) errors.push(`the log ends at entry ${seq} but the head records entry ${head.seq} (entries were removed or rewritten)`);
  return { ok: errors.length === 0, errors, count: lines.length };
}

module.exports = { record, recordError, logged, verify, redact, envSecrets, SECRET_KEY, fileOf, headOf };
