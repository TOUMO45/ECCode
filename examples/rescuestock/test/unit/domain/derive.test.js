// RS-36: the rescue status is derived by the revision-2 table (rows 1-14 incl. 4a and 5a), row by row.
// Contents: table cases for every row and clause, RS-36 (i)-(iv), the reviewer scenarios S01-S21 (S09-S20 included),
// message/next-step coverage, and the totality property test (>= 20,000 seeded walks x 120 events over the composed
// machines; the defensive row 14 is never reached; every model move is checked against states.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_LIMITS, ROW_STATUS, deriveRescueStatus } from '../../../src/domain/derive.js';
import { explainRescueStatus, messageText, nextStepText } from '../../../src/domain/explain.js';
import { LIM, ROW_NAME, T0, makeWalk, refDerive, toInput, ts } from './helpers/derive-model.js';

// ---------------------------------------------------------------- builders (abstract model state)
const op = (status, extra = {}) => ({ status, since: 0, ...extra });
const ver = (v, status, res, ops = [], orders = [], extra = {}) => ({ v, run: v, status, res, ops, orders, ...extra });
const run = (id, feasible = true) => ({ id, feasible });
const model = (extra) => ({ reqConfirmed: true, budgetDeadline: true, runs: [run(1)], versions: [], queue: false, now: 1, ...extra });
const derive = (st, tweak) => {
  const input = toInput(st);
  if (tweak) tweak(input);
  return deriveRescueStatus(input);
};
const rowOf = (st) => derive(st).rule;

// ---------------------------------------------------------------- table cases, row by row
test('RS-36 row 1: needs_input - no confirmed requirements, or budget or deadline missing', () => {
  let d = derive(model({ reqConfirmed: false }));
  assert.deepEqual([d.status, d.rule, d.nextStepCode], ['needs_input', '1', 'CONFIRM_REQUIREMENTS'], 'fields were extracted, the buyer must confirm them');
  d = derive(model({ reqConfirmed: false }), (i) => { i.request.intake_status = 'draft'; });
  assert.deepEqual([d.rule, d.nextStepCode], ['1', 'ENTER_DETAILS']);
  d = derive(model({ budgetDeadline: false }));
  assert.deepEqual([d.status, d.rule, d.messageParams.missing], ['needs_input', '1', ['budgetCents', 'deadline']]);
  d = derive(model(), (i) => { i.requirements.deadline_at = null; });
  assert.deepEqual([d.rule, d.messageParams.missing], ['1', ['deadline']]);
  d = derive(model(), (i) => { i.requirements.budget_cents = null; });
  assert.deepEqual([d.rule, d.messageParams.missing], ['1', ['budgetCents']]);
  // row 1 wins over everything below it
  d = derive(model({ budgetDeadline: false, versions: [ver(1, 'non_executable', 'reconciling', [op('refund_failed')], ['confirmed'])] }));
  assert.equal(d.rule, '1');
});

test('RS-36 row 2: failed_needs_attention - refund_failed, void_failed, unknown or pending too long, escalated reconciling reservation', () => {
  const v = (o) => [ver(1, 'non_executable', 'released', [o], ['cancelled'])];
  assert.equal(rowOf(model({ versions: v(op('refund_failed')) })), '2');
  assert.equal(rowOf(model({ versions: v(op('authorized', { voidFailed: true })) })), '2');
  // unknown longer than the unknown limit (15 min): strict, exactly 15 is still young
  assert.equal(rowOf(model({ now: LIM.unknownMin, versions: v(op('unknown', { prev: 'approved' })) })), '4');
  assert.equal(rowOf(model({ now: LIM.unknownMin + 1, versions: v(op('unknown', { prev: 'approved' })) })), '2');
  // *_pending longer than the pending limit (1440 min)
  for (const s of ['authorization_pending', 'capture_pending', 'refund_pending']) {
    const young = rowOf(model({ now: LIM.pendingMin, versions: [ver(1, 'approved', 'active', [op(s)], ['confirmed'])] }));
    const old = rowOf(model({ now: LIM.pendingMin + 1, versions: [ver(1, 'approved', 'active', [op(s)], ['confirmed'])] }));
    assert.notEqual(young, '2', `${s} young`);
    assert.equal(old, '2', `${s} old`);
  }
  // reservation reconciling with an escalation flag
  const esc = model({ versions: [ver(1, 'non_executable', 'reconciling', [op('voided')], ['cancelled'], { resEscalation: true })] });
  const d = derive(esc);
  assert.deepEqual([d.status, d.rule, d.nextStepCode, d.messageParams.reasons], ['failed_needs_attention', '2', 'CONTACT_ORGANISER', ['RESERVATION_ESCALATED']]);
  const noFlag = model({ versions: [ver(1, 'non_executable', 'reconciling', [op('voided')], ['cancelled'])] });
  assert.equal(rowOf(noFlag), '4', 'a reconciling reservation without a flag is only cancelling');
});

