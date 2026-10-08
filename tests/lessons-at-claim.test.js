'use strict';
// Verified lessons are not left to agent diligence: claiming a task retrieves
// the matching ones and completion requires a recorded decision on each.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const { init } = require('../lib/project');
const { loadConfig } = require('../lib/config');
const gates = require('../lib/gates');
const tasks = require('../lib/tasks');
const evidence = require('../lib/evidence');
const { Memory } = require('../lib/memory/records');
const { write, passCheck, handoffFor, approval, expectCode } = require('./helpers');

const BIN = path.join(__dirname, '..', 'bin', 'eccode.js');

/** A change-profile project with one task about money-moving POST endpoints and a verified idempotency lesson. */
function setup({ taskTitle = 'Issue store credit through a POST endpoint', idea = 'Support wants to issue store credit to customers through the API', criteria = ['A credit is issued and the balance changes', 'Invalid amounts are rejected'], learning = 'on' } = {}) {
  const shared = fs.mkdtempSync(path.join(os.tmpdir(), 'eccode-shared-'));
  process.env.ECCODE_SHARED_MEMORY = shared;
  process.env.ECCODE_LEARNING = learning;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eccode-lac-'));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init'], { cwd: dir });
  const store = init(dir, { name: 'Credits', idea, profile: 'change' });
  const config = loadConfig(dir);

  write(dir, 'check.js', 'process.exit(require("fs").existsSync("fixed") ? 0 : 1)\n');
  const repro = evidence.runCommand(store, 'learning-debugger', { label: 'repro', command: 'node check.js', purpose: 'reproduction' });
  write(dir, 'fixed', 'yes');
  const fix = evidence.runCommand(store, 'learning-debugger', { label: 'fix', command: 'node check.js' });
  const mem = new Memory(store, config);
  const lesson = mem.add('learning-debugger', { layer: 'debugging', content: {
    title: 'Money-moving POST endpoints (refunds, payouts, credits, charges) must honour the Idempotency-Key header',
    problem: 'A retried POST to a money endpoint issued a second credit because the handler ignored Idempotency-Key.',
    symptoms: ['repeating a POST with the same Idempotency-Key created a duplicate credit, refund, payout or charge'], component: 'POST endpoints that move money',
    environment: { node: '>=18' }, fingerprint: 'idempotency-key',
    reproduction: { steps: ['POST twice with one key'], evidence: [`ev:${repro.id}`] },
    rootCause: { explanation: 'Acme payments rule PAY-3: a POST endpoint that moves money honours the Idempotency-Key request header; a repeat returns the original status and body and creates nothing new.', evidence: [`ev:${repro.id}`] },
    failedAttempts: [{ approach: 'memo() the handler', whyFailed: 'memo caches per call, not per successful outcome' }],
    solution: { description: 'Store the first successful response per key and replay it for repeats.', tradeoffs: 'In-process store.' },
    verification: { evidence: [`ev:${fix.id}`], regressionTest: 'node check.js' }, sources: [],
    appliesWhen: ['Adding or changing a POST endpoint that moves money: refunds, payouts, credits, charges'], notApplicableWhen: ['Read-only endpoints', 'POST endpoints that do not move money'], confidence: 'high', tags: ['credit', 'refund', 'payout', 'idempotency'] } });
  mem.review(lesson.id, 'technical-reviewer', { decision: 'verify', notes: 'Re-ran the failing check after the fix: it passes.' });

  const plan = { phases: [{ id: 'core', name: 'Core', goal: 'Implement the requested change and its tests', acceptanceCriteria: ['The endpoint works', 'Existing tests pass'] }],
    tasks: [{ id: 'credits', phase: 'core', title: taskTitle, owner: 'backend-engineer', dependencies: [], inputs: ['TASK.md'], outputs: ['endpoint', 'tests'], files: ['src/**', 'test/**'], acceptanceCriteria: criteria, verification: { method: 'run the tests', command: 'node --test' } }] };
  gates.startGate(store, config, 'plan', 'orchestrator');
  write(dir, '.eccode/artifacts/plan.json', JSON.stringify(plan));
  gates.submit(store, config, 'plan', 'delivery-lead', { artifacts: ['.eccode/artifacts/plan.json'] });
  gates.recordReview(store, config, 'plan', 'technical-reviewer', approval([['artifact:.eccode/artifacts/plan.json']]));
  gates.startGate(store, config, 'phase:core', 'orchestrator');
  return { dir, store, config, lesson, mem };
}

function finish(ctx, decisions) {
  write(ctx.dir, 'src/credits.js', '// issue credit\n');
  const ev = passCheck(ctx.store, 'backend-engineer');
  const h = handoffFor('credits', 'backend-engineer', [ev.id], ['src/credits.js']);
  if (decisions) h.lessonDecisions = decisions;
  return tasks.complete(ctx.store, ctx.config, 'credits', 'backend-engineer', h);
}

