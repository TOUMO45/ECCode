// Phase F, task f3: the recovery UI. The pure view-model of "If something fails" (components/compensation.js) and the
// status header (components/status.js) are checked against the recovery fixtures in test/fixtures/contracts/recovery:
// the exact sentences, replanning with polling, outstanding voids and refunds with their outcome, the next-step
// buttons, plus the supplier refuse form, the admin faults and reset forms, the PayPal "not confirmed" notice
// (FU-43) and the corrected non-executable fixture (FU-38). A small fake document stands in for the browser's, so
// this runs under plain `node --test`.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { el, setDocument } from '../../../public/js/dom.js';
import { ApiError } from '../../../public/js/api.js';
import { parseRoute } from '../../../public/js/router.js';
import { EXACT, NEXT_STEP_FALLBACK, nextStepSentence, pricesChangedText } from '../../../public/js/texts.js';
import { createPoller, isTransient } from '../../../public/js/poll.js';
import { compensationOf, compensationSummary, failureModel } from '../../../public/js/components/compensation.js';
import { actionsModel, successText } from '../../../public/js/components/payments.js';
import { statusModel } from '../../../public/js/components/status.js';
import { buildRequestViewModel, mountRequestDetail, renderRequestPage, returnNoticeModel } from '../../../public/js/views/request-detail.js';
import {
  REFUSE_HINT, buildSupplierOrdersViewModel, mountSupplierOrders, refusedText, validateRefusalReason,
} from '../../../public/js/views/supplier-orders.js';
import {
  FAKE_MODEL_FAULTS, FAKE_PAYPAL_FAULTS, FAULT_KINDS, buildFaultBody, buildResetBody, faultFieldsFor, faultResultText, mountAdmin, resetResultModel,
} from '../../../public/js/views/admin.js';

// ---- a tiny fake document ------------------------------------------------------------------------------------------

class FakeText {
  constructor(data) { this.nodeType = 3; this.data = data; }
  get textContent() { return this.data; }
}

class FakeElement {
  constructor(tag) {
    this.nodeType = 1;
    this.tagName = tag.toUpperCase();
    this.attrs = new Map();
    this.children = [];
    this.listeners = {};
    this.value = '';
    this.checked = false;
  }
  setAttribute(name, value) { this.attrs.set(name, String(value)); }
  getAttribute(name) { return this.attrs.has(name) ? this.attrs.get(name) : null; }
  removeAttribute(name) { this.attrs.delete(name); }
  appendChild(child) {
    if (child instanceof FakeFragment) this.children.push(...child.children);
    else this.children.push(child);
    return child;
  }
  removeChild(child) { this.children = this.children.filter((c) => c !== child); return child; }
  get firstChild() { return this.children[0] ?? null; }
  set textContent(value) { this.children = [new FakeText(String(value))]; }
  get textContent() { return this.children.map((c) => c.textContent).join(''); }
  addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); }
  removeEventListener() {}
  focus() { this.focused = true; }
  async fire(type, extra = {}) {
    const event = { type, target: this, preventDefault() { this.prevented = true; }, ...extra };
    for (const fn of this.listeners[type] ?? []) await fn(event);
    return event;
  }
  walk(visit) {
    visit(this);
    for (const c of this.children) if (c instanceof FakeElement) c.walk(visit);
  }
  all(predicate) { const out = []; this.walk((n) => { if (predicate(n)) out.push(n); }); return out; }
  querySelectorAll(selector) {
    const tag = /^[a-z][a-z0-9]*$/.exec(selector);
    if (tag) return this.all((n) => n !== this && n.tagName === selector.toUpperCase());
    const m = /^\[data-testid(?:="(.*)")?\]$/.exec(selector);
    if (!m) throw new Error(`fake DOM: unsupported selector ${selector}`);
    return this.all((n) => n.getAttribute('data-testid') !== null && (m[1] === undefined || n.getAttribute('data-testid') === m[1]));
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
}

class FakeFragment extends FakeElement {
  constructor() { super('#fragment'); }
}

const fakeDocument = {
  hidden: false,
  activeElement: null,
  createElement: (tag) => new FakeElement(tag),
  createTextNode: (text) => new FakeText(text),
  createDocumentFragment: () => new FakeFragment(),
  addEventListener() {},
  removeEventListener() {},
};
setDocument(fakeDocument);

const byTestId = (root, id) => root.querySelector(`[data-testid="${id}"]`);
const allByTestId = (root, id) => root.querySelectorAll(`[data-testid="${id}"]`);
const textOf = (node) => (node ? node.textContent : null);
const tick = () => new Promise((resolve) => setImmediate(resolve));
const wrap = (nodes) => { const root = el('div'); for (const n of nodes) root.appendChild(n); return root; };

// ---- fixtures -------------------------------------------------------------------------------------------------------

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CONTRACTS = path.join(HERE, '..', '..', 'fixtures', 'contracts');
const RECOVERY = path.join(CONTRACTS, 'recovery');
const load = (dir, file) => JSON.parse(readFileSync(path.join(dir, file), 'utf8'));
const recovery = new Map(readdirSync(RECOVERY).filter((f) => f.endsWith('.json')).sort().map((f) => [f.replace(/\.json$/, ''), load(RECOVERY, f)]));
const view = (name) => structuredClone(recovery.get(name).response);
const contract = (name) => load(CONTRACTS, `${name}.json`);
const payment = (name) => structuredClone(load(path.join(CONTRACTS, 'payments'), `${name}.json`).response);
// the answer of GET /api/config for the Sandbox adapter (FU-54: the admin clean-up text depends on the adapter)
const SANDBOX_CONFIG = structuredClone(load(path.join(CONTRACTS, 'labels'), 'config-sandbox.json').response);
const VIEW_NAMES = [...recovery.keys()].filter((n) => n.startsWith('view-'));

const REQUEST_ID_RE = /^[A-Za-z0-9-]{8,64}$/;
const TS_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function apiError(code, status = 409, details = null) {
  return new ApiError({ kind: 'http', status, code, message: 'server text', requestId: 'req-test-00000001', details });
}

function baseCtx(api, extra = {}) {
  const announced = [];
  const container = el('main');
  return {
    announced,
    container,
    ctx: { api, container, storage: null, announce: (t) => announced.push(t), navigate() {}, assignLocation() {}, confirm: () => true, document: fakeDocument, ...extra },
  };
}

const NOOP_HANDLERS = { plan() {}, replan() {}, review() {}, approve() {}, reserve() {}, execute() {}, paypal() {}, abandon() {}, receipt() {}, remove() {} };

function walk(value, visit, key = '') {
  visit(value, key);
  if (Array.isArray(value)) value.forEach((v) => walk(v, visit, key));
  else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) walk(v, visit, k);
}

// ---- the fixtures themselves -----------------------------------------------------------------------------------------

