// technical-reviewer check (plan gate). Usage: node tr-plan-check.mjs <plan.json> <brief.md> <spec.md>
// 1. structure: every task has owner, dependencies, inputs, outputs, files, acceptanceCriteria, verification{command,cwd}
// 2. graph: dependencies exist, no cycle, no dependency on a later phase
// 3. concurrency: tasks of one phase not ordered by the dependency closure must have disjoint ownership globs
// 4. no ownership glob names .eccode/, .claude/ or hooks
// 5. claims: each of the brief's 45 ids is claimed ("<id>[ (a)][ [..]]:") by exactly one phase
// 6. traceability: every [D]/[B] test file the spec's Criterion Traceability names for an id is owned by some task in
//    or before the claiming phase AND is run by a verification command of a task in the claiming phase
//    (explicitly, by a quoted glob, by `npm test` = the spec's six globs, or by `npm run test:browser` = test/browser/**)
// 7. falsifiability: does each task's command reference at least one file that THIS task creates first (so it fails
//    before the work exists)? Glob-only commands pass with 0 tests on Node 22 (see tr-plan-probes.mjs).
// Exit 0 = 1-6 hold (7 is reported, not failed).
import { readFileSync } from 'node:fs';
const [planPath, briefPath, specPath] = process.argv.slice(2);
const plan = JSON.parse(readFileSync(planPath, 'utf8'));
const brief = readFileSync(briefPath, 'utf8');
const spec = readFileSync(specPath, 'utf8');
let hard = 0;
const bad = (m) => { hard++; console.log('FAIL ' + m); };

const phases = plan.phases.map((p) => p.id);
const T = new Map(plan.tasks.map((t) => [t.id, t]));
// 1
for (const t of plan.tasks) for (const k of ['owner', 'dependencies', 'inputs', 'outputs', 'files', 'acceptanceCriteria', 'verification'])
  if (t[k] == null || (Array.isArray(t[k]) && k !== 'dependencies' && !t[k].length)) bad(`${t.id} missing ${k}`);
