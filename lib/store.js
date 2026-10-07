'use strict';
// Event-sourced project record. events.jsonl (append-only, hash-chained) is
// the source of truth; state.json is a snapshot that can always be rebuilt by
// replaying events. Every mutation goes through commit() under a file lock,
// which makes the record safe against interrupted processes and concurrent
// agents writing at the same time.

const fs = require('fs');
const path = require('path');
const { sha256, writeJson, readJson, withLock, ensureDir, isoNow, EccodeError, exists } = require('./util');
const { reduce, initialState } = require('./reducer');

const GENESIS = '0'.repeat(64);

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
    if (!exists(this.eventsFile)) return [];
    const lines = fs.readFileSync(this.eventsFile, 'utf8').split('\n');
    const events = [];
    lines.forEach((line, i) => {
      if (!line.trim()) return;
      try {
        events.push(JSON.parse(line));
      } catch {
        // A torn final line means the process died mid-append; ignore it so
        // the record stays usable. Corruption elsewhere is a hard error.
        if (i < lines.length - 2) {
          throw new EccodeError('CORRUPT_LOG', `events.jsonl line ${i + 1} is not valid JSON`);
        }
      }
    });
    return events;
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
    if (snap && last && snap.seq === last.seq && snap.lastHash === last.hash) return snap;
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
    return { ok: errors.length === 0, errors, events: seq };
  }
}

module.exports = { Store, GENESIS };
