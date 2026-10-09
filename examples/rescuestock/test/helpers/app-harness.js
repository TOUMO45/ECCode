// In-process application for the API tests: createApp with a fixed clock, a temp
// SQLite file, fake adapters (RS_TEST_OFFLINE=1) and a listener on 127.0.0.1:0.
// Every request made through harness.request() is timed and appended to
// test/.out/latency.jsonl, which scripts/report-p95.js turns into the NFR5 p95.
// Multi-process and restart tests use server-proc.js, which does not record.
import { appendFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { createApp } from '../../src/app.js';
import { fixedClock } from '../../src/clock.js';
import { loadConfig } from '../../src/config.js';
import { openDb } from '../../src/db/connection.js';
import { migrate } from '../../src/db/migrate.js';
import { createLogger } from '../../src/log.js';

const HERE = dirname(fileURLToPath(import.meta.url));
export const OUT_DIR = resolve(HERE, '..', '.out');
export const LATENCY_FILE = join(OUT_DIR, 'latency.jsonl');

// 2026-10-20 09:00 in Asia/Amman (UTC+3), the RS-FIX-1 "now".
export const FIXED_NOW_MS = Date.UTC(2026, 9, 20, 6, 0, 0);
export const DEMO_DATE = '2026-10-20';
// Shared password of the seeded demo accounts in tests (not a secret; local temp database only).
export const DEMO_PASSWORD = 'demo-password-for-tests';

export function testEnv(dir, overrides = {}) {
  return {
    PORT: '0',
    HOST: '127.0.0.1',
    RS_DB_PATH: join(dir, 'app.db'),
    RS_UPLOAD_DIR: join(dir, 'uploads'),
    RS_PAYMENT_PROVIDER: 'fake',
    RS_MODEL_PROVIDER: 'fake',
    RS_TEST_OFFLINE: '1',
    RS_DEMO_DATE: DEMO_DATE,
    ...overrides,
  };
}

// One latency sample per line. appendFileSync of a short line is a single
// O_APPEND write, so test files running in parallel do not interleave lines.
export function recordLatency(sample, file = LATENCY_FILE) {
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, `${JSON.stringify(sample)}\n`);
}

// startHarness({ env, routes, authorize, publicDir, dbBusyTimeoutMs, startMs, seed, record, latencyFile })
export async function startHarness({
  env = {},
  routes = [],
  authorize = null,
  publicDir,
  dbBusyTimeoutMs,
  startMs = FIXED_NOW_MS,
  seed = false,
  record = true,
  latencyFile = LATENCY_FILE,
} = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'rs-app-'));
  const config = loadConfig(testEnv(dir, env));
  const lines = [];
  const log = createLogger({ write: (line) => lines.push(line), clock: fixedClock(startMs) });
  const clock = fixedClock(startMs);
  const db = openDb(config.dbPath, { busyTimeoutMs: dbBusyTimeoutMs ?? config.dbBusyTimeoutMs });
  let app;
  try {
    migrate(db, { clock });
    if (seed) {
      const { seedDatabase } = await import('../../scripts/seed.js');
      seedDatabase(db, { clock, demoDate: config.demoDate ?? DEMO_DATE, demoPassword: DEMO_PASSWORD });
    }
    app = createApp({ db, clock, config, log, routes, publicDir, authorize });
  } catch (err) {
    db.close();
    rmSync(dir, { recursive: true, force: true });
    throw err;
  }
  const port = await app.listen(0, '127.0.0.1');

  // request({ method, path, headers, body, host }) -> { status, headers, text, json, ms }
  // `body` is a string or Buffer; use jsonBody for an object. `host` overrides the Host header.
  function request({ method = 'GET', path = '/', headers = {}, body, jsonBody, host, record: recordThis = record } = {}) {
    return new Promise((resolvePromise, reject) => {
      const h = { ...headers };
      if (host !== undefined) h.Host = host;
      let payload = body;
      if (jsonBody !== undefined) {
        payload = JSON.stringify(jsonBody);
        h['Content-Type'] = h['Content-Type'] ?? 'application/json';
      }
      if (payload !== undefined) h['Content-Length'] = String(Buffer.byteLength(payload));
      const started = performance.now();
      const req = httpRequest({ host: '127.0.0.1', port, method, path, headers: h, agent: false }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const ms = performance.now() - started;
          const text = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try {
            json = JSON.parse(text);
          } catch {
            // Not JSON; callers read `text`.
          }
          if (recordThis) {
            try {
              recordLatency({ method, path: path.split('?')[0], status: res.statusCode, ms: Math.round(ms * 1000) / 1000 }, latencyFile);
            } catch (err) {
              reject(err);
              return;
            }
          }
          resolvePromise({ status: res.statusCode, headers: res.headers, text, json, ms });
        });
      });
      req.on('error', reject);
      if (payload !== undefined) req.write(payload);
      req.end();
    });
  }

  return {
    app,
    db,
    config,
    port,
    dir,
    clock,
    lines,
    request,
    logEntries: () => lines.map((l) => JSON.parse(l)),
    async close() {
      await app.close();
      try {
        db.close();
      } catch {
        // A test may have closed the database on purpose.
      }
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
