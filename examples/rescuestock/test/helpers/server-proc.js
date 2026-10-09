// Starts the real server (src/index.js) as a separate OS process for the
// integration tests. Environment: PORT=0, a temp RS_DB_PATH, fake adapters,
// RS_TEST_OFFLINE=1 and RS_TEST_HOOKS=1; the bound port is read from the
// {"msg":"listening","port":N} line on stdout. The process goes through
// node-proc.js, so it carries the net guard and (on Node < 22.13) the sqlite flags.
//
// Waits are for events (the listening line, the process exit), not for time;
// the timeouts below only bound a hang.
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PROJECT_ROOT, spawnNode } from './node-proc.js';

export const DEFAULT_TEST_DATE = '2026-10-20';

// Names a developer's shell could carry in that would change what the server does.
const INHERITED_NAME = /^(RS_|PORT$|HOST$|ANTHROPIC_|PAYPAL_)/;

export function baseServerEnv({ dir, dbPath, uploadDir, overrides = {}, base = process.env } = {}) {
  const env = {};
  for (const name of Object.keys(base)) if (INHERITED_NAME.test(name)) env[name] = undefined;
  Object.assign(env, {
    PORT: '0',
    HOST: '127.0.0.1',
    RS_DB_PATH: dbPath ?? join(dir, 'app.db'),
    RS_UPLOAD_DIR: uploadDir ?? join(dir, 'uploads'),
    RS_PAYMENT_PROVIDER: 'fake',
    RS_MODEL_PROVIDER: 'fake',
    RS_TEST_OFFLINE: '1',
    RS_TEST_HOOKS: '1',
    RS_DEMO_DATE: DEFAULT_TEST_DATE,
    // Multi-process and browser harnesses pin these so earlier journeys cannot
    // exhaust the per-customer daily count (spec: Testing Strategy, F-TR-15).
    RS_MAX_REQUESTS_PER_CUSTOMER_PER_DAY: '1000',
    RS_MAX_LIVE_RESERVATIONS_PER_CUSTOMER: '1',
  });
  return Object.assign(env, overrides);
}

// Finds {"msg":"listening","port":N} in a stream of stdout chunks.
export function createListeningParser() {
  let pending = '';
  return {
    push(chunk) {
      pending += chunk;
      let newline = pending.indexOf('\n');
      let found = null;
      while (newline !== -1) {
        const line = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        newline = pending.indexOf('\n');
        if (found !== null) continue;
        try {
          const parsed = JSON.parse(line);
          if (parsed && parsed.msg === 'listening' && Number.isInteger(parsed.port)) found = parsed.port;
        } catch {
          // Not a JSON line (for example a warning); ignore it.
        }
      }
      return found;
    },
  };
}

// startServer({ env, dir, dbPath, execArgv, script, readyTimeoutMs, version })
//   dir: use this directory for the database and uploads (kept on stop); default is a new temp dir (removed by cleanup()).
// Resolves { port, url, pid, child, dir, dbPath, env, stdout(), stderr(), request(), stop(), kill(), exited, cleanup() }.
export async function startServer(options = {}) {
  const { env: overrides = {}, dbPath, script = 'src/index.js', extraExecArgv = [], readyTimeoutMs = 30000, version, execArgv } = options;
  const ownsDir = !options.dir;
  const dir = options.dir ?? mkdtempSync(join(tmpdir(), 'rs-server-'));
  mkdirSync(dir, { recursive: true });
  const env = baseServerEnv({ dir, dbPath, overrides });

  const spawnOptions = { cwd: PROJECT_ROOT, extraExecArgv };
  if (version !== undefined) spawnOptions.version = version;
  if (execArgv !== undefined) spawnOptions.execArgv = execArgv;
  const child = spawnNode(script, [], env, spawnOptions);

  const outChunks = [];
  const errChunks = [];
  const parser = createListeningParser();
  let exitInfo = null;
  const exited = new Promise((resolve) => {
    child.once('close', (code, signal) => {
      exitInfo = { code, signal };
      resolve(exitInfo);
    });
  });
  child.stderr.on('data', (c) => errChunks.push(c));

  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`server did not print its listening line within ${readyTimeoutMs} ms; stderr: ${Buffer.concat(errChunks).toString('utf8')}`));
    }, readyTimeoutMs);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      outChunks.push(chunk);
      const found = parser.push(chunk);
      if (found !== null) {
        clearTimeout(timer);
        resolve(found);
      }
    });
    child.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      reject(new Error(`server exited before listening (code ${code}, signal ${signal}); stderr: ${Buffer.concat(errChunks).toString('utf8')}`));
    });
  }).catch(async (err) => {
    child.kill('SIGKILL');
    await exited;
    if (ownsDir) rmSync(dir, { recursive: true, force: true });
    throw err;
  });

  function request({ method = 'GET', path = '/', headers = {}, body, host } = {}) {
    return new Promise((resolve, reject) => {
      const h = { ...headers };
      if (host !== undefined) h.Host = host;
      const req = httpRequest({ host: '127.0.0.1', port, method, path, headers: h, agent: false }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try {
            json = JSON.parse(text);
          } catch {
            // Not JSON; callers read `text`.
          }
          resolve({ status: res.statusCode, headers: res.headers, text, json });
        });
      });
      req.on('error', reject);
      if (body !== undefined) req.write(body);
      req.end();
    });
  }

  async function stop(signal = 'SIGTERM', { forceAfterMs = 10000 } = {}) {
    if (exitInfo) return exitInfo;
    child.kill(signal);
    const timer = setTimeout(() => child.kill('SIGKILL'), forceAfterMs);
    try {
      return await exited;
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    port,
    url: `http://127.0.0.1:${port}`,
    pid: child.pid,
    child,
    dir,
    dbPath: env.RS_DB_PATH,
    env,
    stdout: () => outChunks.join(''),
    stderr: () => Buffer.concat(errChunks).toString('utf8'),
    request,
    stop,
    kill: (signal = 'SIGKILL') => child.kill(signal),
    exited,
    async cleanup() {
      await stop('SIGTERM');
      if (ownsDir) rmSync(dir, { recursive: true, force: true });
    },
  };
}
