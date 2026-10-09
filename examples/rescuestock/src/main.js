// Process entry logic: umask, configuration, directories, database, migrations,
// application, listener, shutdown. src/index.js runs the Node version gate and
// then imports this file (so node:sqlite is only loaded on a supported Node).
import { mkdirSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { createApp } from './app.js';
import { systemClock } from './clock.js';
import { ConfigError, loadConfig } from './config.js';
import { openDb } from './db/connection.js';
import { migrate } from './db/migrate.js';
import { getOrCreateMeta } from './db/meta.js';
import { createLogger } from './log.js';

// data/ and data/uploads/ are created with mode 0700 (SEC-14). Directories that
// already exist are left as they are: they may be shared (for example /tmp).
export function ensureRuntimeDirs(config) {
  const dirs = [];
  if (config.dbPath !== ':memory:') dirs.push(dirname(resolve(config.dbPath)));
  dirs.push(resolve(config.uploadDir));
  const created = [];
  for (const dir of dirs) {
    let exists = true;
    try {
      exists = statSync(dir).isDirectory();
    } catch {
      exists = false;
    }
    if (!exists) {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      created.push(dir);
    }
  }
  return created;
}

// Builds everything and starts listening. Returns { app, db, config, port, close }.
export async function startApp({ env = process.env, log = createLogger(), clock = systemClock, routes = [] } = {}) {
  // Files the process creates (database, WAL files, uploads) are owner-only (SEC-14).
  process.umask(0o077);

  const config = loadConfig(env);
  ensureRuntimeDirs(config);

  const db = openDb(config.dbPath, { busyTimeoutMs: config.dbBusyTimeoutMs });
  try {
    migrate(db, { clock, log });
    getOrCreateMeta(db, 'csrf_key', () => randomBytes(32).toString('hex'));
    if (config.paymentProvider === 'fake' && !config.fakeWebhookSecret) {
      getOrCreateMeta(db, 'fake_webhook_secret', () => randomBytes(32).toString('hex'));
    }

    const app = createApp({ db, clock, config, log, routes });
    const port = await app.listen();
    log.info('listening', { port });
    return {
      app,
      db,
      config,
      port,
      async close() {
        await app.close();
        db.close();
      },
    };
  } catch (err) {
    try {
      db.close();
    } catch {
      // Already closed.
    }
    throw err;
  }
}

export async function main(env = process.env) {
  const log = createLogger();
  let running;
  try {
    running = await startApp({ env, log });
  } catch (err) {
    if (err instanceof ConfigError) {
      log.error('config.refused', { counts: { variables: err.variables.length } });
      process.stderr.write(`RescueStock refused to start. ${err.message}\n`);
    } else {
      log.error('startup.failed', { code: err && err.code ? String(err.code) : 'STARTUP_FAILED', kind: err && err.name });
      process.stderr.write(`RescueStock could not start (${err && err.code ? err.code : 'error'}).\n`);
    }
    process.exitCode = 1;
    return;
  }

  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    try {
      await running.close();
    } finally {
      process.exit(0);
    }
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}
