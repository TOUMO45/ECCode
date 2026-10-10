// delivery-lead check: does the latest submission of a phase gate cover the phase's work, and only that?
// Compares three sets, all relative to the project root (.eccode/ excluded):
//   D = files declared in the phase tasks' handoffs (every completion, via the record's events),
//   G = files changed in git (committed since <base commit>, plus uncommitted and untracked-unignored) that match a
//       phase task's ownership glob in plan.json,
//   S = the latest submission's artifacts.
// Reports D-S (declared but not submitted), G-S (changed in owned paths but not submitted: undeclared change),
// S outside every phase task's ownership, and the counts. Read-only: reads .eccode/state.json and events.jsonl.
// Usage: node phase-artifacts-check.mjs <plan.json> <phase id> <base commit>.  Exit 0 = D-S and G-S empty and
// nothing outside ownership.
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const [planPath, phase, base] = process.argv.slice(2);
const plan = JSON.parse(readFileSync(planPath, 'utf8'));
const tasks = plan.tasks.filter((t) => t.phase === phase);
const ids = new Set(tasks.map((t) => t.id));

const expand = (g) => { const m = g.match(/\{([^}]*)\}/); return m ? m[1].split(',').flatMap((x) => expand(g.replace(m[0], x))) : [g]; };
const toRe = (g) => new RegExp('^' + g.replace(/[.+^$()|[\]\\]/g, '\\$&').replace(/\*\*\//g, '\u0001').replace(/\*\*/g, '\u0002').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]').replace(/\u0001/g, '(?:.*/)?').replace(/\u0002/g, '.*') + '$');
const owners = (f) => tasks.filter((t) => t.files.some((g) => expand(g).some((e) => toRe(e).test(f)))).map((t) => t.id);

// D: every handoff recorded for a phase task (all completions, not only the latest)
const declared = new Set();
for (const line of readFileSync('.eccode/events.jsonl', 'utf8').split('\n')) {
  if (!line.includes('"handoff.recorded"')) continue;
  const ev = JSON.parse(line);
  const h = ev.data && ev.data.handoff;
  if (h && ids.has(h.task)) for (const f of h.filesChanged || []) if (!f.startsWith('.eccode/')) declared.add(f);
}

// G: git changes in the project since base
const git = (...a) => execFileSync('git', a, { encoding: 'utf8' }).split('\n').filter(Boolean);
const changed = new Set([
  ...git('diff', '--name-only', '--relative', base, '--', '.'),
  ...git('ls-files', '--others', '--exclude-standard', '.'),
].filter((f) => !f.startsWith('.eccode/')));
const changedOwned = [...changed].filter((f) => owners(f).length);

// S: latest submission of the gate
const state = JSON.parse(readFileSync('.eccode/state.json', 'utf8'));
const gate = state.gates[`phase:${phase}`];
const sub = gate.submissions[gate.submissions.length - 1];
const submitted = new Set(sub.artifacts.map((a) => a.path));
const submittedCode = [...submitted].filter((f) => !f.startsWith('.eccode/'));

const missingDeclared = [...declared].filter((f) => !submitted.has(f));
const undeclared = changedOwned.filter((f) => !submitted.has(f));
const outside = submittedCode.filter((f) => !owners(f).length);
const changedNotOwned = [...changed].filter((f) => !owners(f).length);

console.log(`submission ${sub.id}: ${submitted.size} artifacts (${submittedCode.length} project files, ${submitted.size - submittedCode.length} under .eccode/)`);
console.log(`declared in handoffs: ${declared.size}; changed in owned paths since ${base.slice(0, 8)}: ${changedOwned.length}`);
for (const t of tasks) console.log(`  ${t.id}: ${submittedCode.filter((f) => owners(f).includes(t.id)).length} submitted files in its ownership`);
console.log(`declared but not submitted: ${missingDeclared.length}${missingDeclared.length ? ' ' + missingDeclared.join(', ') : ''}`);
console.log(`changed in owned paths but not submitted (undeclared): ${undeclared.length}${undeclared.length ? ' ' + undeclared.join(', ') : ''}`);
console.log(`submitted outside phase ownership: ${outside.length}${outside.length ? ' ' + outside.join(', ') : ''}`);
console.log(`changed since base outside phase ownership (other phases or records, informational): ${changedNotOwned.length}${changedNotOwned.length ? ' ' + changedNotOwned.join(', ') : ''}`);
process.exit(missingDeclared.length || undeclared.length || outside.length ? 1 : 0);
