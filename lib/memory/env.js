'use strict';
// Environment detection and constraint matching. Lessons declare the
// environment they were verified in (e.g. {"node": ">=18 <22", "express":
// "^4"}); before a lesson is used we check those constraints against the
// current project instead of assuming the lesson still applies.

const fs = require('fs');
const path = require('path');

function parseVersion(v) {
  const m = String(v).trim().replace(/^v/, '').match(/^(\d+|x|\*)(?:\.(\d+|x|\*))?(?:\.(\d+|x|\*))?/);
  if (!m) return null;
  const n = (s) => (s === undefined || s === 'x' || s === '*' ? null : Number(s));
  return [n(m[1]), n(m[2]), n(m[3])];
}

function cmp(a, b) {
  for (let i = 0; i < 3; i++) {
    const x = a[i] || 0;
    const y = b[i] || 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

/** Does version satisfy a single comparator like ">=18", "^4.2", "~1.2", "4.x", "=3"? */
function satisfiesOne(version, comp) {
  const m = comp.match(/^(>=|<=|>|<|=|\^|~)?\s*(.+)$/);
  if (!m) return false;
  const op = m[1] || '';
  const target = parseVersion(m[2]);
  if (!target) return false;
  const v = version;
  switch (op) {
    case '>=':
      return cmp(v, target) >= 0;
    case '<=':
      return cmp(v, target) <= 0;
    case '>':
      return cmp(v, target) > 0;
    case '<':
      return cmp(v, target) < 0;
    case '^': {
      if (cmp(v, target) < 0) return false;
      if (target[0] !== 0) return v[0] === target[0];
      if ((target[1] || 0) !== 0) return v[0] === 0 && v[1] === target[1];
      return v[0] === 0 && v[1] === 0 && v[2] === (target[2] || 0);
    }
    case '~':
      return cmp(v, target) >= 0 && v[0] === target[0] && (target[1] === null || v[1] === target[1]);
    default:
      // "=" or bare: wildcards (null) match anything.
      return target.every((t, i) => t === null || t === v[i]);
  }
}

/** Range with "||" alternatives and space-separated AND comparators. */
function satisfies(versionStr, range) {
  const v = parseVersion(versionStr);
  if (!v) return false;
  const full = v.map((x) => x || 0);
  return String(range)
    .split('||')
    .some((alt) =>
      alt
        .trim()
        .split(/\s+/)
        .filter(Boolean)
        .every((c) => satisfiesOne(full, c)),
    );
}

/** Lowest version a declared dependency range allows ("^4.18.2" -> "4.18.2"). */
function minVersionOf(range) {
  const m = String(range).match(/(\d+)(?:\.(\d+))?(?:\.(\d+))?/);
  return m ? [m[1], m[2] || '0', m[3] || '0'].join('.') : null;
}

function detectEnv(root, overrides = {}) {
  const env = {
    node: process.version.replace(/^v/, ''),
    os: process.platform,
    arch: process.arch,
  };
  const pkgFile = path.join(root, 'package.json');
  if (fs.existsSync(pkgFile)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'));
      for (const [name, range] of Object.entries({ ...(pkg.devDependencies || {}), ...(pkg.dependencies || {}) })) {
        // Prefer the installed version when node_modules is present.
        const installed = path.join(root, 'node_modules', name, 'package.json');
        let ver = null;
        if (fs.existsSync(installed)) {
          try {
            ver = JSON.parse(fs.readFileSync(installed, 'utf8')).version;
          } catch {
            ver = null;
          }
        }
        env[name] = ver || minVersionOf(range);
      }
      if (pkg.type) env['module-type'] = pkg.type;
    } catch {
      /* unreadable package.json: ignore */
    }
  }
  if (fs.existsSync(path.join(root, 'pyproject.toml')) || fs.existsSync(path.join(root, 'requirements.txt'))) env.python = 'present';
  // Deliberately no hostname/user/path data: environments are copied into
  // lessons, and lessons may be promoted to shared memory.
  for (const [k, v] of Object.entries(overrides)) env[k] = v;
  return env;
}

/**
 * Compare declared constraints with the detected environment.
 * Returns {ok, mismatches[], unknown[]}.
 */
const DETECTED_KEYS = new Set(['node', 'os', 'arch', 'python', 'module-type']);
// A value made only of version-range characters is a constraint we can evaluate.
const RANGE_CHARS = /^[\s<>=^~|v\dx*.,-]+$/;

/** Machine-checkable: a detected runtime key, or a package version range. Anything else is prose. */
function isCheckable(key, want) {
  return DETECTED_KEYS.has(key) || RANGE_CHARS.test(String(want));
}

function matchEnv(constraints = {}, env) {
  const mismatches = [];
  const unknown = [];
  const notes = []; // free-text entries: shown to the reader, never a reason to discard a lesson
  for (const [key, want] of Object.entries(constraints)) {
    if (!isCheckable(key, want)) {
      notes.push(`${key}: ${want} (not machine-checked)`);
      continue;
    }
    const have = env[key];
    if (have === undefined || have === null) {
      unknown.push(`${key} (lesson requires ${want}; not present here)`);
      continue;
    }
    const isVersion = parseVersion(have) && /[\d<>=^~x*]/.test(String(want)) && !/^[a-z]+$/i.test(String(want));
    const ok = isVersion ? satisfies(have, want) : String(have).toLowerCase() === String(want).toLowerCase();
    if (!ok) mismatches.push(`${key}: lesson requires ${want}, environment has ${have}`);
  }
  return { ok: mismatches.length === 0 && unknown.length === 0, mismatches, unknown, notes };
}

module.exports = { satisfies, parseVersion, detectEnv, matchEnv, minVersionOf };
