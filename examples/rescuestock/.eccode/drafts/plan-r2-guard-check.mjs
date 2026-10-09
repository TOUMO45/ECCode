// delivery-lead check (plan revision 2, F-PL-1). Node's test runner ignores a missing explicit file whenever any
// other pattern or file matches (ev of plan-r2-cmd-probe.mjs), so naming a new file in a command is not enough.
// This check requires every task's verification command to start with `ls <files> >/dev/null && `, where:
//   - the list is non-empty,
//   - every listed file is owned by the task (matches one of its ownership globs),
//   - no task that finishes before it (an earlier phase, or a task in its dependency closure) owns the file,
//     so the file cannot pre-exist when the task starts.
// Usage: node plan-r2-guard-check.mjs <plan.json>. Exit 0 when every task passes.
import { readFileSync } from 'node:fs';

const plan = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const phases = plan.phases.map((p) => p.id);
const byId = new Map(plan.tasks.map((t) => [t.id, t]));
const closure = (id, seen = new Set()) => {
  for (const d of byId.get(id).dependencies) if (!seen.has(d)) { seen.add(d); closure(d, seen); }
  return seen;
};
const expand = (g) => { const m = g.match(/\{([^}]*)\}/); return m ? m[1].split(',').flatMap((x) => expand(g.replace(m[0], x))) : [g]; };
const toRe = (g) => new RegExp('^' + g.replace(/[.+^$()|[\]\\]/g, '\\$&').replace(/\*\*\//g, '\u0001').replace(/\*\*/g, '\u0002').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]').replace(/\u0001/g, '(?:.*/)?').replace(/\u0002/g, '.*') + '$');
const owns = (t, f) => t.files.some((g) => expand(g).some((e) => toRe(e).test(f)));

let bad = 0;
for (const t of plan.tasks) {
  const m = t.verification.command.match(/^ls ((?:\S+ )+)>\/dev\/null && \S/);
  if (!m) { bad++; console.log(`FAIL ${t.id}: command does not start with an ls existence guard`); continue; }
  const files = m[1].trim().split(/\s+/);
  const before = plan.tasks.filter((o) => o.id !== t.id && (phases.indexOf(o.phase) < phases.indexOf(t.phase) || closure(t.id).has(o.id)));
  const problems = [];
  for (const f of files) {
    if (!owns(t, f)) problems.push(`${f} not owned by the task`);
    const earlier = before.filter((o) => owns(o, f)).map((o) => o.id);
    if (earlier.length) problems.push(`${f} may pre-exist (owned earlier by ${earlier.join(', ')})`);
  }
  if (problems.length) { bad++; console.log(`FAIL ${t.id}: ${problems.join('; ')}`); }
  else console.log(`ok   ${t.id}: guard lists ${files.length} file(s) the task creates first`);
}
console.log(`tasks: ${plan.tasks.length}; failing: ${bad}`);
process.exit(bad ? 1 : 0);