test('RS-36 row 2 clause (a): an approved operation whose authorize call is still intent or unknown past the unknown limit', () => {
  for (const authCall of ['intent', 'unknown']) {
    const at = (now) => model({ now, versions: [ver(1, 'approved', 'active', [op('approved', { authCall }), op('created')], ['confirmed', 'confirmed'])] });
    assert.equal(rowOf(at(LIM.unknownMin)), '11', `${authCall} young`);
    const d = derive(at(LIM.unknownMin + 1));
    assert.deepEqual([d.rule, d.messageParams.reasons], ['2', ['AUTHORIZE_OUTSTANDING_TOO_LONG']], `${authCall} old`);
  }
  for (const authCall of ['done', 'cancelled', 'succeeded']) {
    const st = model({ now: 500, versions: [ver(1, 'approved', 'active', [op('approved', { authCall })], ['confirmed'])] });
    assert.notEqual(rowOf(st), '2', `a finished authorize call (${authCall}) does not escalate`);
  }
  // the newest authorize call decides (an older failed attempt does not mask a fresh outstanding one, nor the reverse)
  const input = toInput(model({ now: 100, versions: [ver(1, 'approved', 'active', [op('approved', { authCall: 'intent', since: 99 })], ['confirmed'])] }));
  input.providerCalls.unshift({ id: 0, payment_operation_id: input.operations[0].id, kind: 'authorize', status: 'unknown', created_at: ts(0) });
  assert.notEqual(deriveRescueStatus(input).rule, '2');
});

test('RS-36 row 2 clause (b): a non-terminal operation with cancel_requested_at older than the pending limit', () => {
  for (const status of ['approved', 'authorized', 'captured', 'refund_requested']) {
    const young = model({ now: LIM.pendingMin, versions: [ver(1, 'non_executable', 'released', [op(status, { cancelAt: 0 })], ['cancelled'])] });
    const old = model({ now: LIM.pendingMin + 1, versions: [ver(1, 'non_executable', 'released', [op(status, { cancelAt: 0 })], ['cancelled'])] });
    assert.notEqual(rowOf(young), '2', `${status} young`);
    const d = derive(old);
    assert.equal(d.rule, '2', `${status} old`);
    assert.ok(d.messageParams.reasons.includes('CANCELLATION_STUCK'), status);
  }
  for (const status of ['voided', 'authorization_failed', 'refunded']) {
    const st = model({ now: 5000, versions: [ver(1, 'non_executable', 'released', [op(status, { cancelAt: 0 })], ['cancelled'])] });
    assert.notEqual(rowOf(st), '2', `${status} is terminal`);
  }
});

test('RS-36 row 3: refunding - any operation of any version refund_requested or refund_pending; an unknown refund call counts (r2)', () => {
  for (const status of ['refund_requested', 'refund_pending']) {
    const d = derive(model({ versions: [ver(1, 'non_executable', 'reconciling', [op(status)], ['confirmed'])] }));
    assert.deepEqual([d.status, d.rule, d.nextStepCode], ['refunding', '3', 'WAIT'], status);
  }
  for (const prev of ['refund_requested', 'refund_pending']) {
    const d = derive(model({ versions: [ver(1, 'executed', 'consumed', [op('unknown', { prev }), op('captured')], ['collected', 'collected'])] }));
    assert.deepEqual([d.status, d.rule], ['refunding', '3'], `unknown refund (${prev})`);
  }
  const notRefund = derive(model({ versions: [ver(1, 'executed', 'consumed', [op('unknown', { prev: 'authorized' })], ['confirmed'])] }));
  assert.notEqual(notRefund.rule, '3');
});

test('RS-36 row 4: cancelling - an operation of a superseded or non_executable version is still open, or its reservation is reconciling', () => {
  for (const closedStatus of ['superseded', 'non_executable']) {
    for (const status of ['approved', 'authorization_pending', 'authorized', 'capture_pending', 'captured', 'unknown']) {
      const d = derive(model({ versions: [ver(1, closedStatus, 'released', [op(status, { cancelAt: 0, prev: 'approved' })], ['cancelled'], { reason: 'SUPPLIER_REFUSED' })] }));
      assert.deepEqual([d.status, d.rule, d.nextStepCode], ['cancelling', '4', 'WAIT'], `${closedStatus}/${status}`);
    }
    const reconciling = derive(model({ versions: [ver(1, closedStatus, 'reconciling', [op('voided')], ['cancelled'])] }));
    assert.equal(reconciling.rule, '4', `${closedStatus} reconciling`);
  }
  // `created` is voided locally in the same transaction, so it does not count; finished operations do not count
  for (const status of ['created', 'voided', 'authorization_failed', 'refunded']) {
    assert.notEqual(rowOf(model({ versions: [ver(1, 'non_executable', 'released', [op(status)], ['cancelled'])] })), '4', status);
  }
});

