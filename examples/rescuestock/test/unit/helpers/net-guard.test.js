// NFR1 self-test of the offline network guard (test/helpers/net-guard.js).
// Every blocked call here is expected, so each test takes the attempts it caused.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import dns from 'node:dns';
import { createServer } from 'node:http';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import tls from 'node:tls';
import { NETWORK_BLOCKED, blockedAttempts, guardInstalled, isLoopbackHost, setQuiet, takeBlocked } from '../../helpers/net-guard.js';

// Every block below is on purpose; keep the test output free of NETWORK_BLOCKED lines.
setQuiet(true);

const GUARD_PATH = fileURLToPath(new URL('../../helpers/net-guard.js', import.meta.url));

function expectBlocked(fn, api) {
  takeBlocked();
  assert.throws(fn, (err) => err.code === NETWORK_BLOCKED && /NETWORK_BLOCKED/.test(err.message));
  const taken = takeBlocked();
  assert.equal(taken.length >= 1, true, `${api}: the attempt is recorded`);
  assert.equal(taken[0].api.length > 0, true);
  return taken;
}

test('NFR1: the guard is installed and starts with no blocked attempts', () => {
  assert.equal(guardInstalled(), true);
  assert.deepEqual(blockedAttempts(), []);
});

test('NFR1: loopback hosts are recognised and everything else is not', () => {
  for (const host of ['localhost', 'LOCALHOST', 'app.localhost', '127.0.0.1', '127.9.9.9', '::1', '[::1]', '::ffff:127.0.0.1', '', undefined, null]) {
    assert.equal(isLoopbackHost(host), true, String(host));
  }
  for (const host of ['example.com', '93.184.216.34', '10.0.0.1', '192.168.1.1', '0.0.0.0', '::', '2001:db8::1', '::ffff:10.0.0.1', 'localhost.example.com', '127.0.0.1.example.com', 42]) {
    assert.equal(isLoopbackHost(host), false, String(host));
  }
});

test('NFR1: net.connect to a non-loopback host throws NETWORK_BLOCKED (options and port forms)', () => {
  expectBlocked(() => net.connect({ host: 'example.com', port: 80 }), 'net.connect');
  expectBlocked(() => net.connect(80, '93.184.216.34'), 'net.connect');
  expectBlocked(() => net.createConnection({ host: '10.0.0.1', port: 9 }), 'net.createConnection');
});

test('NFR1: net.Socket.prototype.connect to a non-loopback host throws NETWORK_BLOCKED', () => {
  const socket = new net.Socket();
  try {
    const taken = expectBlocked(() => socket.connect({ host: 'example.org', port: 443 }), 'Socket#connect');
    assert.equal(taken[0].host, 'example.org');
  } finally {
    socket.destroy();
  }
});

test('NFR1: tls.connect to a non-loopback host throws NETWORK_BLOCKED', () => {
  expectBlocked(() => tls.connect({ host: 'api.anthropic.com', port: 443 }), 'tls.connect');
  expectBlocked(() => tls.connect(443, 'api-m.sandbox.paypal.com'), 'tls.connect');
});

test('NFR1: dns.lookup (callback and promise) for a non-loopback name throws NETWORK_BLOCKED', async () => {
  expectBlocked(() => dns.lookup('example.com', () => {}), 'dns.lookup');
  takeBlocked();
  await assert.rejects(
    async () => dns.promises.lookup('example.com'),
    (err) => err.code === NETWORK_BLOCKED,
  );
  assert.equal(takeBlocked().length, 1);
});

test('NFR1: globalThis.fetch to a non-loopback URL rejects with NETWORK_BLOCKED, for strings, URLs and Requests', async () => {
  takeBlocked();
  for (const input of ['https://example.com/', new URL('http://93.184.216.34/x'), new Request('https://api.anthropic.com/v1/messages')]) {
    await assert.rejects(() => fetch(input), (err) => err.code === NETWORK_BLOCKED);
  }
  const taken = takeBlocked();
  assert.equal(taken.length, 3);
  assert.deepEqual(
    taken.map((t) => t.host),
    ['example.com', '93.184.216.34', 'api.anthropic.com'],
  );
});

test('NFR1: loopback connections still work (http client and fetch to a local server, unix socket path)', async () => {
  takeBlocked();
  const server = createServer((req, res) => res.end('ok'));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    const viaFetch = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(await viaFetch.text(), 'ok');
    const viaLocalhost = await fetch(`http://localhost:${port}/`);
    assert.equal(await viaLocalhost.text(), 'ok');
    await new Promise((resolve, reject) => {
      const socket = net.connect({ host: '127.0.0.1', port }, () => {
        socket.end();
        resolve();
      });
      socket.on('error', reject);
    });
    await new Promise((resolve, reject) => {
      dns.lookup('localhost', (err) => (err ? reject(err) : resolve()));
    });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }

  const sockPath = join(tmpdir(), `rs-net-guard-${process.pid}.sock`);
  const unixServer = net.createServer((c) => c.end('x'));
  await new Promise((resolve) => unixServer.listen(sockPath, resolve));
  try {
    await new Promise((resolve, reject) => {
      const socket = net.connect(sockPath, () => resolve(socket.end()));
      socket.on('error', reject);
    });
  } finally {
    await new Promise((resolve) => unixServer.close(resolve));
  }
  assert.deepEqual(blockedAttempts(), [], 'nothing was blocked');
});

test('NFR1: an attempt that the code under test swallows still fails the process', () => {
  const swallow = 'try { await fetch("https://example.com/"); } catch {} ';
  const result = spawnSync(process.execPath, ['--import', GUARD_PATH, '--input-type=module', '-e', swallow], { encoding: 'utf8' });
  assert.equal(result.status, 1, `exit code (stderr: ${result.stderr})`);
  assert.match(result.stderr, /NETWORK_BLOCKED/);
  assert.match(result.stderr, /not acknowledged/);
});

test('NFR1: an attempt that the test takes with takeBlocked() does not fail the process', () => {
  const script = [
    'import { takeBlocked } from ' + JSON.stringify(GUARD_PATH) + ';',
    'try { await fetch("https://example.com/"); } catch {}',
    'if (takeBlocked().length !== 1) process.exitCode = 3;',
  ].join('\n');
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  assert.equal(out, '');
});

test('NFR1: loading the module twice installs the guard once', () => {
  const script = [
    'import * as a from ' + JSON.stringify(GUARD_PATH) + ';',
    'const first = globalThis.fetch;',
    'await import(' + JSON.stringify(GUARD_PATH + '?again') + ');',
    'if (globalThis.fetch !== first) process.exitCode = 4;',
    'a.takeBlocked();',
  ].join('\n');
  execFileSync(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'pipe'] });
});
