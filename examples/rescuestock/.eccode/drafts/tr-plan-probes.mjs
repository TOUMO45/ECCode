// technical-reviewer probe (plan gate): how the plan's verification command shapes behave on this host (Node 22.22),
// in a throwaway directory:
//  (a) node --test with one glob that matches and one that matches nothing (npm test lists six globs; early phases
//      have no test/eval or test/integration files yet)
//  (b) node --test with only an unmatched glob (a task whose tests do not exist yet: must FAIL before the work)
//  (c) node --test with an explicit file that does not exist (NG <file> commands before the work: must FAIL)
//  (d) the same as (a) with --import of a module that does not exist (NG before b3 creates net-guard.js)
//  (e) can npm reach the registry for @playwright/test 1.56.1 (clean-checkout.sh runs npm install)?
//  (f) is the global Playwright 1.56.1 resolvable (the spec's fallback loader)?
// Exit 0 = all observations obtained; result lines report what happened.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'tr-plan-probe-'));
mkdirSync(join(dir, 'a'));
writeFileSync(join(dir, 'a', 'x.test.js'), "import { test } from 'node:test';\ntest('x', () => {});\n");
writeFileSync(join(dir, 'package.json'), '{"type":"module"}');
const run = (label, args) => {
  const r = spawnSync(process.execPath, args, { cwd: dir, encoding: 'utf8', timeout: 60000 });
  const tail = (r.stdout + r.stderr).split('\n').filter((l) => /^# (tests|pass|fail)|Could not|Error|error/.test(l)).slice(0, 4).join(' / ');
  console.log(`${label}: exit=${r.status} | ${tail}`);
};
run('(a) one matching + one unmatched glob', ['--test', 'a/**/*.test.js', 'b/**/*.test.js']);
run('(b) only an unmatched glob', ['--test', 'zz/**/*.test.js']);
run('(c) explicit missing file', ['--test', 'zz/missing.test.js']);
run('(d) --import of a missing module', ['--import', './test/helpers/net-guard.js', '--test', 'a/**/*.test.js']);
const npm = spawnSync('npm', ['view', '@playwright/test@1.56.1', 'version'], { encoding: 'utf8', timeout: 60000 });
console.log(`(e) npm view @playwright/test@1.56.1 version: exit=${npm.status} | ${(npm.stdout + npm.stderr).trim().split('\n').slice(0, 2).join(' / ')}`);
const g = '/opt/node22/lib/node_modules/playwright/package.json';
console.log(`(f) global playwright: ${existsSync(g) ? JSON.parse(readFileSync(g, 'utf8')).version : 'absent'}`);
process.exit(0);