test('RS-36 row 4a (r2): replanning - an entry in the re-plan queue; REPLAN after 5 failed drains', () => {
  let d = derive(model({ queue: true, versions: [ver(1, 'superseded', 'released', [op('voided'), op('voided')], ['cancelled', 'cancelled'], { reason: 'PRICE_CHANGED' })] }));
  assert.deepEqual([d.status, d.rule, d.nextStepCode, d.messageCode], ['replanning', '4a', 'WAIT', 'REPLANNING']);
  assert.equal(explainRescueStatus(d).nextStep.text, 'Finding a new plan with current stock…');
  d = derive(model({ queue: true }), (i) => { i.replanQueueEntry = { failed_drains: DEFAULT_LIMITS.replanFailedDrainsBeforeManual - 1 }; });
  assert.equal(d.nextStepCode, 'WAIT');
  d = derive(model({ queue: true }), (i) => { i.replanQueueEntry = { failed_drains: DEFAULT_LIMITS.replanFailedDrainsBeforeManual }; });
  assert.deepEqual([d.rule, d.nextStepCode], ['4a', 'REPLAN']);
  assert.equal(explainRescueStatus(d).nextStep.text, 'Re-plan with current stock');
  // S20: a lost reserve race (non_executable OUT_OF_STOCK, nothing else) with a queued re-plan reads replanning, not cancelled
  d = derive(model({ queue: true, versions: [ver(1, 'non_executable', null, [], [], { reason: 'OUT_OF_STOCK' })] }));
  assert.deepEqual([d.status, d.rule], ['replanning', '4a']);
  // the queue never hides money in flight: rows 2, 3 and 4 come first
  assert.equal(rowOf(model({ queue: true, versions: [ver(1, 'non_executable', 'released', [op('authorized', { cancelAt: 0 })], ['cancelled'])] })), '4');
});

test('RS-36 row 5: no_feasible_plan - the latest run is infeasible and P is absent or older than that run', () => {
  let d = derive(model({ runs: [run(1, false)], versions: [] }));
  assert.deepEqual([d.status, d.rule], ['no_feasible_plan', '5']);
  d = derive(model({ runs: [run(1), run(2, false)], versions: [ver(1, 'superseded', 'released', [op('voided')], ['cancelled'])] }));
  assert.equal(d.rule, '5', 'S14: superseded version, replan stored infeasible');
  d = derive(model({ runs: [run(1), run(2, false)], versions: [ver(1, 'proposed', null)] }));
  assert.equal(d.rule, '5', 'P is older than the infeasible run');
  d = derive(model({ runs: [run(1, false), run(2, true)], versions: [ver(2, 'proposed', null)] }));
  assert.equal(d.rule, '12', 'a newer feasible run with its version is plan_found');
  assert.equal(derive(model({ runs: [run(1, false)], versions: [] })).messageCode, 'NO_FEASIBLE_PLAN');
});

test('RS-36 row 5a (r2): cancelled - an executed plan whose every operation was refunded afterwards', () => {
  const d = derive(model({ versions: [ver(1, 'executed', 'consumed', [op('refunded'), op('refunded')], ['confirmed', 'collected'])] }));
  assert.deepEqual([d.status, d.rule, d.nextStepCode, d.messageCode], ['cancelled', '5a', 'NONE', 'ALL_REFUNDED']);
  assert.equal(explainRescueStatus(d).message, 'All payments were refunded by the organiser');
  const partial = derive(model({ versions: [ver(1, 'executed', 'consumed', [op('refunded'), op('captured')], ['confirmed', 'collected'])] }));
  assert.equal(partial.rule, '7', 'partial refund keeps rows 7-9');
});

test('RS-36 row 6: cancelled - the current plan is non_executable and no newer version exists; next step by reason', () => {
  const expected = {
    SUPPLIER_REFUSED: 'REPLAN', RESERVATION_EXPIRED: 'REPLAN', PAYMENT_CANCELLED: 'REPLAN', OUT_OF_STOCK: 'REPLAN',
    AUTHORIZATION_FAILED: 'REPLAN_OR_OTHER_ACCOUNT', AUTHORIZATION_EXPIRED: 'REPLAN_OR_OTHER_ACCOUNT', CAPTURE_FAILED: 'REPLAN_OR_OTHER_ACCOUNT',
    REQUEST_DELETED: 'NONE', DEMO_RESET: 'NONE',
  };
  for (const [reason, next] of Object.entries(expected)) {
    const d = derive(model({ versions: [ver(1, 'non_executable', 'released', [op('voided')], ['cancelled'], { reason })] }));
    assert.deepEqual([d.status, d.rule, d.nextStepCode, d.messageCode], ['cancelled', '6', next, reason], reason);
    assert.ok(explainRescueStatus(d).message, `${reason} has a message`);
  }
  const newer = derive(model({ runs: [run(1), run(2)], versions: [ver(1, 'non_executable', 'released', [op('voided')], ['cancelled']), ver(2, 'proposed', null)] }));
  assert.equal(newer.rule, '12', 'a newer version moves the status on');
  // authorization declined names the supplier from the stored detail
  const declined = derive(model({ versions: [ver(1, 'non_executable', 'released', [op('voided')], ['cancelled'], { reason: 'AUTHORIZATION_FAILED' })] }), (i) => {
    i.versions[0].reason_detail_json = JSON.stringify({ supplierCode: 'B' });
  });
  assert.equal(explainRescueStatus(declined).message,
    'PayPal declined the payment for Supplier B. No money was taken; other authorizations were voided. Re-plan or try another PayPal account');
  const expired = derive(model({ versions: [ver(1, 'non_executable', 'released', [], [], { reason: 'RESERVATION_EXPIRED' })] }));
  assert.equal(explainRescueStatus(expired).message, 'Reservation expired — no money was taken; re-plan with current stock');
});

