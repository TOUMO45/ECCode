// Phase G, task g1: accessibility, state completeness and honest labels, checked on the pure view-models and on DOM built
// against a tiny fake document (so this runs under plain `node --test`):
//   - RS-34: the banner and the badges for the fake adapter, the Sandbox adapter, single-credential mode and test mode, from
//     the Labels fixtures (GET /api/config answers), including the admin screen's provider badges and the wording of the
//     forced-reset clean-up for each adapter (FU-54);
//   - RS-35: the six answers in order, and every section's loading / empty / error / timeout / expired / degraded / success state;
//   - NFR2: every control the views build carries a label, errors and hints are tied by aria-describedby to ids that exist;
//   - FU-58: an untrusted refusal reason is rendered isolated (<bdi>), never merged into the sentence around it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { el, setDocument } from '../../../public/js/dom.js';
import { ApiError } from '../../../public/js/api.js';
import { parseRoute } from '../../../public/js/router.js';
import { EXACT, SECTION_TITLES } from '../../../public/js/texts.js';
import { adapterBadgeModels } from '../../../public/js/components/badges.js';
import { adapterOf, bannerModel, labelsModel, renderBanner } from '../../../public/js/components/banner.js';
import { errorNode, loadingNode, showState } from '../../../public/js/components/notice.js';
import { messageNodes, reasonNodes } from '../../../public/js/isolate.js';
import { buildRequestViewModel, renderRequestPage, SECTION_ORDER } from '../../../public/js/views/request-detail.js';
import { mountAdmin, resetResultModel } from '../../../public/js/views/admin.js';
import { mountSignIn } from '../../../public/js/views/signin.js';
import { mountRegister } from '../../../public/js/views/register.js';
import { mountRequestNew } from '../../../public/js/views/request-new.js';
import { mountRequestsList } from '../../../public/js/views/requests-list.js';
import { mountSupplierOrders } from '../../../public/js/views/supplier-orders.js';
import { mountSupplierInventory } from '../../../public/js/views/supplier-inventory.js';

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
  hasAttribute(name) { return this.attrs.has(name); }
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

// ---- fixtures --------------------------------------------------------------------------------------------------------

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CONTRACTS = path.join(HERE, '..', '..', 'fixtures', 'contracts');
const load = (...parts) => JSON.parse(readFileSync(path.join(CONTRACTS, ...parts), 'utf8'));
const contract = (name) => load(`${name}.json`);
const body = (name) => structuredClone(contract(name).response);
const labelsFx = (name) => structuredClone(load('labels', `${name}.json`).response);
const recoveryView = (name) => structuredClone(load('recovery', `${name}.json`).response);
const paymentView = (name) => structuredClone(load('payments', `${name}.json`).response);

const CONFIGS = Object.freeze({
  fake: body('config'),
  fakeTestMode: labelsFx('config-fake-test-mode'),
  sandboxStubSingle: body('config-sandbox-test-mode'),
  sandbox: labelsFx('config-sandbox'),
  sandboxSingle: labelsFx('config-sandbox-single-credential'),
});

function apiError(code, status = 409, details = null) {
  return new ApiError({ kind: 'http', status, code, message: 'server text', requestId: 'req-test-00000001', details });
}

function baseCtx(api, extra = {}) {
  const announced = [];
  const container = el('main');
  return {
    announced,
    container,
    ctx: { api, container, storage: null, announce: (t) => announced.push(t), navigate() {}, assignLocation() {}, confirm: () => true, document: fakeDocument, onSignedIn() {}, ...extra },
  };
}

const NOOP_HANDLERS = { plan() {}, replan() {}, review() {}, approve() {}, reserve() {}, execute() {}, paypal() {}, abandon() {}, receipt() {}, remove() {}, confirm() {}, relax() {} };

// ---- RS-34: the labels for both adapters and test mode ---------------------------------------------------------------------

test('RS-34: the label fixtures are GET /api/config answers with the live label keys', () => {
  const keys = Object.keys(CONFIGS.fake.labels).sort();
  for (const [name, config] of Object.entries(CONFIGS)) {
    assert.deepEqual(Object.keys(config.labels).sort(), keys, name);
    assert.equal(config.labels.priceNotice, EXACT.PRICE_NOTICE, name);
    assert.equal(config.labels.demoData, true, name);
    assert.equal(config.labels.simulatedPayments, config.paymentProvider === 'fake', `${name}: simulatedPayments follows paymentProvider`);
    assert.equal(config.labels.sandbox, config.paymentProvider === 'paypal-sandbox', `${name}: sandbox follows paymentProvider`);
    assert.equal(config.labels.simulatedExtraction, config.extractionProvider === 'fake', `${name}: simulatedExtraction follows extractionProvider`);
  }
});