test('RS-35: the recovery fixtures are RequestView answers (or route answers) that follow the shared conventions', () => {
  assert.ok(VIEW_NAMES.length >= 12, `expected the recovery views, found ${VIEW_NAMES.length}`);
  const keys = ['request', 'extraction', 'requirements', 'planning', 'plans', 'currentPlanId', 'reservation', 'orders', 'cancellingOrders', 'rescueStatus', 'labels', 'requestId'];
  for (const [name, fx] of recovery) {
    assert.match(fx.route, /^(GET|POST|PATCH|DELETE) \/api\/\S+$/, name);
    assert.ok(typeof fx.variant === 'string' && fx.variant.length > 20, `${name}: a variant that says what the state is`);
    if (fx.status < 400) {
      assert.match(fx.response.requestId, REQUEST_ID_RE, name);
    } else {
      assert.deepEqual(Object.keys(fx.response), ['error'], name);
      assert.match(fx.response.error.requestId, REQUEST_ID_RE, name);
    }
    walk(fx.response, (value, key) => {
      if (/Cents$/.test(key) && typeof value === 'number') assert.ok(Number.isInteger(value) && value >= 0, `${name}: ${key}`);
      if (/At$/.test(key) && typeof value === 'string' && key !== 'deadlineAt') assert.match(value, TS_RE, `${name}: ${key}`);
    });
  }
  for (const name of VIEW_NAMES) {
    const fx = recovery.get(name);
    assert.equal(fx.route, 'GET /api/requests/:id', name);
    assert.deepEqual(Object.keys(fx.response).filter((k) => k !== 'capabilities').sort(), [...keys].sort(), name);
    const rs = fx.response.rescueStatus;
    assert.deepEqual(Object.keys(rs).sort(), ['message', 'nextStep', 'rule', 'status', 'underlying'], name);
    // the underlying block mirrors the orders it describes
    for (const o of [...fx.response.orders, ...fx.response.cancellingOrders]) {
      const u = rs.underlying.payments.find((p) => p.orderId === o.id);
      assert.equal(u?.status, o.payment.status, `${name}: order ${o.id}`);
      assert.equal(o.payment.simulated, o.payment.provider === 'fake', name);
    }
  }
});

test('RS-35: the recovery fixtures cover each state the acceptance names', () => {
  const have = Object.fromEntries(VIEW_NAMES.map((n) => [n, view(n).rescueStatus]));
  assert.deepEqual([have['view-replanning'].status, have['view-replanning'].rule, have['view-replanning'].nextStep.code], ['replanning', '4a', 'WAIT']);
  assert.deepEqual([have['view-replan-manual'].status, have['view-replan-manual'].nextStep.code], ['replanning', 'REPLAN']);
  assert.deepEqual([have['view-prices-changed'].status, have['view-prices-changed'].nextStep.code], ['plan_found', 'REVIEW_NEW_PLAN']);
  assert.deepEqual([have['view-supplier-refused-new-plan'].status, have['view-supplier-refused-new-plan'].nextStep.code], ['plan_found', 'REVIEW_NEW_PLAN']);
  assert.equal(have['view-cancelling-voids'].status, 'cancelling');
  assert.equal(have['view-reservation-expired'].message, EXACT.RESERVATION_EXPIRED);
  assert.equal(have['view-failed-needs-attention'].status, 'failed_needs_attention');
  assert.equal(have['view-refunding'].status, 'refunding');
  assert.equal(have['view-all-refunded'].rule, '5a');
  assert.equal(have['view-authorization-declined'].nextStep.code, 'REPLAN_OR_OTHER_ACCOUNT');
});

test('RS-32: every recovery view draws all eight sections in order with the status first, and no raw machine code reaches the page', () => {
  for (const name of VIEW_NAMES) {
    const v = view(name);
    const vm = buildRequestViewModel(v);
    assert.deepEqual(vm.sectionOrder, ['status', 'need', 'why', 'rejected', 'total', 'commitments', 'failure', 'actions'], name);
    const root = wrap([renderRequestPage(vm, NOOP_HANDLERS)]);
    assert.equal(allByTestId(root, 'rescue-status').length, 1, name);
    assert.doesNotMatch(root.textContent, /\b(authorization_pending|refund_requested|cancel_requested|failed_needs_attention|CONTACT_ORGANISER|REVIEW_NEW_PLAN)\b/, `${name}: codes are shown as words`);
  }
});

// ---- exact sentences ---------------------------------------------------------------------------------------------------

test('RS-32: the exact sentences of the brief are constants and match what the server sends', () => {
  assert.equal(EXACT.REPLANNING, 'Finding a new plan with current stock…');
  assert.equal(EXACT.REVIEW_NEW_PLAN, 'Review the new plan');
  assert.equal(EXACT.REPLAN_WITH_CURRENT_STOCK, 'Re-plan with current stock');
  assert.equal(EXACT.REPLAN_OR_OTHER_ACCOUNT, 'Re-plan or try another PayPal account');
  assert.equal(EXACT.RESERVATION_EXPIRED, 'Reservation expired — no money was taken; re-plan with current stock');
  assert.equal(EXACT.CONTACT_ORGANISER, 'Contact the organiser');
  assert.equal(EXACT.ORDER_NOT_PAID, 'Cancelled — payment did not complete');
  assert.equal(pricesChangedText(2), 'Prices changed: review plan v2');
  // the fixtures hold the server's words; the constants are the same words
  assert.equal(view('view-replanning').rescueStatus.nextStep.text, EXACT.REPLANNING);
  assert.equal(view('view-prices-changed').rescueStatus.message, pricesChangedText(2));
  assert.equal(view('view-prices-changed').rescueStatus.nextStep.text, EXACT.REVIEW_NEW_PLAN);
  assert.equal(view('view-reservation-expired').rescueStatus.message, EXACT.RESERVATION_EXPIRED);
  assert.equal(view('view-failed-needs-attention').rescueStatus.nextStep.text, EXACT.CONTACT_ORGANISER);
  assert.equal(view('view-replan-manual').rescueStatus.nextStep.text, EXACT.REPLAN_WITH_CURRENT_STOCK);
  assert.equal(view('view-authorization-declined').rescueStatus.nextStep.text, EXACT.REPLAN_OR_OTHER_ACCOUNT);
});

test('RS-32: the next-step sentence is the server text, and a code with no text falls back to the brief’s sentence', () => {
  assert.equal(nextStepSentence({ code: 'REVIEW_NEW_PLAN', text: 'Anything the server says' }), 'Anything the server says');
  assert.equal(nextStepSentence({ code: 'REVIEW_NEW_PLAN', text: '' }), 'Review the new plan');
  assert.equal(nextStepSentence({ code: 'CONTACT_ORGANISER' }), 'Contact the organiser');
  assert.equal(nextStepSentence({ code: 'REPLAN_OR_OTHER_ACCOUNT', text: null }), 'Re-plan or try another PayPal account');
  assert.equal(nextStepSentence({ code: 'APPROVE_PLAN' }), '', 'no invented sentence for a code the table does not know');
  assert.deepEqual(Object.keys(NEXT_STEP_FALLBACK).sort(), ['CONTACT_ORGANISER', 'REPLAN', 'REPLAN_OR_OTHER_ACCOUNT', 'REVIEW_NEW_PLAN', 'WAIT']);
  const stripped = view('view-failed-needs-attention');
  stripped.rescueStatus.nextStep = { code: 'CONTACT_ORGANISER' };
  assert.equal(statusModel(stripped).nextStep.text, 'Contact the organiser');
});

// ---- replanning ---------------------------------------------------------------------------------------------------------

