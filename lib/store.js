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

function show(v) {
  const s = JSON.stringify(v);
  return s === undefined ? 'undefined' : s.length > 60 ? s.slice(0, 57) + '...' : s;
}

/**
 * Where two values first differ (null when they are equal). Structural, ignoring
 * object key order (merges may reorder keys); the path names the field so an
 * agent can see what a snapshot claims that the log does not.
 */
function firstDifference(a, b, at = 'state') {
  if (a === b) return null;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null || Array.isArray(a) !== Array.isArray(b)) {
    return `${at} (snapshot ${show(a)}, replay ${show(b)})`;
  }
  for (const k of Object.keys(a)) {
    if (!Object.prototype.hasOwnProperty.call(b, k)) return `${at}.${k} (snapshot ${show(a[k])}, replay absent)`;
    const diff = firstDifference(a[k], b[k], `${at}.${k}`);
    if (diff) return diff;
  }
  for (const k of Object.keys(b)) {
    if (!Object.prototype.hasOwnProperty.call(a, k)) return `${at}.${k} (snapshot absent, replay ${show(b[k])})`;
  }
  return null;
}

/** JSON with object keys sorted at every level, so the same state always serializes the same way. */
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    const out = {};
    for (const k of Object.keys(value).sort()) out[k] = canonical(value[k]);
    return out;
  }
  return value;
}

/**
 * Digest of a state, minus lastHash. Every event the store appends carries the
 * digest of the state it produces (`stateHash`, inside the hash chain), which
 * is what lets state() check state.json against the log without a replay.
 * lastHash is left out because it is the event's own hash, which covers the
 * digest; the head check compares it separately.
 */
function stateDigest(state) {
  const { lastHash, ...rest } = state && typeof state === 'object' ? state : {};
  return sha256(JSON.stringify(canonical(rest)));
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
const SNAPSHOT_RECOVERY = 'eccode audit shows the difference; eccode rebuild --actor orchestrator rewrites state.json from the log (nothing is lost: the log is the truth)';

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
    for (const ev of events) {
      if (!ev || typeof ev !== 'object' || Array.isArray(ev)) throw new EccodeError('CORRUPT_LOG', `events.jsonl holds a line that is not an event object (after event ${state.seq})`);
      try {
        state = reduce(state, ev);
      } catch (err) {
        // A tampered or truncated event must be reported as corruption, never as a crash.
        throw new EccodeError('CORRUPT_LOG', `events.jsonl event ${ev.seq}: cannot be replayed (${err.message}); the log was edited or written by an incompatible tool`);
      }
    }
    return state;
  }

  /** The snapshot, or null when it is missing or not valid JSON (a torn write loses a cache, not the record). */
  readSnapshot() {
    try {
      return readJson(this.stateFile, null);
    } catch (err) {
      if (err.code === 'INVALID_JSON') return null;
      throw err;
    }
  }

  /**
   * Current state. The snapshot is a cache of the log and is never trusted on
   * its own: it is returned only when it is the state the log's last event
   * recorded (stateHash) or, for a record written before that digest existed,
   * when it equals a replay. A snapshot whose content differs from the log is
   * refused with SNAPSHOT_DIVERGED, so no commit ever builds on a forged
   * state.json; a missing, torn or behind snapshot (crash between append and
   * snapshot write) is rebuilt; a snapshot AHEAD of the log is refused with
   * LOG_ROLLBACK instead of being treated as stale.
   */
  state() {
    this.assertInitialized();
    const snap = this.readSnapshot();
    const events = this.readEvents();
    const conflict = rollbackReason(snap, events);
    if (conflict) throw new EccodeError('LOG_ROLLBACK', `Refusing to use the project record: ${conflict}.`, { recovery: ROLLBACK_RECOVERY });
    const last = events[events.length - 1];
    if (!snap || !last || snap.seq !== last.seq) return this.rebuild(events);
    // The snapshot sits at the log's head (rollbackReason matched its lastHash); now its content.
    if (last.stateHash && stateDigest(snap) === last.stateHash) return snap;
    const diff = firstDifference(snap, this.rebuild(events));
    if (!diff) return snap;
    throw new EccodeError('SNAPSHOT_DIVERGED', `Refusing to use the project record: state.json diverges from a replay of events.jsonl at ${diff}; the snapshot was edited or written by another tool. ${SNAPSHOT_RECOVERY}.`, { recovery: SNAPSHOT_RECOVERY, difference: diff });
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
      // The event carries the digest of the state it produces, inside the hash
      // chain, so state() can verify state.json against the log without a replay.
      // (Reduced from the JSON-normalized body: the reducer reads nothing else.)
      body.stateHash = stateDigest(reduce(state, JSON.parse(JSON.stringify(body))));
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

  /**
   * Verify the hash chain, timestamp order and snapshot; returns {ok, errors,
   * warnings}. Warnings are gaps a crash can leave that do not block the record.
   * Works on a diverged, torn or rolled-back snapshot (it never calls state()).
   */
  audit() {
    const errors = [];
    const warnings = [];
    let prev = GENESIS;
    let seq = 0;
    let prevTs = null;
    const events = this.readEvents();
    for (const ev of events) {
      if (!ev || typeof ev !== 'object' || Array.isArray(ev)) {
        errors.push(`after event ${seq}: a line is not an event object (edited after the fact)`);
        continue;
      }
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
    let replay = null;
    try {
      replay = this.rebuild(events);
    } catch (err) {
      errors.push(err.message);
    }
    const snap = this.readSnapshot();
    const conflict = rollbackReason(snap, events);
    if (conflict) errors.push(`${conflict} (${ROLLBACK_RECOVERY})`);
    else if (!snap && exists(this.stateFile)) errors.push(`state.json is not valid JSON (a torn write?); state() rebuilds it from the log, eccode rebuild --actor orchestrator writes it back`);
    else if (snap && replay) {
      const diff = firstDifference(snap, replay);
      if (diff) errors.push(`state.json diverges from a replay of events.jsonl at ${diff} (${SNAPSHOT_RECOVERY})`);
    }
    // A task completion is two commits (task.completed, then handoff.recorded); a process that
    // stops between them leaves a done task whose handoff is not in the record. The task's work
    // and evidence are recorded, so this is a gap to fill, not a reason to block the record.
    for (const t of Object.values((replay && replay.tasks) || {})) {
      if (t.status !== 'done' || !t.handoffId || replay.handoffs[t.handoffId]) continue;
      const completed = [...(t.history || [])].reverse().find((h) => h.event === 'completed');
      const recordedLater = Object.values(replay.handoffs).some((h) => h.task === t.id && h.from === t.completedBy && (!completed || h.at >= completed.at));
      if (!recordedLater) warnings.push(`task ${t.id} is done but its handoff ${t.handoffId} is not in the record (the process stopped between task.completed and handoff.recorded): eccode handoff record --actor ${t.completedBy} --file <handoff.json> records it`);
    }
    return { ok: errors.length === 0, errors, warnings, events: seq };
  }

  /**
   * Rewrite state.json from the log (repairs a stale or divergent snapshot).
   * Accepting a rolled-back or replaced log needs force and the user, and the
   * acceptance is itself recorded as an event.
   */
  rebuildSnapshot({ force = false, actor } = {}) {
    const accepted = withLock(this.lockFile, () => {
      const events = this.readEvents();
      const snap = this.readSnapshot();
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

module.exports = { Store, GENESIS, stateDigest };
