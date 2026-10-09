// Process entry: config -> DB -> migrations -> server; hourly session purge; graceful shutdown.
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { loadConfig, ConfigError } from './config.js';
import { openDb, DbError } from './db/connection.js';
import { migrate, MigrationError } from './db/migrate.js';
import { createApp } from './app.js';

function fatal(msg) {
  console.error(`groundwork: ${msg}`);
  process.exit(1);
}

/** An API key must never travel over cleartext to a remote host. */
export function assertSafeApiUrl(url) {
  let u;
  try { u = new URL(url); } catch { throw new ConfigError('GW_ANTHROPIC_URL is not a valid URL'); }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && loopback)) {
    throw new ConfigError('GW_ANTHROPIC_URL must use https (http is allowed only for loopback)');
  }
}

async function main() {
  const config = loadConfig();
  assertSafeApiUrl(config.anthropic.url);
  const db = openDb(config.dbPath);
  if (config.dbPath !== ':memory:') {
    try { fs.chmodSync(config.dbPath, 0o600); } catch { /* best effort on this OS */ }
  }
  const { applied, schemaVersion } = migrate(db);
  const app = await createApp({ config, db });
  const { port, url } = await app.listen();
  console.log(JSON.stringify({ ts: new Date().toISOString(), event: 'startup', url, port, schemaVersion, migrationsApplied: applied }));

  const purge = setInterval(() => {
    try { app.ctx.sessions.purgeExpired(); } catch { /* retried next hour */ }
  }, 60 * 60 * 1000);
  purge.unref();
  app.ctx.sessions.purgeExpired();

  let closing = false;
  const shutdown = async (sig) => {
    if (closing) return;
    closing = true;
    clearInterval(purge);
    await app.close();
    try { db.close(); } catch { /* already closed */ }
    console.log(JSON.stringify({ ts: new Date().toISOString(), event: 'shutdown', signal: sig }));
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
  main().catch((e) => {
    if (e instanceof ConfigError || e instanceof DbError || e instanceof MigrationError) fatal(e.message);
    if (e?.code === 'EADDRINUSE') fatal('port already in use');
    fatal(`failed to start (${e?.constructor?.name ?? 'Error'}${e?.code ? ` ${e.code}` : ''})`);
  });
}
