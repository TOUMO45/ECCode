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

/** Structural equality ignoring object key order (merges may reorder keys). */
function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  return ka.length === kb.length && ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && deepEqual(a[k], b[k]));
}

/**
 * Why a snapshot cannot belong to this log's history (null = it can). The
 * snapshot is written after every append, so a snapshot AHEAD of the log, or
 * one whose last event is not in the log, means the log was rolled back or
 * replaced (e.g. `git checkout -- .eccode/events.jsonl`). Replaying the shorter
 * log silently would erase approvals, rejections and escalations.
 */
function rollbackReason(snap, events) {
  if (!snap || !snap.seq) return null;
  const last = events[events.length - 1];
  const lastSeq = last ? last.seq : 0;
  if (snap.seq > lastSeq) return `state.json is at event #${snap.seq} but events.jsonl ends at #${lastSeq}: the log was rolled back`;
  const ev = events.find((e) => e.seq === snap.seq);
  if (!ev || ev.hash !== snap.lastHash) return `state.json's last event #${snap.seq} is not in events.jsonl: the log was replaced by a different history`;
  return null;
}

const ROLLBACK_RECOVERY = 'Restore the newer events.jsonl (e.g. from git), or, if the user decides the shorter log is the truth: eccode rebuild --force --actor user';

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

  rebuild(events = this.readEvents()) {
    let state = initialState();
    for (const ev of events) state = reduce(state, ev);
    return state;
  }

  /**
   * Current state; rebuilt from the log if the snapshot is missing or behind
   * (crash between append and snapshot write). A snapshot AHEAD of the log is
   * refused with LOG_ROLLBACK instead of being treated as stale.
   */
  state() {
    this.assertInitialized();
    const snap = readJson(this.stateFile, null);
    const events = this.readEvents();
    const last = events[events.length - 1];
    if (snap && last && snap.seq === last.seq && snap.lastHash === last.hash) return snap;
    const conflict = rollbackReason(snap, events);
    if (conflict) throw new EccodeError('LOG_ROLLBACK', `Refusing to use the project record: ${conflict}.`, { recovery: ROLLBACK_RECOVERY });
    return this.rebuild(events);
  }

  /**
   * A crash mid-append can leave a final line without its newline. Appending
   * after it would glue the next event onto the fragment and corrupt the log
   * for good, so before every append (inside the lock) a complete final event
   * gets its newline back and a torn fragment is cut off.
   */
  repairTail() {
    if (!exists(this.eventsFile)) return;
    const text = fs.readFileSync(this.eventsFile, 'utf8');
    if (text === '' || text.endsWith('\n')) return;
    const cut = text.lastIndexOf('\n') + 1;
    let complete = false;
    try {
      const tail = JSON.parse(text.slice(cut));
      complete = Boolean(tail && typeof tail === 'object' && tail.hash);
    } catch {
      complete = false;
    }
    if (complete) fs.appendFileSync(this.eventsFile, '\n');
    else fs.truncateSync(this.eventsFile, Buffer.byteLength(text.slice(0, cut)));
  }

  /**
   * Append an event after validation. `check(state)` runs inside the lock and
   * may throw to abort; it may return extra data merged into the event.
   */
  commit(type, actor, data, check) {
    ensureDir(this.dir);
    return withLock(this.lockFile, () => {
      this.repairTail();
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

  /** Verify the hash chain, timestamp order and snapshot; returns {ok, errors}. */
  audit() {
    const errors = [];
    let prev = GENESIS;
    let seq = 0;
    let prevTs = null;
    const events = this.readEvents();
    for (const ev of events) {
      const { hash, ...body } = ev;
      if (ev.seq !== seq + 1) errors.push(`event ${ev.seq}: expected seq ${seq + 1}`);
      if (ev.prevHash !== prev) errors.push(`event ${ev.seq}: prevHash does not link to previous event`);
      if (sha256(ev.prevHash + JSON.stringify(body)) !== hash) errors.push(`event ${ev.seq}: content hash mismatch (edited after the fact)`);
      // Order rules (check after claim, reviewer check after submission)
      // compare timestamps; a clock that went backwards makes them unprovable.
      if (prevTs !== null && Date.parse(ev.ts) < Date.parse(prevTs)) errors.push(`event ${ev.seq}: timestamp goes backwards (${ev.ts} < ${prevTs})`);
      prev = hash;
      seq = ev.seq;
      prevTs = ev.ts;
    }
    // The snapshot is a cache: it must equal a replay of the log.
    const snap = readJson(this.stateFile, null);
    const conflict = rollbackReason(snap, events);
    if (conflict) errors.push(`${conflict} (${ROLLBACK_RECOVERY})`);
    else if (snap && !deepEqual(snap, this.rebuild(events))) {
      errors.push('state.json diverges from a replay of events.jsonl (run "eccode rebuild")');
    }
    return { ok: errors.length === 0, errors, events: seq };
  }

  /**
   * Rewrite state.json from the log (repairs a stale or divergent snapshot).
   * Accepting a rolled-back or replaced log needs force and the user, and the
   * acceptance is itself recorded as an event.
   */
  rebuildSnapshot({ force = false, actor } = {}) {
    const accepted = withLock(this.lockFile, () => {
      const events = this.readEvents();
      const snap = readJson(this.stateFile, null);
      const conflict = rollbackReason(snap, events);
      if (conflict && !force) throw new EccodeError('LOG_ROLLBACK', `Refusing to rebuild: ${conflict}.`, { recovery: ROLLBACK_RECOVERY });
      if (conflict && actor !== 'user') throw new EccodeError('USER_AUTH_REQUIRED', `Accepting a rolled-back log requires the user (--force --actor user): ${conflict}`);
      writeJson(this.stateFile, this.rebuild(events));
      return conflict ? { reason: conflict, snapshotSeq: snap.seq, snapshotHash: snap.lastHash } : null;
    });
    if (accepted) this.commit('record.rollback_accepted', actor, accepted);
    return this.state();
  }
}

module.exports = { Store, GENESIS };
