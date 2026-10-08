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
function writeFileAtomic(file, content) {
  ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, file);
}

function writeJson(file, value) {
  writeFileAtomic(file, JSON.stringify(value, null, 2) + '\n');
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
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

/**
 * Cross-process exclusive lock using O_EXCL lock files. Locks older than
 * staleMs are considered abandoned (crashed process) and are broken.
 */
function withLock(lockFile, fn, { timeoutMs = 10000, staleMs = 30000 } = {}) {
  ensureDir(path.dirname(lockFile));
  const start = Date.now();
  let fd;
  for (;;) {
    try {
      fd = fs.openSync(lockFile, 'wx');
      fs.writeSync(fd, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
      break;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      try {
        const age = Date.now() - fs.statSync(lockFile).mtimeMs;
        if (age > staleMs) {
          fs.unlinkSync(lockFile);
          continue;
        }
      } catch {
        continue; // lock vanished between checks; retry
      }
      if (Date.now() - start > timeoutMs) {
        throw new EccodeError('LOCK_TIMEOUT', `Could not acquire lock ${lockFile} within ${timeoutMs}ms`);
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
  // ECCODE_NOW pins the clock for tests, and only with ECCODE_TEST=1: order
  // rules ("check after claim", "reviewer check after submission") compare
  // timestamps, so a caller-chosen clock would let earlier evidence pass as later.
  return process.env.ECCODE_TEST === '1' && process.env.ECCODE_NOW ? new Date(process.env.ECCODE_NOW) : new Date();
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

module.exports = {
  EccodeError,
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
