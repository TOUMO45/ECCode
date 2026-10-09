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

/**
 * Does `id` have the shape newId(prefix) produces? `prefix` is a regex
 * fragment (e.g. 'ev', 'mem-s?[pdkw]'). Ids from callers are checked before
 * they index state or name files, so `../x` or `constructor` never resolve.
 */
function isId(prefix, id) {
  return typeof id === 'string' && new RegExp(`^${prefix}-[0-9a-z]+-[0-9a-z]{2}[0-9a-f]{6}$`).test(id);
}

/** Own-property lookup: a caller-supplied key never resolves to an inherited member (constructor, __proto__, toString…). */
function own(map, key) {
  return map && typeof key === 'string' && Object.prototype.hasOwnProperty.call(map, key) ? map[key] : undefined;
}

// Caller-chosen keys (risk, task and phase ids) must not shadow Object.prototype members.
const RESERVED_KEYS = new Set([...Object.getOwnPropertyNames(Object.prototype), 'prototype']);
function isReservedKey(key) {
  return RESERVED_KEYS.has(key);
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

/** Number of `**` segments in a glob; each one is a backtracking point, so plans cap it. */
function globstarCount(glob) {
  return (String(glob).match(/\*\*/g) || []).length;
}

/**
 * Convert a simple glob (**, *, ?) to a RegExp anchored on posix paths.
 * Consecutive `**` segments are collapsed first: `a/**\/**\/**\/b` matches the
 * same paths as `a/**\/b` but each extra segment multiplied the regex
 * backtracking (a 12-segment glob took 45 s on a 25-segment path).
 */
function globToRegExp(glob) {
  glob = String(glob).replace(/(?:\*\*\/)+\*\*(\/|$)/g, '**$1').replace(/(\*\*\/)+/g, '**/');
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

/**
 * Quote one argv element for the shell that `evidence run -- <command...>`
 * hands the joined command to (`/bin/sh` on Unix, cmd.exe on Windows). Safe
 * characters pass through unchanged everywhere. The POSIX branch is single-quote
 * quoting; the win32 branch is the double-quote grouping cmd.exe and the C
 * runtime argv parser agree on (the rules libuv applies). cmd.exe toggles its
 * quote state at every `"`, so an argument that mixes embedded quotes with
 * & | < > ^ can still be split there, the limitation Node's own shell: true has.
 */
function shellQuote(arg) {
  if (/^[A-Za-z0-9_\/.,:=@%+-]+$/.test(arg)) return arg;
  if (process.platform === 'win32') {
    return `"${arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1')}"`;
  }
  return `'${arg.replace(/'/g, "'\\''")}'`;
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
  isId,
  own,
  isReservedKey,
  now,
  isoNow,
  globToRegExp,
  globstarCount,
  matchesAny,
  globsOverlap,
  toPosix,
  shellQuote,
};
