// NFR5: app-harness.js runs createApp in-process with a fixed clock and records the latency of
// each request. These tests write to a temp latency file, never to test/.out/latency.jsonl.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FIXED_NOW_MS, LATENCY_FILE, OUT_DIR, startHarness } from '../../helpers/app-harness.js';
import { parseLatency } from '../../../scripts/report-p95.js';

const tempFile = (name) => join(tmpdir(), `rs-harness-${name}-${process.pid}.jsonl`);

test('NFR5: the latency file lives at test/.out/latency.jsonl', () => {
  assert.equal(LATENCY_FILE, join(OUT_DIR, 'latency.jsonl'));
  assert.match(LATENCY_FILE, /test[\\/]\.out[\\/]latency\.jsonl$/);
});

test('NFR5: the harness serves the app on a loopback port with a fixed clock and records one sample per request', async () => {
  const latencyFile = tempFile('latency');
  rmSync(latencyFile, { force: true });
  const h = await startHarness({ latencyFile });
  try {
    assert.equal(h.clock.now(), FIXED_NOW_MS);
    const health = await h.request({ path: '/api/health' });
    assert.equal(health.status, 200);
    assert.equal(health.json.status, 'ok');
    const missing = await h.request({ path: '/api/nope?x=1' });
    assert.equal(missing.status, 404);
    const skipped = await h.request({ path: '/api/health', record: false });
    assert.equal(skipped.status, 200);

    const text = readFileSync(latencyFile, 'utf8');
    const { samples, malformed } = parseLatency(text);
    assert.equal(malformed, 0);
    assert.equal(samples.length, 2, 'two recorded calls, one skipped');
    const rows = text.trim().split('\n').map((l) => JSON.parse(l));
    assert.deepEqual(
      rows.map((r) => [r.method, r.path, r.status]),
      [
        ['GET', '/api/health', 200],
        ['GET', '/api/nope', 404],
      ],
    );
    assert.equal(rows.every((r) => typeof r.ms === 'number' && r.ms >= 0), true);
    assert.equal(h.clock.now(), FIXED_NOW_MS, 'requests do not move the fixed clock');
  } finally {
    await h.close();
    rmSync(latencyFile, { force: true });
  }
  assert.equal(existsSync(h.dir), false, 'the temp directory is removed on close');
});

test('NFR5: the harness uses fake adapters and test mode, and seeds RS-FIX-1 on request', async () => {
  const latencyFile = tempFile('seed');
  rmSync(latencyFile, { force: true });
  const h = await startHarness({ seed: true, record: false, latencyFile });
  try {
    assert.equal(h.config.paymentProvider, 'fake');
    assert.equal(h.config.extractionProvider, 'fake');
    const users = h.db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
    assert.equal(users, 7, 'seven demo accounts');
    await h.request({ path: '/api/health' });
    assert.equal(existsSync(latencyFile), false, 'record:false writes no latency');
  } finally {
    await h.close();
  }
});
