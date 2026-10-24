'use strict';
// Evidence is produced by the toolkit, not asserted by agents: commands are
// executed here and their exit code, duration and a log digest are recorded.
// Reviews and lessons may only cite evidence that exists in the record.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { newId, sha256, sha256File, writeFileAtomic, EccodeError, exists, commandEnv, withLock, sleepSync } = require('./util');
const { projectRelative } = require('./project');

const SECRET_PATTERNS = [
  /sk-ant-[A-Za-z0-9_-]{10,}/g,
  /sk-[A-Za-z0-9]{20,}/g,
  /AKIA[0-9A-Z]{16}/g,
  /gh[pousr]_[A-Za-z0-9]{20,}/g,
  /xox[abpr]-[A-Za-z0-9-]{10,}/g,
  /((?:api[_-]?key|secret|token|password|passwd)\s*[=:]\s*)["']?[^\s"']{6,}/gi,
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
// externalCwd/cwdLabel run the command outside the project (fix verify's
// pre-fix worktree); purposeFor decides the purpose from the result; extra
// adds fields to the record. The integrity window applies either way.
function runCommand(store, actor, { label, command, cwd, gate, task, purpose = 'check', timeoutMs = 600000, externalCwd, cwdLabel, purposeFor, extra }) {
  if (!command) throw new EccodeError('INVALID_INPUT', 'evidence run requires a command');
  if (!label) throw new EccodeError('INVALID_INPUT', 'evidence run requires --label');
  const workDir = externalCwd || (cwd ? path.join(store.root, projectRelative(store.root, cwd)) : store.root);
  const shownCwd = externalCwd ? cwdLabel || 'outside the project' : projectRelative(store.root, workDir) || '.';
  // Integrity window: whatever the command runs (including project code an
  // agent may have edited), it must not change the record or tracked files
  // outside the actor's claimed ownership. Checked on the effects, not on the
  // command text, so obfuscation does not matter.
  const trackedBefore = trackedChanges(store.root);
  const othersBefore = claimedGlobs(store, (agent) => agent !== actor);
  const started = Date.now();
  const { result: res, tampered: tamperedRecord } = recordWindow(store, label, () => spawnSync(command, {
    cwd: workDir,
    shell: true,
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 32 * 1024 * 1024,
    env: commandEnv({ ECCODE_EVIDENCE: store.dir }),
  }));
  const durationMs = Date.now() - started;
  const timedOut = res.error && res.error.code === 'ETIMEDOUT';
  const { outside: outsideOwnership, concurrent } = changedOutsideOwnership(store, actor, trackedBefore, trackedChanges(store.root), othersBefore);
  const violations = [
    ...(tamperedRecord.length ? [`the command changed the ECCode record (${tamperedRecord.join(', ')}); the change was reverted`] : []),
    ...(outsideOwnership.length ? [`the command changed tracked files outside ${actor}'s claimed ownership: ${outsideOwnership.slice(0, 10).join(', ')}${outsideOwnership.length > 10 ? ', …' : ''}`] : []),
  ];
  const output = redact(`${res.stdout || ''}${res.stderr ? `\n[stderr]\n${res.stderr}` : ''}${res.error ? `\n[error] ${res.error.message}` : ''}${violations.map((v) => `\n[eccode] INTEGRITY: ${v}`).join('')}`);
  const exitCode = violations.length ? 99 : typeof res.status === 'number' ? res.status : timedOut ? 124 : 1;
  const shownCommand = redact(command); // secrets on the command line must not reach the record either
  const id = newId('ev');
  const logRel = `.eccode/evidence/${id}.log`;
  writeFileAtomic(path.join(store.root, logRel), `$ ${shownCommand}\n# cwd: ${shownCwd}\n# exit: ${exitCode}\n${output}`);
  const data = {
    id,
    kind: 'command',
    label,
    command: shownCommand,
    cwd: shownCwd,
    purpose: typeof purposeFor === 'function' ? purposeFor(exitCode, output) : purpose,
    exitCode,
    status: exitCode === 0 ? 'passed' : 'failed',
    timedOut: Boolean(timedOut),
    durationMs,
    log: logRel,
    logSha256: sha256(output),
    outputTail: tail(output, 25),
    gate: gate || null,
    task: task || null,
    ...(violations.length ? { integrity: violations } : {}),
    ...(concurrent.length ? { concurrent } : {}),
    ...(extra || {}),
  };
  store.commit('evidence.recorded', actor, data);
  return data;
}

const RECORD_FILES = ['events.jsonl', 'state.json', 'config.json'];

function snapshotRecord(store) {
  return RECORD_FILES.map((f) => {
    const file = path.join(store.dir, f);
    return { file, rel: `.eccode/${f}`, content: exists(file) ? fs.readFileSync(file) : null };
  });
}

/**
 * Run fn with the record locked: other agents' writes wait until it ends, so
 * any change to the record seen afterwards is fn's own, and is put back.
 * Returns {result, tampered} (the record files fn changed).
 */
function recordWindow(store, label, fn) {
  if (!exists(store.dir)) return { result: fn(), tampered: [] };
  const lockFile = path.join(store.dir, '.lock');
  const out = withLock(lockFile, () => {
    const before = snapshotRecord(store);
    let result;
    let tampered = [];
    try {
      result = fn();
    } finally {
      tampered = restoreRecord(before);
    }
    return { result, tampered };
  }, { meta: { window: true, label } });
  // Writers that waited for this window go first (up to 2 s) before the
  // caller's next window: mutate runs one window per test run.
  const until = Date.now() + 2000;
  const waiters = () => fs.readdirSync(store.dir).some((f) => f.startsWith('.lock.waiting-'));
  while (Date.now() < until && waiters()) sleepSync(25);
  return out;
}

/** Put back any record file the command changed; returns the ones it changed. */
function restoreRecord(snapshot) {
  const changed = [];
  for (const s of snapshot) {
    const now = exists(s.file) ? fs.readFileSync(s.file) : null;
    const same = now === null || s.content === null ? now === s.content : now.equals(s.content);
    if (same) continue;
    changed.push(s.rel);
    if (s.content === null) fs.rmSync(s.file, { force: true });
    else writeFileAtomic(s.file, s.content);
  }
  return changed;
}

/** Tracked files that differ from HEAD, with a content hash; null outside git. */
function trackedChanges(root) {
  const r = spawnSync('git', ['diff', 'HEAD', '--name-only', '-z'], { cwd: root, encoding: 'utf8' });
  if (r.status !== 0) return null;
  const out = new Map();
  for (const rel of r.stdout.split('\0').filter(Boolean)) {
    const abs = path.join(root, rel);
    out.set(rel, exists(abs) ? sha256File(abs) : 'deleted');
  }
  return out;
}

function claimedGlobs(store, ofAgent) {
  return Object.values(store.state().tasks || {})
    .filter((t) => t.status === 'claimed' && t.claim && ofAgent(t.claim.agent))
    .flatMap((t) => t.files || []);
}

// Files the command changed outside the actor's claims. In a parallel phase
// another agent edits its own claimed files while the command runs; a change
// to a file another claim owned at the start or the end is named as
// concurrent, not blamed on the command.
function changedOutsideOwnership(store, actor, before, after, othersBefore = []) {
  if (!before || !after) return { outside: [], concurrent: [] };
  const changed = [...after.keys()].filter((f) => before.get(f) !== after.get(f));
  for (const f of before.keys()) if (!after.has(f)) changed.push(f); // reverted to HEAD by the command
  if (!changed.length) return { outside: [], concurrent: [] };
  const { matchesAny } = require('./util');
  const mine = claimedGlobs(store, (agent) => agent === actor);
  const others = [...othersBefore, ...claimedGlobs(store, (agent) => agent !== actor)];
  const files = [...new Set(changed)].filter((f) => !f.startsWith('.eccode/') && !matchesAny(f, mine)).sort();
  return { outside: files.filter((f) => !matchesAny(f, others)), concurrent: files.filter((f) => matchesAny(f, others)) };
}

/** Record that a file was inspected, pinning its content hash. */
function recordFile(store, actor, { label, file, note, gate, task }) {
  const rel = projectRelative(store.root, file);
  const abs = path.join(store.root, rel);
  if (!exists(abs)) throw new EccodeError('NOT_FOUND', `File not found: ${rel}`);
  const data = {
    id: newId('ev'),
    kind: 'file',
    label: label || `inspected ${rel}`,
    path: rel,
    sha256: sha256File(abs),
    bytes: fs.statSync(abs).size,
    note: note || null,
    status: 'recorded',
    gate: gate || null,
    task: task || null,
  };
  store.commit('evidence.recorded', actor, data);
  return data;
}

/**
 * Resolve an evidence reference ("ev:<id>" or "artifact:<path>[#anchor]").
 * Returns {ok, reason?, evidence?}.
 */
function resolveRef(state, root, ref, { allowedArtifacts } = {}) {
  if (ref.startsWith('ev:')) {
    const ev = state.evidence[ref.slice(3)];
    if (!ev) return { ok: false, reason: `${ref} does not exist in the project record` };
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

module.exports = { runCommand, recordFile, resolveRef, redact, SECRET_PATTERNS, snapshotRecord, restoreRecord, recordWindow };
