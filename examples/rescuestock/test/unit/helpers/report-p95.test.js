// NFR5: scripts/report-p95.js fails at p95 >= 300 ms and at a suite time >= 5 min from the
// pretest timestamp; scripts/reset-test-out.js writes that timestamp. All files live in temp dirs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { P95_LIMIT_MS, SUITE_LIMIT_MS, evaluate, formatReport, parseLatency, percentile, reportFromDir } from '../../../scripts/report-p95.js';
import { resetTestOut } from '../../../scripts/reset-test-out.js';
import { recordLatency } from '../../helpers/app-harness.js';

const REPORT = fileURLToPath(new URL('../../../scripts/report-p95.js', import.meta.url));
const RESET = fileURLToPath(new URL('../../../scripts/reset-test-out.js', import.meta.url));

const lines = (values) => values.map((ms) => JSON.stringify({ method: 'GET', path: '/x', status: 200, ms })).join('\n') + '\n';
const tempDir = () => mkdtempSync(join(tmpdir(), 'rs-p95-'));

test('NFR5: percentile is nearest-rank', () => {
  const ten = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  assert.equal(percentile(ten, 50), 5);
  assert.equal(percentile(ten, 95), 10);
  assert.equal(percentile(ten, 90), 9);
  assert.equal(percentile([7], 95), 7);
  assert.equal(Number.isNaN(percentile([], 95)), true);
  const hundred = Array.from({ length: 100 }, (_, i) => i + 1);
  assert.equal(percentile(hundred, 95), 95);
});

test('NFR5: p95 below 300 ms and suite time below 5 min pass', () => {
  const values = Array.from({ length: 100 }, () => 20);
  const result = evaluate({ latencyText: lines(values), startedAtMs: 1000, nowMs: 1000 + 60_000 });
  assert.equal(result.ok, true, result.failures.join('; '));
  assert.equal(result.count, 100);
  assert.equal(result.p95, 20);
});

test('NFR5: p95 of exactly 300 ms fails (the limit is exclusive) and 299.9 ms passes', () => {
  const at = evaluate({ latencyText: lines([300, 300, 300]), startedAtMs: 0, nowMs: 10 });
  assert.equal(at.ok, false);
  assert.match(at.failures.join(), /p95 300\.0 ms is not below 300 ms/);
  assert.equal(evaluate({ latencyText: lines([299.9]), startedAtMs: 0, nowMs: 10 }).ok, true);
  assert.equal(P95_LIMIT_MS, 300);
});

test('NFR5: six slow calls among a hundred push the p95 over the limit, five do not', () => {
  const five = [...Array.from({ length: 95 }, () => 10), 900, 900, 900, 900, 900];
  const six = [...Array.from({ length: 94 }, () => 10), 900, 900, 900, 900, 900, 900];
  assert.equal(evaluate({ latencyText: lines(five), startedAtMs: 0, nowMs: 10 }).ok, true);
  assert.equal(evaluate({ latencyText: lines(six), startedAtMs: 0, nowMs: 10 }).ok, false);
});

test('NFR5: a suite time of exactly 5 minutes fails, just under passes, a future timestamp fails', () => {
  assert.equal(SUITE_LIMIT_MS, 300_000);
  const base = { latencyText: lines([1]), startedAtMs: 5_000 };
  assert.equal(evaluate({ ...base, nowMs: 5_000 + 299_999 }).ok, true);
  const at = evaluate({ ...base, nowMs: 5_000 + 300_000 });
  assert.equal(at.ok, false);
  assert.match(at.failures.join(), /suite time 300\.0 s/);
  assert.equal(evaluate({ ...base, nowMs: 1_000 }).ok, false);
});

test('NFR5: missing, empty or malformed latency data and a missing timestamp fail instead of passing quietly', () => {
  assert.equal(evaluate({ latencyText: null, startedAtMs: 0, nowMs: 1 }).ok, false);
  assert.equal(evaluate({ latencyText: '', startedAtMs: 0, nowMs: 1 }).ok, false);
  assert.equal(evaluate({ latencyText: 'not json\n', startedAtMs: 0, nowMs: 1 }).ok, false);
  assert.equal(evaluate({ latencyText: lines([1]) + '{"ms":-3}\n', startedAtMs: 0, nowMs: 1 }).ok, false);
  assert.equal(evaluate({ latencyText: lines([1]) + '{"ms":"5"}\n', startedAtMs: 0, nowMs: 1 }).ok, false);
  assert.equal(evaluate({ latencyText: lines([1]), startedAtMs: undefined, nowMs: 1 }).ok, false);
  assert.deepEqual(parseLatency(lines([1, 2]) + '\n  \n'), { samples: [1, 2], malformed: 0 });
});

test('NFR5: reset-test-out empties the directory and writes the start timestamp; recordLatency appends one line per call', () => {
  const dir = tempDir();
  try {
    writeFileSync(join(dir, 'latency.jsonl'), lines([999]));
    writeFileSync(join(dir, 'stale.txt'), 'x');
    resetTestOut(dir, 1_700_000_000_000);
    assert.equal(existsSync(join(dir, 'latency.jsonl')), false);
    assert.equal(existsSync(join(dir, 'stale.txt')), false);
    assert.deepEqual(JSON.parse(readFileSync(join(dir, 'suite-start.json'), 'utf8')), { startedAtMs: 1_700_000_000_000 });
    const file = join(dir, 'latency.jsonl');
    recordLatency({ method: 'GET', path: '/a', status: 200, ms: 3 }, file);
    recordLatency({ method: 'GET', path: '/b', status: 404, ms: 4 }, file);
    assert.deepEqual(parseLatency(readFileSync(file, 'utf8')), { samples: [3, 4], malformed: 0 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('NFR5: the command line reports and sets the exit code from the files in a directory', () => {
  const ok = tempDir();
  const slow = tempDir();
  const empty = tempDir();
  try {
    resetTestOut(ok);
    writeFileSync(join(ok, 'latency.jsonl'), lines([5, 6, 7]));
    const pass = spawnSync(process.execPath, [REPORT, ok], { encoding: 'utf8' });
    assert.equal(pass.status, 0, pass.stderr);
    assert.match(pass.stdout, /NFR5 API latency: 3 requests/);
    assert.match(pass.stdout, /NFR5 suite time:/);
    assert.match(pass.stdout, /ok/);

    resetTestOut(slow);
    writeFileSync(join(slow, 'latency.jsonl'), lines([5, 400]));
    const fail = spawnSync(process.execPath, [REPORT, slow], { encoding: 'utf8' });
    assert.equal(fail.status, 1);
    assert.match(fail.stderr, /NFR5 FAIL: API p95 400\.0 ms/);

    const none = spawnSync(process.execPath, [REPORT, empty], { encoding: 'utf8' });
    assert.equal(none.status, 1);
    assert.match(none.stderr, /latency\.jsonl is missing/);

    const reset = spawnSync(process.execPath, [RESET, join(empty, 'out')], { encoding: 'utf8' });
    assert.equal(reset.status, 0, reset.stderr);
    assert.equal(existsSync(join(empty, 'out', 'suite-start.json')), true);

    const report = reportFromDir(ok);
    assert.equal(report.ok, true);
    assert.match(formatReport(report), /limit: p95 < 300 ms/);
  } finally {
    for (const d of [ok, slow, empty]) rmSync(d, { recursive: true, force: true });
  }
});
