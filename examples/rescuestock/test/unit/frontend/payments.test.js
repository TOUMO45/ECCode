// Phase E, task e5: the payment UI. The pure payment view-model (public/js/components/payments.js and the pieces it
// shares with the request page) is checked against the payment fixtures in test/fixtures/contracts/payments and the
// payment-route fixtures in test/fixtures/contracts: the approval counter text, the badge per adapter, the
// single-credential notice, "Try approval again" and "Abandon purchase" after a cancel, the cancelled presentation
// with supplier actions hidden, RESERVATION_LIMIT with its link, and the poll interval schedule. A small fake
// document stands in for the browser's, so this runs under plain `node --test`.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { el, setDocument } from '../../../public/js/dom.js';
import { ApiError } from '../../../public/js/api.js';
import { parseRoute } from '../../../public/js/router.js';
import { EXACT } from '../../../public/js/texts.js';
import {
  POLL_BACKOFF_AFTER_MS, POLL_FAST_MS, POLL_SLOW_MS, createPoller, isTransient, nextDelay,
} from '../../../public/js/poll.js';
import { providerBadgeModels } from '../../../public/js/components/badges.js';
import { bannerModel } from '../../../public/js/components/banner.js';
import { commitmentsModel } from '../../../public/js/components/commitments.js';
import { failureModel } from '../../../public/js/components/compensation.js';
import { actionsModel, reservationLimitModel, successText } from '../../../public/js/components/payments.js';
import { statusModel } from '../../../public/js/components/status.js';
import { buildRequestViewModel, mountRequestDetail, renderRequestPage, returnNoticeModel } from '../../../public/js/views/request-detail.js';
import { buildSupplierOrdersViewModel, mountSupplierOrders, renderSupplierOrders } from '../../../public/js/views/supplier-orders.js';

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
const PAYMENTS = path.join(CONTRACTS, 'payments');
const load = (dir, file) => JSON.parse(readFileSync(path.join(dir, file), 'utf8'));
const payment = new Map(readdirSync(PAYMENTS).filter((f) => f.endsWith('.json')).sort().map((f) => [f.replace(/\.json$/, ''), load(PAYMENTS, f)]));
const contract = (name) => load(CONTRACTS, `${name}.json`);
const view = (name) => structuredClone(payment.get(name).response);
const routeBody = (name) => structuredClone(contract(name).response);

function apiError(code, status = 409, details = null) {
  return new ApiError({ kind: 'http', status, code, message: 'server text', requestId: 'req-test-00000001', details });
}

function baseCtx(api, extra = {}) {
  const container = el('div');
  const assigned = [];
  const announced = [];
  const ctx = {
    api,
    container,
    storage: null,
    announce: (t) => announced.push(t),
    navigate() {},
    assignLocation: (u) => assigned.push(u),
    confirm: () => true,
    document: fakeDocument,
    ...extra,
  };
  return { ctx, container, assigned, announced };
}

// ---- the fixtures themselves -----------------------------------------------------------------------------------------

test('RS-34: the payment fixtures are RequestView (or supplier orders) answers that follow the shared conventions', () => {
  assert.ok(payment.size >= 7, `expected the payment fixtures, found ${payment.size}`);
  const keys = ['request', 'extraction', 'requirements', 'planning', 'plans', 'currentPlanId', 'reservation', 'orders', 'cancellingOrders', 'rescueStatus', 'labels', 'requestId'];
  for (const [name, fx] of payment) {
    assert.ok(fx.route === 'GET /api/requests/:id' || fx.route === 'GET /api/supplier/orders', name);
    assert.equal(fx.status, 200, name);
    assert.match(fx.response.requestId, /^[A-Za-z0-9-]{8,64}$/, name);
    if (fx.route === 'GET /api/requests/:id') {
      assert.deepEqual(Object.keys(fx.response).filter((k) => k !== 'capabilities').sort(), [...keys].sort(), name);
      for (const o of fx.response.orders) {
        // Labels (RS-34): every payment object carries provider, simulated and sandbox, and they agree.
        assert.ok(['fake', 'paypal-sandbox'].includes(o.payment.provider), name);
        assert.equal(o.payment.simulated, o.payment.provider === 'fake', name);
        assert.equal(o.payment.sandbox, o.payment.provider === 'paypal-sandbox', name);
        assert.ok(['per-supplier', 'single-credential'].includes(o.payment.merchantMode), name);
        assert.ok(Number.isInteger(o.payment.amountCents) && o.payment.amountCents === o.totals.totalCents, `${name}: amount is the order total`);
      }
    }
  }
});

