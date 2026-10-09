// RS-36 (state machines): the four transition tables of the brief, with the OQ-D1 reasons. Every pair of states
// of every machine is checked: allowed pairs pass, every other pair is refused with AppError(409, INVALID_STATE).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MACHINE_NAMES, NON_EXECUTABLE_REASONS, SUPERSEDE_REASONS, TABLES, TERMINAL_PAYMENT_STATES,
  allowedTargets, assertTransition, canTransition, requiresReason, statesOf, transitionReasons,
} from '../../../src/domain/states.js';
import { AppError } from '../../../src/domain/errors.js';

// The brief's tables, written out edge by edge (independent of the module's own table layout).
const STATES = {
  plan: ['draft', 'proposed', 'approved', 'superseded', 'non_executable', 'executing', 'executed'],
  reservation: ['active', 'consumed', 'expired', 'released', 'reconciling'],
  payment: ['created', 'approved', 'authorization_pending', 'authorized', 'authorization_failed', 'capture_pending', 'captured',
    'voided', 'refund_requested', 'refund_pending', 'refunded', 'refund_failed', 'unknown'],
  fulfilment: ['awaiting_supplier', 'confirmed', 'refused', 'cancelled', 'ready', 'collected'],
};

const EDGES = {
  plan: [
    ['draft', 'proposed'],
    ['proposed', 'approved'],
    ['proposed', 'superseded'], ['approved', 'superseded'],
    ['approved', 'non_executable'],
    ['approved', 'executing'],
    ['executing', 'executed'],
    ['executing', 'non_executable'],
  ],
  reservation: [
    ['active', 'consumed'], ['active', 'expired'], ['active', 'released'],
    ['consumed', 'reconciling'],
    ['reconciling', 'released'],
  ],
  payment: [
    ['created', 'approved'], ['created', 'created'], ['created', 'voided'], ['approved', 'voided'],
    ['approved', 'authorized'], ['approved', 'authorization_pending'], ['approved', 'authorization_failed'], ['approved', 'unknown'],
    ['authorization_pending', 'authorized'], ['authorization_pending', 'authorization_failed'],
    ['authorized', 'capture_pending'], ['authorized', 'captured'], ['authorized', 'unknown'],
    ['authorized', 'authorized'], // capture DECLINED keeps `authorized` with last_error = CAPTURE_DECLINED
    ['capture_pending', 'captured'], ['capture_pending', 'authorized'],
    ['authorized', 'voided'],
    ['captured', 'refund_requested'],
    ['refund_requested', 'refund_pending'], ['refund_requested', 'unknown'],
    ['refund_pending', 'refunded'], ['refund_pending', 'refund_failed'], ['refund_pending', 'unknown'],
    ...['created', 'approved', 'authorization_pending', 'authorized', 'authorization_failed', 'capture_pending', 'captured',
      'voided', 'refund_requested', 'refund_pending', 'refunded', 'refund_failed'].map((s) => ['unknown', s]),
  ],
  fulfilment: [
    ['awaiting_supplier', 'confirmed'],
    ['awaiting_supplier', 'refused'], ['confirmed', 'refused'],
    ['awaiting_supplier', 'cancelled'], ['confirmed', 'cancelled'],
    ['confirmed', 'ready'],
    ['ready', 'collected'],
  ],
};

for (const machine of MACHINE_NAMES) {
  test(`RS-36: ${machine} machine - every allowed pair passes and every other pair is refused with 409 INVALID_STATE`, () => {
    assert.deepEqual([...statesOf(machine)].sort(), [...STATES[machine]].sort(), 'state set matches the schema CHECK');
    const allowed = new Set(EDGES[machine].map(([a, b]) => `${a}>${b}`));
    assert.equal(allowed.size, EDGES[machine].length, 'no duplicate edges in the expectation');
    let checkedAllowed = 0;
    let checkedRefused = 0;
    for (const from of STATES[machine]) {
      for (const to of STATES[machine]) {
        const key = `${from}>${to}`;
        if (allowed.has(key)) {
          assert.equal(canTransition(machine, from, to), true, `${machine} ${key} should be allowed`);
          assert.doesNotThrow(() => assertTransition(machine, from, to), `${machine} ${key}`);
          checkedAllowed += 1;
        } else {
          assert.equal(canTransition(machine, from, to), false, `${machine} ${key} should be refused`);
          assert.throws(() => assertTransition(machine, from, to), (err) => {
            assert.ok(err instanceof AppError);
            assert.equal(err.name, 'AppError');
            assert.equal(err.status, 409);
            assert.equal(err.code, 'INVALID_STATE');
            assert.deepEqual(err.details, { machine, from, to });
            return true;
          }, `${machine} ${key}`);
          checkedRefused += 1;
        }
      }
    }
    assert.equal(checkedAllowed, EDGES[machine].length);
    assert.equal(checkedAllowed + checkedRefused, STATES[machine].length ** 2);
    assert.deepEqual(allowedTargets(machine, STATES[machine][0]).sort(), EDGES[machine].filter(([a]) => a === STATES[machine][0]).map(([, b]) => b).sort());
  });
}

