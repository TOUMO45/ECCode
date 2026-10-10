// technical-reviewer check (rework-1): the rework's tests are falsifying. Exports the pre-rework tree (git archive of
// the claim base) into a temp directory, copies the rework's 7 test files over it, and runs them there. Expected:
// failures for TR-C-2, SEC-C-2 and SEC-C-3 (each finding has at least one failing named test on the old source).
// Then runs the same 7 files on the current tree: expected 0 failures. Writes only under the OS temp directory.
// Usage: node tr-r1-falsify.mjs <base-commit>   Exit 0 = old source fails per finding, new source passes.
import { mkdtempSync, copyFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
const base = process.argv[2];
const files = ['test/unit/config/limits.test.js', 'test/unit/auth/client-ip.test.js', 'test/unit/auth/general-limit.test.js', 'test/api/auth.test.js',
  'test/api/requests-plans.test.js', 'test/api/rate-limits.test.js', 'test/scan/env-example.test.js'];
const top = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
const prefix = execFileSync('git', ['rev-parse', '--show-prefix'], { encoding: 'utf8' }).trim().replace(/\/$/, '');
const dir = mkdtempSync(join(tmpdir(), 'tr-r1-base-'));
const run = (cwd) => spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', '--import', './test/helpers/net-guard.js', '--test', ...files], { cwd, encoding: 'utf8' });
try {
  const tar = execFileSync('git', ['-C', top, 'archive', base, prefix], { maxBuffer: 1 << 28 });
  execFileSync('tar', ['-x', '-C', dir], { input: tar });
  const old = join(dir, prefix);
  for (const f of files) copyFileSync(f, join(old, f));
  const before = run(old).stdout;
  const after = run(process.cwd()).stdout;
  const failNames = before.split('\n').filter((l) => /^\s*not ok/.test(l)).map((l) => l.replace(/^\s*not ok \d+ - /, ''));
  const per = { 'TR-C-2': failNames.filter((n) => n.startsWith('TR-C-2')).length, 'SEC-C-2': failNames.filter((n) => n.startsWith('SEC-C-2')).length, 'SEC-C-3': failNames.filter((n) => n.includes('SEC-C-3') || n.includes('general-limit')).length };
  const failOld = Number(/# fail (\d+)/.exec(before)?.[1] ?? -1);
  const failNew = Number(/# fail (\d+)/.exec(after)?.[1] ?? -1);
  const passNew = Number(/# pass (\d+)/.exec(after)?.[1] ?? -1);
  console.log(`old source (${base}) with the rework's tests: ${failOld} failing; named failures per finding ${JSON.stringify(per)}`);
  console.log(`current tree: pass ${passNew}, fail ${failNew}`);
  const ok = failOld > 0 && per['TR-C-2'] > 0 && per['SEC-C-2'] > 0 && per['SEC-C-3'] > 0 && failNew === 0 && passNew > 0;
  console.log(ok ? 'the regression tests fail before the rework and pass after it' : 'NOT falsifying as expected');
  process.exitCode = ok ? 0 : 1;
} finally {
  rmSync(dir, { recursive: true, force: true });
}