test('RS-34: the seven phase E route fixtures keep the shapes this UI reads', () => {
  const created = contract('order-paypal-create');
  assert.equal(created.route, 'POST /api/orders/:id/paypal/create');
  assert.deepEqual(Object.keys(created.response).sort(), ['approvalIndex', 'approvalUrl', 'approvalsNeeded', 'payment', 'requestId']);
  assert.equal(created.response.approvalUrl, created.response.payment.approvalUrl);
  assert.equal(contract('plan-execute').status, 202);
  assert.equal(contract('plan-execute').response.claimed, true);
  assert.equal(contract('plan-execute-replay').response.claimed, false);
  assert.equal(contract('plan-abandon').response.plan.status, 'non_executable');
  assert.equal(contract('order-receipt').response.order.receiptRecorded, true);
  assert.equal(contract('supplier-order-ready').response.order.fulfilmentStatus, 'ready');
  assert.equal(contract('supplier-order-handover').response.order.fulfilmentStatus, 'collected');
});

// ---- approval counter, badge per adapter, single-credential notice ------------------------------------------------------

test('RS-18: approvals read "PayPal approvals: 1 of 2 — Supplier A — Approve with PayPal" with a Simulated badge for the fake adapter', () => {
  const v = view('view-approve-simulated');
  const model = actionsModel(v);
  assert.deepEqual(model.paypal.map((p) => [p.testid, p.step, p.state, p.buttonLabel]), [
    ['paypal-approve-A', 'PayPal approvals: 1 of 2', 'todo', 'Approve with PayPal'],
    ['paypal-approve-B', 'PayPal approvals: 2 of 2', 'todo', 'Approve with PayPal'],
  ]);
  assert.deepEqual(model.paypal[0].badges, [{ text: 'Simulated', testid: 'badge-simulated' }]);
  assert.deepEqual(model.paypalNotices, [], 'per-supplier merchants: no single-credential notice');
  assert.equal(model.abandon, null);
  const clicked = [];
  const root = wrap([renderRequestPage(buildRequestViewModel(v), { paypal: (p) => clicked.push(p.orderId) })]);
  assert.match(textOf(byTestId(root, 'paypal-A')), /PayPal approvals: 1 of 2 — Supplier A — Approve with PayPal/);
  assert.match(textOf(byTestId(root, 'paypal-B')), /PayPal approvals: 2 of 2 — Supplier B — Approve with PayPal/);
  // one badge per approval card, and the "If something fails" cards carry theirs too
  assert.deepEqual(allByTestId(byTestId(root, 'paypal-approvals'), 'badge-simulated').map(textOf), ['Simulated', 'Simulated']);
  assert.equal(allByTestId(root, 'badge-simulated').length, 4);
  assert.equal(allByTestId(root, 'badge-sandbox').length, 0);
  assert.equal(byTestId(root, 'single-credential-notice'), null);
  byTestId(root, 'paypal-approve-A').listeners.click[0]({});
  assert.deepEqual(clicked, [31]);
});

test('RS-34: with the Sandbox adapter every payment element says "PayPal Sandbox — no real money" and never "Simulated"', () => {
  const v = view('view-approve-sandbox-single-credential');
  const root = wrap([renderRequestPage(buildRequestViewModel(v), { paypal() {} })]);
  const sandbox = allByTestId(root, 'badge-sandbox');
  // approvals list (2) and "If something fails" (2): one badge for each payment element shown
  assert.ok(sandbox.length >= 4, `found ${sandbox.length} sandbox badges`);
  assert.ok(sandbox.every((b) => textOf(b) === EXACT.SANDBOX_BADGE));
  assert.equal(EXACT.SANDBOX_BADGE, 'PayPal Sandbox — no real money');
  assert.equal(allByTestId(root, 'badge-simulated').length, 0);
  assert.deepEqual(providerBadgeModels({ provider: 'fake', simulated: true, sandbox: false }), [{ text: 'Simulated', testid: 'badge-simulated' }]);
  assert.deepEqual(providerBadgeModels({ provider: 'paypal-sandbox', simulated: false, sandbox: true }), [{ text: 'PayPal Sandbox — no real money', testid: 'badge-sandbox' }]);
  // a payment that is neither is still named, as text, never left unlabelled
  assert.deepEqual(providerBadgeModels({ provider: 'other', simulated: false, sandbox: false }), [{ text: 'Provider: other', testid: 'badge-provider' }]);
});