test('RS-36 rows 7-9 (r2 scoping): collected / ready_for_pickup / purchase_confirmed, refunded orders excluded from the order checks', () => {
  const exec = (ops, orders) => model({ versions: [ver(1, 'executed', 'consumed', ops, orders)] });
  assert.deepEqual([derive(exec([op('captured'), op('captured')], ['collected', 'collected'])).status, rowOf(exec([op('captured'), op('captured')], ['collected', 'collected']))], ['collected', '7']);
  assert.deepEqual(derive(exec([op('captured'), op('captured')], ['ready', 'collected'])).status, 'ready_for_pickup');
  assert.equal(rowOf(exec([op('captured'), op('captured')], ['ready', 'ready'])), '8');
  assert.equal(rowOf(exec([op('captured'), op('captured')], ['confirmed', 'ready'])), '9');
  assert.equal(derive(exec([op('captured'), op('captured')], ['confirmed', 'confirmed'])).status, 'purchase_confirmed');
  // a refunded operation's order is not checked; at least one captured operation is required
  let d = derive(exec([op('refunded'), op('captured')], ['confirmed', 'collected']));
  assert.deepEqual([d.status, d.rule, d.messageCode, d.messageParams.supplierCodes], ['collected', '7', 'ORDER_REFUNDED', ['A']]);
  assert.equal(explainRescueStatus(d).message, 'Order from Supplier A was refunded by the organiser');
  d = derive(exec([op('refunded'), op('captured')], ['confirmed', 'ready']));
  assert.deepEqual([d.status, d.rule], ['ready_for_pickup', '8']);
  d = derive(exec([op('refunded'), op('captured')], ['confirmed', 'confirmed']));
  assert.deepEqual([d.status, d.rule, d.messageCode], ['purchase_confirmed', '9', 'ORDER_REFUNDED']);
  // an executed plan with an operation that is neither captured nor refunded is not a purchase (it falls to row 14 only if nothing else fits)
  assert.notEqual(rowOf(exec([op('captured'), op('unknown', { prev: 'authorized-capture' })], ['collected', 'collected'])), '7');
});

test('RS-36 row 10: payment_authorized - approved with an active reservation and every operation authorized, or executing', () => {
  const approved = (orders) => model({ versions: [ver(1, 'approved', 'active', [op('authorized'), op('authorized')], orders)] });
  let d = derive(approved(['confirmed', 'confirmed']));
  assert.deepEqual([d.status, d.rule, d.nextStepCode], ['payment_authorized', '10', 'COMPLETE_PURCHASE']);
  d = derive(approved(['confirmed', 'awaiting_supplier']));
  assert.deepEqual([d.rule, d.nextStepCode], ['10', 'WAIT_FOR_SUPPLIERS']);
  d = derive(model({ versions: [ver(1, 'executing', 'consumed', [op('captured'), op('authorized')], ['confirmed', 'confirmed'])] }));
  assert.deepEqual([d.status, d.rule, d.nextStepCode, d.messageCode], ['payment_authorized', '10', 'WAIT', 'CAPTURES_IN_PROGRESS']);
  d = derive(model({ versions: [ver(1, 'executing', 'consumed', [op('captured'), op('capture_pending')], ['confirmed', 'confirmed'])] }));
  assert.equal(d.rule, '10', 'captures in progress, within limits');
});

test('RS-36 row 11: stock_reserved - approved with an active reservation, payments not all authorized', () => {
  let d = derive(model({ versions: [ver(1, 'approved', 'active', [op('created'), op('created')], ['awaiting_supplier', 'awaiting_supplier'])] }));
  assert.deepEqual([d.status, d.rule, d.nextStepCode], ['stock_reserved', '11', 'APPROVE_PAYMENTS']);
  d = derive(model({ versions: [ver(1, 'approved', 'active', [op('authorized'), op('created')], ['confirmed', 'confirmed'])] }));
  assert.deepEqual([d.rule, d.nextStepCode], ['11', 'APPROVE_PAYMENTS']);
  d = derive(model({ versions: [ver(1, 'approved', 'active', [op('created', { buyerCancelled: true }), op('authorized')], ['confirmed', 'confirmed'])] }));
  assert.deepEqual([d.rule, d.nextStepCode], ['11', 'RETRY_APPROVAL_OR_ABANDON']);
  for (const status of ['approved', 'authorization_pending', 'unknown']) {
    d = derive(model({ versions: [ver(1, 'approved', 'active', [op(status, { prev: 'approved' }), op('authorized')], ['confirmed', 'confirmed'])] }));
    assert.deepEqual([d.rule, d.nextStepCode], ['11', 'WAIT'], status);
  }
});

