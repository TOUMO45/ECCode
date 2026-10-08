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
const { write, passCheck, handoffFor, approval, approvalWithLessons, expectCode } = require('./helpers');

const BIN = path.join(__dirname, '..', 'bin', 'eccode.js');
const { setup, finish } = require('./lesson-fixture');

test('claiming a task retrieves the matching verified lesson and records it on the claim', () => {
  const ctx = setup();
  const { event } = tasks.claim(ctx.store, ctx.config, 'credits', 'backend-engineer');
  assert.deepStrictEqual(event.data.lessons.map((l) => l.id), [ctx.lesson.id]);
  assert.strictEqual(ctx.store.state().tasks.credits.claim.lessons[0].id, ctx.lesson.id);
});

test('a precise lesson outranks long generic ones: topic fields (title, tags, appliesWhen) count more than body text, with light stemming', () => {
  const ctx = setup();
  const generic = 'The request handler validates the body, returns the response, writes the data and handles the endpoint error for every request that arrives at the service api and its tests';
  // Verified distractors with long bodies full of words that every endpoint task shares.
  const verifiedDistractor = (n, title) => {
    write(ctx.dir, `check${n}.js`, `process.exit(require("fs").existsSync("fixed${n}") ? 0 : 1)\n`);
    const repro = evidence.runCommand(ctx.store, 'learning-debugger', { label: `repro ${n}`, command: `node check${n}.js`, purpose: 'reproduction' });
    write(ctx.dir, `fixed${n}`, 'yes');
    const fix = evidence.runCommand(ctx.store, 'learning-debugger', { label: `fix ${n}`, command: `node check${n}.js` });
    const rec = ctx.mem.add('learning-debugger', { layer: 'debugging', content: {
      title, problem: `${generic}. ${generic}.`, symptoms: [`${generic} (${n})`], component: 'request handling', environment: { node: '>=18' }, fingerprint: `generic-${n}`,
      reproduction: { steps: ['run'], evidence: [`ev:${repro.id}`] }, rootCause: { explanation: `${generic}. ${generic}. ${generic}. ${generic}.`, evidence: [`ev:${repro.id}`] },
      failedAttempts: [{ approach: 'guess', whyFailed: 'nothing' }], solution: { description: `${generic}. Apply it to every endpoint request.`, tradeoffs: 'none' },
      verification: { evidence: [`ev:${fix.id}`], regressionTest: `node check${n}.js` }, sources: [], appliesWhen: ['Any request handling code'], notApplicableWhen: ['Static assets'], confidence: 'low', tags: ['misc'] } });
    ctx.mem.review(rec.id, 'technical-reviewer', { decision: 'verify', notes: 'Re-ran the failing check after the fix: it passes.' });
    return rec;
  };
  for (const [n, title] of [[1, 'Request handlers must validate input'], [2, 'Endpoints must return structured errors'], [3, 'Every request must be logged with its outcome'], [4, 'Responses must carry a request id']]) verifiedDistractor(n, title);
  const { event } = tasks.claim(ctx.store, ctx.config, 'credits', 'backend-engineer');
  const ids = (event.data.lessons || []).map((l) => l.id);
  assert.ok(ids.includes(ctx.lesson.id), `the idempotency lesson must be retrieved, got ${JSON.stringify(event.data.lessons)}`);
  assert.strictEqual(ids[0], ctx.lesson.id, 'and ranked first');
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

test('real trial data: the idempotency lesson is retrieved and ranked first for the credits task, behind none of three longer lessons', () => {
  const { retrieveForTask } = require('../lib/lessons');
  const fixDir = path.join(__dirname, 'fixtures', 'lessons');
  const shared = fs.mkdtempSync(path.join(os.tmpdir(), 'eccode-fixshared-'));
  fs.mkdirSync(path.join(shared, 'records'));
  for (const f of fs.readdirSync(fixDir)) if (f.endsWith('.json')) fs.copyFileSync(path.join(fixDir, f), path.join(shared, 'records', f));
  process.env.ECCODE_SHARED_MEMORY = shared;
  process.env.ECCODE_LEARNING = 'on';
  const fx = JSON.parse(fs.readFileSync(path.join(fixDir, 'e1-task.json.txt'), 'utf8'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eccode-fixproj-'));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  const store = init(dir, { name: fx.project.name, idea: fx.project.idea, profile: 'change' });
  const out = retrieveForTask(store, loadConfig(dir), fx.task, fx.project);
  assert.strictEqual(out[0].id, 'mem-sd-muzhyaa9-0166e67d', JSON.stringify(out.map((o) => [o.id, o.priority])));
  assert.ok(out.length <= 5);
});
