'use strict';
// Regression tests for finding F5 of the independent review: an agent could claim to be the human by
// passing `--actor user`, and every user-reserved operation trusted the string. The repair has two
// halves: the CLI confirms `--actor user` with a person at a terminal (ECCODE_TEST=1 is the suite's
// switch), and the user can grant a bounded delegation (one action, one target, N uses, an expiry,
// recorded in the hash-chained log) that an agent spends with `--delegation <id>`. The guard half
// (denying `--actor user` from every agent context) is tested in hooks-install.test.js.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const H = require('./helpers');
const gates = require('../lib/gates');
const tasks = require('../lib/tasks');
const runs = require('../lib/runs');
const rework = require('../lib/rework');
const evidence = require('../lib/evidence');
const authority = require('../lib/authority');
const { Store } = require('../lib/store');
const { init } = require('../lib/project');
const { loadConfig } = require('../lib/config');
const { Memory } = require('../lib/memory/records');
const improve = require('../lib/memory/improve');
const { isId } = require('../lib/util');

const BIN = path.join(__dirname, '..', 'bin', 'eccode.js');
const { tmpProject, write, expectCode, ARCH_MD } = H;

/** The CLI with no TTY (stdin closed). `suite: true` sets ECCODE_TEST=1, the test suite's path; otherwise the variable is absent. */
function cli(dir, args, { suite = false, env = {} } = {}) {
  const e = { ...process.env };
  for (const k of ['ECCODE_TEST', 'ECCODE_NOW', 'ECCODE_ACTOR']) delete e[k];
  Object.assign(e, env);
  if (suite) e.ECCODE_TEST = '1';
  return spawnSync(process.execPath, [BIN, '--root', dir, ...args], { encoding: 'utf8', env: e, stdio: ['ignore', 'pipe', 'pipe'] });
}

function events(dir) {
  return new Store(dir).readEvents();
}

/** An approval that already names the criteria the gate will require: AC1 for documents, phase:<id> and task:<id> for phases. */
function approval(ids, refs) {
  return { decision: 'approve', summary: 'Every required criterion checked against the submitted work.', criteria: ids.map((id) => ({ id, description: `criterion ${id}`, met: true, evidence: refs })), findings: [] };
}

/** Two rejections (maxReviewIterations=2) escalate the architecture gate; `round` keeps finding ids and artifact revisions distinct. */
function escalate(ctx, round = 1) {
  const { dir, store, config } = ctx;
  if (store.state().gates.architecture.status === 'pending') gates.startGate(store, config, 'architecture', 'orchestrator');
  write(dir, '.eccode/artifacts/brief.md', `${ARCH_MD}\nrev ${round}a\n`);
  gates.submit(store, config, 'architecture', 'product-architect', { artifacts: ['.eccode/artifacts/brief.md'] });
  const { event } = gates.recordReview(store, config, 'architecture', 'architecture-reviewer', H.rejection(`F${round}a`));
  write(dir, '.eccode/artifacts/brief.md', `${ARCH_MD}\nrev ${round}b\n`);
  gates.submit(store, config, 'architecture', 'product-architect', { artifacts: ['.eccode/artifacts/brief.md'], respondsTo: event.data.reviewId });
  gates.recordReview(store, config, 'architecture', 'architecture-reviewer', H.rejection(`F${round}b`));
  assert.strictEqual(store.state().gates.architecture.status, 'escalated');
  return ctx;
}

function escalatedProject() {
  return escalate(tmpProject({ configOverrides: { limits: { maxReviewIterations: 2 } } }));
}

/** A task that failed twice with maxTaskRetries=1 is escalated. */
function escalatedTask() {
  const ctx = tmpProject({ configOverrides: { limits: { maxTaskRetries: 1 } } });
  H.approveThroughPlan(ctx);
  gates.startGate(ctx.store, ctx.config, 'phase:core', 'orchestrator');
  for (const attempt of [1, 2]) {
    tasks.claim(ctx.store, ctx.config, 'api', 'backend-engineer');
    tasks.fail(ctx.store, ctx.config, 'api', 'backend-engineer', `attempt ${attempt} failed`);
  }
  assert.strictEqual(ctx.store.state().tasks.api.status, 'escalated');
  return ctx;
}

/** A change-profile project with its plan approved, so reworks can be opened. */
function changeProject(configOverrides) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eccode-f5-'));
  require('child_process').execFileSync('git', ['init', '-q'], { cwd: dir });
  require('child_process').execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init'], { cwd: dir });
  const store = init(dir, { name: 'Fix totals', idea: 'Invoice totals are wrong when a shipping fee is present', profile: 'change' });
  if (configOverrides) {
    const file = path.join(dir, '.eccode', 'config.json');
    const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
    for (const [k, v] of Object.entries(configOverrides)) cfg[k] = { ...cfg[k], ...v };
    fs.writeFileSync(file, JSON.stringify(cfg, null, 2));
  }
  const config = loadConfig(dir);
  gates.startGate(store, config, 'plan', 'orchestrator');
  write(dir, '.eccode/artifacts/plan.json', JSON.stringify(H.samplePlan(), null, 2));
  gates.submit(store, config, 'plan', 'delivery-lead', { artifacts: ['.eccode/artifacts/plan.json'] });
  gates.recordReview(store, config, 'plan', 'technical-reviewer', approval(['phase:core'], ['artifact:.eccode/artifacts/plan.json']));
  return { dir, store, config };
}