test('RS-36: terminal states have no way out (plan: superseded, non_executable, executed; reservation: expired, released; payment: terminal set; fulfilment: refused, cancelled, collected)', () => {
  for (const s of ['superseded', 'non_executable', 'executed']) assert.deepEqual(allowedTargets('plan', s), [], s);
  for (const s of ['expired', 'released']) assert.deepEqual(allowedTargets('reservation', s), [], s);
  assert.deepEqual([...TERMINAL_PAYMENT_STATES].sort(), ['authorization_failed', 'refund_failed', 'refunded', 'voided']);
  for (const s of TERMINAL_PAYMENT_STATES) assert.deepEqual(allowedTargets('payment', s), [], s);
  for (const s of ['refused', 'cancelled', 'collected']) assert.deepEqual(allowedTargets('fulfilment', s), [], s);
});

test('OQ-D1: plan reasons - approved->non_executable and executing->non_executable list their reasons, supersession lists its own', () => {
  const preClaim = ['SUPPLIER_REFUSED', 'AUTHORIZATION_FAILED', 'AUTHORIZATION_EXPIRED', 'PAYMENT_CANCELLED', 'RESERVATION_EXPIRED', 'OUT_OF_STOCK', 'REQUEST_DELETED', 'DEMO_RESET'];
  for (const r of preClaim) assert.equal(canTransition('plan', 'approved', 'non_executable', r), true, r);
  assert.equal(canTransition('plan', 'approved', 'non_executable', 'CAPTURE_FAILED'), false, 'a capture cannot fail before the claim');
  for (const r of ['CAPTURE_FAILED', 'AUTHORIZATION_EXPIRED']) assert.equal(canTransition('plan', 'executing', 'non_executable', r), true, r);
  for (const r of ['SUPPLIER_REFUSED', 'RESERVATION_EXPIRED', 'OUT_OF_STOCK', 'PAYMENT_CANCELLED']) {
    assert.equal(canTransition('plan', 'executing', 'non_executable', r), false, `${r} cannot apply after the claim`);
  }
  const supersede = ['PRICE_CHANGED', 'PREP_FEE_CHANGED', 'READY_TIME_CHANGED', 'OFFER_WITHDRAWN', 'AVAILABILITY_DROPPED', 'REQUIREMENTS_CHANGED', 'REPLANNED'];
  assert.deepEqual([...SUPERSEDE_REASONS], supersede);
  for (const from of ['proposed', 'approved']) {
    for (const r of supersede) assert.equal(canTransition('plan', from, 'superseded', r), true, `${from} ${r}`);
    assert.equal(canTransition('plan', from, 'superseded', 'SUPPLIER_REFUSED'), false);
  }
  assert.deepEqual([...NON_EXECUTABLE_REASONS].sort(), [...new Set([...preClaim, 'CAPTURE_FAILED'])].sort());
  assert.equal(requiresReason('plan', 'approved', 'non_executable'), true);
  assert.equal(requiresReason('plan', 'proposed', 'approved'), false);
  assert.deepEqual(transitionReasons('plan', 'approved', 'executing'), true);
  assert.equal(transitionReasons('plan', 'executed', 'approved'), null);
  assert.throws(() => assertTransition('plan', 'approved', 'non_executable', 'CAPTURE_FAILED'), (e) => e.code === 'INVALID_STATE' && e.details.reason === 'CAPTURE_FAILED');
});

test('RS-36: unknown machines and states are refused without throwing a type error from lookups', () => {
  assert.throws(() => canTransition('nope', 'a', 'b'), RangeError);
  assert.equal(canTransition('plan', 'not-a-state', 'proposed'), false);
  assert.equal(canTransition('plan', '__proto__', 'proposed'), false);
  assert.equal(canTransition('plan', 'draft', 'constructor'), false);
  assert.throws(() => assertTransition('plan', undefined, 'proposed'), (e) => e.status === 409 && e.code === 'INVALID_STATE');
});

test('RS-36: the exported tables cannot be edited at run time', () => {
  assert.throws(() => { TABLES.plan.draft.superseded = true; }, TypeError);
  assert.throws(() => { TABLES.payment.captured.voided = true; }, TypeError);
  assert.throws(() => { TABLES.plan.approved.non_executable.push('X'); }, TypeError);
  assert.equal(canTransition('plan', 'draft', 'superseded'), false);
  allowedTargets('plan', 'draft').push('superseded'); // a returned list is a copy
  assert.deepEqual(allowedTargets('plan', 'draft'), ['proposed']);
});