test('RS-34: single-credential mode says "All demo suppliers are paid to one Sandbox account" next to the approvals and in the banner', () => {
  const v = view('view-approve-sandbox-single-credential');
  const model = actionsModel(v);
  assert.deepEqual(model.paypalNotices, [{ testid: 'single-credential-notice', tone: 'info', text: 'All demo suppliers are paid to one Sandbox account' }]);
  const root = wrap([renderRequestPage(buildRequestViewModel(v), { paypal() {} })]);
  assert.equal(textOf(byTestId(root, 'single-credential-notice')), 'All demo suppliers are paid to one Sandbox account');
  assert.deepEqual(bannerModel({ labels: v.labels }).map((b) => b.testid), ['banner-simulated', 'banner-single-credential']);
  // the notice follows the server's mode: no labels flag, no payment flag, no notice
  const plain = view('view-approve-sandbox-single-credential');
  plain.labels.merchantMode = 'per-supplier';
  for (const o of plain.orders) o.payment.merchantMode = 'per-supplier';
  assert.deepEqual(actionsModel(plain).paypalNotices, []);
});

test('RS-18: a payment that is already approved shows its state as text and no approval button; the next supplier is "2 of 2"', () => {
  const v = view('view-approve-sandbox-single-credential');
  const model = actionsModel(v);
  assert.deepEqual(model.paypal.map((p) => [p.supplierCode, p.state]), [['A', 'done'], ['B', 'todo']]);
  assert.equal(model.paypal[0].statusText, 'Authorized — no money taken yet');
  const root = wrap([renderRequestPage(buildRequestViewModel(v), { paypal() {} })]);
  assert.equal(byTestId(root, 'paypal-approve-A'), null);
  assert.ok(byTestId(root, 'paypal-approve-B'));
  assert.match(textOf(byTestId(root, 'paypal-A')), /Authorized — no money taken yet/);
});

// ---- after a cancel ---------------------------------------------------------------------------------------------------------

test('RS-18: after a cancel on PayPal the buyer is offered "Try approval again" and "Abandon purchase"', () => {
  const v = view('view-after-cancel');
  const model = actionsModel(v);
  assert.deepEqual(model.paypal.map((p) => [p.supplierCode, p.state, p.buttonLabel]), [
    ['A', 'retry', 'Try approval again'],
    ['B', 'todo', 'Approve with PayPal'],
  ]);
  assert.deepEqual({ ...model.abandon }, { planId: 21, label: 'Abandon purchase', testid: 'abandon' });
  assert.equal(model.execute, null);
  const calls = [];
  const root = wrap([renderRequestPage(buildRequestViewModel(v), { paypal: (p) => calls.push(['paypal', p.orderId]), abandon: (a) => calls.push(['abandon', a.planId]) })]);
  assert.match(textOf(byTestId(root, 'paypal-approve-A')), /Try approval again/);
  assert.equal(textOf(byTestId(root, 'abandon')), 'Abandon purchase');
  byTestId(root, 'paypal-approve-A').listeners.click[0]({});
  byTestId(root, 'abandon').listeners.click[0]({});
  assert.deepEqual(calls, [['paypal', 31], ['abandon', 21]]);
  // Without a cancel there is nothing to abandon yet.
  assert.equal(actionsModel(view('view-approve-simulated')).abandon, null);
});

// ---- complete purchase, receipt -----------------------------------------------------------------------------------------------

test('RS-35: "Complete purchase" appears once every supplier has confirmed, from the header and from the actions, and nowhere before', () => {
  const v = view('view-complete-purchase');
  const model = actionsModel(v);
  assert.deepEqual({ ...model.execute }, { planId: 21, label: 'Complete purchase', testid: 'execute' });
  assert.deepEqual(model.paypal, [], 'no approval is left to do');
  assert.equal(model.abandon, null);
  assert.equal(statusModel(v).action.kind, 'execute');
  for (const name of ['view-approve-simulated', 'view-approve-sandbox-single-credential', 'view-after-cancel', 'view-non-executable']) {
    assert.equal(actionsModel(view(name)).execute, null, name);
  }
  const calls = [];
  const root = wrap([renderRequestPage(buildRequestViewModel(v), { execute: (s) => calls.push(s.planId) })]);
  assert.equal(textOf(byTestId(root, 'execute')), 'Complete purchase');
  byTestId(root, 'execute').listeners.click[0]({});
  assert.deepEqual(calls, [21]);
});