test('RS-32: replanning shows "Finding a new plan with current stock…", offers no button and keeps polling', () => {
  const v = view('view-replanning');
  const model = statusModel(v);
  assert.equal(model.status, 'replanning');
  assert.equal(model.statusText, 'Finding a new plan');
  assert.equal(model.replanning, true);
  assert.equal(model.replanningText, 'Finding a new plan with current stock…');
  assert.equal(model.nextStep.text, 'Finding a new plan with current stock…');
  assert.equal(model.action, null, 'the server is working: nothing for the user to press');
  assert.equal(isTransient(v), true);
  const root = wrap([renderRequestPage(buildRequestViewModel(v), NOOP_HANDLERS)]);
  assert.equal(textOf(byTestId(root, 'replanning')), 'Finding a new plan with current stock…');
  assert.equal(byTestId(root, 'next-step-action'), null);
  assert.equal(byTestId(root, 'replan'), null);
  assert.equal(actionsModel(v).replan, null);
  const actions = actionsModel(v);
  assert.deepEqual([actions.plan, actions.replan, actions.approve, actions.reserve, actions.paypal, actions.abandon, actions.execute, actions.receipts], [null, null, null, null, [], null, null, []],
    'no action competes with the search that is running');
  // the earlier plan is not shown as current
  assert.equal(failureModel(v).state, 'empty');
});

test('RS-32: the page keeps polling through replanning and stops once the new plan is waiting for review', async () => {
  const timers = [];
  let now = 0;
  const states = [view('view-replanning'), view('view-replanning'), view('view-prices-changed')];
  let loads = 0;
  const shown = [];
  const poller = createPoller({
    load: async () => states[Math.min(++loads, states.length - 1)],
    onData: (d) => shown.push(d.rescueStatus.status),
    isHidden: () => false,
    now: () => now,
    setTimer: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    clearTimer() {},
  });
  poller.start(states[0]);
  assert.equal(poller.active, true);
  assert.equal(timers.at(-1).ms, 2000);
  now = 2000;
  await timers.at(-1).fn();
  assert.equal(poller.active, true, 'still replanning');
  assert.equal(timers.at(-1).ms, 2000);
  now = 4000;
  await timers.at(-1).fn();
  assert.deepEqual(shown, ['replanning', 'plan_found']);
  assert.equal(poller.active, false, 'the new plan is waiting for the user: no more polling');
  poller.stop();
});

test('RS-32: after five failed drains the status is still replanning but the user starts it: Re-plan, no claim that a search is running', async () => {
  const v = view('view-replan-manual');
  const model = statusModel(v);
  assert.equal(model.replanning, false);
  assert.deepEqual(model.action, { kind: 'replan', label: 'Re-plan with current stock' });
  assert.equal(isTransient(v), true, 'the reconciler may still drain it, so the page keeps checking');
  const root = wrap([renderRequestPage(buildRequestViewModel(v), NOOP_HANDLERS)]);
  assert.equal(byTestId(root, 'replanning'), null);
  assert.equal(textOf(byTestId(root, 'next-step-action')), 'Re-plan with current stock');
  assert.equal(allByTestId(root, 'replan').length, 1, 'one Re-plan button in the Actions section');

  const calls = [];
  const api = {
    getRequest: async () => structuredClone(v),
    planRequest: async (id) => { calls.push(['plan', id]); return contract('plan-create-feasible').response; },
  };
  const { ctx, container, announced } = baseCtx(api);
  const page = mountRequestDetail(ctx, parseRoute('#/requests/14'));
  await tick();
  await byTestId(container, 'next-step-action').fire('click');
  await tick();
  page.dispose();
  assert.deepEqual(calls, [['plan', 14]]);
  assert.match(textOf(byTestId(container, 'success-replan')), /A new plan was found with current stock\. Review it below before you approve it\./);
  assert.ok(announced.some((t) => /Looking for a new plan/.test(t)), 'loading is announced');
});

// ---- review the new plan (price change, refusal) -----------------------------------------------------------------------

test('RS-13: "Prices changed: review plan v2" with a "Review the new plan" button, and the new plan can be approved', () => {
  const v = view('view-prices-changed');
  const model = statusModel(v);
  assert.equal(model.message, 'Prices changed: review plan v2');
  assert.equal(model.nextStep.text, 'Review the new plan');
  assert.deepEqual(model.action, { kind: 'review', label: 'Review the new plan' });
  assert.equal(isTransient(v), false, 'nothing is changing by itself: the user reads and approves');
  const actions = actionsModel(v);
  assert.deepEqual([actions.approve.planId, actions.approve.expectedTotalCents, actions.approve.label, actions.approve.blockedReason],
    [22, 8600, 'Approve plan ($86.00)', null], 'the new version is approved with its own hash and total');
  assert.notEqual(actions.approve.planHash, v.plans.find((p) => p.id === 21).planHash);
  const calls = [];
  const root = wrap([renderRequestPage(buildRequestViewModel(v), { ...NOOP_HANDLERS, review: () => calls.push('review'), approve: (a) => calls.push(['approve', a.planId]) })]);
  assert.equal(textOf(byTestId(root, 'rescue-message')), 'Prices changed: review plan v2');
  assert.equal(textOf(byTestId(root, 'next-step')), 'Review the new plan');
  assert.equal(textOf(byTestId(root, 'next-step-action')), 'Review the new plan');
  byTestId(root, 'next-step-action').listeners.click[0]({});
  byTestId(root, 'approve-plan').listeners.click[0]({});
  assert.deepEqual(calls, ['review', ['approve', 22]]);
  // the old version is shown as replaced, with no live order or compensation
  assert.equal(failureModel(v).state, 'empty');
  assert.equal(failureModel(v).nextStepText, 'Review the new plan');
});

test('RS-17: after a supplier refusal the buyer sees the refusal in the message and "Review the new plan", and may approve the new plan', () => {
  const v = view('view-supplier-refused-new-plan');
  const model = statusModel(v);
  assert.equal(model.message, 'Supplier A refused the order: Out of lids. No money was taken.');
  assert.equal(model.nextStep.text, EXACT.REVIEW_NEW_PLAN);
  assert.equal(model.action.kind, 'review');
  assert.equal(actionsModel(v).approve.planId, 22);
  assert.deepEqual(v.plans.find((p) => p.id === 22).body.suppliers.map((s) => s.supplierCode), ['B'], 'the new plan leaves the refusing supplier out');
  const root = wrap([renderRequestPage(buildRequestViewModel(v), NOOP_HANDLERS)]);
  assert.match(textOf(byTestId(root, 'rescue-message')), /Out of lids\. No money was taken\./);
});

test('RS-17: a refusal reason from a supplier is text on the buyer’s page, never markup', () => {
  const v = view('view-cancelling-voids');
  const hostile = '<img src=x onerror=alert(1)> رسالة';
  v.cancellingOrders[0].refusalReason = hostile;
  const root = wrap([renderRequestPage(buildRequestViewModel(v), NOOP_HANDLERS)]);
  const node = byTestId(root, 'failure-A-earlier-refusal');
  assert.equal(node.textContent, `Reason the supplier gave: ${hostile}`);
  // FU-58: the supplier's words sit in their own <bdi dir="auto"> isolate, below which there are only text nodes
  const isolates = node.children.filter((c) => !(c instanceof FakeText));
  assert.deepEqual(isolates.map((c) => c.tagName), ['BDI']);
  assert.equal(isolates[0].getAttribute('dir'), 'auto');
  assert.equal(isolates[0].textContent, hostile);
  assert.ok(isolates[0].children.every((c) => c instanceof FakeText), 'only text nodes below it');
  assert.equal(root.all((n) => n.tagName === 'IMG').length, 0);
});

// ---- cancelling: voids outstanding --------------------------------------------------------------------------------------