/** Open a rework as the orchestrator and take it through claim, handoff, submission and independent approval. */
function finishRework(ctx, base) {
  const { dir, store, config } = ctx;
  const rw = rework.openRework(store, config, 'orchestrator', base);
  tasks.claim(store, config, rw.task, 'backend-engineer');
  write(dir, 'src/server/a.js', `// ${rw.id}\n`);
  tasks.complete(store, config, rw.task, 'backend-engineer', H.handoffFor(rw.task, 'backend-engineer', [H.passCheck(store, 'backend-engineer').id], ['src/server/a.js']));
  gates.submit(store, config, rw.gate, 'delivery-lead');
  const check = H.passCheck(store, 'technical-reviewer');
  gates.recordReview(store, config, rw.gate, 'technical-reviewer', approval([rw.gate, `task:${rw.task}`], [`ev:${check.id}`]));
  return rw;
}

/** A project whose only allowed rework (maxReworks=1) is already used, so the next one needs the user. */
function reworkAtCap() {
  const ctx = changeProject({ limits: { maxReworks: 1 } });
  const base = { reason: 'QA found a defect after the review', files: ['src/**'], owner: 'backend-engineer' };
  finishRework(ctx, base);
  return { ...ctx, base };
}

/** events.jsonl rolled back behind state.json (e.g. `git checkout -- .eccode/events.jsonl`). */
function rolledBack() {
  const ctx = tmpProject();
  const log = path.join(ctx.dir, '.eccode/events.jsonl');
  runs.recordRisk(ctx.store, 'product-architect', { id: 'R1', title: 'a', severity: 'low' });
  const older = fs.readFileSync(log, 'utf8');
  runs.recordRisk(ctx.store, 'product-architect', { id: 'R2', title: 'b', severity: 'low' });
  fs.writeFileSync(log, older);
  return ctx;
}

/** An approved improvement proposal (the memory.test.js flow), ready for adoption. */
function approvedProposal() {
  process.env.ECCODE_SHARED_MEMORY = fs.mkdtempSync(path.join(os.tmpdir(), 'eccode-f5-shared-'));
  const ctx = tmpProject();
  const mem = new Memory(ctx.store, ctx.config);
  write(ctx.dir, 'check.js', 'process.exit(require("fs").existsSync("fixed") ? 0 : 1)\n');
  const repro = evidence.runCommand(ctx.store, 'learning-debugger', { label: 'repro', command: 'node check.js', purpose: 'reproduction' });
  write(ctx.dir, 'fixed', 'yes');
  const fix = evidence.runCommand(ctx.store, 'learning-debugger', { label: 'fix verified', command: 'node check.js' });
  const l = mem.add('learning-debugger', {
    layer: 'debugging',
    content: {
      title: 'JSON body parse fails on missing content-type',
      problem: 'POST /api/triage returned 500 when clients omitted the Content-Type header.',
      symptoms: ['HTTP 500 on POST without content-type'],
      component: 'api/server',
      environment: { node: '>=18' },
      fingerprint: 'api-json-parse-500',
      reproduction: { steps: ['POST without header'], evidence: [`ev:${repro.id}`] },
      rootCause: { explanation: 'The handler parsed the body unconditionally.', evidence: [`ev:${repro.id}`] },
      failedAttempts: [{ approach: 'Wrap only JSON.parse in try/catch', whyFailed: 'Empty bodies still crashed downstream' }],
      solution: { description: 'Validate content-type and parse defensively.', tradeoffs: 'Rejects lenient clients.' },
      verification: { evidence: [`ev:${fix.id}`], regressionTest: 'node check.js' },
      sources: [{ title: 'Node.js JSON.parse docs', url: 'https://nodejs.org/api/', checkedAt: '2026-10-07' }],
      appliesWhen: ['Node HTTP handlers parsing JSON request bodies'],
      notApplicableWhen: ['Frameworks that already enforce content-type'],
      confidence: 'high',
      tags: ['json', 'http', '500'],
    },
  });
  mem.review(l.id, 'technical-reviewer', { decision: 'verify', notes: 'Re-ran the failing check after the fix: passes.' });
  write(ctx.dir, 'skills/checklist.md', '# Review checklist\n- tests pass\n');
  write(ctx.dir, 'eval.js', 'const t=require("fs").readFileSync("skills/checklist.md","utf8");const cases=[/tests pass/.test(t),/content-type/i.test(t)];console.log("ECCODE_EVAL "+JSON.stringify({passed:cases.filter(Boolean).length,total:cases.length}));\n');
  const prop = improve.propose(ctx.store, ctx.config, mem, 'learning-debugger', {
    title: 'Add content-type check to review checklist',
    observation: 'Two reviews missed missing content-type validation.',
    lessons: [l.id],
    target: 'skills/checklist.md',
    change: { type: 'append', content: '- request content-type validated before parsing\n' },
    rationale: 'Lesson shows 500s from unvalidated bodies.',
    evaluation: { command: 'node eval.js', cases: 'checklist coverage cases' },
  });
  improve.evaluate(ctx.store, 'learning-debugger', prop.id, 'baseline');
  improve.evaluate(ctx.store, 'learning-debugger', prop.id, 'candidate');
  improve.review(ctx.store, 'technical-reviewer', prop.id, 'approve', 'Candidate passes 2/2 vs 1/2 baseline; change is additive.');
  return { ...ctx, prop };
}

