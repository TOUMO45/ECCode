// Process entry logic: umask, configuration, directories, database, migrations,
// application, listener, shutdown. src/index.js runs the Node version gate and
// then imports this file (so node:sqlite is only loaded on a supported Node).
import { chmodSync, mkdirSync, statSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { createApp } from './app.js';
import { systemClock } from './clock.js';
import { ConfigError, loadConfig } from './config.js';
import { openDb } from './db/connection.js';
import { migrate } from './db/migrate.js';
import { getOrCreateMeta } from './db/meta.js';
import { createLogger } from './log.js';
import { createVoidPort } from './services/calls.js';
import { createAiRuntime } from './services/extraction.js';
import { createReconciler } from './services/reconciler.js';
import { startRetention } from './services/retention.js';
import { ensureAdmin } from './services/users.js';

// A pre-existing directory named data or uploads (the app's own, per SEC-14) that is owned by the
// current user and open to group or others is tightened to 0700 (SEC-B-5). Any other existing
// directory is left alone, because it may be shared (for example /tmp).
const APP_DIR_NAMES = new Set(['data', 'uploads']);

function tightenDir(dir) {
  try {
    const info = statSync(dir);
    const ownedByUs = typeof process.getuid !== 'function' || info.uid === process.getuid();
    if (ownedByUs && (info.mode & 0o077) !== 0) chmodSync(dir, 0o700);
  } catch {
    // Not ours to change; the files inside are still created owner-only by the umask.
  }
}

// data/ and data/uploads/ are created with mode 0700 (SEC-14).
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
    } else if (APP_DIR_NAMES.has(basename(dir))) {
      tightenDir(dir);
    }
  }
  return created;
}

// The real model adapters (src/ai/cli.js, src/ai/anthropic.js) are loaded only when they are the configured provider. An
// adapter that cannot be used (the claude binary is not found, the module does not load) is not an error: selectProvider then
// falls back to the labelled fake, and the configuration the app sees says so (see startApp). Nothing here calls a model.
export async function loadAdapterFactories(config, { log, clock }) {
  const factories = {};
  if (config.testOffline) return factories; // RS_TEST_OFFLINE=1: always the fake, never a real adapter
  const unavailable = (kind, err, code) => log.warn('extraction.adapter_missing', { kind, code: code ?? (err && err.code ? String(err.code) : 'IMPORT_FAILED') });
  if (config.extractionProvider === 'cli') {
    try {
      const mod = await import('./ai/cli.js');
      if (await mod.cliVersion()) {
        factories.cli = () =>
          mod.createCliProvider({ model: config.model, timeoutMs: config.modelTimeoutMs, callCapMicroUsd: config.modelCallCapMicroUsd, clock });
      } else {
        unavailable('cli', null, 'BINARY_NOT_FOUND');
      }
    } catch (err) {
      unavailable('cli', err);
    }
  }
  if (config.extractionProvider === 'anthropic') {
    try {
      const mod = await import('./ai/anthropic.js');
      factories.anthropic = () =>
        mod.createAnthropicProvider({
          apiKey: config.anthropicApiKey, baseUrl: config.anthropicBaseUrl, model: config.anthropicModel, timeoutMs: config.modelTimeoutMs,
          usdPerMtokIn: config.anthropicUsdPerMtokIn, usdPerMtokOut: config.anthropicUsdPerMtokOut, clock,
        });
    } catch (err) {
      unavailable('anthropic', err);
    }
  }
  return factories;
}

// Builds everything and starts listening. Returns { app, db, config, port, ai, retention, reconciler, payments, close }.
// The fake approval listener (fake provider only) is started by app.listen(); the reconciler runs once now and then every
// RS_RECONCILE_INTERVAL_MS. The REAL void port is passed to createApp: without it a void would never leave the process.
export async function startApp({ env = process.env, log = createLogger(), clock = systemClock, routes = [], provider = null } = {}) {
  // Files the process creates (database, WAL files, uploads) are owner-only (SEC-14).
  process.umask(0o077);

  const requested = loadConfig(env);
  ensureRuntimeDirs(requested);
  let config = requested;

  const db = openDb(config.dbPath, { busyTimeoutMs: config.dbBusyTimeoutMs });
  try {
    migrate(db, { clock, log });
    getOrCreateMeta(db, 'csrf_key', () => randomBytes(32).toString('hex'));
    if (config.paymentProvider === 'fake' && !config.fakeWebhookSecret) {
      getOrCreateMeta(db, 'fake_webhook_secret', () => randomBytes(32).toString('hex'));
    }

    // The admin account follows RS_ADMIN_PASSWORD: created or updated as a scrypt hash, or disabled when unset (SEC-5).
    const adminState = await ensureAdmin({ db, config, clock });
    log.info('auth.admin', { kind: adminState });

    // The model: the configured provider, or the labelled fake when its adapter is unavailable. The configuration the app
    // sees names the provider that really runs, so /api/config and the labels never claim a model that is not there.
    // `provider` is a seam for tests (an ExtractionProvider used as is); production passes none.
    const ai = createAiRuntime({
      db, clock, config: requested, provider, factories: provider ? {} : await loadAdapterFactories(requested, { log, clock }),
    });
    if (ai.selection.fellBack) log.warn('extraction.fallback', { provider: ai.provider.id, kind: ai.selection.requested });
    if (ai.provider.id !== requested.extractionProvider) config = Object.freeze({ ...requested, extractionProvider: ai.provider.id });

    const app = createApp({ db, clock, config, log, routes, ai, voidProvider: createVoidPort({ clock }) });
    const port = await app.listen();
    log.info('listening', { port });
    // The retention sweep: now (startup), then every RS_RETENTION_INTERVAL_MS (default hourly).
    const retention = startRetention({ db, clock, config, log, gate: ai.gate });
    // The reconciler: now (startup: an intent left by a dead process becomes unknown, a lapsed lease is taken over), then every
    // RS_RECONCILE_INTERVAL_MS. app.deps holds the payment adapter that listen() built.
    const reconciler = createReconciler(app.deps);
    reconciler.start();
    return {
      app,
      db,
      config,
      port,
      ai,
      retention,
      reconciler,
      get payments() {
        return app.payments;
      },
      async close() {
        await reconciler.stop();
        await retention.stop();
        // TR-D-9: kill in-flight CLI children (their own process groups) before the app drains. Adapters without close() (the
        // fake, the API adapter) have nothing to release; a failing close never blocks the shutdown.
        try {
          if (typeof ai.provider.close === 'function') await ai.provider.close();
        } catch (err) {
          log.warn('extraction.close_failed', { code: err && err.code ? String(err.code) : 'CLOSE_FAILED', kind: err && err.name });
        }
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

  // TR-D-16: stop() is idempotent and the handlers stay installed (`on`, not `once`), so a second signal during close()'s grace
  // period (Ctrl-C twice, a SIGTERM after a SIGHUP) is swallowed instead of falling to the default disposition, which would kill
  // the server with a CLI child still alive. SIGHUP (a closed terminal) is handled like SIGINT and SIGTERM.
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
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, stop);
}
