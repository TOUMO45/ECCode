// npm posttest step (NFR5): reads test/.out/latency.jsonl, which test/helpers/app-harness.js
// writes for every HTTP call of the deterministic API tests, and fails when
//   - the p95 latency is >= 300 ms, or
//   - the suite took >= 5 minutes from the pretest timestamp (scripts/reset-test-out.js), or
//   - there are no samples or the files are unreadable (a dead recorder must not pass).
// Usage: node scripts/report-p95.js [outDir]
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const P95_LIMIT_MS = 300;
export const SUITE_LIMIT_MS = 5 * 60 * 1000;
export const DEFAULT_OUT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'test', '.out');

// Nearest-rank percentile of a sorted ascending array.
export function percentile(sorted, p) {
  if (sorted.length === 0) return NaN;
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1];
}

// -> { samples: number[], malformed: number }
export function parseLatency(text) {
  const samples = [];
  let malformed = 0;
  for (const line of String(text).split('\n')) {
    if (line.trim() === '') continue;
    try {
      const ms = JSON.parse(line).ms;
      if (typeof ms === 'number' && Number.isFinite(ms) && ms >= 0) samples.push(ms);
      else malformed += 1;
    } catch {
      malformed += 1;
    }
  }
  return { samples, malformed };
}

// evaluate({ latencyText, startedAtMs, nowMs }) -> { ok, failures, count, p50, p95, suiteMs }
export function evaluate({ latencyText, startedAtMs, nowMs }) {
  const failures = [];
  let count = 0;
  let p50 = NaN;
  let p95 = NaN;
  if (latencyText === null || latencyText === undefined) {
    failures.push('test/.out/latency.jsonl is missing: no API test recorded a latency');
  } else {
    const { samples, malformed } = parseLatency(latencyText);
    if (malformed > 0) failures.push(`${malformed} malformed line(s) in latency.jsonl`);
    count = samples.length;
    if (count === 0) failures.push('latency.jsonl has no samples');
    else {
      const sorted = [...samples].sort((a, b) => a - b);
      p50 = percentile(sorted, 50);
      p95 = percentile(sorted, 95);
      if (p95 >= P95_LIMIT_MS) failures.push(`API p95 ${p95.toFixed(1)} ms is not below ${P95_LIMIT_MS} ms`);
    }
  }
  let suiteMs = NaN;
  if (!Number.isFinite(startedAtMs)) {
    failures.push('the pretest timestamp (suite-start.json) is missing, so the suite time cannot be checked');
  } else {
    suiteMs = nowMs - startedAtMs;
    if (suiteMs < 0) failures.push('the pretest timestamp is in the future');
    else if (suiteMs >= SUITE_LIMIT_MS) failures.push(`suite time ${(suiteMs / 1000).toFixed(1)} s is not below ${SUITE_LIMIT_MS / 1000} s`);
  }
  return { ok: failures.length === 0, failures, count, p50, p95, suiteMs };
}

function readOptional(file) {
  try {
    return readFileSync(file, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return null;
    throw err;
  }
}

export function reportFromDir(outDir = DEFAULT_OUT_DIR, nowMs = Date.now()) {
  const latencyText = readOptional(join(outDir, 'latency.jsonl'));
  let startedAtMs;
  const startText = readOptional(join(outDir, 'suite-start.json'));
  if (startText !== null) {
    try {
      startedAtMs = JSON.parse(startText).startedAtMs;
    } catch {
      startedAtMs = undefined;
    }
  }
  return evaluate({ latencyText, startedAtMs, nowMs });
}

export function formatReport(result) {
  const fmt = (n) => (Number.isFinite(n) ? n.toFixed(1) : 'n/a');
  const lines = [
    `NFR5 API latency: ${result.count} requests, p50 ${fmt(result.p50)} ms, p95 ${fmt(result.p95)} ms (limit: p95 < ${P95_LIMIT_MS} ms)`,
    `NFR5 suite time: ${Number.isFinite(result.suiteMs) ? (result.suiteMs / 1000).toFixed(1) : 'n/a'} s (limit: < ${SUITE_LIMIT_MS / 1000} s)`,
  ];
  for (const failure of result.failures) lines.push(`NFR5 FAIL: ${failure}`);
  lines.push(result.ok ? 'NFR5 latency and suite time: ok' : 'NFR5 latency and suite time: FAILED');
  return lines.join('\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = reportFromDir(process.argv[2] ? resolve(process.argv[2]) : DEFAULT_OUT_DIR);
  const text = `${formatReport(result)}\n`;
  (result.ok ? process.stdout : process.stderr).write(text);
  process.exitCode = result.ok ? 0 : 1;
}
