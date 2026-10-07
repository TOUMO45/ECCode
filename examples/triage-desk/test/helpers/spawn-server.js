'use strict';
// Starts `node src/server.js` as a child process for end-to-end tests (spec §Testing Strategy).
// DES-1: the child env is built EXPLICITLY as { PATH: process.env.PATH, ...testEnv, PORT: '0' }.
// Nothing else from process.env is spread or copied, so a real ANTHROPIC_API_KEY or base URL in the
// developer's shell can never reach the child.
const { spawn } = require('node:child_process');
const path = require('node:path');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const live = new Set();

// Last-resort cleanup: never leave a server running if a test forgets stop().
process.once('exit', () => {
  for (const child of live) {
    try { child.kill('SIGKILL'); } catch { /* already gone */ }
  }
});

/**
 * @param {Record<string,string>} [testEnv] string values only.
 * @returns {Record<string,string>} exactly { PATH, ...testEnv, PORT: '0' } (PATH omitted if the parent has none).
 */
function buildChildEnv(testEnv = {}) {
  for (const [k, v] of Object.entries(testEnv)) {
    if (typeof v !== 'string') throw new TypeError(`spawn-server: env value for ${k} must be a string`);
  }
  const env = {};
  if (typeof process.env.PATH === 'string') env.PATH = process.env.PATH;
  Object.assign(env, testEnv);
  env.PORT = '0';
  return env;
}

function parseLine(line) {
  try {
    const rec = JSON.parse(line);
    return rec !== null && typeof rec === 'object' ? rec : null;
  } catch {
    return null;
  }
}

/**
 * @param {{env?:Record<string,string>, entry?:string, cwd?:string, timeoutMs?:number}} [opts]
 *   env: test variables (see buildChildEnv). entry: script path relative to cwd (default src/server.js).
 *   cwd: default the project root. timeoutMs: how long to wait for the `listening` line (default 10 s).
 * @returns {Promise<SpawnedServer>} resolved once stdout carries {"event":"listening","port":<n>}.
 *   Rejects (after killing the child) on early exit or timeout; the error has exitCode, signal,
 *   stdout and stderr properties.
 *
 * SpawnedServer:
 *   child, port, listening (the parsed listening record), env (what the child got)
 *   stdout() / stderr(): everything captured so far, as strings
 *   logs(): every stdout line that parsed as a JSON object
 *   waitForLog(predicate, {timeoutMs=5000}): resolves with the first (past or future) matching record
 *   stop(): SIGTERM, then SIGKILL after 3 s; resolves {code, signal}. Idempotent.
 */
function spawnServer({ env: testEnv = {}, entry = 'src/server.js', cwd = PROJECT_ROOT, timeoutMs = 10000 } = {}) {
  const env = buildChildEnv(testEnv);
  const child = spawn(process.execPath, [entry], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
  live.add(child);

  let out = '';
  let err = '';
  let partial = '';
  const records = [];
  const waiters = new Set();
  let exitInfo = null;
  const exited = new Promise((resolve) => {
    child.once('exit', (code, signal) => {
      exitInfo = { code, signal };
      live.delete(child);
      resolve(exitInfo);
    });
  });

  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (d) => { err += d; });
  child.stdout.on('data', (d) => {
    out += d;
    partial += d;
    let nl;
    while ((nl = partial.indexOf('\n')) !== -1) {
      const line = partial.slice(0, nl);
      partial = partial.slice(nl + 1);
      const rec = parseLine(line);
      if (!rec) continue;
      records.push(rec);
      for (const w of [...waiters]) {
        if (w.predicate(rec)) { waiters.delete(w); w.resolve(rec); }
      }
    }
  });

  function stop() {
    if (exitInfo) return Promise.resolve(exitInfo);
    child.kill('SIGTERM');
    const force = setTimeout(() => { if (!exitInfo) child.kill('SIGKILL'); }, 3000);
    return exited.then((info) => { clearTimeout(force); return info; });
  }

  function waitForLog(predicate, { timeoutMs: waitMs = 5000 } = {}) {
    const found = records.find(predicate);
    if (found) return Promise.resolve(found);
    return new Promise((resolve, reject) => {
      const w = { predicate, resolve: (rec) => { clearTimeout(timer); resolve(rec); } };
      const timer = setTimeout(() => {
        waiters.delete(w);
        reject(new Error(`spawn-server: no matching log line within ${waitMs} ms`));
      }, waitMs);
      waiters.add(w);
    });
  }

  function failure(message) {
    const e = new Error(message);
    e.exitCode = exitInfo ? exitInfo.code : null;
    e.signal = exitInfo ? exitInfo.signal : null;
    e.stdout = out;
    e.stderr = err;
    return e;
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    // No timer of its own: the startup timer below bounds the wait, and every exit path removes it.
    const listeningWaiter = {
      predicate: (rec) => rec.event === 'listening' && Number.isInteger(rec.port) && rec.port > 0,
      resolve: (listening) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({
          child,
          env,
          port: listening.port,
          listening,
          stdout: () => out,
          stderr: () => err,
          logs: () => records.slice(),
          waitForLog,
          stop,
        });
      },
    };
    const giveUp = (message, { kill }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      waiters.delete(listeningWaiter);
      const done = kill ? stop() : Promise.resolve();
      // setImmediate lets buffered stderr drain before it is attached to the error.
      done.then(() => setImmediate(() => reject(failure(message))));
    };
    const timer = setTimeout(() => {
      giveUp(`spawn-server: ${entry} did not log a listening event within ${timeoutMs} ms`, { kill: true });
    }, timeoutMs);

    child.once('error', (e) => giveUp(`spawn-server: could not start ${entry}: ${e.code || e.name}`, { kill: false }));
    exited.then(() => giveUp(`spawn-server: ${entry} exited before listening (code ${exitInfo.code}, signal ${exitInfo.signal})`, { kill: false }));

    waiters.add(listeningWaiter);
  });
}

module.exports = { spawnServer, buildChildEnv, PROJECT_ROOT };
