'use strict';
// Event-sourced project record. events.jsonl (append-only, hash-chained) is
// the source of truth; state.json is a snapshot that can always be rebuilt by
// replaying events. Every mutation goes through commit() under a file lock,
// which makes the record safe against interrupted processes and concurrent
// agents writing at the same time.

const fs = require('fs');
const path = require('path');
const { sha256, writeJson, readJson, withLock, ensureDir, isoNow, EccodeError, exists } = require('./util');
const { reduce, initialState, STATE_VERSION } = require('./reducer');

const GENESIS = '0'.repeat(64);

/** Parse JSONL events. A torn final line (process died mid-append) is ignored; corruption elsewhere is fatal. */
function parseEvents(text) {
  const lines = text.split('\n');
  const events = [];
  lines.forEach((line, i) => {
    if (!line.trim()) return;
    try {
      events.push(JSON.parse(line));
    } catch {
      if (i < lines.length - 2) {
        throw new EccodeError('CORRUPT_LOG', `events.jsonl line ${i + 1} is not valid JSON`);
      }
    }
  });
  return events;
}

/** Structural equality ignoring object key order (merges may reorder keys). */
function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  return ka.length === kb.length && ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && deepEqual(a[k], b[k]));
}

class Store {
  constructor(root) {
    this.root = path.resolve(root);
    this.dir = path.join(this.root, '.eccode');
    this.eventsFile = path.join(this.dir, 'events.jsonl');
    this.stateFile = path.join(this.dir, 'state.json');
    this.lockFile = path.join(this.dir, '.lock');
  }

  isInitialized() {
    return exists(this.eventsFile);
  }

  assertInitialized() {
    if (!this.isInitialized()) {
      throw new EccodeError('NOT_INITIALIZED', `No ECCode project at ${this.root}. Run "eccode init" first.`);
    }
  }

  path(...parts) {
    return path.join(this.dir, ...parts);
  }

  readEvents() {
    return exists(this.eventsFile) ? parseEvents(fs.readFileSync(this.eventsFile, 'utf8')) : [];
  }

  rebuild() {
    let state = initialState();
    for (const ev of this.readEvents()) state = reduce(state, ev);
    return state;
  }

  /** Current state; rebuilt from the log if the snapshot is missing or stale. */
  state() {
    this.assertInitialized();
    const snap = readJson(this.stateFile, null);
    const events = this.readEvents();
    const last = events[events.length - 1];
    // A snapshot from an older engine schema is a stale cache: replay instead.
    if (snap && (snap.stateVersion || 1) === STATE_VERSION && last && snap.seq === last.seq && snap.lastHash === last.hash) return snap;
    let state = initialState();
    for (const ev of events) state = reduce(state, ev);
    return state;
  }

  /**
   * Append an event after validation. `check(state)` runs inside the lock and
   * may throw to abort; it may return extra data merged into the event.
   */
  commit(type, actor, data, check) {
    ensureDir(this.dir);
    this.assertWritable();
    return withLock(this.lockFile, () => {
      const state = this.isInitialized() ? this.state() : initialState();
      const extra = check ? check(state) : undefined;
      const payload = extra && typeof extra === 'object' ? { ...data, ...extra } : data;
      const prevHash = state.lastHash || GENESIS;
      const body = { seq: state.seq + 1, ts: isoNow(), type, actor: actor || 'system', data: payload, prevHash };
      const line = JSON.stringify({ ...body, hash: sha256(prevHash + JSON.stringify(body)) });
      fs.appendFileSync(this.eventsFile, line + '\n');
      // Reduce the event exactly as it was persisted (undefined-valued keys
      // dropped, values JSON-normalized), so the snapshot always equals a
      // replay of the log. Reducing the in-memory object instead let
      // `{ ...old, ...d }` merges overwrite fields with undefined.
      const event = JSON.parse(line);
      const next = reduce(state, event);
      writeJson(this.stateFile, next);
      return { event, state: next };
    });
  }

  /** Verify the hash chain; returns {ok, errors}. */
  audit() {
    const errors = [];
    let prev = GENESIS;
    let seq = 0;
    for (const ev of this.readEvents()) {
      const { hash, ...body } = ev;
      if (ev.seq !== seq + 1) errors.push(`event ${ev.seq}: expected seq ${seq + 1}`);
      if (ev.prevHash !== prev) errors.push(`event ${ev.seq}: prevHash does not link to previous event`);
      if (sha256(ev.prevHash + JSON.stringify(body)) !== hash) errors.push(`event ${ev.seq}: content hash mismatch (edited after the fact)`);
      prev = hash;
      seq = ev.seq;
    }
    // The snapshot is a cache: it must equal a replay of the log. One written
    // by an older engine schema is stale, not tampered; replay covers it.
    const snap = readJson(this.stateFile, null);
    if (snap && (snap.stateVersion || 1) === STATE_VERSION && !deepEqual(snap, this.rebuild())) {
      errors.push('state.json diverges from a replay of events.jsonl (run "eccode rebuild")');
    }
    return { ok: errors.length === 0, errors, events: seq };
  }

  /**
   * Compare with the log as it was committed (e.g. \`git show <ref>:…\`). The
   * chain alone can be recomputed after an edit; a committed copy, above all
   * one on a protected remote branch, cannot. Every committed event must still
   * be present with the same hash.
   */
  divergenceFrom(committedText) {
    const now = this.readEvents();
    for (const ev of parseEvents(committedText)) {
      const cur = now[ev.seq - 1];
      if (!cur) return [`event ${ev.seq} from the committed log is missing (log truncated after it was committed)`];
      if (cur.hash !== ev.hash) return [`event ${ev.seq} differs from the committed log (history rewritten after it was committed)`];
    }
    return [];
  }

  /**
   * In the sandboxed profile the record is read-only to shell commands at the
   * OS level; say so at once instead of waiting out a lock that cannot be taken.
   */
  assertWritable() {
    if (!fs.existsSync(this.eventsFile)) return;
    try {
      fs.accessSync(this.eventsFile, fs.constants.W_OK);
    } catch (err) {
      if (err.code === 'EROFS' || err.code === 'EACCES' || err.code === 'EPERM') {
        throw new EccodeError('RECORD_READ_ONLY', 'The ECCode record is read-only in this shell (sandboxed profile). Record changes go through the eccode MCP tools of your role; user decisions are made by the human in their own terminal.');
      }
      throw err;
    }
  }

  /** Rewrite state.json from the log (repairs a stale or divergent snapshot). */
  rebuildSnapshot() {
    this.assertWritable();
    return withLock(this.lockFile, () => {
      const state = this.rebuild();
      writeJson(this.stateFile, state);
      return state;
    });
  }
}

module.exports = { Store, GENESIS, parseEvents };