test('RS-35: "Record receipt" is offered for a ready order whose receipt is not recorded, and not for a recorded one', () => {
  const v = view('view-ready-receipt');
  const model = actionsModel(v);
  assert.deepEqual(model.receipts.map((r) => [r.orderId, r.testid, r.label]), [[31, 'receipt-A', 'Record receipt — Supplier A']]);
  const calls = [];
  const root = wrap([renderRequestPage(buildRequestViewModel(v), { receipt: (r) => calls.push(r.orderId) })]);
  byTestId(root, 'receipt-A').listeners.click[0]({});
  assert.deepEqual(calls, [31]);
  assert.equal(byTestId(root, 'receipt-B'), null);
  // The server's answer after the call: the order now has receiptRecorded.
  const after = view('view-ready-receipt');
  after.orders[0] = { ...after.orders[0], ...routeBody('order-receipt').order, id: 31, supplier: after.orders[0].supplier };
  assert.deepEqual(actionsModel(after).receipts, []);
});

// ---- cancelled presentation -------------------------------------------------------------------------------------------------

test('RS-18: orders of a non-executable plan read "Cancelled — payment did not complete", with no approval, execute or receipt action (F-TR-11)', () => {
  const v = view('view-non-executable');
  const failure = failureModel(v);
  assert.ok(failure.rows.every((r) => r.notPaid && r.presentationText === 'Cancelled — payment did not complete'));
  const commit = commitmentsModel(v);
  assert.ok(commit.rows.every((r) => r.fulfilmentText === 'Cancelled — payment did not complete'), 'a confirmed order of a cancelled plan is not shown as a live commitment');
  const model = actionsModel(v);
  assert.deepEqual([model.paypal, model.abandon, model.execute, model.receipts], [[], null, null, []]);
  const root = wrap([renderRequestPage(buildRequestViewModel(v), { paypal() {}, abandon() {}, execute() {}, receipt() {}, replan() {} })]);
  assert.match(textOf(byTestId(root, 'failure-A-presentation')), /Cancelled — payment did not complete/);
  assert.match(textOf(byTestId(root, 'failure-B-presentation')), /Cancelled — payment did not complete/);
  for (const id of ['paypal-approve-A', 'paypal-approve-B', 'abandon', 'execute', 'receipt-A']) assert.equal(byTestId(root, id), null, id);
  // Even if a stale next step still asked for approvals, an order that is cancelled never gets an approval button.
  const stale = view('view-non-executable');
  stale.rescueStatus.nextStep = { code: 'APPROVE_PAYMENTS', text: 'Approve each payment with PayPal' };
  const staleModel = actionsModel(stale);
  assert.deepEqual(staleModel.paypal.map((p) => p.state), ['cancelled', 'cancelled']);
  const staleRoot = wrap([renderRequestPage(buildRequestViewModel(stale), { paypal() {} })]);
  assert.equal(byTestId(staleRoot, 'paypal-approve-A'), null);
  assert.match(textOf(byTestId(staleRoot, 'paypal-A')), /Cancelled — payment did not complete/);
});

test('RS-18: the supplier view marks ready and records handover from the can* flags, and hides every action for a cancelled order', () => {
  const answer = payment.get('supplier-orders-ready-handover').response;
  const vm = buildSupplierOrdersViewModel(answer);
  assert.deepEqual(vm.cards.map((c) => [c.id, c.cancelled, c.actions.ready, c.actions.handover, c.actions.confirm, c.actions.refuse !== null]), [
    [31, false, true, false, null, true],
    [33, false, false, true, null, false],
    [27, true, false, false, null, false],
  ]);
  assert.equal(vm.cards[2].statusText, 'Cancelled — payment did not complete');
  assert.match(vm.cards[2].noActionText, /payment did not complete/);
  // payment labels on the supplier card: Sandbox for one, Simulated for the other
  assert.deepEqual(vm.cards[0].badges.map((b) => b.text), ['PayPal Sandbox — no real money']);
  assert.deepEqual(vm.cards[1].badges.map((b) => b.text), ['Simulated']);
  const calls = [];
  const nodes = renderSupplierOrders(vm, { ready: (c) => calls.push(['ready', c.id]), handover: (c) => calls.push(['handover', c.id]), filter() {}, confirm() {}, refuse() {} }, '');
  const root = wrap(nodes);
  byTestId(root, 'ready-order-31').listeners.click[0]({});
  byTestId(root, 'handover-order-33').listeners.click[0]({});
  assert.deepEqual(calls, [['ready', 31], ['handover', 33]]);
  assert.equal(byTestId(root, 'handover-order-31'), null);
  assert.equal(byTestId(root, 'ready-order-33'), null);
  for (const kind of ['ready', 'handover']) assert.equal(byTestId(root, `${kind}-order-27`), null, kind);
  assert.equal(byTestId(root, 'confirm-form-order-27'), null);
  assert.equal(byTestId(root, 'refuse-form-order-27'), null);
  assert.match(textOf(byTestId(root, 'order-27-no-action')), /payment did not complete/);
});

