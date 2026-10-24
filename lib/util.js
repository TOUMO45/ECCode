'use strict';
// Small, dependency-free helpers shared by the engine and the memory system.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

class EccodeError extends Error {
  /**
   * @param {string} code machine-readable error code (e.g. GATE_BLOCKED)
   * @param {string} message human-readable explanation
   * @param {object} [details] structured context (reasons, ids)
   */
  constructor(code, message, details) {
    super(message);
    this.name = 'EccodeError';
    this.code = code;
    this.details = details || {};
  }
}

function sha256(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function sha256File(file) {
  return sha256(fs.readFileSync(file));
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

/** Write via temp file + rename so readers never observe a half-written file. */
// Windows reports contention as EPERM/EACCES/EBUSY: a file another process
// holds open cannot be replaced, and a file being deleted cannot be reopened
// until its last handle closes. These clear on their own, so they are retried
// (as graceful-fs does) instead of failing the command.
const WIN_TRANSIENT = new Set(['EPERM', 'EACCES', 'EBUSY']);
function isTransient(err) {
  return process.platform === 'win32' && Boolean(err) && WIN_TRANSIENT.has(err.code);
}

function retryTransient(fn, totalMs = 2000) {
  const start = Date.now();
  for (let wait = 5; ; wait = Math.min(wait * 2, 100)) {
    try {
      return fn();
    } catch (err) {
      if (!isTransient(err) || Date.now() - start > totalMs) throw err;
      sleepSync(wait);
    }
  }
}

function writeFileAtomic(file, content) {
  ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, content);
  try {
    retryTransient(() => fs.renameSync(tmp, file));
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* best effort */ }
    throw err;
  }
}

function writeJson(file, value) {
  writeFileAtomic(file, JSON.stringify(value, null, 2) + '\n');
}

function readJson(file, fallback) {
  try {
    return JSON.parse(retryTransient(() => fs.readFileSync(file, 'utf8')));
  } catch (err) {
    if (err.code === 'ENOENT' && fallback !== undefined) return fallback;
    if (err instanceof SyntaxError) {
      throw new EccodeError('INVALID_JSON', `Invalid JSON in ${file}: ${err.message}`);
    }
    throw err;
  }
}

