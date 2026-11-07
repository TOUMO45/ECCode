'use strict';
// GF-RUN-1 and GF-RUN-2, the owner's round-5 decision on S2: in a Greenfield-Senior project a group role has no
// shell (the hook denies Bash, PowerShell and Monitor), and commands run through the Greenfield runner, which accepts
// only the pinned forms of eight tools (pytest, alembic, uvicorn, ruff, semgrep, gitleaks, trivy, playwright) or a
// plan's pinned command, and runs them through the frozen evidence runner and its integrity window. Also GF-CLOSE-2 as
// amended by the same decision: the user may defer a major documentation finding. Positive, negative and bypass rows.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const net = require('net');
const path = require('path');
const { spawnSync } = require('child_process');
const C = require('../lib/greenfield/constants');
const audit = require('../lib/greenfield/audit');
const { install } = require('../lib/install');
const { gfProject } = require('./fixtures/gf/flow');
const { tmpProject } = require('./helpers');
const X = require('./fixtures/gf/close');
const { closeProject, battery, dispatch, review, resolve, commitAll, F, LONG } = X;

const runner = () => require('../lib/greenfield/runner');
const ROOT = path.join(__dirname, '..');
const GUARD = path.join(ROOT, 'scripts/hooks/guard.js');
const GROUP_ROLES = Object.values(C.GROUPS).flat();
const rulesOf = (err) => ((err && err.details && err.details.problems) || []).map((p) => p.rule);
function hook(dir, role, tool, input) {
  const res = spawnSync(process.execPath, [GUARD], { input: JSON.stringify({ cwd: dir, tool_name: tool, ...(role ? { agent_type: `eccode:${role}` } : {}), tool_input: input }), encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: dir, ECCODE_ACTOR: '' } });
  if (!res.stdout) return { decision: 'allow', reason: '' };
  const o = JSON.parse(res.stdout).hookSpecificOutput;
  return { decision: o.permissionDecision, reason: o.permissionDecisionReason || '' };
}
const put = (ctx, rel, text) => { fs.mkdirSync(path.dirname(path.join(ctx.dir, rel)), { recursive: true }); fs.writeFileSync(path.join(ctx.dir, rel), text); };
function team() {
  const ctx = closeProject();
  require('../lib/greenfield/wrap').gateStart(ctx.store, ctx.config, 'phase:skeleton', 'orchestrator');
  F(ctx, 'task.claimed', 'backend-engineer', { task: 's0-app' });
  return ctx;
}

// ------------------------------------------------------------------ GF-RUN-1: no shell for a group role
test('GF-RUN-1 positive: in a Greenfield-Senior project every group role is denied every shell tool', () => {
  const ctx = team();
  for (const role of GROUP_ROLES) for (const tool of ['Bash', 'PowerShell', 'Monitor']) {
    const r = hook(ctx.dir, role, tool, { command: 'ls' });
    assert.strictEqual(r.decision, 'deny', `${role} ${tool}: ${r.reason}`);
    assert.match(r.reason, /GF-RUN-1/);
  }
});
test('GF-RUN-1 negative: the orchestrator, a reviewer role, and a group role outside a Greenfield-Senior project keep their shell', () => {
  const ctx = team();
  assert.doesNotMatch(hook(ctx.dir, null, 'Bash', { command: 'ls' }).reason, /GF-RUN-1/);
  assert.doesNotMatch(hook(ctx.dir, 'technical-reviewer', 'Bash', { command: 'ls' }).reason, /GF-RUN-1/);
  const plain = tmpProject();
  assert.doesNotMatch(hook(plain.dir, 'backend-engineer', 'Bash', { command: 'ls' }).reason, /GF-RUN-1/);
});
test('GF-RUN-1 bypass: a Greenfield-Senior record that cannot be read denies a group role the shell (fail closed)', () => {
  const ctx = team();
  // A line in the middle that does not parse makes the log unreadable (the frozen store skips only a torn last line).
  const file = path.join(ctx.dir, '.eccode/events.jsonl');
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  lines.splice(1, 0, '{not json');
  fs.writeFileSync(file, lines.join('\n'));
  const r = hook(ctx.dir, 'backend-engineer', 'Bash', { command: 'ls' });
  assert.strictEqual(r.decision, 'deny', r.reason);
  assert.match(r.reason, /GF-RUN-1/);
});
test('GF-RUN-1: the install wires the guard for the three shell tools, and the preflight requires that wiring', () => {
  delete process.env.ECCODE_HOOKS;
  const ctx = gfProject();
  install({ target: ctx.dir, profile: 'sandbox' });
  const file = path.join(ctx.dir, '.claude/settings.json');
  const s = JSON.parse(fs.readFileSync(file, 'utf8'));
  const m = s.hooks.PreToolUse.map((g) => g.matcher).join('|');
  for (const t of ['Bash', 'PowerShell', 'Monitor']) assert.match(m, new RegExp(`(^|\\|)${t}(\\||$)`), t);
  assert.match(JSON.parse(fs.readFileSync(path.join(ROOT, 'hooks/hooks.json'), 'utf8')).hooks.PreToolUse.map((g) => g.matcher).join('|'), /Monitor/);
  const preflight = require('../lib/greenfield/preflight');
  assert.strictEqual(preflight.preflight(ctx.dir).regime, 'managed-path');
  for (const g of s.hooks.PreToolUse) g.matcher = String(g.matcher).replace('|Monitor', '');
  fs.writeFileSync(file, JSON.stringify(s));
  const r = preflight.preflight(ctx.dir);
  assert.strictEqual(r.regime, 'text-level');
  assert.ok(r.warnings.some((w) => /guard is not wired/.test(w)), JSON.stringify(r.warnings));
});