test('RS-18: the supplier screen shows a success line only after the server accepted ready or handover, and the error when it refused', async () => {
  const answer = payment.get('supplier-orders-ready-handover').response;
  const calls = [];
  const api = {
    listSupplierOrders: async () => structuredClone(answer),
    markSupplierOrderReady: async (id) => { calls.push(['ready', id]); return routeBody('supplier-order-ready'); },
    recordHandover: async (id) => { calls.push(['handover', id]); throw apiError('HANDOVER_BLOCKED'); },
  };
  const { ctx, container, announced } = baseCtx(api);
  mountSupplierOrders(ctx, parseRoute('#/supplier/orders'));
  await tick();
  await byTestId(container, 'ready-order-31').listeners.click[0]({});
  await tick();
  assert.match(textOf(byTestId(container, 'action-done')), /Order R12-V1 is marked ready for pickup\./);
  await byTestId(container, 'handover-order-33').listeners.click[0]({});
  await tick();
  assert.equal(byTestId(container, 'action-done'), null, 'a refused handover shows no success line');
  assert.match(textOf(byTestId(container, 'state-error')), /This step is not allowed yet\./);
  assert.deepEqual(calls, [['ready', 31], ['handover', 33]]);
  assert.ok(announced.some((t) => /marked ready/.test(t)));
});

// ---- the request page actions: loading, success, error ---------------------------------------------------------------------------

test('RS-18: Approve with PayPal goes to the approval URL through location.assign, never a form post', async () => {
  const v = view('view-approve-simulated');
  const created = routeBody('order-paypal-create');
  const asked = [];
  const api = { getRequest: async () => structuredClone(v), createPayPalOrder: async (id) => { asked.push(id); return created; } };
  const { ctx, container, assigned } = baseCtx(api);
  const page = mountRequestDetail(ctx, parseRoute('#/requests/12'));
  await tick();
  await byTestId(container, 'paypal-approve-A').listeners.click[0]({});
  await tick();
  page.dispose();
  assert.deepEqual(asked, [31]);
  assert.deepEqual(assigned, [created.approvalUrl]);
  assert.match(textOf(byTestId(container, 'success-paypal')), /simulated approval page \(not PayPal\)/);
  assert.equal(byTestId(container, 'section-actions').all((n) => n.tagName === 'FORM').length, 0, 'the approval step builds no form');
  assert.equal(container.all((n) => n.tagName === 'FORM' && n.getAttribute('action') !== null).length, 0, 'and no form posts anywhere');
  // Sandbox: the sentence names the Sandbox, not the simulator.
  assert.match(successText('paypal', { payment: { simulated: false } }), /PayPal Sandbox \(no real money\)/);
});

test('RS-18: a failed PayPal create shows the error with what to do next, follows no link and shows no success', async () => {
  const v = view('view-approve-simulated');
  const api = { getRequest: async () => structuredClone(v), createPayPalOrder: async () => { throw apiError('PROVIDER_UNAVAILABLE', 503); } };
  const { ctx, container, assigned } = baseCtx(api);
  const page = mountRequestDetail(ctx, parseRoute('#/requests/12'));
  await tick();
  await byTestId(container, 'paypal-approve-A').listeners.click[0]({});
  await tick();
  page.dispose();
  assert.deepEqual(assigned, []);
  assert.equal(byTestId(container, 'success-paypal'), null);
  const err = textOf(byTestId(container, 'state-error'));
  assert.match(err, /PayPal did not answer\./);
  assert.match(err, /Try again in a moment\./);
  assert.match(err, /Request id: req-test-00000001/);
  assert.ok(byTestId(container, 'retry'), 'a retryable error offers Retry');
});

test('RS-18: abandon, execute and receipt each show loading, then a truthful success line, and reload the page', async () => {
  const v = view('view-after-cancel');
  let loads = 0;
  const calls = [];
  const api = {
    getRequest: async () => { loads += 1; return structuredClone(v); },
    abandonPlan: async (id) => { calls.push(['abandon', id]); return routeBody('plan-abandon'); },
    executePlan: async (id) => { calls.push(['execute', id]); return contract('plan-execute-replay').response; },
    recordReceipt: async (id) => { calls.push(['receipt', id]); return routeBody('order-receipt'); },
  };
  const { ctx, container, announced } = baseCtx(api);
  const page = mountRequestDetail(ctx, parseRoute('#/requests/12'));
  await tick();
  assert.equal(loads, 1);
  await byTestId(container, 'abandon').listeners.click[0]({});
  await tick();
  assert.deepEqual(calls, [['abandon', 21]]);
  assert.equal(loads, 2, 'the view is read again after the action');
  assert.match(textOf(byTestId(container, 'success-abandon')), /Purchase abandoned\. Nothing was charged/);
  assert.ok(announced.includes('Abandoning the purchase…'), 'the working text is announced first');
  assert.ok(announced.some((t) => /Purchase abandoned/.test(t)), 'and the outcome');
  page.dispose();
  assert.match(successText('execute', { claimed: true }), /Purchase started\. Payments are being captured/);
  assert.match(successText('execute', contract('plan-execute-replay').response), /already being completed/);
  assert.equal(successText('receipt'), 'Receipt recorded.');
});