test('RS-36 row 12: plan_found - proposed, or approved without an active reservation; REVIEW_NEW_PLAN after a price change or refusal', () => {
  let d = derive(model({ versions: [ver(1, 'proposed', null)] }));
  assert.deepEqual([d.status, d.rule, d.nextStepCode], ['plan_found', '12', 'APPROVE_PLAN']);
  d = derive(model({ versions: [ver(1, 'approved', null)] }));
  assert.deepEqual([d.rule, d.nextStepCode], ['12', 'RESERVE']);
  d = derive(model({ versions: [ver(1, 'approved', 'released')] }));
  assert.equal(d.rule, '12', 'an approved plan whose reservation was released');
  // price change: v1 superseded (voids done), v2 proposed
  d = derive(model({ runs: [run(1), run(2)], versions: [ver(1, 'superseded', 'released', [op('voided'), op('voided')], ['cancelled', 'cancelled'], { reason: 'PRICE_CHANGED' }), ver(2, 'proposed', null)] }));
  assert.deepEqual([d.rule, d.nextStepCode, d.messageCode, d.messageParams.version], ['12', 'REVIEW_NEW_PLAN', 'PRICES_CHANGED', 2]);
  assert.equal(explainRescueStatus(d).message, 'Prices changed: review plan v2');
  // supplier refusal: v1 non_executable SUPPLIER_REFUSED (refused order), v2 proposed
  d = derive(model({ runs: [run(1), run(2)], versions: [ver(1, 'non_executable', 'released', [op('voided'), op('voided')], ['refused', 'cancelled'], { reason: 'SUPPLIER_REFUSED' }), ver(2, 'proposed', null)] }), (i) => {
    i.orders.find((o) => o.fulfilment_status === 'refused').refusal_reason = 'Out of lids';
  });
  assert.deepEqual([d.rule, d.nextStepCode, d.messageCode, d.messageParams.supplierCode, d.messageParams.refusal], ['12', 'REVIEW_NEW_PLAN', 'SUPPLIER_REFUSED', 'A', 'Out of lids']);
  assert.equal(explainRescueStatus(d).message, 'Supplier A refused the order: Out of lids. No money was taken.');
  assert.equal(explainRescueStatus(d).nextStep.text, 'Review the new plan');
});

test('RS-36 row 13: requirements_confirmed - requirements confirmed and no planning run yet (S19, S21)', () => {
  let d = derive(model({ runs: [], versions: [] }));
  assert.deepEqual([d.status, d.rule, d.nextStepCode], ['requirements_confirmed', '13', 'PLAN']);
  d = derive(model({ runs: [], versions: [ver(1, 'superseded', null)] }));
  assert.equal(d.rule, '13', 'requirements changed: old version superseded, no run for the new requirements');
});

test('RS-36 row 14 (r2): defensive fallback is total and reports its state vector; no table row is skipped', () => {
  // a feasible run newer than every version, nothing queued: no row matches
  const d = derive(model({ runs: [run(1), run(2)], versions: [ver(1, 'proposed', null, [], [])].map((v) => ({ ...v, run: 1, status: 'executed', res: 'consumed', ops: [op('unknown', { prev: 'authorized-capture' })], orders: ['confirmed'] })) }), (i) => { i.operations[0].unknown_since = ts(1); });
  assert.deepEqual([d.status, d.rule, d.nextStepCode, d.fallback], ['replanning', '14', 'REPLAN', true]);
  assert.equal(d.stateVector.currentVersion.status, 'executed');
  assert.equal(explainRescueStatus(d).nextStep.text, 'Re-plan with current stock');
  assert.equal(refDerive(model({ runs: [run(1), run(2)], versions: [ver(1, 'executed', 'consumed', [op('unknown', { prev: 'authorized-capture' })], ['confirmed'])] })), '14');
});

test('RS-36: every row of the table is represented in ROW_STATUS and in the reference table names', () => {
  assert.deepEqual(Object.keys(ROW_STATUS).sort(), Object.keys(ROW_NAME).sort());
  for (const [row, status] of Object.entries(ROW_STATUS)) assert.equal(ROW_NAME[row], status, row);
});

// ---------------------------------------------------------------- RS-36 (i)-(iv)
test('RS-36 (i): any operation of any plan version in refund_requested or refund_pending yields refunding, even when every other order is collected', () => {
  for (const status of ['refund_requested', 'refund_pending']) {
    const st = model({ runs: [run(1), run(2)], versions: [
      ver(1, 'non_executable', 'reconciling', [op(status)], ['confirmed']),
      ver(2, 'executed', 'consumed', [op('captured')], ['collected']),
    ] });
    const d = derive(st);
    assert.deepEqual([d.status, d.rule], ['refunding', '3'], status);
    assert.equal(refDerive(st), '3');
  }
});

test('RS-36 (ii): a refusal or non_executable plan with an operation still authorized, authorization_pending or unknown yields cancelling; refund_failed, failed void or over-age unknown yields failed_needs_attention', () => {
  for (const status of ['authorized', 'authorization_pending', 'unknown']) {
    const st = model({ runs: [run(1), run(2)], versions: [
      ver(1, 'non_executable', 'released', [op(status, { cancelAt: 0, prev: 'approved' }), op('voided')], ['refused', 'cancelled'], { reason: 'SUPPLIER_REFUSED' }),
      ver(2, 'proposed', null),
    ] });
    assert.deepEqual([derive(st).status, derive(st).rule], ['cancelling', '4'], status);
  }
  const failing = {
    refund_failed: op('refund_failed'),
    'failed void': op('authorized', { voidFailed: true, cancelAt: 0 }),
    'over-age unknown': op('unknown', { prev: 'approved', cancelAt: 0, since: 0 }),
  };
  for (const [name, o] of Object.entries(failing)) {
    const st = model({ now: name === 'over-age unknown' ? 30 : 1, versions: [ver(1, 'non_executable', 'reconciling', [o, op('voided')], ['refused', 'cancelled'], { reason: 'SUPPLIER_REFUSED' })] });
    assert.deepEqual([derive(st).status, derive(st).rule], ['failed_needs_attention', '2'], name);
  }
});