// ------------------------------------------------------------------ GF-RUN-2: the runner's pinned forms
const OK = [
  ['backend-engineer', 'pytest -q tests/test_ok.py'],
  ['backend-engineer', 'python -m pytest -x tests/test_ok.py::test_ok'],
  ['test-engineer', 'python3 -m pytest -q --maxfail=1 -k smoke tests'],
  ['database-engineer', 'alembic upgrade head'],
  ['database-engineer', 'alembic revision --autogenerate -m add_tasks'],
  ['backend-engineer', 'alembic current'],
  ['backend-engineer', 'serve app.main:app --port 8000 -- pytest -q tests/e2e'],
  ['frontend-engineer', 'serve app.main:app --port 8001 -- npx playwright test tests/e2e --reporter=line'],
  ['backend-engineer', 'ruff check app'],
  ['backend-engineer', 'ruff check --fix app/main.py'],
  ['backend-engineer', 'ruff format --check app'],
  ['backend-engineer', 'ruff format app/main.py'],
  ['security-engineer', 'semgrep scan --config=p/python --metrics=off --error --json app'],
  ['security-engineer', 'gitleaks detect --no-git --redact --source=.'],
  ['security-engineer', 'trivy fs --scanners=vuln,secret --exit-code=1 --quiet .'],
  ['frontend-engineer', 'npx playwright test --project=chromium'],
];
for (const [role, command] of OK) {
  test(`GF-RUN-2 positive: ${role} may run "${command}"`, () => {
    const ctx = team();
    assert.deepStrictEqual(runner().formProblems(ctx.store, ctx.config, role, command), []);
  });
}
const BAD = [
  ['backend-engineer', 'pytest -q; rm -rf web', /shell syntax/],
  ['backend-engineer', 'pytest && touch web/x', /shell syntax/],
  ['backend-engineer', 'pytest $(cat x)', /shell syntax/],
  ['backend-engineer', 'pytest | tee out', /shell syntax/],
  ['backend-engineer', 'pytest > web/out.txt', /shell syntax/],
  ['backend-engineer', 'pytest `id`', /shell syntax/],
  ['backend-engineer', 'bash -c ls', /not a pinned form/],
  ['backend-engineer', 'python -c print', /not a pinned form/],
  ['backend-engineer', 'python -m pip install requests', /not a pinned form/],
  ['backend-engineer', 'node scripts/x.js', /not a pinned form/],
  ['backend-engineer', 'pytest ../outside', /outside the project/],
  ['backend-engineer', 'pytest /etc/passwd', /outside the project/],
  ['backend-engineer', 'pytest --rootdir=/tmp', /flag --rootdir/],
  ['backend-engineer', 'pytest -p no:cacheprovider', /flag -p/],
  ['frontend-engineer', 'ruff check --fix app/main.py', /app\/main\.py belongs to backend/],
  ['backend-engineer', 'ruff format', /names the paths it writes/],
  ['backend-engineer', 'alembic revision --autogenerate -m add_x', /migrations/],
  ['security-engineer', 'gitleaks detect --no-git --source=.', /--redact/],
  ['security-engineer', 'semgrep scan --config=p/python app', /--metrics=off/],
  ['backend-engineer', 'serve app.main:app --port 8000 -- ruff format app/main.py', /a pytest or playwright form/],
  ['backend-engineer', 'serve app.main:app --port 80 -- pytest -q', /port/],
  ['orchestrator', 'ruff format app/main.py', /only a group role/],
];
for (const [role, command, re] of BAD) {
  test(`GF-RUN-2 negative: ${role} may not run "${command.replace(/\n/g, ' ')}"`, () => {
    const ctx = team();
    const p = runner().formProblems(ctx.store, ctx.config, role, command);
    assert.ok(p.length && p.every((x) => x.rule === 'GF-RUN-2'), JSON.stringify(p));
    assert.match(p.map((x) => x.message).join(' | '), re);
  });
}
test('GF-RUN-2: a pinned form runs through the frozen evidence runner and is recorded under the caller', () => {
  const ctx = team();
  put(ctx, 'tests/test_ok.py', 'def test_ok():\n    assert 1 == 1\n');
  commitAll(ctx, 'a test');
  const r = runner().run(ctx.store, ctx.config, 'backend-engineer', { label: 'smoke', command: 'pytest -q tests/test_ok.py' });
  assert.strictEqual(r.status, 'passed', r.outputTail);
  assert.deepStrictEqual(r.problems, []);
  const ev = ctx.store.readEvents().find((e) => e.type === 'evidence.recorded' && `ev:${e.data.id}` === r.evidence);
  assert.strictEqual(ev.actor, 'backend-engineer');
});
test('GF-RUN-2: a refused form records nothing', () => {
  const ctx = team();
  const before = ctx.store.readEvents().length;
  let err;
  try { runner().run(ctx.store, ctx.config, 'backend-engineer', { label: 'x', command: 'bash -c ls' }); } catch (e) { err = e; }
  assert.ok(rulesOf(err).includes('GF-RUN-2'), err && err.message);
  assert.strictEqual(ctx.store.readEvents().length, before);
});
test('GF-RUN-2 bypass: project code run by a pinned form that writes a new file in another group\'s area is reported', () => {
  const ctx = team();
  put(ctx, 'tests/test_w.py', 'import os\n\ndef test_w():\n    os.makedirs("web", exist_ok=True)\n    open("web/evil.js", "w").write("x")\n');
  commitAll(ctx, 'a writing test');
  const r = runner().run(ctx.store, ctx.config, 'backend-engineer', { label: 'w', command: 'pytest -q tests/test_w.py' });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.status, 'failed'); // round 6: the run fails, it is not only reported
  assert.match(r.problems.map((p) => `${p.rule} ${p.message}`).join(' '), /GF-RUN-2 .*web\/evil\.js/);
});
test('GF-RUN-2 bypass: project code that changes a tracked file outside the caller\'s claimed ownership fails the run (frozen integrity window)', () => {
  const ctx = team();
  put(ctx, 'web/index.html', '<h1>Tasks</h1>\n');
  put(ctx, 'tests/test_t.py', 'def test_t():\n    open("web/index.html", "a").write("changed")\n');
  commitAll(ctx, 'a page and a test that changes it');
  const r = runner().run(ctx.store, ctx.config, 'backend-engineer', { label: 't', command: 'pytest -q tests/test_t.py' });
  assert.strictEqual(r.status, 'failed');
  assert.strictEqual(r.exitCode, 99);
});
const freePort = () => new Promise((res) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
const portOpen = (port) => new Promise((res) => { const c = net.connect(port, '127.0.0.1'); c.on('connect', () => { c.destroy(); res(true); }); c.on('error', () => res(false)); });
test('GF-RUN-2 (uvicorn): serve starts the app, runs the check against it, and stops it', async () => {
  const ctx = team();
  const port = await freePort();
  put(ctx, 'app/asgi_ok.py', 'async def app(scope, receive, send):\n    await send({"type": "http.response.start", "status": 200, "headers": []})\n    await send({"type": "http.response.body", "body": b"ok"})\n');
  put(ctx, 'tests/test_serve.py', `import urllib.request\n\ndef test_serve():\n    assert urllib.request.urlopen("http://127.0.0.1:${port}/").status == 200\n`);
  commitAll(ctx, 'an app and its smoke test');
  const r = runner().run(ctx.store, ctx.config, 'backend-engineer', { label: 'serve', command: `serve app.asgi_ok:app --port ${port} -- pytest -q tests/test_serve.py` });
  assert.strictEqual(r.status, 'passed', r.outputTail);
  assert.strictEqual(await portOpen(port), false, 'the server was stopped');
});
test('GF-RUN-2: a pinned tool that is not installed here fails the run and says it is unverifiable here', { skip: spawnSync('sh', ['-c', 'command -v gitleaks']).status === 0 && 'gitleaks is installed here' }, () => {
  const ctx = team();
  const r = runner().run(ctx.store, ctx.config, 'security-engineer', { label: 'secrets', command: 'gitleaks detect --no-git --redact --source=.' });
  assert.strictEqual(r.status, 'failed');
  assert.match(r.problems.map((p) => p.message).join(' '), /unverifiable here: gitleaks is not installed/);
});
test('GF-RUN-2: gf_run is a tool of the role servers and applies the same check', () => {
  const ctx = team();
  const tool = require('../lib/greenfield').gfTools().find((t) => t.name === 'gf_run');
  assert.ok(tool, 'gf_run');
  let err;
  try { tool.handler({ label: 'x', command: 'bash -c ls' }, { store: ctx.store, config: ctx.config, actor: 'backend-engineer' }); } catch (e) { err = e; }
  assert.ok(rulesOf(err).includes('GF-RUN-2'), err && err.message);
});

// ------------------------------------------------------------------ GF-CLOSE-2 as amended in round 5: deferring a major documentation finding
function withFinding(severity, kind) {
  const ctx = closeProject();
  battery(ctx);
  const step = kind === 'documentation' ? 'comprehension' : 'critique';
  const role = step === 'comprehension' ? 'technical-reviewer' : 'security-reviewer';
  const d = dispatch(ctx, step, role);
  review(ctx, role, { scope: 'S2', step, dispatch: d.id, summary: LONG, findings: [{ id: 'F-1', severity, kind, summary: 'a finding to defer, for the test of the deferral rule' }] });
  return ctx;
}
const DEFER = { finding: 'F-1', resolution: 'deferred', limit: 'L-GF-99', reason: 'deferred by the owner with a named limit, to a later slice' };
test('GF-CLOSE-2 (round 5) positive: the user may defer a major documentation finding, and a minor one of either kind', () => {
  for (const [sev, kind] of [['major', 'documentation'], ['minor', 'documentation'], ['minor', 'defect']]) {
    const ctx = withFinding(sev, kind);
    assert.strictEqual(resolve(ctx, 'user', DEFER).resolution, 'deferred', `${sev} ${kind}`);
  }
});
test('GF-CLOSE-2 (round 5) negative: a major defect, a blocking finding, and a deferral by the orchestrator are refused', () => {
  for (const [sev, kind, actor, re] of [['major', 'defect', 'user', /major defect/], ['blocking', 'documentation', 'user', /blocking/], ['minor', 'documentation', 'orchestrator', /only the user/]]) {
    const ctx = withFinding(sev, kind);
    let err;
    try { resolve(ctx, actor, DEFER); } catch (e) { err = e; }
    assert.ok(rulesOf(err).includes('GF-CLOSE-2'), `${sev} ${kind} ${actor}`);
    assert.match(err.message, re);
  }
});
test('GF-CLOSE-2 (round 5) bypass: a forged deferral of a major defect is reported by the audit', () => {
  const ctx = withFinding('major', 'defect');
  F(ctx, 'gf.finding.resolved', 'user', { id: 'res-forged', ...DEFER });
  assert.ok(audit.run(ctx.store, ctx.config).errors.some((e) => e.rule === 'GF-CLOSE-2' && /major defect/.test(e.message)));
});
