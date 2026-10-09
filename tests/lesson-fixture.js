'use strict';
// Shared fixture for the lesson tests: a change-profile project with one task about money-moving POST
// endpoints and a verified idempotency lesson.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { init } = require('../lib/project');
const { loadConfig } = require('../lib/config');
const gates = require('../lib/gates');
const tasks = require('../lib/tasks');
const evidence = require('../lib/evidence');
const { Memory } = require('../lib/memory/records');
const { write, passCheck, handoffFor, coverageWithLessons, initRepo, approvalWithLessons } = require('./helpers');

/** A change-profile project with one task about money-moving POST endpoints and a verified idempotency lesson. */
function setup({ taskTitle = 'Issue store credit through a POST endpoint', idea = 'Support wants to issue store credit to customers through the API', criteria = ['A credit is issued and the balance changes', 'Invalid amounts are rejected'], learning = 'on', planDecision = 'not-applicable' } = {}) {
  const shared = fs.mkdtempSync(path.join(os.tmpdir(), 'eccode-shared-'));
  process.env.ECCODE_SHARED_MEMORY = shared;
  process.env.ECCODE_LEARNING = learning;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eccode-lac-'));
  initRepo(dir);
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

  const decisions = {
    'not-applicable': [{ id: lesson.id, decision: 'not-applicable', note: 'Fixture plan: the claim-time tests set the lesson aside here so that claim retrieval is exercised on its own.' }],
    incorporated: [{ id: lesson.id, decision: 'incorporated', note: 'Acceptance criterion 3 of the credits task carries the Idempotency-Key rule.' }],
    none: [],
  }[planDecision];
  const inputs = planDecision === 'incorporated' ? ['TASK.md', lesson.id] : ['TASK.md'];
  const plan = { ...(decisions.length ? { lessonDecisions: decisions } : {}), phases: [{ id: 'core', name: 'Core', goal: 'Implement the requested change and its tests', acceptanceCriteria: ['The endpoint works', 'Existing tests pass'] }],
    tasks: [{ id: 'credits', phase: 'core', title: taskTitle, owner: 'backend-engineer', dependencies: [], inputs, outputs: ['endpoint', 'tests'], files: ['src/**', 'test/**'], acceptanceCriteria: criteria, verification: { method: 'run the tests', command: 'node -e "process.exit(0)"' } }] }; // the command passCheck() runs
  gates.startGate(store, config, 'plan', 'orchestrator');
  write(dir, '.eccode/artifacts/plan.json', JSON.stringify(plan));
  if (planDecision === 'none') return { dir, store, config, lesson, mem, plan };
  gates.submit(store, config, 'plan', 'delivery-lead', { artifacts: ['.eccode/artifacts/plan.json'] });
  gates.recordReview(store, config, 'plan', 'technical-reviewer', coverageWithLessons({ dir, store, config }, 'plan', ['artifact:.eccode/artifacts/plan.json#phases']));
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

module.exports = { setup, finish };
