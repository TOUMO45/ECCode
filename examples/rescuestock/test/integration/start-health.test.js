// NFR1: the `npm start` equivalent serves GET /api/health with 200.
// The spawn mirrors the package.json start script step by step (the flag-free Node gate, then
// `node <flags> src/index.js`), but with PORT=0 and a temp database so the test can run beside
// others; the port comes from the listening line on stdout. Its process carries the net guard.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { PROJECT_ROOT, runNode } from '../helpers/node-proc.js';
import { startServer } from '../helpers/server-proc.js';

const start = JSON.parse(readFileSync(join(PROJECT_ROOT, 'package.json'), 'utf8')).scripts.start;

// "node scripts/check-node.cjs && node --disable-warning=ExperimentalWarning src/index.js"
function splitStart(command) {
  const steps = command.split(' && ').map((s) => s.trim().split(/\s+/));
  assert.equal(steps.length, 2, 'start is the gate followed by the server command');
  const [gate, server] = steps;
  assert.deepEqual(gate, ['node', 'scripts/check-node.cjs'], 'the gate has no flags');
  assert.equal(server[0], 'node');
  const script = server.at(-1);
  const flags = server.slice(1, -1);
  assert.equal(
    flags.every((f) => f.startsWith('--')),
    true,
    `only flags between node and the script (${flags})`,
  );
  return { gate: gate[1], script, flags };
}

test('NFR1: the start script splits into the Node gate and src/index.js', () => {
  const parts = splitStart(start);
  assert.equal(parts.gate, 'scripts/check-node.cjs');
  assert.equal(parts.script, 'src/index.js');
  assert.deepEqual(parts.flags, ['--disable-warning=ExperimentalWarning']);
});

test('NFR1: the Node gate passes silently on this Node', async () => {
  const { gate } = splitStart(start);
  const result = await runNode(gate, [], {}, { netGuard: false, execArgv: [] });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.equal(result.stdout, '');
});

test('NFR1: the start equivalent serves GET /api/health with 200 and stops cleanly', async () => {
  const { script, flags } = splitStart(start);
  const server = await startServer({ script, extraExecArgv: flags });
  try {
    const health = await server.request({ path: '/api/health' });
    assert.equal(health.status, 200);
    assert.equal(health.json.status, 'ok');
    assert.equal(typeof health.json.requestId, 'string');
    assert.equal(health.headers['x-request-id'], health.json.requestId);
    assert.match(health.headers['content-type'], /^application\/json/);

    const listening = server
      .stdout()
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l))
      .find((l) => l.msg === 'listening');
    assert.equal(listening.port, server.port);

    const exit = await server.stop('SIGTERM');
    assert.deepEqual(exit, { code: 0, signal: null }, server.stderr());
  } finally {
    await server.cleanup();
  }
});

test('NFR1: the server refuses a Host it does not serve, so a rebinding name cannot reach /api/health', async () => {
  const server = await startServer();
  try {
    const refused = await server.request({ path: '/api/health', host: 'evil.example' });
    assert.equal(refused.status, 421);
    assert.equal(refused.json.error.code, 'MISDIRECTED_REQUEST');
    const ok = await server.request({ path: '/api/health', host: `localhost:${server.port}` });
    assert.equal(ok.status, 200);
  } finally {
    await server.cleanup();
  }
});

test('NFR3: the server process runs in test mode with fake adapters (harness environment)', async () => {
  const server = await startServer();
  try {
    assert.equal(server.env.RS_TEST_OFFLINE, '1');
    assert.equal(server.env.RS_TEST_HOOKS, '1');
    assert.equal(server.env.PORT, '0');
    const config = await server.request({ path: '/api/config' });
    assert.equal(config.status, 200);
    assert.equal(config.json.paymentProvider, 'fake');
    assert.equal(config.json.extractionProvider, 'fake');
    assert.equal(config.json.labels.testMode, true);
    assert.equal(dirname(server.dbPath), server.dir);
  } finally {
    await server.cleanup();
  }
});