test('RS-18: a refused abandon (409 INVALID_STATE) shows the error and no success line, then the page shows what is true now', async () => {
  const v = view('view-after-cancel');
  let loads = 0;
  const api = {
    getRequest: async () => { loads += 1; return structuredClone(v); },
    abandonPlan: async () => { throw apiError('INVALID_STATE'); },
  };
  const { ctx, container } = baseCtx(api);
  const page = mountRequestDetail(ctx, parseRoute('#/requests/12'));
  await tick();
  await byTestId(container, 'abandon').listeners.click[0]({});
  await tick();
  page.dispose();
  assert.equal(byTestId(container, 'success-abandon'), null);
  assert.match(textOf(byTestId(container, 'state-error')), /That step is not available right now\./);
  assert.equal(loads, 2, 'reloaded after the refusal');
});

test('RS-18: buttons carry aria-disabled while an action runs, and a second click does nothing', async () => {
  const v = view('view-complete-purchase');
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const calls = [];
  const api = {
    getRequest: async () => structuredClone(v),
    executePlan: async (id) => { calls.push(id); await gate; return contract('plan-execute').response; },
  };
  const { ctx, container } = baseCtx(api);
  const page = mountRequestDetail(ctx, parseRoute('#/requests/12'));
  await tick();
  const first = byTestId(container, 'execute').listeners.click[0]({});
  await tick();
  assert.match(textOf(byTestId(container, 'state-loading')), /Completing the purchase…/);
  assert.equal(byTestId(container, 'execute').getAttribute('aria-disabled'), 'true');
  await byTestId(container, 'execute').listeners.click[0]({});
  release();
  await first;
  await tick();
  page.dispose();
  assert.deepEqual(calls, [21], 'one call, not two');
});

// ---- the notice after coming back from PayPal --------------------------------------------------------------------------------------------

test('RS-18: the notice after coming back from PayPal waits only while the payment is in flight, confirms once authorized, and goes when the purchase outcome is known', () => {
  const returned = { paypal: 'returned', order: '31' };
  // present while approved / authorization_pending (and unknown, which is also "waiting for PayPal")
  for (const status of ['approved', 'authorization_pending', 'unknown']) {
    const v = view('view-approve-sandbox-single-credential');
    v.orders[0].payment.status = status;
    const n = returnNoticeModel(returned, v);
    assert.ok(n, status);
    assert.match(n.text, /back from PayPal for Supplier A\. Waiting for PayPal to confirm/, status);
    assert.equal(buildRequestViewModel(v, { query: returned }).returnNotice?.testid, 'paypal-returned', status);
  }
  // once authorized (or captured) the notice is still there, as one short sentence with no "waiting"
  // (with the fake provider the return handler authorizes at once, so this is the usual first look)
  for (const status of ['authorized', 'capture_pending', 'captured']) {
    const v = view('view-approve-sandbox-single-credential'); // order 31 is authorized, plan approved
    v.orders[0].payment.status = status;
    const n = returnNoticeModel(returned, v);
    assert.ok(n, status);
    assert.equal(n.testid, 'paypal-returned', status);
    assert.equal(n.text, 'PayPal approval for Supplier A is confirmed.', status);
    assert.doesNotMatch(n.text, /wait/i, status);
    assert.equal(n.tone, 'ok', status);
    const root = wrap([renderRequestPage(buildRequestViewModel(v, { query: returned }), {})]);
    assert.equal(textOf(byTestId(root, 'paypal-returned')), 'PayPal approval for Supplier A is confirmed.', status);
  }
  // absent once the plan is executed or non_executable, whatever the order says: the purchase outcome is shown instead
  for (const planStatus of ['executed', 'non_executable']) {
    for (const status of ['approved', 'authorization_pending', 'authorized', 'captured']) {
      const v = view('view-approve-sandbox-single-credential');
      v.orders[0].payment.status = status;
      v.plans[0].status = planStatus;
      assert.equal(returnNoticeModel(returned, v), null, `plan ${planStatus}, order ${status}`);
      assert.equal(buildRequestViewModel(v, { query: returned }).returnNotice, null);
    }
  }
  const executed = view('view-ready-receipt');
  assert.equal(returnNoticeModel(returned, executed), null, 'executed fixture');
  assert.equal(returnNoticeModel(returned, view('view-non-executable')), null, 'non_executable fixture');
  const root = wrap([renderRequestPage(buildRequestViewModel(executed, { query: returned }), {})]);
  assert.equal(byTestId(root, 'paypal-returned'), null);
  assert.doesNotMatch(textOf(root), /Waiting for PayPal to confirm/);
  // no order named in the link: nothing is known, so nothing is claimed
  assert.equal(returnNoticeModel({ paypal: 'returned', order: '999' }, view('view-approve-sandbox-single-credential')), null);
});