test('RS-36 (iii): collected only when every supplier order of the current plan is collected and every capture is captured; one ready and one collected is ready_for_pickup', () => {
  const st = (orders, ops = [op('captured'), op('captured')]) => model({ versions: [ver(1, 'executed', 'consumed', ops, orders)] });
  assert.equal(derive(st(['ready', 'collected'])).status, 'ready_for_pickup');
  assert.equal(derive(st(['collected', 'collected'])).status, 'collected');
  assert.notEqual(derive(st(['collected', 'confirmed'])).status, 'collected');
  assert.notEqual(derive(st(['collected', 'collected'], [op('captured'), op('capture_pending')])).status, 'collected');
});

test('RS-36 (iv): after every void completes following a refusal and a new version is proposed, the status is plan_found', () => {
  const st = model({ runs: [run(1), run(2)], versions: [
    ver(1, 'non_executable', 'released', [op('voided'), op('voided')], ['refused', 'cancelled'], { reason: 'SUPPLIER_REFUSED' }),
    ver(2, 'proposed', null),
  ] });
  const d = derive(st);
  assert.deepEqual([d.status, d.rule, d.nextStepCode], ['plan_found', '12', 'REVIEW_NEW_PLAN']);
  // while the void is outstanding the same request reads cancelling
  const outstanding = model({ runs: [run(1), run(2)], versions: [
    ver(1, 'non_executable', 'released', [op('authorized', { cancelAt: 0 }), op('voided')], ['refused', 'cancelled'], { reason: 'SUPPLIER_REFUSED' }),
    ver(2, 'proposed', null),
  ] });
  assert.equal(derive(outstanding).status, 'cancelling');
});

// ---------------------------------------------------------------- reviewer scenarios S01-S21
const SCENARIOS = [
  ['S01 confirmed, no run', model({ runs: [], versions: [] }), 'requirements_confirmed'],
  ['S02 v1 proposed', model({ versions: [ver(1, 'proposed', null)] }), 'plan_found'],
  ['S03 v1 approved, reservation active, operations created', model({ versions: [ver(1, 'approved', 'active', [op('created'), op('created')], ['awaiting_supplier', 'awaiting_supplier'])] }), 'stock_reserved'],
  ['S04 all authorized', model({ versions: [ver(1, 'approved', 'active', [op('authorized'), op('authorized')], ['confirmed', 'confirmed'])] }), 'payment_authorized'],
  ['S05 executing', model({ versions: [ver(1, 'executing', 'consumed', [op('captured'), op('authorized')], ['confirmed', 'confirmed'])] }), 'payment_authorized'],
  ['S06 executed, all captured', model({ versions: [ver(1, 'executed', 'consumed', [op('captured'), op('captured')], ['confirmed', 'confirmed'])] }), 'purchase_confirmed'],
  ['S07 RS-36(iii) one ready one collected', model({ versions: [ver(1, 'executed', 'consumed', [op('captured'), op('captured')], ['ready', 'collected'])] }), 'ready_for_pickup'],
  ['S08 all collected', model({ versions: [ver(1, 'executed', 'consumed', [op('captured'), op('captured')], ['collected', 'collected'])] }), 'collected'],
  ['S09 RS-36(i) old version refund_pending, current all collected', model({ runs: [run(1), run(2)], versions: [
    ver(1, 'non_executable', 'reconciling', [op('refund_pending')], ['confirmed']),
    ver(2, 'executed', 'consumed', [op('captured')], ['collected'])] }), 'refunding'],
  ['S10 RS-36(ii) refusal, void outstanding, v2 proposed', model({ runs: [run(1), run(2)], versions: [
    ver(1, 'non_executable', 'released', [op('authorized', { cancelAt: 0 }), op('voided')], ['refused', 'cancelled']),
    ver(2, 'proposed', null)] }), 'cancelling'],
  ['S10b refusal, void outstanding, re-plan queued', model({ queue: true, versions: [
    ver(1, 'non_executable', 'released', [op('authorized', { cancelAt: 0 }), op('voided')], ['refused', 'cancelled'])] }), 'cancelling'],
  ['S11 RS-36(ii) refund_failed', model({ versions: [ver(1, 'non_executable', 'reconciling', [op('refund_failed'), op('voided')], ['confirmed', 'confirmed'])] }), 'failed_needs_attention'],
  ['S11b RS-36(ii) unknown past the limit', model({ now: 30, versions: [ver(1, 'non_executable', 'released', [op('unknown', { prev: 'approved', cancelAt: 0 }), op('voided')], ['refused', 'cancelled'])] }), 'failed_needs_attention'],
  ['S12 RS-36(iv) voids done, v2 proposed, queue entry removed', model({ runs: [run(1), run(2)], versions: [
    ver(1, 'non_executable', 'released', [op('voided'), op('voided')], ['refused', 'cancelled']),
    ver(2, 'proposed', null)] }), 'plan_found'],
  ['S13 superseded, voids done, re-plan queued', model({ queue: true, versions: [ver(1, 'superseded', 'released', [op('voided'), op('voided')], ['cancelled', 'cancelled'])] }), 'replanning'],
  ['S13b superseded, offers_hash retries exhausted (entry kept)', model({ queue: true, versions: [ver(1, 'superseded', 'released', [op('voided')], ['cancelled'])] }), 'replanning'],
  ['S14 supersession, replan stored infeasible', model({ runs: [run(1), run(2, false)], versions: [ver(1, 'superseded', 'released', [op('voided')], ['cancelled'])] }), 'no_feasible_plan'],
  ['S15 executed, admin refund of A completed, B collected', model({ versions: [ver(1, 'executed', 'consumed', [op('refunded'), op('captured')], ['confirmed', 'collected'])] }), 'collected'],
  ['S15b executed, every order refunded by the admin', model({ versions: [ver(1, 'executed', 'consumed', [op('refunded'), op('refunded')], ['confirmed', 'confirmed'])] }), 'cancelled'],
  ['S15c executed, admin refund call unknown', model({ versions: [ver(1, 'executed', 'consumed', [op('unknown', { prev: 'refund_requested' }), op('captured')], ['collected', 'collected'])] }), 'refunding'],
  ['S16 compensation complete (CAPTURE_FAILED)', model({ versions: [ver(1, 'non_executable', 'released', [op('refunded'), op('voided')], ['confirmed', 'confirmed'])] }), 'cancelled'],
  ['S17 post-claim AUTHORIZATION_EXPIRED, voids outstanding', model({ versions: [ver(1, 'non_executable', 'reconciling', [op('authorized', { cancelAt: 0 }), op('authorized', { cancelAt: 0 })], ['confirmed', 'confirmed'])] }), 'cancelling'],
  ['S18 expiry, authorize call outstanding for 3 days (clauses a and b)', model({ now: 4320, versions: [ver(1, 'non_executable', 'expired', [op('approved', { authCall: 'intent', cancelAt: 0 }), op('voided')], ['cancelled', 'cancelled'])] }), 'failed_needs_attention'],
  ['S18a expiry, queued authorize never started: call cancelled, operation voided locally', model({ versions: [ver(1, 'non_executable', 'expired', [op('voided'), op('voided')], ['cancelled', 'cancelled'])] }), 'cancelled'],
  ['S18b approved with a started authorize still unknown, 20 min', model({ now: 20, versions: [ver(1, 'approved', 'active', [op('approved', { authCall: 'unknown' }), op('created')], ['awaiting_supplier', 'awaiting_supplier'])] }), 'failed_needs_attention'],
  ['S18c approved, authorize retryable (429) re-queued, 20 min', model({ now: 20, versions: [ver(1, 'approved', 'active', [op('approved', { authCall: 'intent' }), op('authorized')], ['confirmed', 'confirmed'])] }), 'failed_needs_attention'],
  ['S19 requirements changed, v2 requirements confirmed, no run for them', model({ runs: [], versions: [ver(1, 'superseded', null)] }), 'requirements_confirmed'],
  ['S20 reserve lost the race: v1 non_executable OUT_OF_STOCK, re-plan queued', model({ queue: true, versions: [ver(1, 'non_executable', null, [], [])] }), 'replanning'],
];