for (const t of plan.tasks) if (!t.verification?.command || t.verification.cwd !== '.') bad(`${t.id} verification command/cwd`);
// 2
const reach = new Map();
const visit = (id, stack = new Set()) => {
  if (reach.has(id)) return reach.get(id);
  if (stack.has(id)) { bad(`cycle through ${id}`); return new Set(); }
  stack.add(id);
  const s = new Set();
  for (const d of T.get(id).dependencies) {
    if (!T.has(d)) { bad(`${id} depends on unknown ${d}`); continue; }
    if (phases.indexOf(T.get(d).phase) > phases.indexOf(T.get(id).phase)) bad(`${id} depends on later-phase ${d}`);
    s.add(d); for (const x of visit(d, stack)) s.add(x);
  }
  stack.delete(id); reach.set(id, s); return s;
};
for (const t of plan.tasks) visit(t.id);
// glob helpers
const expand = (g) => { const m = g.match(/\{([^}]*)\}/); return m ? m[1].split(',').flatMap((x) => expand(g.replace(m[0], x))) : [g]; };
const toRe = (g) => new RegExp('^' + g.replace(/[.+^$()|[\]\\]/g, '\\$&').replace(/\*\*\//g, '\u0001').replace(/\*\*/g, '\u0002').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]').replace(/\u0001/g, '(?:.*/)?').replace(/\u0002/g, '.*') + '$');
const isGlob = (g) => /[*?{]/.test(g);
const matches = (g, path) => expand(g).some((e) => toRe(e).test(path));
const prefix = (g) => g.split(/[*?{]/)[0];
const overlap = (a, b) => expand(a).some((x) => expand(b).some((y) => {
  if (!isGlob(x)) return toRe(y).test(x);
  if (!isGlob(y)) return toRe(x).test(y);
  const px = prefix(x), py = prefix(y); return px.startsWith(py) || py.startsWith(px);
}));
// 3
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
// 4
for (const t of plan.tasks) for (const f of t.files) if (/(^|\/)\.eccode|(^|\/)\.claude|(^|\/)hooks(\/|$)/.test(f)) bad(`${t.id} owns ${f}`);
// 5
const ids = [...brief.slice(brief.indexOf('## Acceptance Criteria'), brief.indexOf('## Scope')).matchAll(/^- ((?:RS-\d{2})|(?:NFR\d))(?: \([^)]*\))?:/gm)].map((m) => m[1]);
const claims = new Map(ids.map((i) => [i, []]));
for (const p of plan.phases) for (const a of p.acceptanceCriteria)
  for (const m of a.matchAll(/(?:^|[;:]\s)((?:RS-\d{2})|(?:NFR\d))(?:\(a\))?(?: \[[^\]]*\])?:/g))
    if (claims.has(m[1]) && !claims.get(m[1]).includes(p.id)) claims.get(m[1]).push(p.id);
for (const [id, ps] of claims) if (ps.length !== 1) bad(`${id} claimed by ${ps.length} phases (${ps.join(',')})`);
console.log(`brief ids: ${ids.length}; claimed exactly once: ${[...claims.values()].filter((p) => p.length === 1).length}`);
// 6
const NPM_TEST = ['test/unit/**/*.test.js', 'test/api/**/*.test.js', 'test/integration/**/*.test.js', 'test/eval/**/*.test.js', 'test/scan/**/*.test.js', 'test/timing/**/*.test.js', 'scripts/report-p95.js'];
const runSet = (cmd) => {
  const pats = [];
  if (/\bnpm test\b/.test(cmd)) pats.push(...NPM_TEST);
  if (/npm run test:browser/.test(cmd)) pats.push('test/browser/**/*.test.js');
  for (const m of cmd.matchAll(/"([^"]+)"|(\S+\.(?:js|sh|cjs))/g)) pats.push((m[1] || m[2]).replace(/^\.\//, ''));
  return pats;
};
const tStart = spec.indexOf('### Criterion Traceability');
const rows = spec.slice(tStart, spec.indexOf('Design-specific tests', tStart)).split('\n');
let traced = 0;
for (const line of rows) {
  const m = line.match(/^\| ((?:RS-\d{2})|(?:NFR\d)) \| .*? \| (.*) \|$/);
  if (!m) continue;
  const [, id, cell] = m;
  const phase = claims.get(id)?.[0]; if (!phase) continue;
  const pIdx = phases.indexOf(phase);
  let dir = '';
  const files = [];
  for (const b of cell.matchAll(/`([^`]+)`/g)) {
    const tok = b[1].trim();
    if (!/\.test\.js$|report-p95\.js$/.test(tok)) continue;
    if (tok.includes('/')) { dir = tok.slice(0, tok.lastIndexOf('/') + 1); files.push(tok); } else files.push(dir + tok);
  }
  for (const f of files.filter((x) => !x.startsWith('test/live/'))) {
    traced++;
    const owners = plan.tasks.filter((t) => phases.indexOf(t.phase) <= pIdx && t.files.some((g) => matches(g, f)));
    if (!owners.length) bad(`${id}: ${f} is owned by no task in or before ${phase}`);
    const runners = plan.tasks.filter((t) => t.phase === phase && runSet(t.verification.command).some((g) => g === f || (isGlob(g) && matches(g, f))));
    if (!runners.length) bad(`${id}: ${f} is not run by any verification command in ${phase}`);
  }
}
console.log(`traceability test files checked: ${traced}`);
// 7
const order = [...plan.tasks].sort((a, b) => phases.indexOf(a.phase) - phases.indexOf(b.phase) || reach.get(a.id).size - reach.get(b.id).size);
const firstOwner = (f) => order.find((t) => t.files.some((g) => matches(g, f)))?.id;
const vacuous = [];
for (const t of plan.tasks) {
  const cmd = t.verification.command;
  const refs = [...cmd.matchAll(/"([^"]+)"|(\S+\.(?:js|sh|cjs))/g)].map((m) => (m[1] || m[2]).replace(/^\.\//, '')).filter((x) => !isGlob(x));
  if (/\bnpm test\b/.test(cmd)) refs.push('test/helpers/net-guard.js', 'scripts/report-p95.js', 'scripts/reset-test-out.js', 'scripts/check-node.cjs');
  if (/--import \.\/test\/helpers\/net-guard\.js/.test(cmd)) refs.push('test/helpers/net-guard.js');
  const own = refs.filter((f) => firstOwner(f) === t.id);
  if (!own.length) vacuous.push(t.id);
  console.log(`${own.length ? 'falsifiable ' : 'PRE-PASSING '} ${t.id}: ${own.length ? 'fails before work via ' + own.slice(0, 3).join(', ') : 'every referenced file pre-exists or the command is globs only: ' + cmd.slice(0, 110)}`);
}
console.log(`tasks whose command can pass before their work exists: ${vacuous.length} (${vacuous.join(', ')})`);
console.log(`hard problems: ${hard}`);
process.exit(hard ? 1 : 0);