test('RS-34: fake adapter -> the simulated banner, a Simulated payment badge and the fake adapter name', () => {
  const m = labelsModel(CONFIGS.fake);
  assert.equal(m.adapter, 'fake');
  assert.deepEqual(m.banner.map((b) => [b.testid, b.text]), [['banner-simulated', 'Simulated payments and/or AI — nothing here is real']]);
  assert.deepEqual(m.paymentBadges, [{ text: 'Simulated', testid: 'badge-simulated' }]);
  assert.equal(m.testMode, false);
  assert.equal(m.singleCredential, false);
});

test('RS-34: fake adapter in test mode -> both banners, in that order, and still the Simulated badge', () => {
  const m = labelsModel(CONFIGS.fakeTestMode);
  assert.deepEqual(m.banner.map((b) => [b.testid, b.text]), [
    ['banner-simulated', 'Simulated payments and/or AI — nothing here is real'],
    ['banner-test-mode', 'Test mode — local stubs, nothing is real'],
  ]);
  assert.equal(m.testMode, true);
  assert.deepEqual(m.paymentBadges.map((b) => b.text), ['Simulated']);
});

test('RS-34: Sandbox adapter (per supplier, real extraction) -> no simulated banner, but the Sandbox badge on payment elements', () => {
  const m = labelsModel(CONFIGS.sandbox);
  assert.equal(m.adapter, 'sandbox');
  assert.deepEqual(m.banner, [], 'nothing on the page is simulated, so nothing is claimed');
  assert.deepEqual(m.paymentBadges, [{ text: 'PayPal Sandbox — no real money', testid: 'badge-sandbox' }]);
});

test('RS-34: Sandbox adapter in single-credential mode -> the single-credential notice and the Sandbox badge', () => {
  const m = labelsModel(CONFIGS.sandboxSingle);
  assert.equal(m.adapter, 'sandbox');
  assert.deepEqual(m.banner.map((b) => [b.testid, b.text]), [['banner-single-credential', 'All demo suppliers are paid to one Sandbox account']]);
  assert.equal(m.singleCredential, true);
  assert.deepEqual(m.paymentBadges.map((b) => b.text), ['PayPal Sandbox — no real money']);
});

test('RS-34: Sandbox adapter against a loopback stub in test mode -> all three banner lines, the Sandbox badge, and the stub is named', () => {
  const m = labelsModel(CONFIGS.sandboxStubSingle);
  assert.equal(m.adapter, 'sandbox-stub');
  assert.deepEqual(m.banner.map((b) => b.testid), ['banner-simulated', 'banner-test-mode', 'banner-single-credential']);
  assert.deepEqual(m.paymentBadges.map((b) => b.text), ['PayPal Sandbox — no real money']);
});

test('RS-34: when the labels did not load, nothing is claimed either way and the banner says to reload', () => {
  const failed = labelsModel(null, { configFailed: true });
  assert.equal(failed.adapter, 'unknown');
  assert.deepEqual(failed.paymentBadges, []);
  assert.equal(failed.banner[0].testid, 'banner-config-error');
  assert.match(failed.banner[0].text, /Reload the page before you trust any figure on it\./);
  assert.deepEqual(labelsModel(null).banner, []);
  assert.equal(adapterOf(undefined), 'unknown');
  assert.equal(adapterOf({ labels: { simulatedPayments: false, sandbox: false } }), 'unknown', 'neither flag set: the adapter is not guessed');
});

test('RS-34: bannerModel is the banner of labelsModel, and the banner renders one paragraph per line', () => {
  for (const [name, config] of Object.entries(CONFIGS)) assert.deepEqual(bannerModel(config), labelsModel(config).banner, name);
  const host = el('div');
  renderBanner(host, labelsModel(CONFIGS.sandboxStubSingle).banner);
  assert.equal(host.children.length, 3);
  assert.deepEqual(host.children.map((c) => c.tagName), ['P', 'P', 'P']);
});

