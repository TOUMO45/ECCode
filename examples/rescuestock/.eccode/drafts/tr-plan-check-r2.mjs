// technical-reviewer check (plan gate, revision 2). Usage: node tr-plan-check-r2.mjs <plan.json> <brief.md> <spec.md>
// Same checks 1-6 as tr-plan-check.mjs (structure, graph, concurrent ownership disjointness, no record paths,
// 45 claims exactly once, traceability files owned and run in the claiming phase), plus, for revision 2:
// 7. guard: every command starts with `ls <explicit files> >/dev/null && `; every guard file is owned by the task and by
//    NO other task that is in an earlier phase, in the task's dependency closure, or anywhere in the same phase; at
//    least one guard file is a test file that the rest of the command runs.
// 8. created-file coverage: every test file (test/...*.test.js) named in a task's acceptance criteria or command is owned
//    by that task or by a task that finishes before it (earlier phase or dependency closure).
// Exit 0 = no hard problem.
import { readFileSync } from 'node:fs';
const [planPath, briefPath, specPath] = process.argv.slice(2);
const plan = JSON.parse(readFileSync(planPath, 'utf8'));
const brief = readFileSync(briefPath, 'utf8');
const spec = readFileSync(specPath, 'utf8');
let hard = 0;
const bad = (m) => { hard++; console.log('FAIL ' + m); };
const phases = plan.phases.map((p) => p.id);
const T = new Map(plan.tasks.map((t) => [t.id, t]));
for (const t of plan.tasks) for (const k of ['owner', 'dependencies', 'inputs', 'outputs', 'files', 'acceptanceCriteria', 'verification'])
  if (t[k] == null || (Array.isArray(t[k]) && k !== 'dependencies' && !t[k].length)) bad(`${t.id} missing ${k}`);