test('RS-18: the "approval was cancelled" notice also goes once the purchase is abandoned or executed or the order is no longer waiting for approval', () => {
  const cancelled = { paypal: 'cancelled', order: '31' };
  assert.match(returnNoticeModel(cancelled, view('view-after-cancel')).text, /approval for Supplier A was cancelled\. Nothing was paid\./);
  assert.equal(returnNoticeModel(cancelled, view('view-non-executable')), null, 'abandoned');
  assert.equal(returnNoticeModel(cancelled, view('view-ready-receipt')), null, 'executed');
  assert.equal(returnNoticeModel(cancelled, view('view-approve-sandbox-single-credential')), null, 'order 31 was approved in the meantime');
});

// ---- RESERVATION_LIMIT -------------------------------------------------------------------------------------------------------------

test('SEC-2: RESERVATION_LIMIT gives the fixed sentence and a link to the other request, never to this one', () => {
  const env = contract('error-reservation-limit').response.error;
  const err = apiError('RESERVATION_LIMIT', 409, env.details);
  const requests = routeBody('requests-list').requests;
  const m = reservationLimitModel({ error: err, requests, currentRequestId: 15 });
  assert.equal(m.message, 'You already hold stock for another request — finish or abandon it first');
  assert.deepEqual(m.links, [{ href: '#/requests/12', label: 'Open request #12' }]);
  assert.equal(m.found, true);
  // the request that holds the stock is never linked from itself
  assert.deepEqual(reservationLimitModel({ error: err, requests, currentRequestId: 12 }).links, [{ href: '#/requests', label: 'Open your requests' }]);
  // a lookup that failed (no list) falls back to the whole list
  assert.deepEqual(reservationLimitModel({ error: err, currentRequestId: 15 }).links, [{ href: '#/requests', label: 'Open your requests' }]);
  // request ids from the server win and come first
  const withIds = apiError('RESERVATION_LIMIT', 409, { reservationIds: [9], requestIds: [7] });
  assert.deepEqual(reservationLimitModel({ error: withIds, requests, currentRequestId: 15 }).links.map((l) => l.href), ['#/requests/7', '#/requests/12']);
});

test('SEC-2: a refused Reserve shows the RESERVATION_LIMIT sentence with a working link to the other request', async () => {
  const v = view('view-approve-simulated');
  v.reservation = null;
  v.orders = [];
  v.rescueStatus = { status: 'plan_found', rule: '12', nextStep: { code: 'RESERVE', text: 'Reserve the stock' }, message: null, underlying: { plan: 'approved', reservation: null, payments: [], fulfilment: [] } };
  const env = contract('error-reservation-limit').response.error;
  const api = {
    getRequest: async () => structuredClone(v),
    listRequests: async () => routeBody('requests-list'),
    reservePlan: async () => { throw apiError('RESERVATION_LIMIT', 409, env.details); },
  };
  const store = new Map();
  const storage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, val) => store.set(k, val) };
  const { ctx, container } = baseCtx(api, { storage });
  const page = mountRequestDetail(ctx, parseRoute('#/requests/15'));
  await tick();
  await byTestId(container, 'reserve').listeners.click[0]({});
  await tick();
  page.dispose();
  const box = textOf(byTestId(container, 'state-error'));
  assert.match(box, /You already hold stock for another request — finish or abandon it first/);
  const link = byTestId(container, 'error-link-1');
  assert.equal(link.getAttribute('href'), '#/requests/12');
  assert.equal(textOf(link), 'Open request #12');
  assert.equal(byTestId(container, 'success-reserve'), null);
});

