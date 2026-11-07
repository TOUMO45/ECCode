'use strict';
// Independent readiness probe of the S2 rules (architecture-reviewer, R3). It drives the tree under review through
// its public entry points: the real PreToolUse hook as a child process, and the lib/greenfield functions. Each probe
// prints PASS or FAIL; the process exits 1 if any probe fails. Usage: node probe.js <tree>
const fs = require('fs');
const path = require('path');
const { spawnSync, execFileSync } = require('child_process');

const TREE = path.resolve(process.argv[2]);
const R = (rel) => require(path.join(TREE, rel));
const sample = R('tests/fixtures/gf/sample');
const { gfProject, run, WRAPPED } = R('tests/fixtures/gf/flow');
const { tmpProject } = R('tests/helpers');
const wrap = R('lib/greenfield/wrap');
const messages = R('lib/greenfield/messages');
const ownershipOps = R('lib/greenfield/ownership-ops');
const pin = R('lib/greenfield/pin');
const audit = R('lib/greenfield/audit');
const closure = R('lib/greenfield/closure');
const { preflight } = R('lib/greenfield/preflight');
const GUARD = path.join(TREE, 'scripts/hooks/guard.js');

let failed = 0;
function check(name, ok, detail = '') {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : ` :: ${detail}`}`);
}
function rules(fn) {
  try { fn(); return { threw: false, rules: [], text: '' }; } catch (e) {
    const ps = (e.details && e.details.problems) || [];
    return { threw: true, rules: ps.map((p) => p.rule), text: String(e.message) };
  }
}
function hook(dir, role, tool, input) {
  const res = spawnSync(process.execPath, [GUARD], {
    input: JSON.stringify({ cwd: dir, tool_name: tool, ...(role ? { agent_type: `eccode:${role}` } : {}), tool_input: input }),
    encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: dir, ECCODE_ACTOR: '' },
  });
  if (!res.stdout) return { decision: 'allow', reason: '' };
  const o = JSON.parse(res.stdout).hookSpecificOutput;
  return { decision: o.permissionDecision, reason: o.permissionDecisionReason || '' };
}
const W = (dir, role, rel) => hook(dir, role, 'Write', { file_path: path.join(dir, rel), content: 'x' });
const B = (dir, role, command) => hook(dir, role, 'Bash', { command });
const denied = (r, re) => r.decision === 'deny' && re.test(r.reason);

function sealedTeam() {
  const ctx = gfProject();
  run(ctx, sample.build(), WRAPPED);
  wrap.gateStart(ctx.store, ctx.config, 'phase:skeleton', 'orchestrator');
  wrap.taskClaim(ctx.store, ctx.config, 's0-contracts', 'integration-engineer'); // through the wrapped claim
  // The others depend on s0-contracts; their claims are recorded directly, as the authors' fixture does.
  for (const [role, task] of [['backend-engineer', 's0-app'], ['database-engineer', 's0-db'], ['frontend-engineer', 's0-web']]) {
    ctx.store.commit('task.claimed', role, { task, runId: null });
  }
  return ctx;
}

// ---------------------------------------------------------------- GF-OWN-2, GF-FRZ-1, drafts, GF-CONF-1 in the hook
const t = sealedTeam();
const d = t.dir;
check('sealed project: G1 is sealed and claims went through the wrapped claim', Boolean(wrap.gfState(t.store).seal));
let r = W(d, 'backend-engineer', 'app/main.py');
check('GF-OWN-2: backend writes app/main.py (own group, claimed task) -> allowed', r.decision === 'allow', JSON.stringify(r));
r = W(d, 'backend-engineer', 'app/other.py');
check('GF-OWN-2 second half: backend writes app/other.py (own group, outside its claimed task) -> denied by the claimed-task rule', denied(r, /outside the ownership of backend-engineer's claimed task/), JSON.stringify(r));
r = W(d, 'frontend-engineer', 'app/main.py');
check('GF-OWN-2: frontend writes app/main.py -> denied, belongs to backend', denied(r, /belongs to backend.*GF-OWN-2/), JSON.stringify(r));
r = W(d, 'backend-engineer', 'app/db/models.py');
check('GF-OWN-2 denyGlobs: backend writes app/db/models.py -> denied, belongs to db', denied(r, /belongs to db/), JSON.stringify(r));
r = W(d, 'backend-engineer', 'pyproject.toml');
check('GF-OWN-2 unowned: backend writes pyproject.toml -> denied, names the amendment remedy', denied(r, /owned by no group \(GF-OWN-2\).*ownership amend/), JSON.stringify(r));
r = W(d, 'backend-engineer', 'web/../app/db/x.py');
check('GF-OWN-2 normalisation: backend writes web/../app/db/x.py -> judged as app/db/x.py, denied', denied(r, /app\/db\/x\.py belongs to db/), JSON.stringify(r));
r = B(d, 'backend-engineer', 'printf x > web/index.html');
check('GF-OWN-2 shell path: backend `printf x > web/index.html` -> denied', denied(r, /Shell write to web\/index\.html.*belongs to frontend/), JSON.stringify(r));
r = W(d, 'frontend-engineer', 'contracts/openapi.json');
check('GF-FRZ-1: frontend writes contracts/openapi.json -> denied', denied(r, /GF-FRZ-1: .*writable by the api group only/), JSON.stringify(r));
r = W(d, 'integration-engineer', 'contracts/openapi.json');
check('GF-FRZ-1: api writes a sealed contract with no open amendment request -> denied', denied(r, /GF-FRZ-1: .*only while an amendment request/), JSON.stringify(r));
r = W(d, 'integration-engineer', 'contracts/events.json');
check('GF-FRZ-1: api creates contracts/events.json that is not in the seal -> denied', denied(r, /GF-FRZ-1: .*not in the seal/), JSON.stringify(r));
r = W(d, 'integration-engineer', 'mocks/server.js');
check('mocks/** is an api path under GF-OWN-2, not a contract file -> api allowed', r.decision === 'allow', JSON.stringify(r));
r = W(d, 'backend-engineer', '.eccode/drafts/backend/n.md');
check('drafts: backend writes .eccode/drafts/backend/n.md -> allowed', r.decision === 'allow', JSON.stringify(r));
r = W(d, 'backend-engineer', '.eccode/drafts/frontend/n.md');
check('drafts: backend writes .eccode/drafts/frontend/n.md -> denied (namespaced)', denied(r, /drafts are namespaced per group/), JSON.stringify(r));
r = W(d, 'backend-engineer', '.eccode/drafts/n.md');
check('drafts: backend writes the shared .eccode/drafts/n.md -> denied', denied(r, /drafts are namespaced per group/), JSON.stringify(r));
r = W(d, 'backend-engineer', '.eccode/guards.json');
check('GF-CONF-1 in the hook: backend writes .eccode/guards.json -> denied', denied(r, /GF-CONF-1/), JSON.stringify(r));
r = W(d, 'security-engineer', '.eccode/security.json');
check('GF-CONF-1 in the hook: security-engineer writes .eccode/security.json -> denied', denied(r, /GF-CONF-1/), JSON.stringify(r));
r = W(d, null, 'app/main.py');
check('the orchestrator (no agent_type) is not subject to the group rules', r.decision === 'allow', JSON.stringify(r));

// ---------------------------------------------------------------- GF-OWN-3 (completion), GF-OWN-5 (rescope, amendment)
let x = rules(() => wrap.taskComplete(t.store, t.config, 's0-app', 'backend-engineer', { summary: 'done', filesChanged: ['app/main.py', 'web/index.html'], testsRun: [] }));
check('GF-OWN-3: backend completion listing web/index.html -> refused before the frozen call', x.threw && x.rules.includes('GF-OWN-3') && t.store.state().tasks['s0-app'].status === 'claimed', JSON.stringify(x));
x = rules(() => ownershipOps.rescope(t.store, t.config, 's0-app', 'orchestrator', { files: 'app/main.py,web/auth/**', reason: 'probe' }));
check('GF-OWN-5: a rescope moving a backend task onto web/auth/** -> refused before the frozen call', x.threw && x.rules.includes('GF-OWN-5') && t.store.state().tasks['s0-app'].files.join(',') === 'app/main.py,app/__init__.py', JSON.stringify(x));
const msg = messages.send(t.store, t.config, 'backend-engineer', { to: ['orchestrator'], kind: 'question', subject: 'pyproject', body: 'backend needs pyproject.toml to declare its dependencies' }).id;
x = rules(() => ownershipOps.amend(t.store, t.config, 'orchestrator', { group: 'backend', to: ['app/**', 'pyproject.toml'], reason: 'backend needs the dependency manifest for its routes', message: msg }));
check('GF-OWN-5: an ownership amendment by the orchestrator (not a reviewer) -> refused', x.threw && x.rules.includes('GF-OWN-5'), JSON.stringify(x));
x = rules(() => ownershipOps.amend(t.store, t.config, 'technical-reviewer', { group: 'backend', to: ['app/**', '../pyproject.toml'], reason: 'backend needs the dependency manifest for its routes', message: msg }));
check('GF-OWN-5: an amendment whose glob contains .. -> refused', x.threw && x.rules.includes('GF-OWN-5'), JSON.stringify(x));
x = rules(() => ownershipOps.amend(t.store, t.config, 'technical-reviewer', { group: 'backend', to: ['app/**', 'web/**'], reason: 'backend needs the dependency manifest for its routes', message: msg }));
check('GF-OWN-5 disjointness: an amendment giving backend web/** (frontend\'s) -> refused', x.threw && /the resulting map is invalid/.test(x.text), JSON.stringify(x));
x = rules(() => ownershipOps.amend(t.store, t.config, 'technical-reviewer', { group: 'backend', to: ['app/**', 'pyproject.toml'], reason: 'backend needs the dependency manifest for its routes', message: msg }));
check('GF-OWN-5 positive: a reviewer amendment with a reason and a recorded message -> committed', !x.threw, JSON.stringify(x));
r = W(d, 'backend-engineer', 'pyproject.toml');
check('after the amendment the hook reads the effective map: pyproject.toml is no longer "owned by no group" for backend (only the claimed-task rule answers)', r.decision === 'deny' && !/owned by no group/.test(r.reason) && /claimed task/.test(r.reason), JSON.stringify(r));

// ---------------------------------------------------------------- audit replay of forged events (Store.commit bypass)
t.store.commit('gf.ownership.amended', 'backend-engineer', { id: 'own-forged', group: 'frontend', from: ['web/**'], to: ['web/**', 'Makefile'], reason: 'a forged amendment that no reviewer recorded at all', message: msg });
t.store.commit('task.completed', 'frontend-engineer', { task: 's0-web', handoffId: 'h-forged', filesChanged: ['web/index.html', 'app/main.py'] });
let a = audit.run(t.store, t.config);
check('audit: a forged amendment by a group role is GF-OWN-5', a.errors.some((e) => e.rule === 'GF-OWN-5' && /own-forged/.test(e.message)), JSON.stringify(a.errors.map((e) => e.rule)));
check('audit: a forged completion listing a backend file is GF-OWN-3', a.errors.some((e) => e.rule === 'GF-OWN-3' && /app\/main\.py belongs to backend/.test(e.message)), JSON.stringify(a.errors.filter((e) => e.rule === 'GF-OWN-3')));
check('audit carries the managed-path section with L-GF-17 warnings (no install here)', a.managedPath && a.managedPath.regime === 'text-level' && a.warnings.some((w) => /^L-GF-17/.test(w)), JSON.stringify(a.managedPath && a.managedPath.regime));

// ---------------------------------------------------------------- GF-CONF-1 pin and drift
const cfgFile = ['.eccode/security.json', '.eccode/guards.json', '.eccode/behavior.json'].find((f) => fs.existsSync(path.join(d, f)));
if (!cfgFile) fs.writeFileSync(path.join(d, '.eccode/guards.json'), '{}\n');
const target = cfgFile || '.eccode/guards.json';
x = rules(() => pin.pin(t.store, t.config, 'backend-engineer', { scope: 'S2', reason: 'pinning the guard configuration' }));
check('GF-CONF-1: a group role cannot pin', x.threw && x.rules.includes('GF-CONF-1'), JSON.stringify(x));
x = rules(() => pin.pin(t.store, t.config, 'orchestrator', { scope: 'S2', reason: 'short' }));
check('GF-CONF-1: a pin needs a reason of 10 characters or more', x.threw && x.rules.includes('GF-CONF-1'), JSON.stringify(x));
x = rules(() => pin.pin(t.store, t.config, 'orchestrator', { scope: 'S2', reason: 'pin the guard configuration for the slice' }));
check('GF-CONF-1: the orchestrator pins', !x.threw, JSON.stringify(x));
const before = audit.run(t.store, t.config).errors.filter((e) => e.rule === 'GF-CONF-1').length;
const obj = JSON.parse(fs.readFileSync(path.join(d, target), 'utf8'));
obj.probeLoosened = true;
fs.writeFileSync(path.join(d, target), JSON.stringify(obj));
a = audit.run(t.store, t.config);
check(`GF-CONF-1: a change to ${target} after the pin is reported by the audit`, before === 0 && a.errors.some((e) => e.rule === 'GF-CONF-1' && e.message.includes(target)), JSON.stringify({ before, after: a.errors.filter((e) => e.rule === 'GF-CONF-1') }));

// ---------------------------------------------------------------- GF-OWN-1: fail closed when the sealed breakdown is tampered
const bdRel = Object.keys(wrap.gfState(t.store).seal.hashes).find((p) => path.posix.basename(p) === 'breakdown.json');
fs.appendFileSync(path.join(d, bdRel), ' ');
r = W(d, 'backend-engineer', 'app/main.py');
check('GF-OWN-1 fail closed: one byte appended to the sealed breakdown.json -> a group role\'s write in its own claimed task is denied with GF-OWN-1', denied(r, /GF-OWN-1/), JSON.stringify(r));
r = W(d, null, 'app/main.py');
check('GF-OWN-1 fail closed does not touch the orchestrator', r.decision === 'allow', JSON.stringify(r));
a = audit.run(t.store, t.config);
check('GF-OWN-1: the audit reports the tampered breakdown', a.errors.some((e) => e.rule === 'GF-OWN-1' && /differs from the sealed bytes/.test(e.message)), JSON.stringify(a.errors.map((e) => e.rule)));

// ---------------------------------------------------------------- GF-OWN-1: a record that cannot be read fails closed
const t2 = sealedTeam();
// A torn LAST line is tolerated by the frozen store (crash recovery, lib/store.js parseEvents); a corrupt middle line
// is CORRUPT_LOG, which is "the log cannot be read".
const logFile = path.join(t2.dir, '.eccode/events.jsonl');
const lines = fs.readFileSync(logFile, 'utf8').split('\n');
lines.splice(1, 0, '{not json');
fs.writeFileSync(logFile, lines.join('\n'));
r = W(t2.dir, 'backend-engineer', 'app/main.py');
check('GF-OWN-1 fail closed: an unreadable log -> a group role\'s write is denied "could not be evaluated"', denied(r, /GF-OWN-1: the ownership policy could not be evaluated/), JSON.stringify(r));

// ---------------------------------------------------------------- not a Greenfield-Senior project: rules unchanged
const plain = tmpProject();
r = W(plain.dir, 'backend-engineer', 'app/main.py');
check('a plain ECCode project (no gf.project.initialized): the existing hook rule answers, no GF reason', r.decision === 'deny' && /has no claimed task/.test(r.reason) && !/GF-/.test(r.reason), JSON.stringify(r));

// ---------------------------------------------------------------- GF-OWN-4: attribution
const t3 = sealedTeam();
fs.mkdirSync(path.join(t3.dir, 'web'), { recursive: true });
fs.writeFileSync(path.join(t3.dir, 'web/undeclared.js'), 'x');
const at = ownershipOps.attribute(t3.store, 'HEAD');
check('GF-OWN-4: a changed path no completed task declares is reported by attribute', !at.ok && at.problems.some((p) => p.rule === 'GF-OWN-4' && /web\/undeclared\.js was changed but no completed task of frontend declares it/.test(p.message)), JSON.stringify(at.problems.slice(0, 3)));
const cli = spawnSync(process.execPath, [path.join(TREE, 'bin/eccode-gf.js'), 'attribute', '--base', 'HEAD'], { cwd: t3.dir, encoding: 'utf8' });
check('GF-OWN-4: `eccode-gf attribute --base HEAD` exits non-zero on an unattributed change', cli.status !== 0 && /web\/undeclared\.js/.test(cli.stdout + cli.stderr), `status ${cli.status}`);

// ---------------------------------------------------------------- GF-CLOSE-1..5 refusals
const c = sealedTeam();
const git = (...args) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd: c.dir, encoding: 'utf8' });
fs.mkdirSync(path.join(c.dir, 'docs'), { recursive: true });
fs.writeFileSync(path.join(c.dir, 'docs/design.md'), '# design\n');
git('add', '-A'); git('commit', '-q', '-m', 'all');
x = rules(() => closure.close(c.store, c.config, 'orchestrator', { scope: 'S2', accounting: { unit: 'all-processed-tokens', start: 1, end: 2 } }));
check('GF-CLOSE-1/3: a closure with no reviews and no batteries -> refused', x.threw && x.rules.includes('GF-CLOSE-1') && x.rules.includes('GF-CLOSE-3'), JSON.stringify(x.rules));
for (const [label, acc] of [['absent', undefined], ['null', null], ["'0' as text", { unit: 'all-processed-tokens', start: '0', end: 5 }], ['end below start', { unit: 'all-processed-tokens', start: 9, end: 5 }]]) {
  x = rules(() => closure.close(c.store, c.config, 'orchestrator', { scope: 'S2', accounting: acc }));
  check(`GF-CLOSE-4: accounting ${label} -> refused`, x.threw && x.rules.includes('GF-CLOSE-4'), JSON.stringify(x.rules));
}
x = rules(() => closure.recordDispatch(c.store, c.config, 'orchestrator', { scope: 'S2', role: 'technical-reviewer', step: 'critique', inputs: ['docs/design.md', '.eccode/handoffs/h.json'] }));
check('GF-CLOSE-5: a dispatch listing .eccode/handoffs/ -> refused', x.threw && x.rules.includes('GF-CLOSE-5'), JSON.stringify(x));
x = rules(() => closure.recordDispatch(c.store, c.config, 'backend-engineer', { scope: 'S2', role: 'technical-reviewer', step: 'critique', inputs: ['docs/design.md'] }));
check('GF-CLOSE-5: a dispatch recorded by a non-orchestrator -> refused', x.threw && x.rules.includes('GF-CLOSE-5'), JSON.stringify(x));
const disp = closure.recordDispatch(c.store, c.config, 'orchestrator', { scope: 'S2', role: 'technical-reviewer', step: 'critique', inputs: ['docs/design.md'] }).event.data;
const LONG = 'Probe review summary: this text is long enough to pass the hundred-character floor of the review step record, deliberately.';
x = rules(() => closure.recordReview(c.store, c.config, 'security-reviewer', { scope: 'S2', step: 'critique', dispatch: disp.id, summary: LONG }));
check('GF-CLOSE-1/5: a review by a role other than the dispatched one -> refused', x.threw && /was recorded for technical-reviewer/.test(x.text), JSON.stringify(x));
x = rules(() => closure.recordReview(c.store, c.config, 'backend-engineer', { scope: 'S2', step: 'critique', dispatch: disp.id, summary: LONG }));
check('GF-CLOSE-1: a review by a non-reviewer (an author) -> refused', x.threw && x.rules.includes('GF-CLOSE-1'), JSON.stringify(x));
x = rules(() => closure.recordReview(c.store, c.config, 'technical-reviewer', { scope: 'S2', step: 'critique', dispatch: disp.id, summary: LONG }));
check('GF-CLOSE-1 positive: the dispatched reviewer records its critique on the clean tree', !x.threw, JSON.stringify(x));
x = rules(() => closure.recordReview(c.store, c.config, 'technical-reviewer', { scope: 'S2', step: 'critique', dispatch: disp.id, summary: LONG }));
check('GF-CLOSE-5: a second review on the same dispatch -> refused', x.threw && /already carries review/.test(x.text), JSON.stringify(x));
const disp2 = closure.recordDispatch(c.store, c.config, 'orchestrator', { scope: 'S2', role: 'architecture-reviewer', step: 'readiness', inputs: ['docs/design.md'] }).event.data;
fs.writeFileSync(path.join(c.dir, 'docs/design.md'), '# design changed\n');
git('commit', '-qam', 'later');
x = rules(() => closure.recordReview(c.store, c.config, 'architecture-reviewer', { scope: 'S2', step: 'readiness', dispatch: disp2.id, summary: LONG, verdict: 'go', evidence: ['docs/design.md:1'] }));
check('GF-CLOSE-1: a review recorded after the tree moved since its dispatch -> refused', x.threw && /the tree changed since dispatch/.test(x.text), JSON.stringify(x));
fs.writeFileSync(path.join(c.dir, 'docs/dirty.md'), 'x');
x = rules(() => closure.recordDispatch(c.store, c.config, 'orchestrator', { scope: 'S2', role: 'architecture-reviewer', step: 'readiness', inputs: ['docs/design.md'] }));
check('clean tree: an untracked file outside .eccode makes a dispatch refused', x.threw && /the tree is not clean/.test(x.text), JSON.stringify(x));

console.log(failed ? `${failed} probe(s) FAILED` : 'all probes passed');
process.exit(failed ? 1 : 0);