for (const t of plan.tasks) if (!t.verification?.command || t.verification.cwd !== '.') bad(`${t.id} verification command/cwd`);
const reach = new Map();
const visit = (id, stack = new Set()) => {
  if (reach.has(id)) return reach.get(id);
  if (stack.has(id)) { bad(`cycle through ${id}`); return new Set(); }
  stack.add(id); const s = new Set();
  for (const d of T.get(id).dependencies) {
    if (!T.has(d)) { bad(`${id} depends on unknown ${d}`); continue; }
    if (phases.indexOf(T.get(d).phase) > phases.indexOf(T.get(id).phase)) bad(`${id} depends on later-phase ${d}`);
    s.add(d); for (const x of visit(d, stack)) s.add(x);
  }
  stack.delete(id); reach.set(id, s); return s;
};
for (const t of plan.tasks) visit(t.id);
const expand = (g) => { const m = g.match(/\{([^}]*)\}/); return m ? m[1].split(',').flatMap((x) => expand(g.replace(m[0], x))) : [g]; };
const toRe = (g) => new RegExp('^' + g.replace(/[.+^$()|[\]\\]/g, '\\$&').replace(/\*\*\//g, '\u0001').replace(/\*\*/g, '\u0002').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]').replace(/\u0001/g, '(?:.*/)?').replace(/\u0002/g, '.*') + '$');
const isGlob = (g) => /[*?{]/.test(g);
const matches = (g, p) => expand(g).some((e) => toRe(e).test(p));
const owns = (t, p) => t.files.some((g) => matches(g, p));
const prefix = (g) => g.split(/[*?{]/)[0];
const overlap = (a, b) => expand(a).some((x) => expand(b).some((y) => {
  if (!isGlob(x)) return toRe(y).test(x);
  if (!isGlob(y)) return toRe(x).test(y);
  const px = prefix(x), py = prefix(y); return px.startsWith(py) || py.startsWith(px);
}));
let pairs = 0;
for (const ph of phases) {
  const ts = plan.tasks.filter((t) => t.phase === ph);
  for (let i = 0; i < ts.length; i++) for (let j = i + 1; j < ts.length; j++) {
    const a = ts[i], b = ts[j];
    if (reach.get(a.id).has(b.id) || reach.get(b.id).has(a.id)) continue;
    pairs++;
    for (const fa of a.files) for (const fb of b.files) if (overlap(fa, fb)) bad(`concurrent ${a.id} and ${b.id} both own ${fa} / ${fb}`);
  }
}
console.log(`concurrent pairs checked: ${pairs}`);
for (const t of plan.tasks) for (const f of t.files) if (/(^|\/)\.eccode|(^|\/)\.claude|(^|\/)hooks(\/|$)/.test(f)) bad(`${t.id} owns ${f}`);
const ids = [...brief.slice(brief.indexOf('## Acceptance Criteria'), brief.indexOf('## Scope')).matchAll(/^- ((?:RS-\d{2})|(?:NFR\d))(?: \([^)]*\))?:/gm)].map((m) => m[1]);
const claims = new Map(ids.map((i) => [i, []]));
for (const p of plan.phases) for (const a of p.acceptanceCriteria)
  for (const m of a.matchAll(/(?:^|[;:]\s)((?:RS-\d{2})|(?:NFR\d))(?:\(a\))?(?: \[[^\]]*\])?:/g))
    if (claims.has(m[1]) && !claims.get(m[1]).includes(p.id)) claims.get(m[1]).push(p.id);
for (const [id, ps] of claims) if (ps.length !== 1) bad(`${id} claimed by ${ps.length} phases (${ps.join(',')})`);
console.log(`brief ids: ${ids.length}; claimed exactly once: ${[...claims.values()].filter((p) => p.length === 1).length}`);
const NPM_TEST = ['test/unit/**/*.test.js', 'test/api/**/*.test.js', 'test/integration/**/*.test.js', 'test/eval/**/*.test.js', 'test/scan/**/*.test.js', 'test/timing/**/*.test.js', 'scripts/report-p95.js'];
const runSet = (cmd) => {
  const body = cmd.replace(/^ls (?:\S+ )+>\/dev\/null && /, '');
  const pats = [];
  if (/\bnpm test\b/.test(body)) pats.push(...NPM_TEST);
  if (/npm run test:browser/.test(body)) pats.push('test/browser/**/*.test.js');
  for (const m of body.matchAll(/"([^"]+)"|(\S+\.(?:js|sh|cjs))/g)) pats.push((m[1] || m[2]).replace(/^\.\//, ''));
  return pats;
};
const runs = (t, f) => runSet(t.verification.command).some((g) => g === f || (isGlob(g) && matches(g, f)));
const tStart = spec.indexOf('### Criterion Traceability');
let traced = 0;
for (const line of spec.slice(tStart, spec.indexOf('Design-specific tests', tStart)).split('\n')) {
  const m = line.match(/^\| ((?:RS-\d{2})|(?:NFR\d)) \| .*? \| (.*) \|$/);
  if (!m) continue;
  const [, id, cell] = m;
  const phase = claims.get(id)?.[0]; if (!phase) continue;
  const pIdx = phases.indexOf(phase);
  let dir = ''; const files = [];
  for (const b of cell.matchAll(/`([^`]+)`/g)) {
    const tok = b[1].trim();
    if (!/\.test\.js$|report-p95\.js$/.test(tok)) continue;
    if (tok.includes('/')) { dir = tok.slice(0, tok.lastIndexOf('/') + 1); files.push(tok); } else files.push(dir + tok);
  }
  for (const f of files.filter((x) => !x.startsWith('test/live/'))) {
    traced++;
    if (!plan.tasks.some((t) => phases.indexOf(t.phase) <= pIdx && owns(t, f))) bad(`${id}: ${f} owned by no task in or before ${phase}`);
    if (!plan.tasks.some((t) => t.phase === phase && runs(t, f))) bad(`${id}: ${f} not run in ${phase}`);
  }
}
console.log(`traceability test files checked: ${traced}`);
// 7
let guarded = 0;
for (const t of plan.tasks) {
  const m = t.verification.command.match(/^ls ((?:\S+ )+)>\/dev\/null && \S/);
  if (!m) { bad(`${t.id}: no leading ls guard`); continue; }
  const files = m[1].trim().split(/\s+/);
  const others = plan.tasks.filter((o) => o.id !== t.id && (phases.indexOf(o.phase) < phases.indexOf(t.phase) || reach.get(t.id).has(o.id) || o.phase === t.phase));
  for (const f of files) {
    if (isGlob(f)) bad(`${t.id}: guard entry ${f} is a glob`);
    if (!owns(t, f)) bad(`${t.id}: guard file ${f} not owned by the task`);
    const pre = others.filter((o) => owns(o, f)).map((o) => o.id);
    if (pre.length) bad(`${t.id}: guard file ${f} also owned by ${pre.join(', ')} (earlier, dependency or same phase)`);
  }
  if (!files.some((f) => /\.test\.js$/.test(f) && runs(t, f))) bad(`${t.id}: no guard file is a test the command runs`);
  guarded++;
}
console.log(`tasks with a valid-shaped guard: ${guarded}/${plan.tasks.length}`);
// 8
let named = 0;
for (const t of plan.tasks) {
  const text = t.acceptanceCriteria.join(' ') + ' ' + t.verification.command;
  const before = plan.tasks.filter((o) => phases.indexOf(o.phase) < phases.indexOf(t.phase) || reach.get(t.id).has(o.id));
  for (const m of new Set([...text.matchAll(/\btest\/[A-Za-z0-9_./-]+\.test\.js\b/g)].map((x) => x[0]))) {
    if (m.startsWith('test/live/') && !owns(t, m)) continue;
    named++;
    if (!owns(t, m) && !before.some((o) => owns(o, m))) bad(`${t.id}: names ${m}, which neither it nor an earlier/dependency task owns`);
  }
}
console.log(`task-named test files checked: ${named}`);
console.log(`hard problems: ${hard}`);
process.exit(hard ? 1 : 0);