test('RS-17: cancelling lists each older order with its payment text, the void still outstanding, the one that finished, and the next step', () => {
  const v = view('view-cancelling-voids');
  assert.equal(isTransient(v), true, 'cancelling polls');
  const model = failureModel(v);
  assert.equal(model.state, 'ready');
  assert.deepEqual(model.rows.map((r) => [r.testid, r.earlierPlan, r.paymentText, r.compensation.state, r.compensation.kind]), [
    ['failure-A-earlier', true, 'Authorized — no money taken yet', 'in_progress', 'void'],
    ['failure-B-earlier', true, 'Authorization voided — no money taken', 'done', 'void'],
  ]);
  assert.equal(model.rows[0].compensation.text, 'Void queued — the authorization is being released; no money has been taken');
  assert.equal(model.rows[1].compensation.text, 'Authorization voided — no money was taken');
  assert.equal(model.rows[0].refusalReason, 'Out of lids');
  assert.deepEqual([model.summary.voids, model.summary.refunds],
    [{ outstanding: 1, done: 1, failed: 0 }, { outstanding: 0, done: 0, failed: 0 }]);
  assert.equal(model.summary.text, 'Voids: 1 outstanding, 1 done. Refunds: 0 outstanding, 0 done.');
  assert.equal(model.nextStepText, 'Please wait: this page updates by itself');
  const root = wrap([renderRequestPage(buildRequestViewModel(v), NOOP_HANDLERS)]);
  assert.equal(allByTestId(root, 'compensation').length, 2);
  assert.match(textOf(allByTestId(root, 'compensation')[0]), /^Compensation: Void queued/);
  assert.equal(allByTestId(root, 'compensation')[0].getAttribute('data-state'), 'in_progress');
  assert.equal(textOf(byTestId(root, 'compensation-summary')), 'Voids: 1 outstanding, 1 done. Refunds: 0 outstanding, 0 done.');
  assert.match(textOf(byTestId(root, 'failure-A-earlier-refusal')), /Reason the supplier gave: Out of lids/);
  assert.match(textOf(byTestId(root, 'failure-next-step')), /Next step: Please wait: this page updates by itself/);
  assert.equal(textOf(byTestId(root, 'rescue-message')), 'Cancelling the previous plan: outstanding payments are being cancelled.');
  assert.equal(byTestId(root, 'next-step-action'), null, 'nothing to press while the voids finish');
});

test('RS-17: compensation text says what the view says: void queued, cancelled before authorization, declined, refund queued, failures', () => {
  const order = (payment) => ({ payment });
  assert.deepEqual(compensationOf(order({ status: 'voided', voidedLocally: true })), { state: 'done', kind: 'void', text: 'Cancelled before authorization — no money was taken' });
  assert.deepEqual(compensationOf(order({ status: 'authorization_failed' })), { state: 'done', kind: null, text: 'PayPal declined — no money was taken' });
  assert.equal(compensationOf(order({ status: 'authorized', cancelRequested: true })).state, 'in_progress');
  assert.deepEqual(compensationOf(order({ status: 'captured', cancelRequested: true })), { state: 'in_progress', kind: 'refund', text: 'Refund queued — the captured payment is being returned' });
  assert.deepEqual(compensationOf(order({ status: 'refund_requested' })), { state: 'in_progress', kind: 'refund', text: 'Refund in progress' });
  assert.deepEqual(compensationOf(order({ status: 'refund_pending' })), { state: 'in_progress', kind: 'refund', text: 'Refund in progress' });
  assert.deepEqual(compensationOf(order({ status: 'authorized', voidFailed: true, cancelRequested: true })),
    { state: 'failed', kind: 'void', text: 'Voiding the authorization failed — contact the organiser' });
  assert.deepEqual(compensationOf(order({ status: 'refund_failed' })), { state: 'failed', kind: 'refund', text: 'Refund failed — contact the organiser' });
  assert.deepEqual(compensationOf(order({ status: 'approved', cancelRequested: true })), { state: 'in_progress', kind: 'void', text: 'Cancelling — waiting for PayPal' });
  assert.deepEqual(compensationOf(order({ status: 'captured' })), { state: 'none', kind: null, text: 'Nothing to undo' });
  assert.deepEqual(compensationOf(order({ status: 'created' })), { state: 'none', kind: null, text: 'Nothing to undo' });
});

test('RS-17: the summary counts voids and refunds, outstanding, done and failed', () => {
  const row = (state, kind) => ({ compensation: { state, kind } });
  const s = compensationSummary([row('in_progress', 'void'), row('done', 'void'), row('in_progress', 'refund'), row('failed', 'refund'), row('none', null)]);
  assert.deepEqual([s.voids, s.refunds, s.failed], [{ outstanding: 1, done: 1, failed: 0 }, { outstanding: 1, done: 0, failed: 1 }, 1]);
  assert.equal(s.text, 'Voids: 1 outstanding, 1 done. Refunds: 1 outstanding, 0 done. 1 failed: Contact the organiser.');
});

// ---- expired reservation, abandon, decline ---------------------------------------------------------------------------------

test('RS-15: an expired reservation shows its sentence and one Re-plan button, and Re-plan works', async () => {
  const v = view('view-reservation-expired');
  const model = statusModel(v);
  assert.equal(model.expired, true);
  assert.equal(model.message, 'Reservation expired — no money was taken; re-plan with current stock');
  assert.equal(model.action, null, 'the notice carries the one Re-plan button');
  assert.equal(actionsModel(v).replan, null, 'and the Actions section does not repeat it');
  const root = wrap([renderRequestPage(buildRequestViewModel(v), NOOP_HANDLERS)]);
  assert.equal(textOf(byTestId(root, 'reservation-expired').children[0]), 'Reservation expired — no money was taken; re-plan with current stock');
  assert.equal(allByTestId(root, 'replan').length, 1);
  assert.equal(textOf(byTestId(root, 'replan')), 'Re-plan');
  // both operations were cancelled before any authorization, so there is nothing outstanding
  const f = failureModel(v);
  assert.deepEqual(f.rows.map((r) => r.compensation.text), ['Cancelled before authorization — no money was taken', 'Cancelled before authorization — no money was taken']);
  assert.equal(f.summary.voids.outstanding + f.summary.refunds.outstanding, 0);
  assert.equal(isTransient(v), false);

  const calls = [];
  let loads = 0;
  const api = {
    getRequest: async () => { loads += 1; return structuredClone(v); },
    planRequest: async (id) => { calls.push(id); return recovery.get('plan-replan-feasible').response; },
  };
  const { ctx, container, announced } = baseCtx(api);
  const page = mountRequestDetail(ctx, parseRoute('#/requests/14'));
  await tick();
  assert.equal(loads, 1);
  await byTestId(container, 'replan').fire('click');
  await tick();
  page.dispose();
  assert.deepEqual(calls, [14]);
  assert.equal(loads, 2, 'the page reloads after the plan route answered');
  assert.match(textOf(byTestId(container, 'success-replan')), /A new plan was found with current stock/);
  assert.ok(announced.some((t) => /A new plan was found/.test(t)));
});