test('RS-34: adapterBadgeModels gives one provider badge per payment element, from the labels alone', () => {
  assert.deepEqual(adapterBadgeModels(CONFIGS.fake.labels), [{ text: 'Simulated', testid: 'badge-simulated' }]);
  assert.deepEqual(adapterBadgeModels(CONFIGS.sandbox.labels), [{ text: 'PayPal Sandbox — no real money', testid: 'badge-sandbox' }]);
  assert.deepEqual(adapterBadgeModels(null), []);
});

// ---- the admin screen: provider badges and the clean-up wording (FU-54) -----------------------------------------------------

const STRANDED_FIXTURE = load('recovery', 'admin-reset-forced-stranded.json').response;

test('FU-54: a forced reset names the PayPal Sandbox dashboard only when the Sandbox adapter is active', () => {
  const sandbox = resetResultModel(STRANDED_FIXTURE, CONFIGS.sandbox);
  assert.match(sandbox.strandedIntro, /Check each one in the PayPal Sandbox dashboard/);
  const single = resetResultModel(STRANDED_FIXTURE, CONFIGS.sandboxSingle);
  assert.match(single.strandedIntro, /PayPal Sandbox dashboard/);
});

test('FU-54: with the fake provider the reset says plainly that it cleared the simulated provider\'s records and there is nothing to check outside RescueStock', () => {
  for (const config of [CONFIGS.fake, CONFIGS.fakeTestMode]) {
    const fake = resetResultModel(STRANDED_FIXTURE, config);
    assert.match(fake.strandedIntro, /cleared the simulated provider's records/);
    assert.match(fake.strandedIntro, /nothing to check outside RescueStock/);
    assert.doesNotMatch(fake.strandedIntro, /PayPal Sandbox dashboard/, 'a dashboard that holds none of these payments is never named');
    assert.doesNotMatch(fake.strandedIntro, /clean it up there by hand/);
  }
});

test('FU-54: against a loopback stub (test mode) there is no dashboard either, and the text says so', () => {
  const stub = resetResultModel(STRANDED_FIXTURE, CONFIGS.sandboxStubSingle);
  assert.match(stub.strandedIntro, /local stub/);
  assert.match(stub.strandedIntro, /nothing to check outside RescueStock/);
  assert.doesNotMatch(stub.strandedIntro, /Check each one in the PayPal Sandbox dashboard/);
});

test('FU-54: when the active adapter is not known the text does not pick one', () => {
  for (const config of [null, undefined, {}]) {
    const unknown = resetResultModel(STRANDED_FIXTURE, config);
    assert.match(unknown.strandedIntro, /could not tell which payment provider is active/);
    assert.doesNotMatch(unknown.strandedIntro, /nothing to check outside RescueStock/);
  }
});

test('FU-54: no stranded entry means no clean-up text, whatever the adapter', () => {
  for (const config of Object.values(CONFIGS)) {
    const m = resetResultModel({ archivedOperations: 2, requestId: 'req-x' }, config);
    assert.equal(m.strandedIntro, null);
    assert.deepEqual(m.stranded, []);
    assert.equal(m.text, 'The demo was reset. 2 payment operations were archived.');
  }
});

test('FU-54: planStatus and owedRefund are rendered when the entry carries them, and the screen is unchanged when it does not', () => {
  const plain = resetResultModel({ archivedOperations: 1, stranded: [{ id: 7, status: 'captured', providerAuthorizationId: 'AUTH-7', providerCaptureId: 'CAP-7' }] }, CONFIGS.sandbox);
  assert.deepEqual(plain.stranded, [{ text: 'Operation 7: captured, authorization AUTH-7, capture CAP-7' }]);
  const rich = resetResultModel({
    archivedOperations: 1,
    stranded: [
      { id: 7, status: 'captured', providerAuthorizationId: 'AUTH-7', providerCaptureId: 'CAP-7', planStatus: 'cancelled', owedRefund: true },
      { id: 8, status: 'captured', providerAuthorizationId: null, providerCaptureId: 'CAP-8', planStatus: 'executed', owedRefund: false },
      { id: 9, status: 'unknown', providerAuthorizationId: null, providerCaptureId: null, planStatus: 'not a plan status!', owedRefund: 'yes' },
    ],
  }, CONFIGS.sandbox);
  assert.deepEqual(rich.stranded.map((s) => s.text), [
    'Operation 7: captured, authorization AUTH-7, capture CAP-7, plan cancelled, a refund is owed',
    'Operation 8: captured, capture CAP-8, plan executed',
    'Operation 9: unknown',
  ]);
});

test('RS-34: every payment element of the admin screen carries the adapter badge, and the clean-up text follows the adapter', async () => {
  for (const [name, config, badge] of [['fake', CONFIGS.fake, 'Simulated'], ['sandbox', CONFIGS.sandbox, 'PayPal Sandbox — no real money']]) {
    const api = {
      getTimeline: async () => body('admin-timeline'),
      getMetrics: async () => body('admin-metrics'),
      resetDemo: async () => STRANDED_FIXTURE,
      applyFault: async () => load('recovery', 'admin-fault-clear.json').response,
    };
    const { ctx, container } = baseCtx(api, { config });
    mountAdmin(ctx, parseRoute('#/admin'));
    await tick();
    for (const section of ['admin-reset', 'admin-faults', 'admin-timeline', 'admin-metrics']) {
      const badges = allByTestId(container, `provider-${section}`);
      assert.equal(badges.length, 1, `${name}: ${section} has one provider line`);
      assert.match(badges[0].textContent, new RegExp(badge), `${name}: ${section}`);
    }
    const reset = byTestId(container, 'reset-form');
    byTestId(container, 'input-force').checked = true;
    byTestId(container, 'input-reason').value = 'Demo retake before the judging session';
    await reset.fire('submit');
    await tick();
    const done = textOf(byTestId(container, 'reset-done'));
    if (name === 'fake') {
      assert.match(done, /nothing to check outside RescueStock/);
      assert.doesNotMatch(done, /PayPal Sandbox dashboard/);
    } else {
      assert.match(done, /PayPal Sandbox dashboard/);
    }
    assert.match(textOf(byTestId(container, 'reset-stranded')), /Operation 42: unknown/);
  }
});

test('RS-34: with no labels the admin screen shows no provider badge rather than guessing one', async () => {
  const api = { getTimeline: async () => body('admin-timeline'), getMetrics: async () => body('admin-metrics') };
  const { ctx, container } = baseCtx(api, { config: null });
  mountAdmin(ctx, parseRoute('#/admin'));
  await tick();
  assert.equal(allByTestId(container, 'provider-admin-reset').length, 0);
});

// ---- FU-58: an untrusted reason is isolated ----------------------------------------------------------------------------------

const BIDI = '‮⁦';

test('FU-58: reasonNodes and messageNodes put the supplier\'s words in a <bdi dir="auto"> and keep the sentence around them outside it', () => {
  const nodes = reasonNodes('Reason: ', `Out of lids${BIDI}`);
  const host = el('p', {}, nodes);
  const isolated = host.all((n) => n.tagName === 'BDI');
  assert.equal(isolated.length, 1);
  assert.equal(isolated[0].getAttribute('dir'), 'auto');
  assert.equal(isolated[0].textContent, `Out of lids${BIDI}`);
  assert.equal(host.children[0].textContent, 'Reason: ', 'the label stays outside the isolate');
  assert.equal(host.textContent, `Reason: Out of lids${BIDI}`, 'the characters are not removed here: the server refuses them, the display isolates them');

  const sentence = `Supplier A refused the order: ${BIDI}Out of lids. No money was taken.`;
  const msg = el('p', {}, messageNodes(sentence));
  assert.equal(msg.textContent, sentence);
  const inner = msg.all((n) => n.tagName === 'BDI' && n.textContent.includes('Out of lids'));
  assert.equal(inner.length, 1);
  assert.equal(inner[0].textContent, `${BIDI}Out of lids`);
  assert.equal(msg.children[0].textContent, 'Supplier A refused the order: ');
  assert.equal(msg.children[msg.children.length - 1].textContent, '. No money was taken.');
  // the whole message of another shape is isolated as one unit
  const other = el('p', {}, messageNodes('Prices changed: review plan v3'));
  assert.equal(other.all((n) => n.tagName === 'BDI').length, 1);
  assert.equal(other.textContent, 'Prices changed: review plan v3');
});

test('FU-58: the request page isolates the refusal reason in the status line, the commitment card and the failure card', () => {
  // view-cancelling-voids holds a refused order next to the message; the reason is set on both, as the server does
  const view = recoveryView('view-cancelling-voids');
  const reason = `Out of lids${BIDI}`;
  view.rescueStatus.message = `Supplier A refused the order: ${reason}. No money was taken.`;
  for (const o of [...view.orders, ...view.cancellingOrders]) if (o.fulfilmentStatus === 'refused') o.refusalReason = reason;
  const refused = [...view.orders, ...view.cancellingOrders].find((o) => o.fulfilmentStatus === 'refused');
  assert.ok(refused, 'the fixture holds a refused order');
  if (!view.orders.includes(refused)) view.orders = [...view.orders, refused]; // the commitment cards list current orders
  const root = wrap([renderRequestPage(buildRequestViewModel(view), NOOP_HANDLERS)]);
  const outside = (testid) => {
    const node = byTestId(root, testid);
    assert.ok(node, testid);
    const bdi = node.all((n) => n.tagName === 'BDI');
    assert.ok(bdi.length >= 1, `${testid}: has an isolate`);
    // everything outside every <bdi> is free of bidi controls
    let rest = '';
    const collect = (n) => { for (const c of n.children) { if (c.nodeType === 3) rest += c.data; else if (c.tagName !== 'BDI') collect(c); } };
    collect(node);
    assert.doesNotMatch(rest, /[‪-‮⁦-⁩]/, `${testid}: no bidi control outside the isolate`);
    return bdi;
  };
  outside('rescue-message');
  outside('failure-message');
  const refusalCards = root.all((n) => (n.getAttribute('data-testid') ?? '').endsWith('-refusal'));
  assert.ok(refusalCards.length >= 1, 'a failure card shows the reason');
  for (const card of refusalCards) outside(card.getAttribute('data-testid'));
  const commitment = root.all((n) => (n.getAttribute('data-testid') ?? '').startsWith('commit-') && n.textContent.includes('Reason: '));
  assert.ok(commitment.length >= 1, 'a commitment card shows the reason');
  assert.ok(commitment[0].all((n) => n.tagName === 'BDI' && n.textContent === reason).length >= 1);
});

test('FU-58: the supplier screen isolates the reason the supplier gave', async () => {
  const list = body('supplier-orders');
  const target = list.orders.find((o) => o.fulfilmentStatus === 'refused') ?? list.orders[0];
  target.fulfilmentStatus = 'refused';
  target.refusalReason = `Closed${BIDI}`;
  const { ctx, container } = baseCtx({ listSupplierOrders: async () => list });
  mountSupplierOrders(ctx, parseRoute('#/supplier/orders'));
  await tick();
  const bdi = container.all((n) => n.tagName === 'BDI');
  assert.ok(bdi.some((n) => n.textContent === `Closed${BIDI}`));
});

// ---- RS-35: the six answers, in order, and every state of every section ------------------------------------------------------

test('RS-35: the request page answers the six questions in the spec\'s order, with the status first and the actions last', () => {
  assert.deepEqual(SECTION_ORDER, ['status', 'need', 'why', 'rejected', 'total', 'commitments', 'failure', 'actions']);
  const vm = buildRequestViewModel(body('request-view-planned'));
  assert.deepEqual(vm.sectionOrder, SECTION_ORDER);
  assert.deepEqual(vm.sections.map((s) => s.heading), [
    'Status', SECTION_TITLES.need, SECTION_TITLES.why, SECTION_TITLES.rejected, SECTION_TITLES.total, SECTION_TITLES.commitments, SECTION_TITLES.failure, SECTION_TITLES.actions,
  ]);
  assert.deepEqual([SECTION_TITLES.need, SECTION_TITLES.why, SECTION_TITLES.rejected, SECTION_TITLES.total, SECTION_TITLES.commitments, SECTION_TITLES.failure],
    ['What you need', 'Why this plan', 'What was rejected', 'Total', 'Supplier commitments', 'If something fails']);
  const root = wrap([renderRequestPage(vm, NOOP_HANDLERS)]);
  const headings = root.all((n) => n.tagName === 'H2').map(textOf);
  assert.deepEqual(headings, vm.sections.map((s) => s.heading));
  // every section is a labelled region
  for (const section of root.all((n) => n.tagName === 'SECTION')) {
    const labelId = section.getAttribute('aria-labelledby');
    assert.ok(labelId && root.all((n) => n.getAttribute('id') === labelId).length === 1, `${section.getAttribute('id')}: aria-labelledby points at its heading`);
  }
});

test('RS-35: success -> every data section of a planned request renders its data, with the demo and price labels', () => {
  const vm = buildRequestViewModel(body('request-view-planned'));
  const by = Object.fromEntries(vm.sections.map((s) => [s.id, s.model]));
  for (const id of ['why', 'total', 'commitments']) assert.equal(by[id].state, 'ready', id);
  const root = wrap([renderRequestPage(vm, NOOP_HANDLERS)]);
  assert.ok(byTestId(root, 'plan-lines'));
  assert.ok(byTestId(root, 'totals-table'));
  assert.equal(textOf(byTestId(root, 'price-notice')), 'Test prices, not market prices');
  assert.ok(allByTestId(root, 'badge-demo').length >= 2, 'seeded suppliers carry the Demo data badge');
  assert.equal(textOf(allByTestId(root, 'badge-demo')[0]), 'Demo data');
});

test('RS-35: empty -> a request with no plan renders an explained empty state in every data section', () => {
  const view = body('request-view-degraded');
  const vm = buildRequestViewModel(view);
  const by = Object.fromEntries(vm.sections.map((s) => [s.id, s.model]));
  for (const id of ['why', 'rejected', 'total', 'commitments', 'failure']) assert.equal(by[id].state, 'empty', `${id}: empty`);
  const root = wrap([renderRequestPage(vm, NOOP_HANDLERS)]);
  for (const id of ['why', 'rejected', 'total', 'commitments', 'failure']) {
    const empty = byTestId(root, `${id}-empty`);
    assert.ok(empty, `${id}-empty`);
    assert.ok(textOf(empty).length > 10, `${id}: the empty state says why`);
    assert.equal(empty.getAttribute('class'), 'state state-empty');
  }
});

test('RS-35: degraded extraction -> the notice and a manual input for every core field, each labelled', () => {
  const vm = buildRequestViewModel(body('request-view-degraded'));
  assert.equal(vm.sections.find((s) => s.id === 'need').model.degraded, true);
  const root = wrap([renderRequestPage(vm, NOOP_HANDLERS)]);
  assert.equal(textOf(byTestId(root, 'degraded-notice')), 'Automatic reading unavailable — please enter the details');
  assert.equal(byTestId(root, 'degraded-notice').getAttribute('role'), 'status');
  for (const name of ['productType', 'cupQuantity', 'lidQuantity', 'capacityMl', 'diameterMm', 'material', 'deadline', 'budgetCents', 'maxPickups']) {
    assert.ok(byTestId(root, `input-${name}`), `input-${name}`);
  }
  assert.deepEqual(controlsWithoutLabel(root), []);
  assert.ok(allByTestId(root, 'badge-simulated').length >= 1, 'the simulated extraction is labelled');
});

test('RS-35: expired reservation -> the exact sentence and its own Re-plan button', () => {
  const view = recoveryView('view-reservation-expired');
  const root = wrap([renderRequestPage(buildRequestViewModel(view), NOOP_HANDLERS)]);
  const notice = byTestId(root, 'reservation-expired');
  assert.ok(notice);
  assert.match(textOf(notice), /Reservation expired — no money was taken; re-plan with current stock/);
  assert.equal(byTestId(notice, 'replan').tagName, 'BUTTON');
  assert.equal(textOf(byTestId(notice, 'replan')), 'Re-plan');
});

test('RS-35: loading, error with Retry, and timeout with Retry are the states of every fetched view', async () => {
  const slot = el('div');
  showState(slot, { kind: 'loading' });
  assert.equal(slot.getAttribute('aria-busy'), 'true');
  const loading = byTestId(slot, 'state-loading');
  assert.equal(loading.getAttribute('role'), 'status');
  assert.equal(textOf(loading), 'Loading…');

  let retried = 0;
  showState(slot, { kind: 'error', error: apiError('INTERNAL', 500), onRetry: () => { retried += 1; } });
  assert.equal(slot.getAttribute('aria-busy'), null, 'busy is cleared when the answer is shown');
  const error = byTestId(slot, 'state-error');
  assert.equal(error.getAttribute('role'), 'alert');
  assert.match(textOf(error), /Request id: req-test-00000001/, 'the request id is shown so the user can quote it');
  await byTestId(slot, 'retry').fire('click');
  assert.equal(retried, 1);

  const timeout = errorNode(new ApiError({ kind: 'timeout', code: 'CLIENT_TIMEOUT', message: EXACT.TIMEOUT }), { onRetry: () => { retried += 1; } });
  assert.equal(timeout.getAttribute('data-testid'), 'state-timeout');
  assert.equal(textOf(timeout.children[0]), 'The server is taking too long.');
  assert.ok(byTestId(timeout, 'retry'), 'a timeout offers Retry');
  assert.ok(textOf(timeout.children[1]).length > 5, 'and says what to do next');
  assert.equal(loadingNode('Applying…').getAttribute('role'), 'status');
});

test('RS-35: the admin sections show loading, then an error with Retry or the data, and an empty timeline says so', async () => {
  let calls = 0;
  const api = {
    getTimeline: async () => { calls += 1; if (calls === 1) throw apiError('INTERNAL', 500); return { events: [], requestId: 'req-x1234567' }; },
    getMetrics: async () => body('admin-metrics'),
  };
  const { ctx, container } = baseCtx(api, { config: CONFIGS.fake });
  mountAdmin(ctx, parseRoute('#/admin'));
  assert.ok(byTestId(container, 'state-loading'), 'loading first');
  await tick();
  const slot = byTestId(container, 'timeline-slot');
  assert.ok(byTestId(slot, 'state-error'));
  await byTestId(slot, 'retry').fire('click');
  await tick();
  assert.ok(byTestId(container, 'timeline-empty'), 'an empty timeline is an explained state');
  assert.ok(byTestId(container, 'metrics-reconciler'));
});

test('RS-35: the requests list renders empty (with the call to action), error with Retry, and success with the price notice', async () => {
  const empty = baseCtx({ listRequests: async () => body('requests-list-empty') });
  mountRequestsList(empty.ctx, parseRoute('#/requests'));
  await tick();
  assert.match(textOf(byTestId(empty.container, 'requests-empty')), /No rescue requests yet/);
  assert.match(textOf(empty.container), /Start a rescue request/);
  const failing = baseCtx({ listRequests: async () => { throw apiError('INTERNAL', 500); } });
  mountRequestsList(failing.ctx, parseRoute('#/requests'));
  await tick();
  assert.ok(byTestId(failing.container, 'retry'));
  const ok = baseCtx({ listRequests: async () => body('requests-list') });
  mountRequestsList(ok.ctx, parseRoute('#/requests'));
  await tick();
  assert.ok(byTestId(ok.container, 'requests-table'));
  assert.equal(textOf(byTestId(ok.container, 'price-notice')), 'Test prices, not market prices');
});

// ---- NFR2: every control has a label; describedby targets exist -----------------------------------------------------------------

const SKIP_TYPES = new Set(['hidden', 'submit', 'button']);

// -> list of descriptions of controls that no screen reader could name
function controlsWithoutLabel(root) {
  const labelFor = new Set(root.all((n) => n.tagName === 'LABEL' && n.getAttribute('for')).map((n) => n.getAttribute('for')));
  const problems = [];
  root.walk((n) => {
    const desc = `${n.tagName.toLowerCase()}${n.getAttribute('id') ? `#${n.getAttribute('id')}` : ''}[${n.getAttribute('data-testid') ?? ''}]`;
    if (['INPUT', 'SELECT', 'TEXTAREA'].includes(n.tagName)) {
      if (SKIP_TYPES.has(n.getAttribute('type'))) return;
      const named = (n.getAttribute('aria-label') ?? '').trim() !== '' || n.getAttribute('aria-labelledby') !== null || (n.getAttribute('id') !== null && labelFor.has(n.getAttribute('id')));
      if (!named) problems.push(`${desc} has no label`);
      if (n.getAttribute('id') === null && n.getAttribute('aria-label') === null) problems.push(`${desc} has no id to tie a label to`);
    } else if (n.tagName === 'BUTTON' || n.tagName === 'SUMMARY') {
      if (n.getAttribute('type') === null && n.tagName === 'BUTTON') problems.push(`${desc} has no explicit type`);
      if ((n.getAttribute('aria-label') ?? n.textContent).trim() === '') problems.push(`${desc} has no name`);
    } else if (n.tagName === 'A' && n.getAttribute('href') !== null) {
      if ((n.getAttribute('aria-label') ?? n.textContent).trim() === '') problems.push(`${desc} has no name`);
    }
  });
  return problems;
}

// -> aria-describedby / aria-labelledby ids that point at nothing, and ids used twice
function brokenReferences(root) {
  const ids = new Map();
  root.walk((n) => { const id = n.getAttribute('id'); if (id) ids.set(id, (ids.get(id) ?? 0) + 1); });
  const problems = [];
  root.walk((n) => {
    for (const attr of ['aria-describedby', 'aria-labelledby']) {
      for (const id of (n.getAttribute(attr) ?? '').split(/\s+/).filter(Boolean)) if (!ids.has(id)) problems.push(`${attr}="${id}" has no target`);
    }
  });
  for (const [id, n] of ids) if (n > 1) problems.push(`id "${id}" is used ${n} times`);
  return problems;
}

test('NFR2: every control on every view the SPA builds has a label, a name and an explicit type, and every aria reference has a target', async () => {
  const screens = [];
  const sign = baseCtx({});
  mountSignIn(sign.ctx, parseRoute('#/signin'));
  screens.push(['signin', sign.container]);
  const reg = baseCtx({}, { config: CONFIGS.fake });
  mountRegister(reg.ctx, parseRoute('#/register'));
  screens.push(['register', reg.container]);
  const fresh = baseCtx({});
  mountRequestNew(fresh.ctx, parseRoute('#/requests/new'));
  screens.push(['request-new', fresh.container]);
  const orders = baseCtx({ listSupplierOrders: async () => body('supplier-orders') });
  mountSupplierOrders(orders.ctx, parseRoute('#/supplier/orders'));
  const inventory = baseCtx({ getSupplierInventory: async () => body('supplier-inventory') });
  mountSupplierInventory(inventory.ctx, parseRoute('#/supplier/inventory'));
  const admin = baseCtx({ getTimeline: async () => body('admin-timeline'), getMetrics: async () => body('admin-metrics') }, { config: CONFIGS.fake });
  mountAdmin(admin.ctx, parseRoute('#/admin'));
  await tick();
  screens.push(['supplier-orders', orders.container], ['supplier-inventory', inventory.container], ['admin', admin.container]);

  const names = readdirSync(CONTRACTS).filter((f) => /^request-view-.*\.json$/.test(f)).map((f) => f.replace(/\.json$/, ''));
  for (const name of names) screens.push([name, wrap([renderRequestPage(buildRequestViewModel(body(name)), NOOP_HANDLERS)])]);
  for (const f of readdirSync(path.join(CONTRACTS, 'recovery')).filter((x) => x.startsWith('view-'))) {
    screens.push([`recovery/${f}`, wrap([renderRequestPage(buildRequestViewModel(recoveryView(f.replace(/\.json$/, ''))), NOOP_HANDLERS)])]);
  }
  for (const f of readdirSync(path.join(CONTRACTS, 'payments')).filter((x) => x.startsWith('view-'))) {
    screens.push([`payments/${f}`, wrap([renderRequestPage(buildRequestViewModel(paymentView(f.replace(/\.json$/, ''))), NOOP_HANDLERS)])]);
  }
  assert.ok(screens.length >= 25, `expected many screens, built ${screens.length}`);
  let controls = 0;
  for (const [name, root] of screens) {
    assert.deepEqual(controlsWithoutLabel(root), [], name);
    assert.deepEqual(brokenReferences(root), [], name);
    controls += root.all((n) => ['INPUT', 'SELECT', 'TEXTAREA', 'BUTTON'].includes(n.tagName)).length;
  }
  assert.ok(controls >= 60, `the check looked at ${controls} controls`);
});

test('NFR2: a field error is tied to its control by aria-describedby and marks it invalid; a disabled action gives a text reason', () => {
  const view = body('request-view-degraded');
  const vm = buildRequestViewModel(view);
  const root = wrap([renderRequestPage(vm, NOOP_HANDLERS, { cupQuantity: 'Required.' })]);
  const input = byTestId(root, 'input-cupQuantity');
  assert.equal(input.getAttribute('aria-invalid'), 'true');
  const errorId = input.getAttribute('aria-describedby').split(' ').find((id) => id.endsWith('-error'));
  const error = root.all((n) => n.getAttribute('id') === errorId)[0];
  assert.equal(textOf(error), 'Required.');
  assert.equal(error.getAttribute('role'), 'alert');

  const planned = body('request-view-planned');
  planned.requirements.fields.budgetCents = { value: null, status: 'unknown', provenance: 'none', originalWording: null };
  const approve = byTestId(wrap([renderRequestPage(buildRequestViewModel(planned), NOOP_HANDLERS)]), 'approve-plan');
  if (approve && approve.getAttribute('aria-disabled') === 'true') {
    const reasonId = approve.getAttribute('aria-describedby');
    assert.ok(reasonId, 'an aria-disabled button names its reason');
  }
});
