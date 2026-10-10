// technical-reviewer check (phase C): (1) every file changed since c1's claim base (git diff <base> plus untracked,
// unignored files) that falls under a phase-C task's ownership globs is listed in the latest phase:c-core-flow
// submission; (2) every listed artifact's sha256 equals the file on disk now (the reviewed tree is the submitted one);
// (3) listed artifacts outside phase-C ownership are reported.
// Usage: node tr-phc-artifacts.mjs <plan.json> <base-commit>   Exit 0 = nothing missing and every hash matches.
import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
const plan = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const base = process.argv[3];
const gate = JSON.parse(execFileSync(process.execPath, ['/home/user/ECCode/bin/eccode.js', 'gate', 'show', 'phase:c-core-flow', '--json'], { encoding: 'utf8' }));
const sub = gate.submissions[gate.submissions.length - 1];
const listed = new Map(sub.artifacts.map((a) => [a.path, a.sha256]));
const expand = (g) => { const m = g.match(/\{([^}]*)\}/); return m ? m[1].split(',').flatMap((x) => expand(g.replace(m[0], x))) : [g]; };
const toRe = (g) => new RegExp('^' + g.replace(/[.+^$()|[\]\\]/g, '\\$&').replace(/\*\*\//g, '\u0001').replace(/\*\*/g, '\u0002').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]').replace(/\u0001/g, '(?:.*/)?').replace(/\u0002/g, '.*') + '$');
const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).split('\n').filter(Boolean);
const changed = new Set([...git('diff', '--name-only', '--relative', base, '--', '.'), ...git('ls-files', '--others', '--exclude-standard', '.')]
  .filter((f) => !f.startsWith('.eccode/') && !f.startsWith('docs/')));
const tasks = plan.tasks.filter((x) => x.phase === 'c-core-flow');
const owns = (f) => tasks.some((t) => t.files.some((g) => expand(g).some((e) => toRe(e).test(f))));
let missing = 0, changedOwned = 0;
for (const t of tasks) {
  const mine = [...changed].filter((f) => t.files.some((g) => expand(g).some((e) => toRe(e).test(f))));
  changedOwned += mine.length;
  const miss = mine.filter((f) => !listed.has(f) && existsSync(f));
  missing += miss.length;
  console.log(`${t.id}: ${mine.length} owned files changed since ${base}, ${miss.length} not in the submission${miss.length ? ': ' + miss.join(', ') : ''}`);
}
let mismatched = 0, gone = 0;
for (const [p, sha] of listed) {
  if (!existsSync(p)) { gone++; console.log(`listed but absent: ${p}`); continue; }
  const now = createHash('sha256').update(readFileSync(p)).digest('hex');
  if (now !== sha) { mismatched++; console.log(`hash differs from the submission: ${p}`); }
}
const outside = [...listed.keys()].filter((p) => !p.startsWith('.eccode/') && !owns(p));
const changedUnowned = [...changed].filter((f) => !owns(f));
console.log(`submission ${sub.id}: ${listed.size} artifacts; hash mismatches ${mismatched}; listed but absent ${gone}`);
console.log(`listed artifacts outside phase-C ownership (excluding .eccode/): ${outside.join(', ') || 'none'}`);
console.log(`files changed since ${base} outside phase-C ownership (excluding .eccode/, docs/): ${changedUnowned.join(', ') || 'none'}`);
console.log(`owned changed files: ${changedOwned}; missing from the submission: ${missing}`);
process.exit(missing || mismatched || gone ? 1 : 0);
