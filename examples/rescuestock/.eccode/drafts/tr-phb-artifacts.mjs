// technical-reviewer check (phase B re-review): every file on disk (git tracked or untracked-unignored) that matches
// a phase-B task's ownership globs in plan.json is listed in the latest phase:b-foundation submission's artifacts.
// Usage: node tr-phb-artifacts.mjs <plan.json>   (runs `eccode gate show phase:b-foundation --json` itself)
// Exit 0 = no owned file missing from the submission.
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
const plan = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const gate = JSON.parse(execFileSync(process.execPath, ['/home/user/ECCode/bin/eccode.js', 'gate', 'show', 'phase:b-foundation', '--json'], { encoding: 'utf8' }));
const listed = new Set(gate.submissions[gate.submissions.length - 1].artifacts.map((a) => a.path));
const expand = (g) => { const m = g.match(/\{([^}]*)\}/); return m ? m[1].split(',').flatMap((x) => expand(g.replace(m[0], x))) : [g]; };
const toRe = (g) => new RegExp('^' + g.replace(/[.+^$()|[\]\\]/g, '\\$&').replace(/\*\*\//g, '\u0001').replace(/\*\*/g, '\u0002').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]').replace(/\u0001/g, '(?:.*/)?').replace(/\u0002/g, '.*') + '$');
const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '.'], { encoding: 'utf8' }).split('\n').filter((f) => f && !f.startsWith('.eccode/') && !f.startsWith('docs/evidence/'));
let missing = 0, owned = 0;
for (const t of plan.tasks.filter((x) => x.phase === 'b-foundation')) {
  const mine = files.filter((f) => t.files.some((g) => expand(g).some((e) => toRe(e).test(f))));
  owned += mine.length;
  const miss = mine.filter((f) => !listed.has(f));
  missing += miss.length;
  console.log(`${t.id}: ${mine.length} owned files on disk, ${miss.length} not in the submission${miss.length ? ': ' + miss.join(', ') : ''}`);
}
const unowned = [...listed].filter((p) => !p.startsWith('.eccode/') && !plan.tasks.filter((x) => x.phase === 'b-foundation').some((t) => t.files.some((g) => expand(g).some((e) => toRe(e).test(p)))));
console.log(`submission artifacts outside phase-B ownership (excluding .eccode/): ${unowned.join(', ') || 'none'}`);
console.log(`owned files: ${owned}; missing from submission: ${missing}`);
process.exit(missing ? 1 : 0);
