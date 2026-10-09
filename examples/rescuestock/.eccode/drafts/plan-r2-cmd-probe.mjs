// delivery-lead probe (plan revision 2, F-PL-1): which verification command shapes fail before a task's own
// test files exist, on this host's Node? Runs in a throwaway temp directory with one existing test file.
// Each line prints: shape, exit code, expected, OK/UNEXPECTED. Exit 0 when every shape behaves as expected.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'dl-plan-probe-'));
mkdirSync(join(dir, 't'));
writeFileSync(join(dir, 'package.json'), '{"type":"module"}');
writeFileSync(join(dir, 't', 'old.test.js'), "import test from 'node:test';\ntest('old', () => {});\n");

const sh = (cmd) => spawnSync('/bin/sh', ['-c', cmd], { cwd: dir, encoding: 'utf8', timeout: 60000 });
const node = process.execPath;
const cases = [
  ['glob matching nothing only', `${node} --test "zz/**/*.test.js"`, 0],
  ['explicit missing file only', `${node} --test t/new.test.js`, 1],
  ['matching glob + explicit missing file (npm test -- <new file> shape)', `${node} --test "t/**/*.test.js" t/new.test.js`, 0],
  ['existing explicit file + explicit missing file (NG old new shape)', `${node} --test t/old.test.js t/new.test.js`, 0],
  ['glob + the same existing file named explicitly: runs once', `${node} --test "t/**/*.test.js" t/old.test.js | grep -q "^# tests 1$"`, 0],
  ['ls guard on the missing own file, then the suite', `ls t/new.test.js >/dev/null && ${node} --test "t/**/*.test.js"`, 'nonzero'],
];
let bad = 0;
for (const [label, cmd, want] of cases) {
  const r = sh(cmd);
  const ok = want === 'nonzero' ? r.status !== 0 : r.status === want;
  if (!ok) bad++;
  console.log(`${ok ? 'OK        ' : 'UNEXPECTED'} exit=${r.status} expected=${want} | ${label}`);
}
console.log(`node ${process.version}; unexpected: ${bad}`);
process.exit(bad ? 1 : 0);