test('claiming a task retrieves the matching verified lesson and records it on the claim', () => {
  const ctx = setup();
  const { event } = tasks.claim(ctx.store, ctx.config, 'credits', 'backend-engineer');
  assert.deepStrictEqual(event.data.lessons.map((l) => l.id), [ctx.lesson.id]);
  assert.strictEqual(ctx.store.state().tasks.credits.claim.lessons[0].id, ctx.lesson.id);
});

test('nothing is retrieved for an unrelated task, or when learning is off', () => {
  // Same lesson store, but the task text shares nothing with it.
  const unrelated = setup({ taskTitle: 'Rename the CSS class used by the sidebar', idea: 'Tidy the stylesheet of the dashboard', criteria: ['The sidebar renders with the new class', 'Visual regression screenshots are unchanged'] });
  const { event } = tasks.claim(unrelated.store, unrelated.config, 'credits', 'backend-engineer');
  assert.ok(!event.data.lessons || event.data.lessons.length === 0, JSON.stringify(event.data.lessons));
  const off = setup({ learning: 'off' });
  const e2 = tasks.claim(off.store, off.config, 'credits', 'backend-engineer').event;
  assert.ok(!e2.data.lessons || e2.data.lessons.length === 0);
  process.env.ECCODE_LEARNING = 'on';
});

test('completion needs a decision on every retrieved lesson; applied decisions are cited', () => {
  const ctx = setup();
  tasks.claim(ctx.store, ctx.config, 'credits', 'backend-engineer');
  const err = expectCode(() => finish(ctx), 'INVALID_HANDOFF');
  assert.match(err.message, new RegExp(ctx.lesson.id));
  assert.match(err.message, /lessonDecisions/);
  expectCode(() => finish(ctx, [{ id: ctx.lesson.id, decision: 'applied' }]), 'INVALID_HANDOFF'); // an applied lesson says how
  expectCode(() => finish(ctx, [{ id: ctx.lesson.id, decision: 'maybe', note: 'x'.repeat(40) }]), 'INVALID_HANDOFF');
  finish(ctx, [{ id: ctx.lesson.id, decision: 'applied', note: 'POST /credits replays the stored response for a repeated Idempotency-Key; regression test added.' }]);
  const st = ctx.store.state();
  assert.strictEqual(st.tasks.credits.status, 'done');
  assert.strictEqual(st.tasks.credits.lessonDecisions[0].decision, 'applied');
  assert.strictEqual(ctx.mem.get(ctx.lesson.id).citations.length, 1);
});

test('not-applicable needs an evidence-backed assessment or a substantive reason', () => {
  const ctx = setup();
  tasks.claim(ctx.store, ctx.config, 'credits', 'backend-engineer');
  expectCode(() => finish(ctx, [{ id: ctx.lesson.id, decision: 'not-applicable', note: 'does not fit' }]), 'INVALID_HANDOFF');
  // Evidence-backed: an experiment is recorded and the lesson is assessed against it.
  const probe = evidence.runCommand(ctx.store, 'backend-engineer', { label: 'endpoint only reads', command: 'node -e "process.exit(0)"' });
  ctx.mem.assess(ctx.lesson.id, 'backend-engineer', { verdict: 'does-not-apply', reason: 'The endpoint only reads data; no money moves.', evidence: [`ev:${probe.id}`] });
  finish(ctx, [{ id: ctx.lesson.id, decision: 'not-applicable', note: 'read-only endpoint' }]);
  assert.strictEqual(ctx.store.state().tasks.credits.status, 'done');
});

test('a substantive written reason is accepted as a weaker dismissal and counted in metrics', () => {
  const ctx = setup();
  tasks.claim(ctx.store, ctx.config, 'credits', 'backend-engineer');
  finish(ctx, [{ id: ctx.lesson.id, decision: 'not-applicable', note: 'notApplicableWhen: this endpoint is read-only, so no money moves and a repeat is harmless.' }]);
  const m = require('../lib/memory/metrics').compute(ctx.store, ctx.config);
  assert.deepStrictEqual(m.summary.lessonDecisions, { applied: 0, 'not-applicable (evidence)': 0, 'not-applicable (reason only)': 1 });
});

test('CLI: task claim shows the retrieved lessons as evidence and the decision the handoff needs', () => {
  const ctx = setup();
  const res = spawnSync(process.execPath, [BIN, 'task', 'claim', 'credits', '--actor', 'backend-engineer', '--root', ctx.dir], { encoding: 'utf8', env: { ...process.env } });
  assert.strictEqual(res.status, 0, res.stderr);
  assert.match(res.stdout, /VERIFIED LESSONS/);
  assert.match(res.stdout, /Idempotency-Key/);
  assert.match(res.stdout, /lessonDecisions/);
});
