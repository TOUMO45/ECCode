// NFR1: server-proc.js starts src/index.js with PORT=0, a temp RS_DB_PATH, fake adapters,
// RS_TEST_OFFLINE=1 and RS_TEST_HOOKS=1, and reads the bound port from the listening line.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { baseServerEnv, createListeningParser, startServer } from '../../helpers/server-proc.js';

test('NFR1: baseServerEnv sets the harness environment and clears inherited RS_ names', () => {
  const base = { RS_ADMIN_PASSWORD: 'x'.repeat(20), PORT: '8080', ANTHROPIC_API_KEY: 'k', PATH: '/bin', RS_PAYMENT_PROVIDER: 'paypal-sandbox' };
  const env = baseServerEnv({ dir: '/tmp/rs-x', overrides: { RS_TAX_BP: '100' }, base });
  assert.equal(env.PORT, '0');
  assert.equal(env.HOST, '127.0.0.1');
  assert.equal(env.RS_DB_PATH, '/tmp/rs-x/app.db');
  assert.equal(env.RS_UPLOAD_DIR, '/tmp/rs-x/uploads');
  assert.equal(env.RS_PAYMENT_PROVIDER, 'fake');
  assert.equal(env.RS_MODEL_PROVIDER, 'fake');
  assert.equal(env.RS_TEST_OFFLINE, '1');
  assert.equal(env.RS_TEST_HOOKS, '1');
  assert.equal(env.RS_TAX_BP, '100');
  assert.equal(env.RS_MAX_REQUESTS_PER_CUSTOMER_PER_DAY, '1000');
  assert.equal(env.RS_MAX_LIVE_RESERVATIONS_PER_CUSTOMER, '1');
  // Inherited names that are not overridden are removed (undefined removes a name in node-proc).
  assert.equal(env.RS_ADMIN_PASSWORD, undefined);
  assert.equal('RS_ADMIN_PASSWORD' in env, true);
  assert.equal(env.ANTHROPIC_API_KEY, undefined);
  assert.equal('PATH' in env, false);
  assert.equal(baseServerEnv({ dir: '/d', dbPath: '/other/db.sqlite' }).RS_DB_PATH, '/other/db.sqlite');
});

test('NFR1: the listening parser finds the port across chunks and ignores other lines', () => {
  const parser = createListeningParser();
  assert.equal(parser.push('(node:1) ExperimentalWarning: SQLite\n{"ts":"x","level":"info","msg":"migrate","requestId":"sys-1"}\n{"ts":"x","level":"info","msg":"listen'), null);
  assert.equal(parser.push('ing","requestId":"sys-1","port":41234}\n'), 41234);
  const other = createListeningParser();
  assert.equal(other.push('{"msg":"listening","port":"nope"}\n'), null);
  assert.equal(other.push('{"msg":"listening"}\n'), null);
});

test('NFR1: startServer runs src/index.js, answers on the port it printed, and stops on SIGTERM', async () => {
  const server = await startServer();
  try {
    assert.equal(Number.isInteger(server.port) && server.port > 0, true);
    assert.equal(server.env.PORT, '0');
    assert.equal(server.env.RS_TEST_OFFLINE, '1');
    assert.equal(server.env.RS_TEST_HOOKS, '1');
    assert.equal(server.env.RS_PAYMENT_PROVIDER, 'fake');
    assert.equal(dirname(server.dbPath), server.dir);
    assert.match(server.stdout(), /"msg":"listening"/);
    const health = await server.request({ path: '/api/health' });
    assert.equal(health.status, 200);
    assert.equal(existsSync(server.dbPath), true);
    const exit = await server.stop('SIGTERM');
    assert.deepEqual(exit, { code: 0, signal: null }, server.stderr());
  } finally {
    await server.cleanup();
  }
  assert.equal(existsSync(join(server.dir)), false, 'the temp directory is removed');
});

test('NFR1: startServer reports a refusal at startup with the process output instead of hanging', async () => {
  await assert.rejects(
    () => startServer({ env: { RS_TAX_BP: 'not-a-number' }, readyTimeoutMs: 20000 }),
    (err) => /exited before listening \(code 1/.test(err.message) && /RS_TAX_BP/.test(err.message),
  );
});
