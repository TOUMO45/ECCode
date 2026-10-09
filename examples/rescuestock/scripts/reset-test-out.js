// npm pretest step: empties test/.out (latency samples of the previous run) and
// records the suite start time that scripts/report-p95.js measures against.
// test/.out is git-ignored. Usage: node scripts/reset-test-out.js [outDir]
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const DEFAULT_OUT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'test', '.out');
export const START_FILE = 'suite-start.json';

export function resetTestOut(outDir = DEFAULT_OUT_DIR, nowMs = Date.now()) {
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, START_FILE), `${JSON.stringify({ startedAtMs: nowMs })}\n`);
  return outDir;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  resetTestOut(process.argv[2] ? resolve(process.argv[2]) : DEFAULT_OUT_DIR);
}