test('RS-15: a Re-plan the server refuses shows the error with what to do next, and the page shows what is true now', async () => {
  const v = view('view-reservation-expired');
  let loads = 0;
  const api = {
    getRequest: async () => { loads += 1; return structuredClone(v); },
    planRequest: async () => { throw apiError('PLAN_IN_PROGRESS'); },
  };
  const { ctx, container } = baseCtx(api);
  const page = mountRequestDetail(ctx, parseRoute('#/requests/14'));
  await tick();
  await byTestId(container, 'replan').fire('click');
  await tick();
  page.dispose();
  assert.match(textOf(byTestId(container, 'state-error')), /A plan for this request is already being carried out\./);
  assert.match(textOf(byTestId(container, 'state-error')), /Wait for it to finish\./);
  assert.match(textOf(byTestId(container, 'state-error')), /Request id: req-test-00000001/);
  assert.equal(byTestId(container, 'success-replan'), null, 'never a success line after a refusal');
  assert.equal(loads, 2);
});

test('RS-15: Re-plan with nothing feasible says so honestly instead of promising a plan', () => {
  assert.match(successText('replan', { plan: null }), /No plan fits the stock available now/);
  assert.match(successText('replan', { plan: { id: 22 } }), /^A new plan was found with current stock\./);
  assert.match(successText('plan', { plan: { id: 22 } }), /^A plan was found\./);
});

test('FU-38: a real abandon cancels the orders; "Cancelled — payment did not complete" belongs to the post-claim state only', () => {
  const abandoned = view('view-abandoned');
  assert.ok(abandoned.orders.every((o) => o.presentation === 'cancelled' && o.fulfilmentStatus === 'cancelled'));
  const rows = failureModel(abandoned).rows;
  assert.ok(rows.every((r) => r.notPaid === false && r.presentationText === 'Cancelled'), 'an abandon is plainly Cancelled');
  assert.equal(statusModel(abandoned).message, 'The purchase was abandoned. No money was taken; re-plan with current stock');
  assert.deepEqual(statusModel(abandoned).action, { kind: 'replan', label: 'Re-plan with current stock' });

  const nonExecutable = payment('view-non-executable');
  const fx = load(path.join(CONTRACTS, 'payments'), 'view-non-executable.json');
  assert.doesNotMatch(fx.variant, /was abandoned, so the plan/, 'the fixture no longer says the abandon produced this state');
  assert.match(fx.variant, /FU-38/);
  assert.match(fx.variant, /NOT an abandon/);
  assert.equal(nonExecutable.plans[0].nonExecutableReason, 'AUTHORIZATION_EXPIRED');
  assert.notEqual(nonExecutable.plans[0].nonExecutableReason, 'PAYMENT_CANCELLED');
  assert.ok(nonExecutable.orders.every((o) => o.presentation === 'cancelled_payment_incomplete' && o.fulfilmentStatus === 'confirmed'));
  assert.deepEqual([nonExecutable.rescueStatus.nextStep.code, nonExecutable.rescueStatus.nextStep.text], ['REPLAN_OR_OTHER_ACCOUNT', 'Re-plan or try another PayPal account']);
  assert.ok(failureModel(nonExecutable).rows.every((r) => r.notPaid && r.presentationText === 'Cancelled — payment did not complete'));
});

test('RS-18: a declined authorization says so, offers Re-plan or another PayPal account, and shows that nothing was taken', () => {
  const v = view('view-authorization-declined');
  const model = statusModel(v);
  assert.match(model.message, /^PayPal declined the payment for Supplier A\. No money was taken; other authorizations were voided\. Re-plan or try another PayPal account$/);
  assert.deepEqual(model.action, { kind: 'replan', label: 'Re-plan or try another PayPal account' });
  const rows = failureModel(v).rows;
  assert.deepEqual(rows.map((r) => [r.supplierCode, r.compensation.text]), [
    ['A', 'PayPal declined — no money was taken'],
    ['B', 'Authorization voided — no money was taken'],
  ]);
  const calls = [];
  const root = wrap([renderRequestPage(buildRequestViewModel(v), { ...NOOP_HANDLERS, replan: () => calls.push('replan') })]);
  assert.equal(textOf(byTestId(root, 'next-step-action')), 'Re-plan or try another PayPal account');
  byTestId(root, 'next-step-action').listeners.click[0]({});
  assert.deepEqual(calls, ['replan']);
});

// ---- failed_needs_attention --------------------------------------------------------------------------------------------------

test('RS-22: failed_needs_attention says "Contact the organiser", names the request to quote and offers no action that could make it worse', () => {
  const v = view('view-failed-needs-attention');
  const model = statusModel(v);
  assert.equal(model.statusText, 'Needs the organiser’s attention');
  assert.equal(model.nextStep.text, 'Contact the organiser');
  assert.equal(model.action, null);
  assert.deepEqual(model.attention, { text: 'Contact the organiser', detail: 'Quote request #14 when you do. The organiser can see what is still open.' });
  assert.equal(isTransient(v), false);
  const f = failureModel(v);
  assert.deepEqual(f.rows.map((r) => [r.supplierCode, r.compensation.state, r.compensation.text]), [
    ['A', 'failed', 'Voiding the authorization failed — contact the organiser'],
    ['B', 'failed', 'Refund failed — contact the organiser'],
  ]);
  assert.equal(f.summary.failed, 2);
  assert.equal(f.summary.text, 'Voids: 0 outstanding, 0 done. Refunds: 0 outstanding, 0 done. 2 failed: Contact the organiser.');
  const root = wrap([renderRequestPage(buildRequestViewModel(v), NOOP_HANDLERS)]);
  assert.equal(textOf(byTestId(root, 'rescue-status')), 'Needs the organiser’s attention');
  assert.match(textOf(byTestId(root, 'contact-organiser')), /^Contact the organiser/);
  assert.equal(byTestId(root, 'contact-organiser').getAttribute('role'), 'alert');
  assert.equal(textOf(byTestId(root, 'next-step')), 'Contact the organiser');
  assert.equal(byTestId(root, 'next-step-action'), null);
  assert.deepEqual(actionsModel(v).paypal, []);
  assert.equal(actionsModel(v).replan, null);
  assert.deepEqual([actionsModel(v).plan, actionsModel(v).approve, actionsModel(v).reserve, actionsModel(v).execute, actionsModel(v).abandon], [null, null, null, null, null]);
  assert.equal(allByTestId(root, 'compensation')[0].getAttribute('data-state'), 'failed');
});

// ---- refunds after execution ---------------------------------------------------------------------------------------------------

test('RS-38: a refund in progress is shown as in progress, never as returned, and the page keeps polling', () => {
  const v = view('view-refunding');
  const model = statusModel(v);
  assert.equal(model.statusText, 'Refunding');
  assert.equal(isTransient(v), true);
  const f = failureModel(v);
  assert.deepEqual(f.rows.map((r) => [r.supplierCode, r.paymentText, r.compensation.state, r.compensation.text]), [
    ['A', 'Refund in progress', 'in_progress', 'Refund in progress'],
    ['B', 'Paid', 'none', 'Nothing to undo'],
  ]);
  assert.deepEqual(f.summary.refunds, { outstanding: 1, done: 0, failed: 0 });
  assert.doesNotMatch(wrap([renderRequestPage(buildRequestViewModel(v), NOOP_HANDLERS)]).textContent, /Refunded in full|were refunded|was refunded/);
});