for (const [name, st, expected] of SCENARIOS) {
  test(`RS-36 scenario ${name} -> ${expected}`, () => {
    const d = derive(st);
    assert.equal(d.status, expected);
    assert.equal(ROW_NAME[refDerive(st)], expected, 'the reference table agrees');
    assert.equal(d.rule, refDerive(st));
    // every result is renderable
    const shown = explainRescueStatus(d);
    assert.ok(shown.nextStep.text.length > 0);
  });
}

test('RS-36: every non-terminal operation state left in a closed version eventually escalates to failed_needs_attention (nothing stays cancelling forever)', () => {
  const states = ['approved', 'authorization_pending', 'authorized', 'capture_pending', 'captured', 'unknown', 'refund_requested', 'refund_pending'];
  for (const status of states) {
    const st = model({ now: 1e6, versions: [ver(1, 'non_executable', 'released', [op(status, { cancelAt: 0, prev: 'authorized-void', authCall: status === 'approved' ? 'intent' : undefined })], ['cancelled'])] });
    assert.equal(rowOf(st), '2', status);
  }
});

test('RS-36: derive is pure - equal inputs give deep-equal outputs, the input is not modified, and the clock is the injected `now`', () => {
  const st = model({ runs: [run(1), run(2)], versions: [
    ver(1, 'non_executable', 'released', [op('authorized', { cancelAt: 0 }), op('voided')], ['refused', 'cancelled'], { reason: 'SUPPLIER_REFUSED' }),
    ver(2, 'proposed', null)] });
  const input = toInput(st);
  const copy = structuredClone(input);
  const a = deriveRescueStatus(input);
  assert.deepEqual(input, copy);
  assert.deepEqual(deriveRescueStatus(structuredClone(input)), a);
  // the same rows read at a later `now` can change the answer (age escalation), proving `now` is the only clock
  const later = { ...input, now: T0 + (LIM.pendingMin + 5) * 60000 };
  assert.equal(deriveRescueStatus(later).rule, '2');
  assert.equal(deriveRescueStatus({ ...input, now: new Date(T0 + 60000).toISOString() }).rule, '4', 'now may be a Ts string');
});

