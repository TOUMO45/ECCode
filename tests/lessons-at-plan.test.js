'use strict';
// The first real evaluation showed an implementer setting an applicable house rule aside because "the
// ticket does not mention it", and an independent reviewer approving that. So: a plan has to answer for
// the verified lessons that match its tasks, an incorporated lesson binds the implementer, and reviewers
// must judge every recorded lesson decision before they can approve.
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { spawnSync } = require('child_process');
const gates = require('../lib/gates');
const tasks = require('../lib/tasks');
const { write, approval, coverage, coverageWithLessons, expectCode } = require('./helpers');
const { setup, finish } = require('./lesson-fixture');

const BIN = path.join(__dirname, '..', 'bin', 'eccode.js');
const PLAN = '.eccode/artifacts/plan.json';

test('a plan that matches a verified lesson is refused until it answers for it, and the refusal shows the lesson and the rule about silence', () => {
  const ctx = setup({ planDecision: 'none' });
  assert.throws(
    () => gates.submit(ctx.store, ctx.config, 'plan', 'delivery-lead', { artifacts: [PLAN] }),
    (err) => {
      assert.strictEqual(err.code, 'PLAN_LESSONS');
      assert.match(err.message, new RegExp(ctx.lesson.id));
      assert.match(err.message, /Idempotency-Key/);
      assert.match(err.message, /does not mention a rule is NOT a reason/);
      assert.match(err.message, /lessonDecisions/);
      return true;
    },
  );
});

test('"incorporated" must reach the task: the lesson id in its inputs; "not-applicable" needs a real reason', () => {
  const ctx = setup({ planDecision: 'none' });
  const plan = ctx.plan;
  plan.lessonDecisions = [{ id: ctx.lesson.id, decision: 'incorporated', note: 'Acceptance criterion 3 carries the Idempotency-Key rule.' }];
  write(ctx.dir, PLAN, JSON.stringify(plan));
  assert.throws(() => gates.submit(ctx.store, ctx.config, 'plan', 'delivery-lead', { artifacts: [PLAN] }), /name it in the "inputs" of task\(s\) credits/);

  plan.lessonDecisions = [{ id: ctx.lesson.id, decision: 'not-applicable', note: 'no' }];
  write(ctx.dir, PLAN, JSON.stringify(plan));
  assert.throws(() => gates.submit(ctx.store, ctx.config, 'plan', 'delivery-lead', { artifacts: [PLAN] }), /naming the condition that does not hold/);

  plan.lessonDecisions = [{ id: ctx.lesson.id, decision: 'maybe', note: 'x'.repeat(40) }];
  write(ctx.dir, PLAN, JSON.stringify(plan));
  assert.throws(() => gates.submit(ctx.store, ctx.config, 'plan', 'delivery-lead', { artifacts: [PLAN] }), /schema|decision/i);
});

test('the plan reviewer cannot approve without judging the recorded lesson decisions', () => {
  const ctx = setup({ planDecision: 'none' });
  const plan = ctx.plan;
  plan.lessonDecisions = [{ id: ctx.lesson.id, decision: 'incorporated', note: 'Acceptance criterion 3 carries the Idempotency-Key rule.' }];
  plan.tasks[0].inputs = ['TASK.md', ctx.lesson.id];
  plan.tasks[0].acceptanceCriteria.push('A repeated POST with the same Idempotency-Key returns the original response and creates nothing new');
  write(ctx.dir, PLAN, JSON.stringify(plan));
  gates.submit(ctx.store, ctx.config, 'plan', 'delivery-lead', { artifacts: [PLAN] });
  const refused = expectCode(() => gates.recordReview(ctx.store, ctx.config, 'plan', 'technical-reviewer', approval([[`artifact:${PLAN}`]])), 'REVIEW_REJECTED');
  assert.match(refused.message, /criterion with id "lessons"/);
  gates.recordReview(ctx.store, ctx.config, 'plan', 'technical-reviewer', coverageWithLessons(ctx, 'plan', [`artifact:${PLAN}#phases`]));
  assert.strictEqual(ctx.store.state().gates.plan.status, 'approved');
  assert.deepStrictEqual(ctx.store.state().plan.lessonDecisions.map((d) => d.id), [ctx.lesson.id]);
});

test('a lesson the approved plan incorporated binds the implementer: shown as required at claim, dismissal refused, applying it accepted', () => {
  const ctx = setup({ planDecision: 'incorporated' });
  const { event } = tasks.claim(ctx.store, ctx.config, 'credits', 'backend-engineer');
  assert.strictEqual(event.data.lessons[0].bound, true);
  const shown = require('../lib/lessons').renderForClaim(ctx.store, ctx.config, event.data.lessons);
  assert.match(shown, /reviewed plan made this a requirement/);

  const dismissal = expectCode(() => finish(ctx, [{ id: ctx.lesson.id, decision: 'not-applicable', note: 'The ticket for this task does not mention idempotency anywhere, so a plain endpoint is kept as is.' }]), 'INVALID_HANDOFF');
  assert.match(dismissal.message, /cannot be set aside here/);

  finish(ctx, [{ id: ctx.lesson.id, decision: 'applied', note: 'Replays the stored response for a repeated Idempotency-Key; covered by the credits idempotency test.' }]);
  assert.strictEqual(ctx.store.state().tasks.credits.lessonDecisions[0].decision, 'applied');
});

test('the phase reviewer must judge the implementer\'s lesson decisions too, and sees them in `gate show`', () => {
  const ctx = setup({ planDecision: 'not-applicable' });
  tasks.claim(ctx.store, ctx.config, 'credits', 'backend-engineer');
  finish(ctx, [{ id: ctx.lesson.id, decision: 'not-applicable', note: 'This endpoint only adjusts an internal ledger and moves no money between parties, so the rule is outside its scope.' }]);
  gates.submit(ctx.store, ctx.config, 'phase:core', 'backend-engineer', { artifacts: [] });
  const shown = spawnSync(process.execPath, [BIN, 'gate', 'show', 'phase:core', '--json', '--root', ctx.dir], { encoding: 'utf8' });
  assert.strictEqual(shown.status, 0, shown.stderr);
  const parsed = JSON.parse(shown.stdout);
  assert.deepStrictEqual(parsed.lessonDecisionsToJudge.map((d) => [d.id, d.decision]), [[ctx.lesson.id, 'not-applicable']]);

  // The reviewer's own passing check is needed for phase approvals; the lessons criterion is checked first.
  const { passCheck } = require('./helpers');
  const ev = passCheck(ctx.store, 'technical-reviewer');
  const without = expectCode(() => gates.recordReview(ctx.store, ctx.config, 'phase:core', 'technical-reviewer', approval([[`ev:${ev.id}`]])), 'REVIEW_REJECTED');
  assert.match(without.message, /criterion with id "lessons"/);
  gates.recordReview(ctx.store, ctx.config, 'phase:core', 'technical-reviewer', coverageWithLessons(ctx, 'phase:core', [`ev:${ev.id}`]));
  assert.strictEqual(ctx.store.state().gates['phase:core'].status, 'approved');
});

test('with learning off nothing is asked of the plan or the reviewer', () => {
  const ctx = setup({ planDecision: 'none', learning: 'off' });
  gates.submit(ctx.store, ctx.config, 'plan', 'delivery-lead', { artifacts: [PLAN] });
  gates.recordReview(ctx.store, ctx.config, 'plan', 'technical-reviewer', coverage(ctx, 'plan', [`artifact:${PLAN}#phases`]));
  assert.strictEqual(ctx.store.state().gates.plan.status, 'approved');
  delete process.env.ECCODE_LEARNING;
});