test('RS-38: a refunded order is named, and when every payment was refunded the status reads cancelled with the organiser’s sentence', () => {
  const one = view('view-order-refunded');
  assert.equal(statusModel(one).message, 'Order from Supplier A was refunded by the organiser');
  assert.deepEqual(failureModel(one).rows.map((r) => [r.supplierCode, r.presentationText, r.compensation.text]), [
    ['A', 'Refunded', 'Refunded in full'],
    ['B', 'Active', 'Nothing to undo'],
  ]);
  const all = view('view-all-refunded');
  const model = statusModel(all);
  assert.equal(model.statusText, 'Cancelled');
  assert.equal(model.message, 'All payments were refunded by the organiser');
  assert.equal(model.message, EXACT.ALL_REFUNDED);
  assert.equal(model.action, null);
  assert.deepEqual(failureModel(all).summary.refunds, { outstanding: 0, done: 2, failed: 0 });
  assert.equal(isTransient(all), false);
});

test('RS-34: honest labels - "Refunded" only for a refunded payment, "no money was taken" never for a captured one', () => {
  for (const name of [...VIEW_NAMES, 'payments/view-non-executable']) {
    const v = name.startsWith('payments/') ? payment(name.slice(9)) : view(name);
    for (const row of failureModel(v).rows) {
      const order = [...v.orders, ...v.cancellingOrders].find((o) => o.id === row.orderId);
      const status = order.payment.status;
      if (/Refunded in full/.test(row.compensation.text)) assert.equal(status, 'refunded', `${name}: ${row.testid}`);
      if (/no money (was|has been) taken/.test(row.compensation.text)) assert.ok(['voided', 'authorization_failed', 'authorized'].includes(status), `${name}: ${row.testid}: ${status}`);
      if (/no money (was|has been) taken/.test(row.paymentText)) assert.ok(['voided', 'authorization_failed', 'authorized'].includes(status), `${name}: ${row.testid} payment text`);
      if (status === 'captured' && !order.payment.cancelRequested) assert.equal(row.compensation.state, 'none', `${name}: a captured payment with no cancellation has nothing to undo`);
    }
  }
});

// ---- FU-40: the receipt appears without a reload ---------------------------------------------------------------------------------

test('FU-40: after the purchase the page keeps checking while a supplier still has to mark the order ready', () => {
  const ready = payment('view-ready-receipt');
  assert.equal(isTransient(ready), false, 'ready for pickup: the receipt button is already there');
  const waiting = payment('view-ready-receipt');
  waiting.orders[0].fulfilmentStatus = 'confirmed';
  assert.equal(isTransient(waiting), true, 'executed, one order still confirmed: poll');
  waiting.orders[0].presentation = 'refunded';
  assert.equal(isTransient(waiting), false, 'a refunded order is not waited for');
  const collected = payment('view-ready-receipt');
  for (const o of collected.orders) o.fulfilmentStatus = 'collected';
  assert.equal(isTransient(collected), false);
});

// ---- FU-43: PayPal did not confirm the approval ----------------------------------------------------------------------------------

test('FU-43: not_approved and check_failed show one neutral sentence and no claim about money', () => {
  const v = payment('view-approve-simulated');
  for (const paypal of ['not_approved', 'check_failed']) {
    const notice = returnNoticeModel({ paypal, order: '31' }, v);
    assert.equal(notice.testid, 'paypal-not-confirmed');
    assert.equal(notice.tone, 'warn');
    assert.equal(notice.text, 'PayPal did not confirm the approval; try again. Supplier A is still waiting for your approval.');
    assert.doesNotMatch(notice.text, /paid|charged|refund|money|captured/i);
    const page = buildRequestViewModel(v, { query: { paypal, order: '31' } });
    assert.equal(page.returnNotice.testid, 'paypal-not-confirmed');
    const root = wrap([renderRequestPage(page, NOOP_HANDLERS)]);
    assert.equal(textOf(byTestId(root, 'paypal-not-confirmed')).startsWith(EXACT.PAYPAL_NOT_CONFIRMED), true);
    // the approve button is still on the page, so "try again" is something the buyer can do
    assert.equal(textOf(byTestId(root, 'paypal-approve-A')), 'Approve with PayPal — Supplier A');
  }
  assert.equal(returnNoticeModel({ paypal: 'not_approved' }, v).text, 'PayPal did not confirm the approval; try again.', 'no order named: the plain sentence');
});

test('FU-43: the notice goes once the order has moved on or the plan is over, and unknown outcomes show nothing', () => {
  const approved = payment('view-complete-purchase');
  assert.equal(returnNoticeModel({ paypal: 'not_approved', order: String(approved.orders[0].id) }, approved), null, 'already approved since');
  assert.equal(returnNoticeModel({ paypal: 'check_failed', order: '31' }, payment('view-ready-receipt')), null, 'executed');
  assert.equal(returnNoticeModel({ paypal: 'check_failed', order: '31' }, payment('view-non-executable')), null, 'non_executable');
  assert.equal(returnNoticeModel({ paypal: 'something_else', order: '31' }, payment('view-approve-simulated')), null);
  assert.equal(returnNoticeModel({}, payment('view-approve-simulated')), null);
});

// ---- the supplier refuse form ------------------------------------------------------------------------------------------------------

test('RS-17: the refuse reason is 1 to 300 characters after trimming, and the form says who sees it', () => {
  assert.equal(validateRefusalReason(''), 'Say why you are refusing.');
  assert.equal(validateRefusalReason('   '), 'Say why you are refusing.');
  assert.equal(validateRefusalReason(undefined), 'Say why you are refusing.');
  assert.equal(validateRefusalReason('x'), null);
  assert.equal(validateRefusalReason('x'.repeat(300)), null);
  assert.equal(validateRefusalReason(`  ${'x'.repeat(300)}  `), null, 'the server gets the trimmed text');
  assert.equal(validateRefusalReason('x'.repeat(301)), 'Use at most 300 characters.');
  assert.match(REFUSE_HINT, /The buyer sees this reason\./);
  assert.match(REFUSE_HINT, /no money is taken/);
  assert.equal(refusedText('R12-V1'), 'Order R12-V1 is refused. The buyer is shown your reason and a new plan is being made without you.');
});

test('RS-17: the refuse form is on an open order only, is labelled, limits the field to 300 and has no confirm-free path for an empty reason', async () => {
  const answer = contract('supplier-orders').response;
  const model = buildSupplierOrdersViewModel(answer);
  const open = model.cards.find((c) => c.id === 31);
  const cancelled = model.cards.find((c) => c.id === 27);
  assert.deepEqual(open.actions.refuse, { maxLength: 300 });
  assert.equal(cancelled.actions.refuse, null, 'no refusal for an order of a cancelled plan');
  assert.equal(cancelled.statusText, 'Cancelled — payment did not complete');

  const calls = [];
  const api = {
    listSupplierOrders: async () => structuredClone(answer),
    refuseSupplierOrder: async (id, reason) => { calls.push([id, reason]); return contract('supplier-order-refuse').response; },
  };
  const { ctx, container, announced } = baseCtx(api);
  mountSupplierOrders(ctx, parseRoute('#/supplier/orders'));
  await tick();
  const reason = byTestId(container, 'refuse-form-order-31').all((n) => n.tagName === 'TEXTAREA')[0];
  assert.equal(reason.getAttribute('maxlength'), '300');
  assert.equal(reason.getAttribute('required'), '');
  const label = container.all((n) => n.tagName === 'LABEL' && n.getAttribute('for') === reason.getAttribute('id'))[0];
  assert.equal(textOf(label), 'Reason for refusing (1 to 300 characters)');
  assert.match(reason.getAttribute('aria-describedby'), /hint/);
  assert.match(container.textContent, /The buyer sees this reason\./);
  assert.equal(byTestId(container, 'refuse-order-27'), null);

  reason.value = '   ';
  await byTestId(container, 'refuse-form-order-31').fire('submit');
  assert.deepEqual(calls, [], 'blank is not sent');
  assert.equal(textOf(byTestId(container, 'form-problem')), 'Say why you are refusing.');
  assert.equal(byTestId(container, 'form-problem').getAttribute('role'), 'alert');
  reason.value = 'x'.repeat(301);
  await byTestId(container, 'refuse-form-order-31').fire('submit');
  assert.deepEqual(calls, []);
  assert.equal(textOf(byTestId(container, 'form-problem')), 'Use at most 300 characters.');

  reason.value = '  Out of cups today  ';
  await byTestId(container, 'refuse-form-order-31').fire('submit');
  await tick();
  assert.deepEqual(calls, [[31, 'Out of cups today']]);
  assert.equal(textOf(byTestId(container, 'action-done')), 'Order R12-V1 is refused. The buyer is shown your reason and a new plan is being made without you.');
  assert.ok(announced.includes('Refusing the order…'), 'loading is announced');
  assert.ok(announced.some((t) => /is refused/.test(t)), 'and so is the outcome');
});

