// Spawns Node child processes for the tests (servers, lock holders, helpers).
//
// ARCH-24: a child gets only an allow-list of the parent's execArgv, never
// --test, --test-concurrency, --inspect and the like, which would turn a server
// into a nested test run. The allow-list is --experimental-sqlite,
// --disable-warning=* and --import=<net-guard>. When the running Node is older
// than 22.13, node:sqlite sits behind a flag, so
// "--experimental-sqlite --disable-warning=ExperimentalWarning" is merged into
// NODE_OPTIONS (an existing value is kept) and every spawned process loads it.
import { spawn } from 'node:child_process';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const NET_GUARD_PATH = fileURLToPath(new URL('./net-guard.js', import.meta.url));
export const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const SQLITE_NODE_OPTIONS = '--experimental-sqlite --disable-warning=ExperimentalWarning';

function parseVersion(version) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(version));
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

// True when `node:sqlite` is behind a flag (Node < 22.13).
export function needsSqliteFlag(version = process.versions.node) {
  const v = parseVersion(version);
  if (!v) return true;
  const floor = [22, 13, 0];
  for (let i = 0; i < 3; i++) {
    if (v[i] > floor[i]) return false;
    if (v[i] < floor[i]) return true;
  }
  return false;
}

// The allow-listed subset of an execArgv. `--import <path>` and `--import=<path>`
// are kept only for the net guard (as an absolute path, so cwd does not matter);
// other preloads are dropped. Order is kept and duplicates are removed.
export function allowedExecArgv(execArgv = process.execArgv, { cwd = process.cwd() } = {}) {
  const kept = [];
  const add = (arg) => {
    if (!kept.includes(arg)) kept.push(arg);
  };
  const isGuard = (p) => resolve(cwd, p) === NET_GUARD_PATH || p === NET_GUARD_PATH;
  for (let i = 0; i < execArgv.length; i++) {
    const arg = execArgv[i];
    if (arg === '--experimental-sqlite') add(arg);
    else if (arg.startsWith('--disable-warning=')) add(arg);
    else if (arg === '--import' && typeof execArgv[i + 1] === 'string') {
      const target = execArgv[++i];
      if (isGuard(target)) add(`--import=${NET_GUARD_PATH}`);
    } else if (arg.startsWith('--import=')) {
      const target = arg.slice('--import='.length);
      if (isGuard(target)) add(`--import=${NET_GUARD_PATH}`);
    }
  }
  return kept;
}

// NODE_OPTIONS for a child: the existing value (kept), plus the sqlite flags
// when the Node version needs them and they are not already there.
export function mergeNodeOptions(existing, version = process.versions.node) {
  const current = typeof existing === 'string' ? existing.trim() : '';
  if (!needsSqliteFlag(version)) return current;
  const parts = current ? current.split(/\s+/) : [];
  const missing = SQLITE_NODE_OPTIONS.split(' ').filter((flag) => !parts.includes(flag));
  return [...parts, ...missing].join(' ');
}

// The environment of a child: the parent's, overridden by `env`; a value of
// undefined or null removes a name. NODE_OPTIONS is merged, never replaced
// (an explicit NODE_OPTIONS in `env` is the "existing value" that is kept).
export function childEnv(env = {}, { base = process.env, version = process.versions.node } = {}) {
  const out = { ...base };
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined || value === null) delete out[name];
    else out[name] = String(value);
  }
  // The test runner marks its children; a spawned server is not a test file.
  delete out.NODE_TEST_CONTEXT;
  const merged = mergeNodeOptions(out.NODE_OPTIONS, version);
  if (merged) out.NODE_OPTIONS = merged;
  else delete out.NODE_OPTIONS;
  return out;
}

// The argv (after the node binary) for a script: allow-listed execArgv, the
// net guard, then extra flags, the script and its arguments.
export function nodeArgs(script, args = [], { execArgv = process.execArgv, extraExecArgv = [], netGuard = true, parentCwd = process.cwd() } = {}) {
  const flags = allowedExecArgv(execArgv, { cwd: parentCwd });
  if (netGuard) {
    const guardFlag = `--import=${NET_GUARD_PATH}`;
    if (!flags.includes(guardFlag)) flags.push(guardFlag);
  }
  for (const flag of extraExecArgv) if (!flags.includes(flag)) flags.push(flag);
  return [...flags, script, ...args];
}

// spawnNode(script, args, env, options) -> ChildProcess
//   options: cwd, stdio, execArgv (the parent's, default process.execArgv),
//   extraExecArgv, netGuard (default true), execPath, version.
export function spawnNode(script, args = [], env = {}, options = {}) {
  const { cwd = PROJECT_ROOT, stdio = ['ignore', 'pipe', 'pipe'], execPath = process.execPath, version = process.versions.node } = options;
  const resolvedScript = isAbsolute(script) ? script : resolve(cwd, script);
  const argv = nodeArgs(resolvedScript, args, options);
  return spawn(execPath, argv, { cwd, stdio, env: childEnv(env, { version }) });
}

// Runs a script to completion. Resolves { code, signal, stdout, stderr }.
export function runNode(script, args = [], env = {}, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawnNode(script, args, env, options);
    const out = [];
    const err = [];
    child.stdout?.on('data', (c) => out.push(c));
    child.stderr?.on('data', (c) => err.push(c));
    child.once('error', reject);
    child.once('close', (code, signal) => {
      resolvePromise({ code, signal, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8') });
    });
  });
}
