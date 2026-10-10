// Holds the SQLite write lock of a database file from a separate OS process (lock-holder.js), for the
// DB_BUSY test (RS-14). Waits are for events (the "locked" line, the process exit), not for time; the
// timeout only bounds a hang.
import { spawnNode } from './node-proc.js';

// holdWriteLock(dbPath) -> { pid, release(), exited }
//   Resolves once the child holds BEGIN IMMEDIATE. release() rolls back and resolves when the child has exited.
export async function holdWriteLock(dbPath, { readyTimeoutMs = 15000 } = {}) {
  const child = spawnNode('test/helpers/lock-holder.js', [dbPath], {}, { stdio: ['pipe', 'pipe', 'pipe'] });
  const errChunks = [];
  child.stderr.on('data', (c) => errChunks.push(c));
  const exited = new Promise((resolve) => child.once('close', (code, signal) => resolve({ code, signal })));

  await new Promise((resolve, reject) => {
    let out = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`lock holder did not take the lock within ${readyTimeoutMs} ms; stderr: ${Buffer.concat(errChunks).toString('utf8')}`));
    }, readyTimeoutMs);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      out += chunk;
      if (out.includes('locked\n')) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    exited.then(({ code }) => {
      clearTimeout(timer);
      reject(new Error(`lock holder exited early (code ${code}); stderr: ${Buffer.concat(errChunks).toString('utf8')}`));
    });
  });

  return {
    pid: child.pid,
    exited,
    async release() {
      if (child.exitCode === null && child.signalCode === null) child.stdin.end('release\n');
      return exited;
    },
  };
}