test('RS-17: a refusal after execution started is refused by the server, and the supplier is told why and that nothing changed', async () => {
  const answer = contract('supplier-orders').response;
  const fx = recovery.get('supplier-order-refuse-executed');
  assert.equal(fx.status, 409);
  const api = {
    listSupplierOrders: async () => structuredClone(answer),
    refuseSupplierOrder: async () => { throw new ApiError({ kind: 'http', status: 409, ...fx.response.error }); },
  };
  const { ctx, container } = baseCtx(api);
  mountSupplierOrders(ctx, parseRoute('#/supplier/orders'));
  await tick();
  byTestId(container, 'refuse-form-order-31').all((n) => n.tagName === 'TEXTAREA')[0].value = 'Out of cups today';
  await byTestId(container, 'refuse-form-order-31').fire('submit');
  await tick();
  assert.match(textOf(byTestId(container, 'state-error')), /The buyer has already completed this purchase\./);
  assert.match(textOf(byTestId(container, 'state-error')), /It can no longer be refused\./);
  assert.equal(byTestId(container, 'action-done'), null, 'never a success line after a refusal');
  assert.equal(byTestId(container, 'orders-list') !== null, true, 'the list is shown again');
});

// ---- the admin screen ----------------------------------------------------------------------------------------------------------------

test('RS-32: the fault form offers stock depletion, supplier refusal, refund order, fake PayPal and fake model faults, and clear', () => {
  assert.deepEqual(FAULT_KINDS.map(([k]) => k), ['stock_depletion', 'supplier_refusal', 'refund_order', 'fake_paypal', 'fake_model', 'clear']);
  assert.ok(FAKE_PAYPAL_FAULTS.includes('authorize_denied') && FAKE_PAYPAL_FAULTS.includes('capture_declined') && FAKE_PAYPAL_FAULTS.includes('lost_response:capture'));
  assert.ok(!FAKE_PAYPAL_FAULTS.some((f) => /freeze|crash_after|capture_lands/.test(f)), 'test-only faults need RS_TEST_HOOKS and are not offered');
  assert.deepEqual(FAKE_MODEL_FAULTS, ['timeout', 'invalid_json', 'schema_invalid', 'error']);
  // each route fixture's request is a body the form can build
  const bodies = [
    ['stock_depletion', { supplierCode: 'B' }], ['supplier_refusal', { supplierCode: 'A', reason: 'Out of lids' }], ['refund_order', { supplierOrderId: '31' }],
    ['fake_paypal', { fault: 'authorize_denied', supplierCode: 'A', count: '2' }], ['fake_model', { fault: 'timeout', count: '1' }], ['clear', {}],
  ];
  const requests = new Map([
    ['stock_depletion', contract('admin-faults').request],
    ['supplier_refusal', recovery.get('admin-fault-supplier-refusal').request],
    ['refund_order', recovery.get('admin-fault-refund-order').request],
    ['fake_paypal', recovery.get('admin-fault-fake-paypal').request],
    ['fake_model', recovery.get('admin-fault-fake-model').request],
    ['clear', recovery.get('admin-fault-clear').request],
  ]);
  for (const [kind, values] of bodies) {
    const built = buildFaultBody(kind, values);
    assert.equal(built.ok, true, kind);
    assert.deepEqual(built.body, requests.get(kind), kind);
  }
});

test('RS-32: each fault kind shows only its own controls, and the answer is described without promising a result the server did not give', () => {
  assert.deepEqual(faultFieldsFor('stock_depletion'), ['supplier']);
  assert.deepEqual(faultFieldsFor('supplier_refusal'), ['supplier', 'reason']);
  assert.deepEqual(faultFieldsFor('refund_order'), ['order']);
  assert.deepEqual(faultFieldsFor('fake_paypal'), ['paypalFault', 'supplier', 'count']);
  assert.deepEqual(faultFieldsFor('fake_model'), ['modelFault', 'count']);
  assert.deepEqual(faultFieldsFor('clear'), []);
  assert.deepEqual(faultFieldsFor('nonsense'), []);

  assert.equal(faultResultText(contract('admin-faults').response), 'Every offer of supplier B was withdrawn. Plan versions replaced: 21.');
  assert.equal(faultResultText(recovery.get('admin-fault-supplier-refusal').response), 'Supplier A refused 1 open order (31).');
  assert.equal(faultResultText({ applied: { kind: 'supplier_refusal', supplierCode: 'C', supplierOrderIds: [] } }), 'Supplier C had no open order to refuse.');
  const refund = faultResultText(recovery.get('admin-fault-refund-order').response);
  assert.match(refund, /^A refund was requested for supplier order 31\./);
  assert.match(refund, /not complete until PayPal confirms it/);
  assert.doesNotMatch(refund, /refunded/i);
  assert.equal(faultResultText(recovery.get('admin-fault-fake-paypal').response), 'Simulated PayPal fault authorize_denied for supplier A, 2 times is set.');
  assert.equal(faultResultText(recovery.get('admin-fault-fake-model').response), 'Simulated AI fault timeout, 1 time is set.');
  assert.equal(faultResultText(recovery.get('admin-fault-clear').response), 'All simulated faults were cleared.');
});

test('RS-30: a forced reset needs a reason of 10 to 500 characters, an ordinary reset sends none, and a stranded operation is listed for clean-up', () => {
  assert.deepEqual(buildResetBody({ force: false, reason: 'ignored' }), { ok: true, body: {}, error: null });
  assert.equal(buildResetBody({ force: true, reason: 'too short' }).ok, false);
  assert.equal(buildResetBody({ force: true, reason: 'x'.repeat(501) }).ok, false);
  assert.deepEqual(buildResetBody({ force: true, reason: '  Demo retake before the judging session ' }).body, { force: true, reason: 'Demo retake before the judging session' });
  assert.deepEqual(resetResultModel(contract('admin-reset').response), {
    text: 'The demo was reset. 2 payment operations were archived.', strandedIntro: null, stranded: [],
  });
  const stranded = resetResultModel(recovery.get('admin-reset-forced-stranded').response, SANDBOX_CONFIG);
  assert.equal(stranded.text, 'The demo was reset. 3 payment operations were archived.');
  assert.deepEqual(stranded.stranded, [{ text: 'Operation 42: unknown, plan non executable' }]); // FU-54: the contract fixture now carries planStatus
  // FU-54: only the Sandbox adapter has a dashboard to check; the fake provider's records are gone with the reset
  assert.match(stranded.strandedIntro, /PayPal Sandbox dashboard/);
  assert.doesNotMatch(resetResultModel(recovery.get('admin-reset-forced-stranded').response, contract('config').response).strandedIntro, /PayPal Sandbox dashboard/);
  const withIds = resetResultModel({ archivedOperations: 1, stranded: [{ id: 7, status: 'authorized', providerAuthorizationId: 'AUTH-7', providerCaptureId: 'CAP-7' }] });
  assert.deepEqual(withIds.stranded, [{ text: 'Operation 7: authorized, authorization AUTH-7, capture CAP-7' }]);
});

