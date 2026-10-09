'use strict';
// Evidence is produced by the toolkit, not asserted by agents: commands are
// executed here and their exit code, duration and a log digest are recorded.
// Reviews and lessons may only cite evidence that exists in the record.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { newId, isId, own, sha256, sha256File, writeFileAtomic, EccodeError, exists } = require('./util');
const { projectRelative } = require('./project');

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
  writeFileAtomic(path.join(store.root, logRel), `$ ${shownCommand}\n# cwd: ${projectRelative(store.root, workDir) || '.'}\n# exit: ${exitCode}\n${output}`);
  const data = {
    id,
    kind: 'command',
    label: redact(String(label)), // a secret typed into --label must not reach the record either
    command: shownCommand,
    cwd: projectRelative(store.root, workDir) || '.',
    purpose,
    exitCode,
    status: exitCode === 0 ? 'passed' : 'failed',
    timedOut: Boolean(timedOut),
    durationMs,
    log: logRel,
    logSha256: sha256(output),
    outputTail: tail(output, 25),
    gate: gate || null,
    task: task || null,
  };
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
 * Resolve an evidence reference ("ev:<id>" or "artifact:<path>[#anchor]").
 * Returns {ok, reason?, evidence?}.
 */
function resolveRef(state, root, ref, { allowedArtifacts } = {}) {
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
    return { ok: true, evidence: ev };
  }
  if (ref.startsWith('artifact:')) {
    const p = ref.slice('artifact:'.length).split('#')[0];
    let rel;
    try {
      rel = projectRelative(root, p);
    } catch {
      return { ok: false, reason: `${ref} points outside the project` };
    }
    if (allowedArtifacts && !allowedArtifacts.includes(rel)) {
      return { ok: false, reason: `${ref} is not part of the submission under review` };
    }
    if (!exists(path.join(root, rel))) return { ok: false, reason: `${ref} does not exist on disk` };
    return { ok: true, artifact: rel };
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

module.exports = { runCommand, recordFile, resolveRef, redact, deepRedact };