function grant(ctx, fields) {
  return authority.grant(ctx.store, 'user', { to: 'orchestrator', reason: 'The user decided this in the conversation', ...fields });
}

/** Both ways forward must be in every refusal: the user's own command and the grant that would delegate it. */
function assertNamesBothCommands(err, userCommand, action, target) {
  assert.strictEqual(err.code, 'USER_AUTH_REQUIRED');
  assert.ok(err.message.includes(userCommand), `user command missing from: ${err.message}`);
  assert.ok(err.message.includes(`eccode delegate grant --actor user --to orchestrator --action ${action}${target ? ` --target ${target}` : ''}`), `grant command missing from: ${err.message}`);
  assert.match(err.message, /--delegation <id>/);
}

// --------------------------------------------------------------------------- the CLI: a person at a terminal

test('F5 the CLI refuses --actor user without a terminal (USER_AUTH_REQUIRED) and appends nothing', () => {
  const ctx = escalatedProject();
  const before = events(ctx.dir).length;
  let res = cli(ctx.dir, ['gate', 'reopen', 'architecture', '--actor', 'user', '--resolution', 'operator says so, proceed']);
  assert.strictEqual(res.status, 2, res.stdout + res.stderr);
  assert.match(res.stderr, /\[USER_AUTH_REQUIRED\] --actor user needs a person at a terminal/);
  assert.match(res.stderr, /run this command yourself in a terminal/);
  assert.match(res.stderr, /eccode delegate grant --actor user --to orchestrator --action gate.reopen --target architecture/);
  assert.match(res.stderr, /--delegation <id>/);
  assert.strictEqual(events(ctx.dir).length, before, 'nothing appended');
  assert.strictEqual(ctx.store.state().gates.architecture.status, 'escalated');
  // The ambient actor is the same string from the same place.
  res = cli(ctx.dir, ['gate', 'reopen', 'architecture', '--resolution', 'operator says so, proceed'], { env: { ECCODE_ACTOR: 'user' } });
  assert.strictEqual(res.status, 2, res.stdout + res.stderr);
  assert.match(res.stderr, /USER_AUTH_REQUIRED/);
  // Every other reserved command is refused the same way, before anything runs.
  for (const args of [
    ['risk', 'update', '--id', 'R1', '--status', 'accepted', '--actor', 'user'],
    ['rework', 'open', '--actor', 'user', '--reason', 'defect found after delivery', '--files', 'src/**', '--owner', 'backend-engineer'],
    ['task', 'reset', 'api', '--actor', 'user', '--reason', 're-scope the task'],
    ['rebuild', '--force', '--actor', 'user'],
    ['improve', 'adopt', 'imp-abc-00abcdef', '--actor', 'user'],
    ['decision', 'add', '--title', 't', '--decision', 'd', '--rationale', 'r', '--actor', 'user'],
    ['delegate', 'grant', '--actor', 'user', '--to', 'orchestrator', '--action', 'gate.reopen', '--reason', 'the user said so'],
  ]) {
    res = cli(ctx.dir, args);
    assert.strictEqual(res.status, 2, `${args.join(' ')}: ${res.stdout}${res.stderr}`);
    assert.match(res.stderr, /USER_AUTH_REQUIRED/, args.join(' '));
  }
  assert.strictEqual(events(ctx.dir).length, before, 'nothing appended');
  // Read-only commands do not need the confirmation, so an exported ECCODE_ACTOR=user still allows `eccode status`.
  res = cli(ctx.dir, ['status', '--brief'], { env: { ECCODE_ACTOR: 'user' } });
  assert.strictEqual(res.status, 0, res.stderr);
});

test("F5 ECCODE_TEST=1 is the suite's path: --actor user works without a terminal and is recorded as the user", () => {
  const ctx = escalatedProject();
  const res = cli(ctx.dir, ['gate', 'reopen', 'architecture', '--actor', 'user', '--resolution', 'User accepted the narrower scope'], { suite: true });
  assert.strictEqual(res.status, 0, res.stderr);
  assert.strictEqual(ctx.store.state().gates.architecture.status, 'in_progress');
  const last = events(ctx.dir).pop();
  assert.strictEqual(last.type, 'gate.reopened');
  assert.strictEqual(last.actor, 'user');
  assert.strictEqual(last.data.onBehalfOf, undefined, 'a direct user decision carries no delegation data');
  assert.strictEqual(last.data.delegation, undefined);
});