test('SEC-2: when the list cannot be read the RESERVATION_LIMIT link falls back to the whole list', async () => {
  const v = view('view-approve-simulated');
  v.orders = [];
  v.rescueStatus = { status: 'plan_found', rule: '12', nextStep: { code: 'RESERVE', text: 'Reserve the stock' }, message: null, underlying: { plan: 'approved', reservation: null, payments: [], fulfilment: [] } };
  const api = {
    getRequest: async () => structuredClone(v),
    listRequests: async () => { throw apiError('DB_BUSY', 503); },
    reservePlan: async () => { throw apiError('RESERVATION_LIMIT', 409, { reservationIds: [9] }); },
  };
  const { ctx, container } = baseCtx(api);
  const page = mountRequestDetail(ctx, parseRoute('#/requests/15'));
  await tick();
  await byTestId(container, 'reserve').listeners.click[0]({});
  await tick();
  page.dispose();
  assert.equal(byTestId(container, 'error-link-1').getAttribute('href'), '#/requests');
});

// ---- polling -------------------------------------------------------------------------------------------------------------------------

test('NFR2: the poll interval schedule is 2 s, then 10 s from 2 minutes, and none while the page is hidden', () => {
  assert.deepEqual([POLL_FAST_MS, POLL_SLOW_MS, POLL_BACKOFF_AFTER_MS], [2000, 10000, 120000]);
  assert.equal(nextDelay(0), 2000);
  assert.equal(nextDelay(60000), 2000);
  assert.equal(nextDelay(POLL_BACKOFF_AFTER_MS - 1), 2000);
  assert.equal(nextDelay(POLL_BACKOFF_AFTER_MS), 10000);
  assert.equal(nextDelay(10 * 60000), 10000);
  assert.equal(nextDelay(0, { hidden: true }), null);
  assert.equal(nextDelay(POLL_BACKOFF_AFTER_MS, { hidden: true }), null);
});

test('NFR2: the page polls while a payment is in flight, and stops when nothing is left to wait for', () => {
  assert.equal(isTransient(view('view-approve-simulated')), true, 'stock_reserved');
  assert.equal(isTransient(view('view-complete-purchase')), true, 'payment_authorized');
  assert.equal(isTransient(view('view-non-executable')), false, 'cancelled: settled');
  assert.equal(isTransient(view('view-ready-receipt')), false, 'ready for pickup: settled');
  // back from PayPal: the order is approved or its authorization is pending, whatever the rescue status says
  for (const status of ['approved', 'authorization_pending', 'capture_pending', 'unknown', 'refund_requested', 'refund_pending']) {
    const v = view('view-ready-receipt');
    v.orders[0].payment.status = status;
    assert.equal(isTransient(v), true, status);
  }
  const waiting = view('view-ready-receipt');
  waiting.rescueStatus.nextStep = { code: 'WAIT', text: 'Please wait: this page updates by itself' };
  assert.equal(isTransient(waiting), true, 'nextStep WAIT');
  const executing = view('view-ready-receipt');
  executing.plans[0].status = 'executing';
  assert.equal(isTransient(executing), true, 'plan executing');
  assert.equal(isTransient(null), false);
});

test('NFR2: the poller refreshes every 2 s, backs off to 10 s after 2 minutes, pauses while hidden and resumes when visible', async () => {
  const timers = [];
  let now = 0;
  let hidden = false;
  let loads = 0;
  const shown = [];
  let current = view('view-approve-simulated');
  const poller = createPoller({
    load: async () => { loads += 1; return current; },
    onData: (d) => shown.push(d.requestId),
    isHidden: () => hidden,
    now: () => now,
    setTimer: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    clearTimer() {},
  });
  poller.start(current);
  assert.equal(timers.at(-1).ms, 2000);
  now = 4000;
  await timers.at(-1).fn();
  assert.equal(timers.at(-1).ms, 2000, 'still 2 s inside the first two minutes');
  now = 125000;
  await timers.at(-1).fn();
  assert.equal(timers.at(-1).ms, 10000, 'backed off');
  assert.equal(loads, 2);
  hidden = true;
  const before = timers.length;
  await timers.at(-1).fn();
  assert.equal(loads, 2, 'no request while the tab is hidden');
  assert.equal(timers.length, before, 'and no timer is left running');
  hidden = false;
  poller.resume();
  assert.equal(timers.length, before + 1, 'a visible page polls again');
  current = view('view-ready-receipt');
  await timers.at(-1).fn();
  assert.equal(loads, 3);
  assert.equal(poller.active, false, 'stops once the status settles');
  assert.equal(shown.length, 3);
  poller.stop();
});