function exists(p) {
  try {
    fs.accessSync(p);
    return true;
  } catch {
    return false;
  }
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

function lockHolder(lockFile) {
  try {
    return JSON.parse(fs.readFileSync(lockFile, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Cross-process exclusive lock using O_EXCL lock files. Locks older than
 * staleMs are considered abandoned (crashed process) and are broken. A lock
 * taken with meta {window: true} (an integrity window, held while a checked
 * command runs) is broken only when its holder has died, and waiters wait for
 * it up to windowWaitMs instead of timeoutMs.
 */
function withLock(lockFile, fn, { timeoutMs = 10000, staleMs = 30000, meta = null, windowWaitMs = 3600000 } = {}) {
  ensureDir(path.dirname(lockFile));
  const start = Date.now();
  let fd;
  for (;;) {
    try {
      fd = fs.openSync(lockFile, 'wx');
      fs.writeSync(fd, JSON.stringify({ pid: process.pid, at: new Date().toISOString(), ...(meta || {}) }));
      break;
    } catch (err) {
      // EEXIST: someone holds the lock. On Windows a lock file being deleted
      // by its previous holder reports EPERM/EACCES/EBUSY instead: same wait.
      if (err.code !== 'EEXIST' && !isTransient(err)) throw err;
      const holder = lockHolder(lockFile);
      if (holder && holder.window) {
        if (!pidAlive(holder.pid)) {
          try { fs.unlinkSync(lockFile); } catch { /* another waiter removed it first */ }
          continue;
        }
        if (Date.now() - start > windowWaitMs) {
          throw new EccodeError('LOCK_TIMEOUT', `The ECCode record is held by a running check (${holder.label || 'a command'}, pid ${holder.pid}) for more than ${Math.round(windowWaitMs / 1000)}s`);
        }
        sleepSync(50);
        continue;
      }
      if (Date.now() - start > timeoutMs) {
        throw new EccodeError('LOCK_TIMEOUT', `Could not acquire lock ${lockFile} within ${timeoutMs}ms`);
      }
      let age = 0;
      try {
        age = Date.now() - fs.statSync(lockFile).mtimeMs;
      } catch {
        sleepSync(5); // lock vanished (or is mid-delete) between checks; retry soon
        continue;
      }
      if (age > staleMs) {
        try { fs.unlinkSync(lockFile); } catch { /* another waiter removed it first */ }
        continue;
      }
      sleepSync(25);
    }
  }
  try {
    return fn();
  } finally {
    fs.closeSync(fd);
    try {
      fs.unlinkSync(lockFile);
    } catch {
      /* already removed */
    }
  }
}

let idCounter = 0;
/** Sortable, collision-resistant id: <prefix>-<time36>-<counter><random>. */
function newId(prefix) {
  idCounter = (idCounter + 1) % 1296;
  return `${prefix}-${Date.now().toString(36)}-${idCounter.toString(36).padStart(2, '0')}${crypto
    .randomBytes(3)
    .toString('hex')}`;
}

function now() {
  // ECCODE_NOW lets tests and demos pin the clock deterministically.
  return process.env.ECCODE_NOW ? new Date(process.env.ECCODE_NOW) : new Date();
}

function isoNow() {
  return now().toISOString();
}

/** Convert a simple glob (**, *, ?) to a RegExp anchored on posix paths. */
function globToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        i++;
        if (glob[i + 1] === '/') {
          i++;
          re += '(?:.*/)?';
        } else {
          re += '.*';
        }
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else if ('\\^$+.()|{}[]'.includes(c)) {
      re += '\\' + c;
    } else {
      re += c;
    }
  }
  return new RegExp('^' + re + '$');
}

function toPosix(p) {
  return p.split(path.sep).join('/');
}

function matchesAny(file, globs) {
  const f = toPosix(file);
  return globs.some((g) => globToRegExp(g).test(f));
}

/** Literal prefix of a glob, up to the first wildcard. */
function globPrefix(glob) {
  const idx = glob.search(/[*?]/);
  return idx === -1 ? glob : glob.slice(0, idx);
}

/**
 * Conservative overlap test between two ownership glob sets. Two globs
 * overlap if either literal prefix contains the other (could match the same
 * file). False positives are acceptable (they serialize work); false
 * negatives are not (they would allow conflicting edits).
 */
function globsOverlap(a, b) {
  for (const ga of a) {
    for (const gb of b) {
      const pa = globPrefix(ga);
      const pb = globPrefix(gb);
      const wa = pa !== ga;
      const wb = pb !== gb;
      if (!wa && !wb) {
        if (ga === gb) return true;
        continue;
      }
      if (!wa && globToRegExp(gb).test(ga)) return true;
      if (!wb && globToRegExp(ga).test(gb)) return true;
      if (wa && wb && (pa.startsWith(pb) || pb.startsWith(pa))) return true;
    }
  }
  return false;
}

/**
 * Environment for a command whose exit status ECCode records. A Node test
 * runner's NODE_TEST_CONTEXT, inherited from whatever started ECCode, makes a
 * nested `node --test` report to that runner and exit 0 even when its tests
 * fail, so a failing check would be recorded as passing; it is removed.
 */
function commandEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  delete env.NODE_TEST_CONTEXT;
  return env;
}

module.exports = {
  EccodeError,
  commandEnv,
  sha256,
  sha256File,
  ensureDir,
  writeFileAtomic,
  writeJson,
  readJson,
  exists,
  withLock,
  newId,
  now,
  isoNow,
  globToRegExp,
  matchesAny,
  globsOverlap,
  toPosix,
};
