// technical-reviewer probe (plan gate, revision 2): on Node 22.22, in a throwaway directory,
//  (1) node --test <existing file> <missing file>          -> does a missing explicit file fail when another file runs?
//  (2) node --test "<matching glob>" <missing file>          -> same with a glob
//  (3) node --test <missing file> alone                      -> control
//  (4) sh -c 'ls <missing> >/dev/null && node --test ...'    -> the revision-2 existence guard before the work
//  (5) the same guarded line after the file exists           -> passes
//  (6) the guarded line through `eccode evidence run`'s execution mode (spawnSync with shell: true)
// Exit 0 = observations obtained; the result lines say what happened.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'tr-plan-r2-'));
mkdirSync(join(dir, 'a')); mkdirSync(join(dir, 'b'));
writeFileSync(join(dir, 'package.json'), '{"type":"module"}');
const body = "import { test } from 'node:test';\ntest('x', () => {});\n";
writeFileSync(join(dir, 'a', 'old.test.js'), body);
const sh = (label, line) => {
  const r = spawnSync('/bin/sh', ['-c', line], { cwd: dir, encoding: 'utf8', timeout: 60000 });
  const tail = (r.stdout + r.stderr).split('\n').filter((l) => /^# (tests|pass|fail)|Could not|cannot access/.test(l)).slice(0, 3).join(' / ');
  console.log(`${label}: exit=${r.status} | ${tail}`);
  return r.status;
};
const node = process.execPath;
sh('(1) existing + missing explicit file', `${node} --test a/old.test.js b/new.test.js`);
sh('(2) matching glob + missing explicit file', `${node} --test "a/**/*.test.js" b/new.test.js`);
sh('(3) missing explicit file alone', `${node} --test b/new.test.js`);
const guarded = `ls b/new.test.js >/dev/null && ${node} --test "a/**/*.test.js" b/new.test.js`;
const before = sh('(4) ls guard before the file exists', guarded);
writeFileSync(join(dir, 'b', 'new.test.js'), body);
const after = sh('(5) ls guard after the file exists', guarded);
const ev = spawnSync(guarded, { cwd: dir, shell: true, encoding: 'utf8' });
console.log(`(6) spawnSync shell:true (eccode evidence run mode), after: exit=${ev.status}`);
console.log(`guard falsifiable: ${before !== 0 && after === 0}`);
process.exit(0);