test('explain: every message code and next-step code that derive can emit has a text; unknown codes are refused', () => {
  const codes = ['NEEDS_INPUT', 'NEEDS_ATTENTION', 'REFUND_IN_PROGRESS', 'CANCELLING', 'REPLANNING', 'REPLAN_NEEDED', 'NO_FEASIBLE_PLAN', 'ALL_REFUNDED',
    'ORDER_REFUNDED', 'PURCHASE_CONFIRMED', 'CAPTURES_IN_PROGRESS', 'AUTHORIZATION_IN_PROGRESS', 'APPROVAL_CANCELLED', 'RESERVATION_EXPIRED',
    'AUTHORIZATION_FAILED', 'AUTHORIZATION_EXPIRED', 'CAPTURE_FAILED', 'PAYMENT_CANCELLED', 'OUT_OF_STOCK', 'REQUEST_DELETED', 'DEMO_RESET',
    'SUPPLIER_REFUSED', 'PRICES_CHANGED', 'PLAN_REPLACED'];
  for (const c of codes) assert.ok(messageText(c, { version: 2, supplierCode: 'B', supplierCodes: ['B'], missing: ['deadline'] }).length > 0, c);
  assert.equal(messageText(null), null);
  assert.throws(() => messageText('NOPE'), RangeError);
  assert.throws(() => nextStepText('NOPE'), RangeError);
});

// ---------------------------------------------------------------- totality property test
const WALKS = 20000; // the design's requirement: >= 20,000 walks x 120 events
const PROGRESS_WALKS = 5000; // extra walks with failures made rare, so executed / collected / refunded states are common
const EVENTS_PER_WALK = 120;

function runWalks(walk, walks, hits, eventHits) {
  let steps = 0;
  for (let w = 0; w < walks; w += 1) {
    const st = walk.fresh();
    for (let e = 0; e < EVENTS_PER_WALK; e += 1) {
      const event = walk.step(st);
      eventHits[event] = (eventHits[event] ?? 0) + 1;
      const input = toInput(st);
      const d = deriveRescueStatus(input);
      steps += 1;
      hits[d.rule] = (hits[d.rule] ?? 0) + 1;
      if (d.rule === '14' || d.fallback) assert.fail(`row 14 reached (walk ${w}, event ${e} after ${event}): ${JSON.stringify(st)}`);
      const ref = refDerive(st);
      if (d.rule !== ref) assert.fail(`derive row ${d.rule} differs from the reference table row ${ref} (walk ${w}, event ${e}): ${JSON.stringify(st)}`);
      if (d.status !== ROW_NAME[d.rule]) assert.fail(`status/row mismatch ${d.status}/${d.rule}`);
      // RS-36 (i)-(iii) as invariants, outside the rows that legitimately precede them
      if (d.rule !== '1' && d.rule !== '2') {
        const ops = st.versions.flatMap((v) => v.ops);
        const refunding = ops.some((o) => o.status === 'refund_requested' || o.status === 'refund_pending' || (o.status === 'unknown' && o.prev === 'refund'));
        if (refunding && d.status !== 'refunding') assert.fail(`RS-36 (i) violated (walk ${w}, event ${e}): ${JSON.stringify(st)}`);
        if (!refunding) {
          const open = st.versions.some((v) => (v.status === 'superseded' || v.status === 'non_executable') &&
            (v.ops.some((o) => ['approved', 'authorization_pending', 'authorized', 'capture_pending', 'captured', 'unknown'].includes(o.status)) || v.res === 'reconciling'));
          if (open && d.status !== 'cancelling') assert.fail(`RS-36 (ii) violated (walk ${w}, event ${e}): ${JSON.stringify(st)}`);
        }
      }
      if (d.status === 'collected') {
        const P = st.versions.filter((v) => v.status !== 'superseded').reduce((a, b) => (a && a.v > b.v ? a : b), null);
        const captured = P.ops.map((o, i) => [o, P.orders[i]]).filter(([o]) => o.status === 'captured');
        assert.ok(P.status === 'executed' && captured.length > 0 && captured.every(([, s]) => s === 'collected'), 'RS-36 (iii)');
      }
    }
  }
  return steps;
}

test('RS-36 totality: 20,000 seeded walks x 120 events over the composed machines never reach row 14, agree with the reference table, and keep RS-36 (i)-(iv)', () => {
  const hits = {};
  const eventHits = {};
  const walk = makeWalk(20261009);
  const progress = makeWalk(20261010, 'progress');
  const steps = runWalks(walk, WALKS, hits, eventHits) + runWalks(progress, PROGRESS_WALKS, hits, eventHits);
  assert.equal(steps, (WALKS + PROGRESS_WALKS) * EVENTS_PER_WALK);
  for (const row of ['1', '2', '3', '4', '4a', '5', '5a', '6', '7', '8', '9', '10', '11', '12', '13']) {
    assert.ok((hits[row] ?? 0) > 0, `row ${row} was never hit; hits ${JSON.stringify(hits)}`);
  }
  assert.equal(hits['14'] ?? 0, 0);
  for (const name of walk.eventNames) assert.ok((eventHits[name] ?? 0) > 0, `event ${name} never fired`);
  assert.ok(walk.counters.collected + progress.counters.collected > 0, 'walks reach collection');
  assert.ok(walk.counters.transitions > 100000, 'the walk exercised the state tables');
  console.log(`# derive totality: ${steps} steps, rows hit ${JSON.stringify(hits)}, ${walk.counters.transitions + progress.counters.transitions} checked transitions`);
});
