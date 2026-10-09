import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { statSync } from 'node:fs';
import { request } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureRuntimeDirs, startApp } from '../../../src/main.js';
import { loadConfig } from '../../../src/config.js';
import { getMeta } from '../../../src/db/meta.js';
import { createLogger } from '../../../src/log.js';
import { tempDir, testEnv } from '../http/app-fixture.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

function modeOf(path) {
  return statSync(path).mode & 0o777;
}

function get(port, path) {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, agent: false }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('SEC-14: ensureRuntimeDirs creates the data and upload directories with mode 0700', () => {
  const base = tempDir('rs-dirs-');
  process.umask(0o022); // a permissive umask must not widen the modes
  const config = loadConfig(testEnv(base, { RS_DB_PATH: join(base, 'data', 'app.db'), RS_UPLOAD_DIR: join(base, 'data', 'uploads') }));
  const created = ensureRuntimeDirs(config);
  assert.equal(created.length, 2);
  assert.equal(modeOf(join(base, 'data')), 0o700);
  assert.equal(modeOf(join(base, 'data', 'uploads')), 0o700);
});

test('SEC-14: ensureRuntimeDirs leaves an existing directory alone', () => {
  const base = tempDir('rs-dirs-');
  const config = loadConfig(testEnv(base, { RS_DB_PATH: join(base, 'app.db'), RS_UPLOAD_DIR: join(base, 'uploads') }));
  const before = modeOf(base);
  const created = ensureRuntimeDirs(config);
  assert.deepEqual(created, [join(base, 'uploads')]);
  assert.equal(modeOf(base), before);
});

test('SEC-14: startApp applies umask 077, so the database file is 0600 and the directories 0700', async () => {
  const base = tempDir('rs-start-');
  const lines = [];
  const running = await startApp({
    env: testEnv(base, { RS_DB_PATH: join(base, 'data', 'app.db'), RS_UPLOAD_DIR: join(base, 'data', 'uploads') }),
    log: createLogger({ write: (l) => lines.push(l) }),
  });
  try {
    assert.equal(process.umask(), 0o077);
    assert.equal(modeOf(join(base, 'data')), 0o700);
    assert.equal(modeOf(join(base, 'data', 'uploads')), 0o700);
    assert.equal(modeOf(join(base, 'data', 'app.db')), 0o600);
    const listening = lines.map((l) => JSON.parse(l)).find((l) => l.msg === 'listening');
    assert.ok(listening, 'a listening line is logged');
    assert.equal(listening.port, running.port);
    assert.ok(listening.requestId);
    const health = await get(running.port, '/api/health');
    assert.equal(health.status, 200);
  } finally {
    await running.close();
  }
});

test('SEC-5: startApp creates the csrf key and the fake webhook key once in meta, and keeps them across restarts', async () => {
  const base = tempDir('rs-meta-');
  const env = testEnv(base);
  const first = await startApp({ env, log: createLogger({ write: () => {} }) });
  const csrf = getMeta(first.db, 'csrf_key');
  const hmac = getMeta(first.db, 'fake_webhook_secret');
  await first.close();
  assert.match(csrf, /^[0-9a-f]{64}$/);
  assert.match(hmac, /^[0-9a-f]{64}$/);
  assert.notEqual(csrf, hmac);

  const second = await startApp({ env, log: createLogger({ write: () => {} }) });
  try {
    assert.equal(getMeta(second.db, 'csrf_key'), csrf);
    assert.equal(getMeta(second.db, 'fake_webhook_secret'), hmac);
  } finally {
    await second.close();
  }
});

test('SEC-5: an explicit RS_FAKE_WEBHOOK_SECRET is never written to the database', async () => {
  const base = tempDir('rs-meta-');
  const running = await startApp({
    env: testEnv(base, { RS_FAKE_WEBHOOK_SECRET: 'z'.repeat(40) }),
    log: createLogger({ write: () => {} }),
  });
  try {
    assert.equal(getMeta(running.db, 'fake_webhook_secret'), null);
  } finally {
    await running.close();
  }
});

test('SEC-5: index.js refuses a bad configuration with exit 1, naming the variable and not the value', () => {
  const base = tempDir('rs-refuse-');
  const result = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', join(root, 'src', 'index.js')], {
    cwd: root,
    encoding: 'utf8',
    env: { PATH: process.env.PATH, ...testEnv(base, { RS_ADMIN_PASSWORD: 'tiny-marker' }) },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /RS_ADMIN_PASSWORD/);
  assert.doesNotMatch(result.stderr + result.stdout, /tiny-marker/);
  const logged = result.stdout.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  assert.ok(logged.some((l) => l.msg === 'config.refused'));
});

test('NFR1: node src/index.js starts, logs the bound port and serves /api/health over loopback', async () => {
  const base = tempDir('rs-index-');
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', join(root, 'src', 'index.js')], {
    cwd: root,
    env: { PATH: process.env.PATH, ...testEnv(base) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    const port = await new Promise((resolve, reject) => {
      let buffer = '';
      const timer = setTimeout(() => reject(new Error('no listening line within 10 s')), 10000);
      child.stdout.on('data', (chunk) => {
        buffer += chunk.toString('utf8');
        for (const line of buffer.split('\n')) {
          if (!line.startsWith('{')) continue;
          const parsed = JSON.parse(line);
          if (parsed.msg === 'listening') {
            clearTimeout(timer);
            resolve(parsed.port);
          }
        }
      });
      child.once('exit', (code) => reject(new Error(`exited early with ${code}`)));
    });
    assert.ok(Number.isInteger(port) && port > 0);
    const health = await get(port, '/api/health');
    assert.equal(health.status, 200);
    assert.equal(JSON.parse(health.text).status, 'ok');
  } finally {
    child.kill('SIGTERM');
    await new Promise((resolve) => child.once('exit', resolve));
  }
});
