'use strict';
// Evidence is produced by the toolkit, not asserted by agents: commands are
// executed here and their exit code, duration, log digests and the digest of
// the source tree they ran on are recorded. Reviews, handoffs and lessons may
// only cite evidence that exists in the record and whose log is still the one
// that was written; artifact anchors cited by reviews must exist in the file.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { newId, isId, own, sha256, sha256File, writeFileAtomic, EccodeError, exists } = require('./util');
const { projectRelative, treeDigest } = require('./project');

// A capture group, when present, is the prefix kept in front of [REDACTED].
const SECRET_PATTERNS = [
  /sk-ant-[A-Za-z0-9_-]{10,}/g,
  /sk-[A-Za-z0-9]{20,}/g,
  /AKIA[0-9A-Z]{16}/g,
  /gh[pousr]_[A-Za-z0-9]{20,}/g,
  /xox[abpr]-[A-Za-z0-9-]{10,}/g,
  // key=value, "key": "value", key: 'value' (env, JSON, util.inspect), including
  // names that only contain the keyword (AWS_SECRET_ACCESS_KEY, client_secret).
  /((?:api[_-]?key|secret|token|password|passwd|private[_-]?key|access[_-]?key|credentials?)[\w-]*["']?\s*[=:]\s*)["']?[^\s"',;}]{6,}["']?/gi,
  // Authorization: Bearer <token>
  /(\bBearer\s+)[A-Za-z0-9._~+/=-]{16,}/gi,
  // scheme://user:password@host (the password)
  /([a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)[^\s/@]+(?=@)/gi,
];

function redact(text) {
  let out = text;
  for (const re of SECRET_PATTERNS) {
    out = out.replace(re, (m, prefix) => (typeof prefix === 'string' && m.startsWith(prefix) ? `${prefix}[REDACTED]` : '[REDACTED]'));
  }
  return out;
}

function tail(text, lines = 30) {
  const all = text.split('\n');
  return all.slice(Math.max(0, all.length - lines)).join('\n');
}

/** The header every command log starts with; the output follows it. */
function logHeader(ev) {
  return `$ ${ev.command}\n# cwd: ${ev.cwd}\n# exit: ${ev.exitCode}\n`;
}

/**
 * Execute a shell command and record the outcome.
 * purpose: 'check' (normal verification) or 'reproduction' (expected to
 * demonstrate a failure before a fix).
 */
function runCommand(store, actor, { label, command, cwd, gate, task, purpose = 'check', timeoutMs = 600000 }) {
  if (!command) throw new EccodeError('INVALID_INPUT', 'evidence run requires a command');
  if (!label) throw new EccodeError('INVALID_INPUT', 'evidence run requires --label');
  if (!(Number.isInteger(timeoutMs) && timeoutMs > 0)) throw new EccodeError('INVALID_INPUT', `timeout must be a positive whole number of milliseconds (got ${timeoutMs})`);
  const workDir = cwd ? path.join(store.root, projectRelative(store.root, cwd)) : store.root;
  const started = Date.now();
  const res = spawnSync(command, {
    cwd: workDir,
    shell: true,
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 32 * 1024 * 1024,
    env: { ...process.env, ECCODE_EVIDENCE: '1' },
  });
  const durationMs = Date.now() - started;
  const timedOut = res.error && res.error.code === 'ETIMEDOUT';
  const output = redact(`${res.stdout || ''}${res.stderr ? `\n[stderr]\n${res.stderr}` : ''}${res.error ? `\n[error] ${res.error.message}` : ''}`);
  const exitCode = typeof res.status === 'number' ? res.status : timedOut ? 124 : 1;
  const shownCommand = redact(command); // secrets on the command line must not reach the record either
  const id = newId('ev');
  const logRel = `.eccode/evidence/${id}.log`;
  const cwdRel = projectRelative(store.root, workDir) || '.';
  const content = `${logHeader({ command: shownCommand, cwd: cwdRel, exitCode })}${output}`;
  writeFileAtomic(path.join(store.root, logRel), content);
  const data = {
    id,
    kind: 'command',
    label: redact(String(label)), // a secret typed into --label must not reach the record either
    command: shownCommand,
    cwd: cwdRel,
    purpose,
    exitCode,
    status: exitCode === 0 ? 'passed' : 'failed',
    timedOut: Boolean(timedOut),
    durationMs,
    log: logRel,
    logSha256: sha256(output),
    logFileSha256: sha256(content), // the exact bytes written; citing the evidence re-checks them
    outputTail: tail(output, 25),
    gate: gate || null,
    task: task || null,
  };
  // The tree the check ran on. Only present with git, so records made without it replay unchanged.
  const tree = treeDigest(store.root);
  if (tree) data.tree = tree;
  store.commit('evidence.recorded', actor, data);
  return data;
}

/** Record that a file was inspected, pinning its content hash. */
function recordFile(store, actor, { label, file, note, gate, task }) {
  const rel = projectRelative(store.root, file);
  const abs = path.join(store.root, rel);
  if (!exists(abs) || !fs.statSync(abs).isFile()) throw new EccodeError('NOT_FOUND', `Not a regular file: ${rel}`);
  const data = {
    id: newId('ev'),
    kind: 'file',
    label: redact(String(label || `inspected ${rel}`)),
    path: rel,
    sha256: sha256File(abs),
    bytes: fs.statSync(abs).size,
    note: note ? redact(String(note)) : null,
    status: 'recorded',
    gate: gate || null,
    task: task || null,
  };
  store.commit('evidence.recorded', actor, data);
  return data;
}

/** How a file pinned by file evidence differs from the pin (null = unchanged). */
function fileChangedSince(root, ev) {
  const abs = path.join(root, ev.path);
  if (!exists(abs)) return 'was deleted since it was recorded';
  try {
    return fs.statSync(abs).isFile() && sha256File(abs) === ev.sha256 ? null : 'changed since it was recorded';
  } catch {
    return 'is no longer readable';
  }
}

/**
 * Why the log of command evidence is no longer the one recorded (null = intact). Records carry the digest
 * of the whole file; older ones digest the output only, so their header (which the record describes, and
 * which may span lines when the command does) is stripped before comparing.
 */
function logChangedSince(root, ev) {
  if (!ev.log) return null;
  let bytes;
  try {
    bytes = fs.readFileSync(path.join(root, ev.log));
  } catch {
    return 'the file is missing';
  }
  if (ev.logFileSha256) return sha256(bytes) === ev.logFileSha256 ? null : 'its content no longer matches the recorded digest';
  const header = Buffer.from(logHeader(ev));
  if (bytes.length >= header.length && bytes.subarray(0, header.length).equals(header) && sha256(bytes.subarray(header.length)) === ev.logSha256) return null;
  const body = bytes.toString('utf8').split('\n').slice(3).join('\n');
  return sha256(body) === ev.logSha256 ? null : 'its content no longer matches the recorded digest';
}

/** Markdown headings (the text after the #s), trimmed and lower-cased. */
function headings(markdown) {
  return markdown
    .split('\n')
    .filter((l) => /^#{1,6}\s/.test(l))
    .map((l) => l.replace(/^#+\s*/, '').trim().toLowerCase());
}

/** GitHub-style heading slug: lower-case, punctuation dropped, spaces to hyphens. */
function slug(text) {
  return String(text).trim().toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, '').replace(/\s+/g, '-');
}

/** Does the dot path (a.b.0.c; an array element may be named by its `id`) exist in the parsed JSON? */
function jsonPathExists(doc, dotPath) {
  let cur = doc;
  for (const seg of dotPath.split('.')) {
    if (Array.isArray(cur)) {
      const idx = /^\d+$/.test(seg) ? Number(seg) : cur.findIndex((x) => x && typeof x === 'object' && x.id === seg);
      if (idx < 0 || idx >= cur.length) return false;
      cur = cur[idx];
    } else if (cur && typeof cur === 'object' && Object.prototype.hasOwnProperty.call(cur, seg)) {
      cur = cur[seg];
    } else {
      return false;
    }
  }
  return true;
}

function lineCount(text) {
  if (text === '') return 0;
  return text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
}

/**
 * Why an artifact anchor does not point at anything (null = it does): Markdown anchors name a heading
 * (its text, any case, or its slug), JSON anchors a dot path, anchors in any other file a line (L12)
 * or a line range (L12-L20).
 */
function anchorProblem(root, rel, anchor) {
  const abs = path.join(root, rel);
  const ext = path.extname(rel).toLowerCase();
  if (ext === '.md' || ext === '.markdown') {
    const hs = headings(fs.readFileSync(abs, 'utf8'));
    const want = anchor.trim().toLowerCase();
    if (hs.some((h) => h === want || slug(h) === slug(want))) return null;
    const shown = hs.slice(0, 20).map((h) => `"${h}"`);
    if (hs.length > 20) shown.push(`… ${hs.length - 20} more`);
    return `anchor "#${anchor}" not found in ${rel} (headings: ${shown.join(', ') || 'none'}); cite a heading of the file`;
  }
  if (ext === '.json') {
    let doc;
    try {
      doc = JSON.parse(fs.readFileSync(abs, 'utf8'));
    } catch {
      return `anchor "#${anchor}" cannot be checked: ${rel} is not valid JSON`;
    }
    return jsonPathExists(doc, anchor) ? null : `anchor "#${anchor}" not found in ${rel}; cite a dot path that exists (phases.0.id, tasks.<id>)`;
  }
  const m = /^L(\d+)(?:-L?(\d+))?$/.exec(anchor.trim());
  if (!m) return `anchor "#${anchor}" is not a line reference; cite ${rel}#L<n> or #L<a>-L<b>`;
  const lines = lineCount(fs.readFileSync(abs, 'utf8'));
  const from = Number(m[1]);
  const to = m[2] ? Number(m[2]) : from;
  return from >= 1 && to >= from && to <= lines ? null : `anchor "#${anchor}" is outside ${rel} (${lines} line(s))`;
}

/**
 * Resolve an evidence reference ("ev:<id>" or "artifact:<path>[#anchor]").
 * Returns {ok, reason?, evidence?, artifact?, anchor?}. Command evidence resolves only while its log is the
 * one recorded; with validateAnchor (reviews), an artifact anchor must exist in the file.
 */
function resolveRef(state, root, ref, { allowedArtifacts, validateAnchor = false } = {}) {
  if (ref.startsWith('ev:')) {
    const id = ref.slice(3);
    if (!isId('ev', id)) return { ok: false, reason: `${ref} is not an evidence id (ev:ev-…)` };
    const ev = own(state.evidence, id);
    if (!ev) return { ok: false, reason: `${ref} does not exist in the project record` };
    if (ev.kind === 'file') {
      // File evidence pins content: citing it vouches for the file as it is now.
      const stale = fileChangedSince(root, ev);
      if (stale) return { ok: false, reason: `${ref} pins ${ev.path}, which ${stale}; record it again (eccode evidence file)` };
    }
    if (ev.kind === 'command') {
      const damaged = logChangedSince(root, ev);
      if (damaged) return { ok: false, reason: `${ref}: log ${ev.log} was deleted or changed since it was recorded; run the check again (eccode evidence run) - ${damaged}` };
    }
    return { ok: true, evidence: ev };
  }
  if (ref.startsWith('artifact:')) {
    const body = ref.slice('artifact:'.length);
    const hash = body.indexOf('#');
    const p = hash === -1 ? body : body.slice(0, hash);
    const anchor = hash === -1 ? '' : body.slice(hash + 1);
    let rel;
    try {
      rel = projectRelative(root, p);
    } catch {
      return { ok: false, reason: `${ref} points outside the project` };
    }
    if (allowedArtifacts && !allowedArtifacts.includes(rel)) {
      return { ok: false, reason: `${ref} is not part of the submission under review` };
    }
    const abs = path.join(root, rel);
    if (!exists(abs)) return { ok: false, reason: `${ref} does not exist on disk` };
    if (validateAnchor && anchor) {
      let problem;
      try {
        problem = fs.statSync(abs).isFile() ? anchorProblem(root, rel, anchor) : `${rel} is not a file`;
      } catch (err) {
        problem = `${rel} could not be read (${err.message})`;
      }
      if (problem) return { ok: false, reason: `${ref}: ${problem}` };
    }
    return anchor ? { ok: true, artifact: rel, anchor } : { ok: true, artifact: rel };
  }
  return { ok: false, reason: `${ref} is not an ev: or artifact: reference` };
}

/** Redact every string inside a JSON-like value (handoffs, reviews, labels) before it enters the record. */
function deepRedact(value) {
  if (typeof value === 'string') return redact(value);
  if (Array.isArray(value)) return value.map(deepRedact);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, deepRedact(v)]));
  return value;
}

module.exports = { runCommand, recordFile, resolveRef, redact, deepRedact, headings, slug };
