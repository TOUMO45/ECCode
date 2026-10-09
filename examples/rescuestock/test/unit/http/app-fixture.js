// Shared fixture for the foundation tests: an in-process app on 127.0.0.1:0
// with a temporary database, and a small HTTP client that can set the Host header.
// Not a test file (the name does not end in .test.js).
import { mkdtempSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../../../src/app.js';
import { fixedClock } from '../../../src/clock.js';
import { loadConfig } from '../../../src/config.js';
import { openDb } from '../../../src/db/connection.js';
import { migrate } from '../../../src/db/migrate.js';
import { createLogger } from '../../../src/log.js';

export function tempDir(prefix = 'rs-test-') {
  return mkdtempSync(join(tmpdir(), prefix));
}

export function testEnv(dir, overrides = {}) {
  return {
    PORT: '0',
    RS_DB_PATH: join(dir, 'app.db'),
    RS_UPLOAD_DIR: join(dir, 'uploads'),
    RS_TEST_OFFLINE: '1',
    RS_DEMO_DATE: '2026-10-20',
    ...overrides,
  };
}

export async function startTestApp({ env = {}, routes = [], publicDir, authorize, dbBusyTimeoutMs } = {}) {
  const dir = tempDir();
  const config = loadConfig(testEnv(dir, env));
  const lines = [];
  const log = createLogger({ write: (line) => lines.push(line) });
  const clock = fixedClock(Date.UTC(2026, 9, 20, 6, 0, 0));
  const db = openDb(config.dbPath, { busyTimeoutMs: dbBusyTimeoutMs ?? config.dbBusyTimeoutMs });
  migrate(db, { clock });
  const app = createApp({ db, clock, config, log, routes, publicDir, authorize });
  const port = await app.listen(0, '127.0.0.1');

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
            // Not JSON; tests read `text`.
          }
          resolve({ status: res.statusCode, headers: res.headers, text, json });
        });
      });
      req.on('error', reject);
      if (body !== undefined) req.write(body);
      req.end();
    });
  }

  return {
    app,
    db,
    config,
    port,
    dir,
    lines,
    clock,
    request,
    logEntries: () => lines.map((l) => JSON.parse(l)),
    async close() {
      await app.close();
      try {
        db.close();
      } catch {
        // A test may have closed the database on purpose.
      }
    },
  };
}