const hasScript = process.platform === 'linux' && /util-linux/.test((spawnSync('script', ['--version'], { encoding: 'utf8' }).stdout || ''));

test('F5 a person at a terminal sees what will be recorded and confirms with yes; anything else is refused', { skip: hasScript ? false : 'needs util-linux script to allocate a pty' }, () => {
  const ctx = escalatedProject();
  const q = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;
  const command = `${q(process.execPath)} ${q(BIN)} --root ${q(ctx.dir)} gate reopen architecture --actor user --resolution ${q('User accepted the narrower scope')}`;
  const env = { ...process.env };
  for (const k of ['ECCODE_TEST', 'ECCODE_NOW', 'ECCODE_ACTOR']) delete env[k];
  const atTerminal = (answer) => spawnSync('script', ['-qec', command, '/dev/null'], { input: `${answer}\n`, encoding: 'utf8', env });
  let res = atTerminal('no');
  assert.notStrictEqual(res.status, 0, res.stdout);
  assert.match(res.stdout, /About to record as the user: gate reopen architecture/);
  assert.match(res.stdout, /User accepted the narrower scope/);
  assert.match(res.stdout, /USER_AUTH_REQUIRED/);
  assert.strictEqual(ctx.store.state().gates.architecture.status, 'escalated');
  res = atTerminal('yes');
  assert.strictEqual(res.status, 0, res.stdout);
  assert.strictEqual(ctx.store.state().gates.architecture.status, 'in_progress');
  const last = events(ctx.dir).pop();
  assert.strictEqual(last.type, 'gate.reopened');
  assert.strictEqual(last.actor, 'user');
  assert.strictEqual(last.data.onBehalfOf, undefined);
});

// --------------------------------------------------------------------------- delegations

