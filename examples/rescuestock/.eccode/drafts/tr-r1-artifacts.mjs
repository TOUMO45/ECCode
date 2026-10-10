// technical-reviewer check (rework-1): the files changed since the rework's claim base (outside .eccode/) are exactly
// the submission's non-.eccode artifacts, every listed sha256 equals the file now, and every changed file lies inside
// the rework's declared ownership. Usage: node tr-r1-artifacts.mjs <base-commit>   Exit 0 = all three hold.
import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
const base = process.argv[2];
const gate = JSON.parse(execFileSync(process.execPath, ['/home/user/ECCode/bin/eccode.js', 'gate', 'show', 'phase:rework-1', '--json'], { encoding: 'utf8' }));
const sub = gate.submissions[gate.submissions.length - 1];
const listed = new Map(sub.artifacts.map((a) => [a.path, a.sha256]));
const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).split('\n').filter(Boolean);
const changed = new Set([...git('diff', '--name-only', '--relative', base, '--', '.'), ...git('ls-files', '--others', '--exclude-standard', '.')].filter((f) => !f.startsWith('.eccode/')));
const owned = [/^src\/config\.js$/, /^\.env\.example$/, /^src\/auth\//, /^src\/services\/requests\.js$/, /^test\/unit\/config\//, /^test\/unit\/auth\//,
  /^test\/api\/(auth|rate-limits|requests-plans)\.test\.js$/, /^test\/scan\/env-example\.test\.js$/];
let bad = 0;
const notListed = [...changed].filter((f) => !listed.has(f));
const listedNotChanged = [...listed.keys()].filter((p) => !p.startsWith('.eccode/') && !changed.has(p));
const outside = [...changed].filter((f) => !owned.some((re) => re.test(f)));
for (const [p, sha] of listed) {
  if (!existsSync(p)) { console.log('listed but absent: ' + p); bad++; continue; }
  if (createHash('sha256').update(readFileSync(p)).digest('hex') !== sha) { console.log('hash differs: ' + p); bad++; }
}
console.log(`submission ${sub.id}: ${listed.size} artifacts; changed since ${base}: ${changed.size}`);
console.log(`changed but not listed: ${notListed.join(', ') || 'none'}`);
console.log(`listed (non-.eccode) but unchanged: ${listedNotChanged.join(', ') || 'none'}`);
console.log(`changed outside the declared ownership: ${outside.join(', ') || 'none'}`);
bad += notListed.length + outside.length;
console.log(bad ? `${bad} problems` : 'artifacts = changes, hashes match, all inside the ownership');
process.exit(bad ? 1 : 0);