test('RS-30: the admin screen hides the controls of other kinds, shows what each fault did, and lists operations a forced reset could not settle', async () => {
  const calls = [];
  const api = {
    getTimeline: async () => contract('admin-timeline').response,
    getMetrics: async () => contract('admin-metrics').response,
    resetDemo: async (b) => { calls.push(['reset', b]); return recovery.get('admin-reset-forced-stranded').response; },
    applyFault: async (b) => {
      calls.push(['fault', b]);
      if (b.kind === 'refund_order') throw new ApiError({ kind: 'http', status: 409, ...recovery.get('admin-fault-refund-order-invalid-state').response.error });
      if (b.kind === 'supplier_refusal') return recovery.get('admin-fault-supplier-refusal').response;
      return recovery.get('admin-fault-clear').response;
    },
  };
  const { ctx, container, announced } = baseCtx(api, { config: SANDBOX_CONFIG });
  mountAdmin(ctx, parseRoute('#/admin'));
  await tick();
  const rowOf = (testid) => container.all((n) => n.getAttribute('class') === 'form-row' && n.children.some((c) => c.getAttribute?.('data-testid') === testid))[0];
  const hidden = (testid) => rowOf(testid).getAttribute('hidden') !== null;
  // stock depletion (the first kind): only the supplier
  assert.deepEqual(['input-supplierCode', 'input-supplierOrderId', 'input-paypalFault', 'input-modelFault', 'input-count'].map((t) => [t, hidden(t)]),
    [['input-supplierCode', false], ['input-supplierOrderId', true], ['input-paypalFault', true], ['input-modelFault', true], ['input-count', true]]);

  // switching the kind shows the controls it takes
  const kind = byTestId(container, 'input-kind');
  kind.value = 'fake_paypal';
  await kind.fire('change');
  assert.deepEqual(['input-supplierCode', 'input-paypalFault', 'input-count', 'input-supplierOrderId'].map(hidden), [false, false, false, true]);
  kind.value = 'refund_order';
  await kind.fire('change');
  assert.deepEqual(['input-supplierOrderId', 'input-supplierCode', 'input-paypalFault'].map(hidden), [false, true, true]);

  // an incomplete form is not sent and says why, as an alert
  byTestId(container, 'input-supplierOrderId').value = '';
  await byTestId(container, 'fault-form').fire('submit');
  assert.deepEqual(calls, []);
  assert.equal(textOf(byTestId(container, 'fault-problem')), 'Enter the supplier order number.');
  assert.equal(byTestId(container, 'fault-problem').getAttribute('role'), 'alert');

  // the server refuses: the error shows with what to do, no success line
  // (a fake select does not keep the chosen option, so the redrawn form is told its kind again)
  byTestId(container, 'input-kind').value = 'refund_order';
  byTestId(container, 'input-supplierOrderId').value = '32';
  await byTestId(container, 'fault-form').fire('submit');
  await tick();
  assert.deepEqual(calls.at(-1), ['fault', { kind: 'refund_order', supplierOrderId: 32 }]);
  assert.match(textOf(byTestId(container, 'state-error')), /That step is not available right now\./);
  assert.equal(byTestId(container, 'fault-done'), null);

  // supplier refusal with a reason
  const kind2 = byTestId(container, 'input-kind');
  kind2.value = 'supplier_refusal';
  await kind2.fire('change');
  byTestId(container, 'input-supplierCode').value = 'A';
  assert.equal(allByTestId(container, 'input-reason').length, 1, 'one reset reason; the refusal reason has its own hook');
  byTestId(container, 'input-refusalReason').value = 'Out of lids';
  await byTestId(container, 'fault-form').fire('submit');
  await tick();
  assert.deepEqual(calls.at(-1), ['fault', { kind: 'supplier_refusal', supplierCode: 'A', reason: 'Out of lids' }]);
  assert.equal(textOf(byTestId(container, 'fault-done')), 'Supplier A refused 1 open order (31).');

  // forced reset: stranded operations are listed with what to do
  byTestId(container, 'input-force').checked = true;
  byTestId(container, 'input-reason').value = 'Demo retake before the judging session';
  await byTestId(container, 'reset-form').fire('submit');
  await tick();
  assert.deepEqual(calls.at(-1), ['reset', { force: true, reason: 'Demo retake before the judging session' }]);
  assert.match(textOf(byTestId(container, 'reset-done')), /The demo was reset\. 3 payment operations were archived\./);
  assert.match(textOf(byTestId(container, 'reset-done')), /PayPal Sandbox dashboard/);
  assert.equal(textOf(byTestId(container, 'reset-stranded')), 'Operation 42: unknown, plan non executable');
  assert.ok(announced.includes('Applying…') && announced.includes('The demo was reset.'));
  assert.ok(byTestId(container, 'timeline-table') && byTestId(container, 'metrics-model'), 'timeline and metrics are loaded');
});

test('RS-30: the timeline and metrics each have loading, empty, error and success states', async () => {
  const empty = { events: [], requestId: 'req-empty-0000001' };
  const pending = [];
  const api = {
    getTimeline: () => new Promise((resolve, reject) => pending.push({ resolve, reject, kind: 'timeline' })),
    getMetrics: () => new Promise((resolve, reject) => pending.push({ resolve, reject, kind: 'metrics' })),
  };
  const { ctx, container } = baseCtx(api);
  mountAdmin(ctx, parseRoute('#/admin'));
  await tick();
  assert.equal(allByTestId(container, 'state-loading').length, 2, 'loading in both');
  pending.find((p) => p.kind === 'timeline').resolve(empty);
  pending.find((p) => p.kind === 'metrics').reject(apiError('DB_BUSY', 503));
  await tick();
  assert.equal(textOf(byTestId(container, 'timeline-empty').children[0]), 'No events yet.');
  assert.match(textOf(byTestId(container, 'state-error')), /The server is busy\./);
  assert.ok(byTestId(container, 'retry'), 'and a Retry button');
});

// ---- textContent only -----------------------------------------------------------------------------------------------------------------

test('T11: the recovery code builds text with el(...text) only', () => {
  for (const rel of ['components/status.js', 'components/compensation.js', 'components/notice.js', 'views/admin.js', 'views/supplier-orders.js', 'views/request-detail.js']) {
    const source = readFileSync(path.join(HERE, '..', '..', '..', 'public', 'js', rel), 'utf8');
    assert.doesNotMatch(source, /innerHTML|outerHTML|insertAdjacentHTML|document\.write|createContextualFragment|setHTML/, rel);
  }
});