test('F5 a delegation lets the orchestrator reopen once: the event carries onBehalfOf and the delegation, delegation.used is appended, the second use is refused as exhausted', () => {
  const ctx = escalatedProject();
  let res = cli(ctx.dir, ['delegate', 'grant', '--actor', 'user', '--to', 'orchestrator', '--action', 'gate.reopen', '--target', 'architecture', '--reason', 'User decided: proceed with the narrower scope', '--json'], { suite: true });
  assert.strictEqual(res.status, 0, res.stderr);
  const granted = JSON.parse(res.stdout);
  assert.ok(isId('dlg', granted.id), granted.id);
  assert.deepStrictEqual([granted.to, granted.action, granted.target, granted.uses], ['orchestrator', 'gate.reopen', 'architecture', 1]);
  assert.ok(Date.parse(granted.expiresAt) > Date.now());
  const grantEvent = events(ctx.dir).pop();
  assert.strictEqual(grantEvent.type, 'delegation.granted');
  assert.strictEqual(grantEvent.actor, 'user');
  assert.strictEqual(ctx.store.state().delegations[granted.id].status, 'active');

  // The orchestrator acts with the delegation: no TTY, no ECCODE_TEST.
  res = cli(ctx.dir, ['gate', 'reopen', 'architecture', '--actor', 'orchestrator', '--delegation', granted.id, '--resolution', 'User decided: proceed with the narrower scope']);
  assert.strictEqual(res.status, 0, res.stderr);
  assert.match(res.stdout, /on the user's behalf/);
  const st = ctx.store.state();
  assert.strictEqual(st.gates.architecture.status, 'in_progress');
  const [used, reopened] = events(ctx.dir).slice(-2);
  assert.strictEqual(used.type, 'delegation.used');
  assert.strictEqual(used.actor, 'orchestrator');
  assert.deepStrictEqual(used.data, { id: granted.id, action: 'gate.reopen', target: 'architecture', by: 'orchestrator' });
  assert.strictEqual(reopened.type, 'gate.reopened');
  assert.strictEqual(reopened.actor, 'orchestrator');
  assert.strictEqual(reopened.data.onBehalfOf, 'user');
  assert.strictEqual(reopened.data.delegation, granted.id);
  assert.strictEqual(st.delegations[granted.id].used, 1);
  assert.strictEqual(st.delegations[granted.id].status, 'exhausted');
  res = cli(ctx.dir, ['delegate', 'list', '--json']);
  assert.strictEqual(JSON.parse(res.stdout)[0].status, 'exhausted');
  res = cli(ctx.dir, ['delegate', 'list']);
  assert.match(res.stdout, new RegExp(`${granted.id} \\[exhausted\\]`));

  // The same delegation cannot be spent again (the gate escalates once more; the use is gone).
  escalate(ctx, 2);
  const before = events(ctx.dir).length;
  res = cli(ctx.dir, ['gate', 'reopen', 'architecture', '--actor', 'orchestrator', '--delegation', granted.id, '--resolution', 'trying the same delegation again']);
  assert.strictEqual(res.status, 2, res.stdout);
  assert.match(res.stderr, /USER_AUTH_REQUIRED/);
  assert.match(res.stderr, /exhausted \(1 of 1 uses spent\)/);
  assert.strictEqual(events(ctx.dir).length, before, 'a refused use spends nothing');
  assert.strictEqual(ctx.store.state().gates.architecture.status, 'escalated');
  // The user acts directly and never passes a delegation.
  res = cli(ctx.dir, ['gate', 'reopen', 'architecture', '--actor', 'user', '--delegation', granted.id, '--resolution', 'the user does not delegate to itself'], { suite: true });
  assert.strictEqual(res.status, 2);
  assert.match(res.stderr, /INVALID_INPUT/);
  assert.strictEqual(ctx.store.audit().ok, true, JSON.stringify(ctx.store.audit().errors));
});

test('F5 a delegation is bound to its action and its target; a delegation without a target covers any target of that action', () => {
  const ctx = escalatedProject();
  const d = grant(ctx, { action: 'gate.reopen', target: 'design' });
  const before = events(ctx.dir).length;
  let err = expectCode(() => gates.reopenGate(ctx.store, 'architecture', 'orchestrator', 'wrong gate for this delegation', { delegation: d.id }), 'USER_AUTH_REQUIRED');
  assert.match(err.message, /is for target design, not architecture/);
  err = expectCode(() => runs.recordRisk(ctx.store, 'orchestrator', { id: 'R1', title: 'x', severity: 'low', status: 'accepted', delegation: d.id }), 'USER_AUTH_REQUIRED');
  assert.match(err.message, /allows gate.reopen, not risk.accept/);
  assert.strictEqual(events(ctx.dir).length, before, 'refused uses spend nothing');
  assert.strictEqual(ctx.store.state().delegations[d.id].used, 0);
  // Unknown ids are refused before anything else.
  err = expectCode(() => gates.reopenGate(ctx.store, 'architecture', 'orchestrator', 'a delegation that does not exist', { delegation: 'dlg-aaaaaaaa-00aaaaaa' }), 'USER_AUTH_REQUIRED');
  assert.match(err.message, /No delegation dlg-aaaaaaaa-00aaaaaa/);
  expectCode(() => gates.reopenGate(ctx.store, 'architecture', 'orchestrator', 'a malformed delegation id', { delegation: '../x' }), 'INVALID_INPUT');

  const any = grant(ctx, { action: 'gate.reopen' });
  assert.strictEqual(any.target, null);
  const { event } = gates.reopenGate(ctx.store, 'architecture', 'orchestrator', 'User decided: proceed with the narrower scope', { delegation: any.id });
  assert.strictEqual(event.data.delegation, any.id);
  assert.strictEqual(ctx.store.state().delegations[any.id].status, 'exhausted');
  assert.strictEqual(ctx.store.state().delegations[d.id].status, 'active', 'the other delegation is untouched');
});

test('F5 an expired delegation is refused (clock pinned with ECCODE_NOW + ECCODE_TEST)', () => {
  const saved = { test: process.env.ECCODE_TEST, now: process.env.ECCODE_NOW };
  const t0 = Date.now() + 1000;
  try {
    process.env.ECCODE_TEST = '1';
    process.env.ECCODE_NOW = new Date(t0).toISOString();
    const ctx = escalatedProject();
    const d = grant(ctx, { action: 'gate.reopen', target: 'architecture', expires: 10 });
    assert.strictEqual(d.expiresAt, new Date(t0 + 10 * 60000).toISOString());
    assert.strictEqual(authority.list(ctx.store.state())[0].status, 'active');
    process.env.ECCODE_NOW = new Date(t0 + 11 * 60000).toISOString();
    assert.strictEqual(authority.list(ctx.store.state())[0].status, 'expired');
    const err = expectCode(() => gates.reopenGate(ctx.store, 'architecture', 'orchestrator', 'too late for this delegation', { delegation: d.id }), 'USER_AUTH_REQUIRED');
    assert.match(err.message, /expired at/);
    assert.strictEqual(ctx.store.state().gates.architecture.status, 'escalated');
    assert.strictEqual(ctx.store.state().delegations[d.id].used, 0);
    // The default expiry is four hours.
    const fresh = grant(ctx, { action: 'gate.reopen' });
    assert.strictEqual(fresh.expiresAt, new Date(t0 + 11 * 60000 + 240 * 60000).toISOString());
  } finally {
    for (const [k, v] of [['ECCODE_TEST', saved.test], ['ECCODE_NOW', saved.now]]) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

test('F5 a revoked delegation is refused; only the user revokes', () => {
  const ctx = escalatedProject();
  const d = grant(ctx, { action: 'gate.reopen', target: 'architecture' });
  expectCode(() => authority.revoke(ctx.store, 'orchestrator', d.id, 'an agent cannot revoke'), 'USER_AUTH_REQUIRED');
  const res = cli(ctx.dir, ['delegate', 'revoke', d.id, '--actor', 'user', '--reason', 'User changed their mind'], { suite: true });
  assert.strictEqual(res.status, 0, res.stderr);
  const last = events(ctx.dir).pop();
  assert.strictEqual(last.type, 'delegation.revoked');
  assert.strictEqual(last.actor, 'user');
  assert.strictEqual(ctx.store.state().delegations[d.id].status, 'revoked');
  const err = expectCode(() => gates.reopenGate(ctx.store, 'architecture', 'orchestrator', 'using a revoked delegation', { delegation: d.id }), 'USER_AUTH_REQUIRED');
  assert.match(err.message, /is revoked \(User changed their mind\)/);
  assert.strictEqual(ctx.store.state().gates.architecture.status, 'escalated');
  expectCode(() => authority.revoke(ctx.store, 'user', d.id, 'twice'), 'INVALID_TRANSITION');
  expectCode(() => authority.revoke(ctx.store, 'user', 'dlg-aaaaaaaa-00aaaaaa', 'unknown'), 'NOT_FOUND');
});

test('F5 a delegation granted to the orchestrator cannot be spent by a subagent role', () => {
  const ctx = escalatedProject();
  const d = grant(ctx, { action: 'gate.reopen', target: 'architecture' });
  const err = expectCode(() => gates.reopenGate(ctx.store, 'architecture', 'technical-reviewer', 'a reviewer trying the orchestrator delegation', { delegation: d.id }), 'USER_AUTH_REQUIRED');
  assert.match(err.message, /was granted to orchestrator, not technical-reviewer/);
  assert.strictEqual(ctx.store.state().delegations[d.id].used, 0);
  const res = cli(ctx.dir, ['gate', 'reopen', 'architecture', '--actor', 'technical-reviewer', '--delegation', d.id, '--resolution', 'a reviewer trying the orchestrator delegation']);
  assert.strictEqual(res.status, 2);
  assert.match(res.stderr, /granted to orchestrator, not technical-reviewer/);
});

test('F5 the reducer counts uses: two uses, then exhausted; delegations appear in the snapshot only once granted', () => {
  assert.strictEqual(tmpProject().store.state().delegations, undefined, 'created lazily, never in initialState');
  const ctx = escalatedProject();
  const d = grant(ctx, { action: 'gate.reopen', uses: 2 });
  gates.reopenGate(ctx.store, 'architecture', 'orchestrator', 'User decided: first reopen', { delegation: d.id });
  let dl = ctx.store.state().delegations[d.id];
  assert.deepStrictEqual([dl.used, dl.status], [1, 'active']);
  escalate(ctx, 2);
  gates.reopenGate(ctx.store, 'architecture', 'orchestrator', 'User decided: second reopen', { delegation: d.id });
  dl = ctx.store.state().delegations[d.id];
  assert.deepStrictEqual([dl.used, dl.status], [2, 'exhausted']);
  assert.strictEqual(dl.history.length, 2);
  escalate(ctx, 3);
  expectCode(() => gates.reopenGate(ctx.store, 'architecture', 'orchestrator', 'User decided: third reopen', { delegation: d.id }), 'USER_AUTH_REQUIRED');
  assert.deepStrictEqual(ctx.store.rebuild(), ctx.store.state(), 'snapshot equals replay');
  assert.strictEqual(ctx.store.audit().ok, true);
});

test('F5 delegate grant is validated and is the user\'s alone: no chains, bounded uses and expiry, targets only where they mean something', () => {
  const ctx = tmpProject();
  expectCode(() => authority.grant(ctx.store, 'orchestrator', { to: 'orchestrator', action: 'gate.reopen', reason: 'an agent minting its own authority' }), 'USER_AUTH_REQUIRED');
  const bad = (fields, code = 'INVALID_INPUT') => expectCode(() => grant(ctx, fields), code);
  bad({ action: 'delegate.grant' });
  bad({ action: 'gate.reopen', to: 'user' });
  bad({ action: 'gate.reopen', to: 'Orchestrator; rm -rf' });
  bad({ action: 'rebuild.force', target: 'x' });
  bad({ action: 'decision.record', target: 'x' });
  bad({ action: 'gate.reopen', uses: 0 });
  bad({ action: 'gate.reopen', uses: 1.5 });
  bad({ action: 'gate.reopen', uses: 101 });
  bad({ action: 'gate.reopen', expires: 0 });
  bad({ action: 'gate.reopen', expires: 10081 });
  bad({ action: 'gate.reopen', reason: 'short' });
  bad({ action: 'gate.reopen', target: '../x' });
  assert.strictEqual(ctx.store.state().delegations, undefined, 'nothing was granted');
  const ok = grant(ctx, { action: 'limits.raise', target: 'maxCostUsd', uses: 3, expires: 60 });
  assert.deepStrictEqual([ok.to, ok.action, ok.target, ok.uses], ['orchestrator', 'limits.raise', 'maxCostUsd', 3]);
  const res = cli(ctx.dir, ['delegate', 'grant', '--actor', 'orchestrator', '--to', 'orchestrator', '--action', 'gate.reopen', '--reason', 'an agent minting its own authority']);
  assert.strictEqual(res.status, 2);
  assert.match(res.stderr, /USER_AUTH_REQUIRED/);
});

// --------------------------------------------------------------------------- every reserved function

test('F5 reopenGate refuses the orchestrator without a delegation, naming both commands', () => {
  const ctx = escalatedProject();
  const err = expectCode(() => gates.reopenGate(ctx.store, 'architecture', 'orchestrator', 'Proceed with narrower scope'), 'USER_AUTH_REQUIRED');
  assertNamesBothCommands(err, 'eccode gate reopen architecture --actor user --resolution', 'gate.reopen', 'architecture');
  // The gate's own rules come first, so a refused action never spends a delegation.
  expectCode(() => gates.reopenGate(ctx.store, 'design', 'orchestrator', 'this gate is not escalated'), 'INVALID_TRANSITION');
});

test('F5 risk accept refuses the orchestrator without a delegation and works with one; other statuses never need the user', () => {
  const ctx = tmpProject();
  runs.recordRisk(ctx.store, 'product-architect', { id: 'R1', title: 'Prompt injection', severity: 'critical' });
  const err = expectCode(() => runs.recordRisk(ctx.store, 'orchestrator', { id: 'R1', status: 'accepted' }), 'USER_AUTH_REQUIRED');
  assertNamesBothCommands(err, 'eccode risk update --id R1 --status accepted --actor user', 'risk.accept', 'R1');
  assert.strictEqual(ctx.store.state().risks.R1.status, 'open');
  runs.recordRisk(ctx.store, 'orchestrator', { id: 'R1', status: 'mitigated' });
  const d = grant(ctx, { action: 'risk.accept', target: 'R1' });
  const res = cli(ctx.dir, ['risk', 'update', '--id', 'R1', '--status', 'accepted', '--actor', 'orchestrator', '--delegation', d.id]);
  assert.strictEqual(res.status, 0, res.stderr);
  const r = ctx.store.state().risks.R1;
  assert.deepStrictEqual([r.status, r.title, r.onBehalfOf, r.delegation, r.updatedBy], ['accepted', 'Prompt injection', 'user', d.id, 'orchestrator']);
  assert.strictEqual(events(ctx.dir).slice(-2)[0].type, 'delegation.used');
});

test('F5 a rework past the cap refuses the orchestrator without a delegation and opens with one', () => {
  const ctx = reworkAtCap();
  const err = expectCode(() => rework.openRework(ctx.store, ctx.config, 'orchestrator', ctx.base), 'USER_AUTH_REQUIRED');
  assert.match(err.message, /1 rework\(s\) already opened \(limits.maxReworks=1\)/);
  assertNamesBothCommands(err, 'eccode rework open --actor user --reason', 'rework.open', 'rework-2');
  const d = grant(ctx, { action: 'rework.open', target: 'rework-2' });
  const rw = rework.openRework(ctx.store, ctx.config, 'orchestrator', { ...ctx.base, delegation: d.id });
  assert.strictEqual(rw.id, 'rework-2');
  assert.strictEqual(rw.event.data.onBehalfOf, 'user');
  assert.strictEqual(rw.event.data.delegation, d.id);
  assert.strictEqual(ctx.store.state().reworks[1].openedBy, 'orchestrator');
  assert.strictEqual(ctx.store.state().delegations[d.id].status, 'exhausted');
});

test('F5 a rework under the cap needs nobody, and the user still opens one directly past the cap', () => {
  const ctx = changeProject({ limits: { maxReworks: 2 } });
  const base = { reason: 'QA found a defect after the review', files: ['src/**'], owner: 'backend-engineer' };
  const first = finishRework(ctx, base);
  assert.strictEqual(first.event.data.onBehalfOf, undefined);
  finishRework(ctx, base);
  const rw = rework.openRework(ctx.store, ctx.config, 'user', base);
  assert.strictEqual(rw.id, 'rework-3');
  assert.strictEqual(rw.event.actor, 'user');
});

test('F5 task reset of an escalated task refuses the orchestrator without a delegation and works with one', () => {
  const ctx = escalatedTask();
  const err = expectCode(() => tasks.reset(ctx.store, 'api', 'orchestrator', 're-scope the task'), 'USER_AUTH_REQUIRED');
  assertNamesBothCommands(err, 'eccode task reset api --actor user --reason', 'task.reset', 'api');
  const d = grant(ctx, { action: 'task.reset', target: 'api' });
  const res = cli(ctx.dir, ['task', 'reset', 'api', '--actor', 'orchestrator', '--delegation', d.id, '--reason', 'User re-scoped the task']);
  assert.strictEqual(res.status, 0, res.stderr);
  assert.strictEqual(ctx.store.state().tasks.api.status, 'pending');
  const last = events(ctx.dir).pop();
  assert.deepStrictEqual([last.type, last.actor, last.data.onBehalfOf, last.data.delegation], ['task.reset', 'orchestrator', 'user', d.id]);
});

test('F5 rebuild --force on a rolled-back log refuses the orchestrator without a delegation and works with one', () => {
  let ctx = rolledBack();
  let err = expectCode(() => ctx.store.rebuildSnapshot({ force: true, actor: 'orchestrator' }), 'USER_AUTH_REQUIRED');
  assertNamesBothCommands(err, 'eccode rebuild --force --actor user', 'rebuild.force', null);
  let res = cli(ctx.dir, ['rebuild', '--force', '--actor', 'orchestrator']);
  assert.strictEqual(res.status, 2);
  assert.match(res.stderr, /USER_AUTH_REQUIRED/);
  // A delegation granted before the rollback survives in the shorter log and can be spent on accepting it.
  ctx = tmpProject();
  const d = grant(ctx, { action: 'rebuild.force' });
  const log = path.join(ctx.dir, '.eccode/events.jsonl');
  const older = fs.readFileSync(log, 'utf8');
  runs.recordRisk(ctx.store, 'product-architect', { id: 'R2', title: 'b', severity: 'low' });
  fs.writeFileSync(log, older);
  expectCode(() => ctx.store.state(), 'LOG_ROLLBACK');
  err = expectCode(() => ctx.store.rebuildSnapshot({ force: true, actor: 'orchestrator', delegation: 'dlg-aaaaaaaa-00aaaaaa' }), 'USER_AUTH_REQUIRED');
  assert.match(err.message, /No delegation/);
  expectCode(() => ctx.store.state(), 'LOG_ROLLBACK', 'a refused acceptance leaves the record as it was');
  res = cli(ctx.dir, ['rebuild', '--force', '--actor', 'orchestrator', '--delegation', d.id]);
  assert.strictEqual(res.status, 0, res.stderr);
  const [used, accepted] = events(ctx.dir).slice(-2);
  assert.strictEqual(used.type, 'delegation.used');
  assert.strictEqual(accepted.type, 'record.rollback_accepted');
  assert.deepStrictEqual([accepted.actor, accepted.data.onBehalfOf, accepted.data.delegation], ['orchestrator', 'user', d.id]);
  assert.strictEqual(ctx.store.state().delegations[d.id].status, 'exhausted');
  assert.strictEqual(ctx.store.audit().ok, true, JSON.stringify(ctx.store.audit().errors));
});

test('F5 improve adopt refuses the orchestrator without a delegation and works with one', () => {
  const ctx = approvedProposal();
  const err = expectCode(() => improve.adopt(ctx.store, ctx.config, 'orchestrator', ctx.prop.id), 'USER_AUTH_REQUIRED');
  assertNamesBothCommands(err, `eccode improve adopt ${ctx.prop.id} --actor user`, 'improve.adopt', ctx.prop.id);
  const d = grant(ctx, { action: 'improve.adopt', target: ctx.prop.id });
  const res = cli(ctx.dir, ['improve', 'adopt', ctx.prop.id, '--actor', 'orchestrator', '--delegation', d.id, '--json']);
  assert.strictEqual(res.status, 0, res.stderr);
  const prop = JSON.parse(res.stdout);
  assert.deepStrictEqual([prop.status, prop.adoptedBy, prop.onBehalfOf, prop.delegation], ['adopted', 'orchestrator', 'user', d.id]);
  assert.match(fs.readFileSync(path.join(ctx.dir, 'skills/checklist.md'), 'utf8'), /content-type/);
  const last = events(ctx.dir).pop();
  assert.deepStrictEqual([last.type, last.data.onBehalfOf, last.data.delegation], ['improvement.adopted', 'user', d.id]);
});

test("F5 a decision recorded as the user's refuses the orchestrator without a delegation; with one it carries onBehalfOf; the orchestrator's own decisions are unchanged", () => {
  const ctx = tmpProject();
  const fields = { title: 'Drop websockets from v1', decision: 'Polling only in v1', rationale: 'The user decided scope in the conversation' };
  const err = expectCode(() => runs.recordDecision(ctx.store, 'orchestrator', { ...fields, onBehalfOf: 'user' }), 'USER_AUTH_REQUIRED');
  assertNamesBothCommands(err, 'eccode decision add --title "<t>" --decision "<d>" --rationale "<r>" --actor user', 'decision.record', null);
  expectCode(() => runs.recordDecision(ctx.store, 'orchestrator', { ...fields, onBehalfOf: 'orchestrator' }), 'INVALID_INPUT');
  const own = runs.recordDecision(ctx.store, 'orchestrator', fields);
  assert.strictEqual(ctx.store.state().decisions[own].onBehalfOf, undefined);
  const d = grant(ctx, { action: 'decision.record' });
  const res = cli(ctx.dir, ['decision', 'add', '--title', fields.title, '--decision', fields.decision, '--rationale', fields.rationale, '--actor', 'orchestrator', '--delegation', d.id, '--json']);
  assert.strictEqual(res.status, 0, res.stderr);
  const dec = ctx.store.state().decisions[JSON.parse(res.stdout).id];
  assert.deepStrictEqual([dec.by, dec.onBehalfOf, dec.delegation], ['orchestrator', 'user', d.id]);
  assert.strictEqual(ctx.store.state().delegations[d.id].status, 'exhausted');
});
