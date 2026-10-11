// Phase D, task d4: the extraction UI. Pure view-models checked against the extraction contract fixtures
// (request-extract, request-extract-degraded, request-view-degraded), the DOM they build under a tiny fake document,
// the new-request screen's states (idle, creating, uploading, extracting with Cancel, error with Retry, cancelled),
// the capability flag for "Delete request" (TR-C-4), the URL check (SEC-C-4) and the corrected fixtures (FU-13).
// DOM-free: plain `node --test`. Every test name starts with the id of the criterion or finding it proves.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { setDocument, el, isAllowedUrl, setAttr } from '../../../public/js/dom.js';
import { ApiError, EXTRACT_TIMEOUT_MS, UPLOAD_TIMEOUT_MS, createApi } from '../../../public/js/api.js';
import { describeError } from '../../../public/js/errors.js';
import { formatBytes, hasUnsafeUrlChars, isNavigableUrl } from '../../../public/js/format.js';
import { parseRoute } from '../../../public/js/router.js';
import { EXACT } from '../../../public/js/texts.js';
import { badgeNodes, extractionBadgeModels } from '../../../public/js/components/badges.js';
import { NEED_COLUMNS, buildConfirmBody, needModel, renderNeed } from '../../../public/js/components/fields-table.js';
import { actionsModel } from '../../../public/js/components/payments.js';
import { deleteRequestAvailable } from '../../../public/js/view-helpers.js';
import { buildRequestViewModel, renderRequestPage } from '../../../public/js/views/request-detail.js';
import {
  IMAGE_ACCEPT, IMAGE_TYPES, MAX_IMAGE_BYTES, classifyExtractFailure, mountRequestNew, progressModel, validateImageFile,
} from '../../../public/js/views/request-new.js';

// ---- fixtures ----------------------------------------------------------------------------------------------------------

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = path.join(HERE, '..', '..', 'fixtures', 'contracts');
const fixtures = new Map();
for (const file of readdirSync(FIXTURE_DIR).filter((f) => f.endsWith('.json')).sort()) {
  fixtures.set(file.replace(/\.json$/, ''), JSON.parse(readFileSync(path.join(FIXTURE_DIR, file), 'utf8')));
}
const body = (name) => structuredClone(fixtures.get(name).response);
const CSS = readFileSync(path.join(HERE, '..', '..', '..', 'public', 'css', 'app.css'), 'utf8');

// ---- a tiny fake DOM (same shape as the one in dashboards.test.js) -----------------------------------------------------------

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
    this.files = null;
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
const wrap = (nodes) => { const root = el('div'); for (const n of nodes) if (n) root.appendChild(n); return root; };
const apiError = (code, status, details = null) => new ApiError({ kind: 'http', status, code, message: 'm', requestId: 'req-err-00000001', details });

// A request view that holds a given extraction and no requirements yet (the state right after "extract").
function viewWith(extraction, overrides = {}) {
  const view = body('request-view-degraded');
  view.extraction = extraction;
  return { ...view, ...overrides };
}
const extractionOf = (name) => body(name).extraction;

// ---- RS-02, SEC-8: provenance badges, original wording ---------------------------------------------------------------------------------

test('RS-02: the "What you need" model shows the badge text for each provenance: From your text, From the photo, Entered by you, Not found', () => {
  const model = needModel(viewWith(extractionOf('request-extract')));
  const row = (name) => model.rows.find((r) => r.name === name);
  assert.equal(row('cupQuantity').provenanceText, 'From your text');
  assert.equal(row('diameterMm').provenanceText, 'From the photo');
  assert.equal(row('material').provenanceText, 'Not found');
  assert.equal(row('deadline').provenanceText, 'Not found');
  assert.equal(row('cupQuantity').provenance, 'user_text');
  assert.equal(row('diameterMm').provenance, 'image');

  // The server derives "manual" (SEC-8); the UI only shows it.
  const confirmed = viewWith(extractionOf('request-extract'), {
    requirements: { version: 1, confirmedAt: '2026-10-20T06:10:00.000Z', fields: structuredClone(extractionOf('request-extract').fields) },
  });
  confirmed.requirements.fields.material = { value: 'paper', status: 'known', provenance: 'manual', originalWording: null };
  const after = needModel(confirmed);
  assert.equal(after.rows.find((r) => r.name === 'material').provenanceText, 'Entered by you');
  assert.deepEqual(model.rows.map((r) => r.testid), [
    'field-productType', 'field-cupQuantity', 'field-lidQuantity', 'field-capacityMl', 'field-diameterMm',
    'field-material', 'field-deadline', 'field-budgetCents', 'field-maxPickups',
  ]);
});

test('SEC-8: the confirm body holds values only; a provenance, a wording or any other key typed into the form never leaves the UI', () => {
  const values = {
    productType: 'cups_and_lids', cupQuantity: '200', lidQuantity: '200', capacityMl: '250', diameterMm: '90', material: 'paper',
    deadline: '2026-10-20T11:00', budgetCents: '120.00', maxPickups: '2', provenance: 'user_text', originalWording: 'x',
  };
  const built = buildConfirmBody(values);
  assert.equal(built.ok, true);
  assert.deepEqual(Object.keys(built.fields).sort(), ['budgetCents', 'capacityMl', 'cupQuantity', 'deadline', 'diameterMm', 'lidQuantity', 'material', 'maxPickups', 'productType']);
  for (const value of Object.values(built.fields)) assert.ok(typeof value === 'string' || typeof value === 'number', 'a plain value, never an object with provenance');
  assert.equal(built.fields.budgetCents, 12000);
});

test('RS-02: image wording sits under the label "Text read from the photo", text wording under "Your words", both with dir=auto', () => {
  const model = needModel(viewWith(extractionOf('request-extract')));
  assert.equal(EXACT.PHOTO_WORDING, 'Text read from the photo');
  const image = model.rows.find((r) => r.name === 'diameterMm');
  assert.deepEqual([image.wording, image.wordingLabel], ['Lid Ø 90 mm', 'Text read from the photo']);
  const text = model.rows.find((r) => r.name === 'cupQuantity');
  assert.deepEqual([text.wording, text.wordingLabel], ['200 cups', 'Your words']);
  assert.deepEqual([model.rows.find((r) => r.name === 'material').wording, model.rows.find((r) => r.name === 'material').wordingLabel], [null, null]);

  const root = wrap(renderNeed(model));
  const photoWording = byTestId(root, 'field-diameterMm-wording');
  assert.equal(photoWording.getAttribute('dir'), 'auto');
  assert.equal(textOf(photoWording), 'Lid Ø 90 mm');
  assert.match(textOf(byTestId(root, 'field-diameterMm')), /Text read from the photo: Lid Ø 90 mm/);
  assert.equal(byTestId(root, 'field-cupQuantity-wording').getAttribute('dir'), 'auto');
  assert.equal(textOf(byTestId(root, 'field-cupQuantity-provenance')), 'From your text');
  assert.equal(textOf(byTestId(root, 'field-diameterMm-provenance')), 'From the photo');
  assert.equal(textOf(byTestId(root, 'field-material-provenance')), 'Not found');
});

test('SEC-7: wording, values and questions are rendered as text; markup in them never becomes an element, and rephrased text is not shown', () => {
  const extraction = extractionOf('request-extract');
  extraction.fields.cupQuantity.originalWording = '<img src=x onerror=alert(1)> 200 cups';
  extraction.fields.diameterMm.originalWording = '<script>alert(2)</script> Ø 90';
  extraction.questions = [{ field: 'material', question: 'Should the cups be <b>paper</b> or plastic?' }];
  const view = viewWith(extraction);
  view.plans = [];
  const root = wrap(renderNeed(needModel(view)));
  assert.equal(root.all((n) => ['IMG', 'SCRIPT', 'B'].includes(n.tagName)).length, 0, 'no element is created from model text');
  assert.match(root.textContent, /<img src=x onerror=alert\(1\)> 200 cups/);
  assert.match(root.textContent, /<script>alert\(2\)<\/script> Ø 90/);
  assert.match(textOf(byTestId(root, 'question-material')), /Should the cups be <b>paper<\/b> or plastic\?/);
  // Explanation.rephrased is never part of the "What you need" model or page
  const planned = body('request-view-planned');
  planned.plans[0].explanation.rephrased = { text: 'REPHRASED-BY-A-MODEL', label: 'AI-rephrased' };
  const page = renderRequestPage(buildRequestViewModel(planned));
  assert.doesNotMatch(page.textContent, /REPHRASED-BY-A-MODEL|AI-rephrased/);
});

test('SEC-7: the clarification questions are the server\'s templates, listed once, and only for fields that are still unknown', () => {
  const extraction = extractionOf('request-extract');
  extraction.questions.push({ field: 'cupQuantity', question: 'How many cups do you need?' }); // already known: not asked again
  const model = needModel(viewWith(extraction));
  assert.deepEqual(model.questions.map((q) => q.field), ['material', 'deadline']);
  assert.deepEqual(model.questions.map((q) => q.question), [
    'Should the cups be paper or plastic?',
    'By when do you need them? Please give a date and a time.',
  ]);
  const root = wrap(renderNeed(model));
  assert.equal(allByTestId(root, 'question-material').length, 1);
  assert.match(textOf(byTestId(root, 'questions')), /Questions to answer/);
  assert.equal(allByTestId(root, 'question-cupQuantity').length, 0);
  assert.equal(allByTestId(wrap(renderNeed(needModel(viewWith(extractionOf('request-extract-degraded'))))), 'questions').length, 0, 'no questions, no list');
});

// ---- RS-03: the degraded path ------------------------------------------------------------------------------------------------------------------

test('RS-03: a degraded extraction shows "Automatic reading unavailable — please enter the details" and an open manual form with an input for every field', () => {
  for (const view of [body('request-view-degraded'), viewWith(extractionOf('request-extract-degraded'))]) {
    const model = needModel(view);
    assert.equal(model.degraded, true);
    assert.equal(model.degradedText, 'Automatic reading unavailable — please enter the details');
    assert.equal(model.form.open, true, 'the form is open, not behind a toggle');
    assert.deepEqual(model.form.inputs.map((i) => i.name), [
      'productType', 'cupQuantity', 'lidQuantity', 'capacityMl', 'diameterMm', 'material', 'deadline', 'budgetCents', 'maxPickups',
    ]);
    const core = model.form.inputs.filter((i) => i.required).map((i) => i.name);
    assert.deepEqual(core, ['productType', 'cupQuantity', 'lidQuantity', 'capacityMl', 'diameterMm', 'maxPickups'], 'every core field is required');
    for (const input of model.form.inputs) assert.equal(input.value, '', `${input.name} starts empty: nothing was read`);
    assert.ok(model.rows.every((r) => r.provenanceText === 'Not found'));
  }
  const root = wrap(renderNeed(needModel(body('request-view-degraded')), { confirm: () => {} }));
  const notice = byTestId(root, 'degraded-notice');
  assert.equal(textOf(notice), 'Automatic reading unavailable — please enter the details');
  assert.equal(notice.getAttribute('role'), 'status');
  const form = byTestId(root, 'manual-form');
  assert.ok(form, 'the manual form is on the page');
  for (const name of ['productType', 'cupQuantity', 'lidQuantity', 'capacityMl', 'diameterMm', 'material', 'deadline', 'budgetCents', 'maxPickups']) {
    const control = byTestId(form, `input-${name}`);
    assert.ok(control, `input-${name}`);
    const labels = form.all((n) => n.tagName === 'LABEL' && n.getAttribute('for') === control.getAttribute('id'));
    assert.equal(labels.length, 1, `input-${name} has a label`);
  }
  assert.ok(byTestId(form, 'confirm-requirements'));
  assert.equal(allByTestId(wrap(renderNeed(needModel(viewWith(extractionOf('request-extract'))), { confirm: () => {} })), 'degraded-notice').length, 0, 'no notice when the reading worked');
});

test('RS-03: once the customer has confirmed the details the degraded notice is gone; before that it keeps its exact wording', () => {
  const degraded = body('request-view-degraded');
  assert.equal(degraded.requirements, null);
  assert.equal(needModel(degraded).degraded, true, 'degraded and unconfirmed: the notice stays');
  assert.equal(textOf(byTestId(wrap(renderNeed(needModel(degraded), { confirm: () => {} })), 'degraded-notice')), 'Automatic reading unavailable — please enter the details');

  const confirmed = body('request-view-planned');
  confirmed.extraction = extractionOf('request-extract-degraded');
  assert.equal(confirmed.extraction.degraded, true, 'the stored extraction is still the degraded one');
  assert.notEqual(confirmed.requirements, null, 'the customer has confirmed details');
  const model = needModel(confirmed);
  assert.equal(model.degraded, false, 'the notice is stale once requirements exist');
  assert.equal(allByTestId(wrap(renderNeed(model, { confirm: () => {} })), 'degraded-notice').length, 0);
});

test('RS-03: a degraded reading cannot be edited after the plan is executing or executed (the form is locked)', () => {
  const view = body('request-view-reserved');
  view.plans[0].status = 'executing';
  assert.equal(needModel(view).form.locked, true);
  assert.equal(needModel(body('request-view-degraded')).form.locked, false);
});

// ---- addressedToAssistant, simulated badge -------------------------------------------------------------------------------------------------------

test('RS-05: addressedToAssistant shows "This request contains text addressed to an AI; it was ignored." and nothing is acted on', () => {
  const extraction = extractionOf('request-extract');
  assert.equal(needModel(viewWith(extraction)).aiAddressed, false);
  assert.equal(allByTestId(wrap(renderNeed(needModel(viewWith(extraction)))), 'ai-addressed-notice').length, 0);
  extraction.addressedToAssistant = true;
  const model = needModel(viewWith(extraction));
  assert.equal(model.aiAddressed, true);
  assert.equal(model.aiAddressedText, 'This request contains text addressed to an AI; it was ignored.');
  const notice = byTestId(wrap(renderNeed(model)), 'ai-addressed-notice');
  assert.equal(textOf(notice), 'This request contains text addressed to an AI; it was ignored.');
  // The same fields are still shown as read: the flag changes the message only.
  assert.equal(model.rows.find((r) => r.name === 'cupQuantity').valueText, '200');
  extraction.addressedToAssistant = 'yes';
  assert.equal(needModel(viewWith(extraction)).aiAddressed, false, 'only a real true shows the notice');
  delete extraction.addressedToAssistant;
  assert.equal(needModel(viewWith(extraction)).aiAddressed, false, 'a server that does not send the flag shows no notice');
});

test('RS-34: a "Simulated" extraction badge shows while the fake provider is active, and not otherwise', () => {
  const extraction = extractionOf('request-extract');
  assert.equal(extraction.simulated, true);
  assert.deepEqual(extractionBadgeModels(extraction), [{ text: 'Simulated', testid: 'badge-simulated' }]);
  const root = wrap(renderNeed(needModel(viewWith(extraction))));
  assert.equal(textOf(byTestId(root, 'badge-simulated')), 'Simulated');
  extraction.simulated = false;
  extraction.provider = 'cli';
  assert.deepEqual(extractionBadgeModels(extraction), []);
  assert.equal(allByTestId(wrap(renderNeed(needModel(viewWith(extraction)))), 'badge-simulated').length, 0);
  assert.equal(badgeNodes(extractionBadgeModels(extractionOf('request-extract-degraded'))).length, 1);
});

test('RS-02: the request page notes the attached photo by type and size', () => {
  const view = body('request-view-degraded');
  assert.equal(needModel(view).photoNote, null);
  view.request.image = { id: 4, mime: 'image/jpeg', bytes: 48213 };
  assert.equal(needModel(view).photoNote, 'Photo attached: JPEG, 47.1 KB.');
  assert.equal(formatBytes(5242880), '5.0 MB');
  assert.equal(formatBytes(900), '900 bytes');
  assert.equal(formatBytes(-1), '—');
});

// ---- FU-17 / TR-C-6: the table at 360 px ---------------------------------------------------------------------------------------------------------

test('FU-17: every cell of "What you need" names its column, so the stacked table at 360 px still reads Original wording', () => {
  assert.deepEqual([...NEED_COLUMNS], ['Field', 'Value', 'Source', 'Original wording']);
  const root = wrap(renderNeed(needModel(viewWith(extractionOf('request-extract')))));
  const table = byTestId(root, 'fields-table');
  assert.deepEqual(table.all((n) => n.tagName === 'TH' && n.getAttribute('scope') === 'col').map(textOf), ['Field', 'Value', 'Source', 'Original wording']);
  const row = byTestId(root, 'field-diameterMm');
  const cells = row.children.filter((c) => c instanceof FakeElement);
  assert.deepEqual(cells.map((c) => c.getAttribute('data-label')), ['Field', 'Value', 'Source', 'Original wording']);
  assert.equal(table.getAttribute('role'), 'table', 'table semantics are kept when the layout is stacked');
  assert.equal(row.getAttribute('role'), 'row');
});

test('TR-C-6: the table is not inside a sideways scroll region, and the stylesheet stacks it below 640 px', () => {
  const root = wrap(renderNeed(needModel(viewWith(extractionOf('request-extract')))));
  const table = byTestId(root, 'fields-table');
  const scrollRegions = root.all((n) => n.getAttribute('class') === 'table-scroll');
  assert.equal(scrollRegions.length, 0, 'no table-scroll wrapper (its clipped column was the defect)');
  assert.ok(root.all((n) => n.getAttribute('class') === 'table-stack' && n.children.includes(table)).length === 1);
  assert.equal(table.getAttribute('tabindex'), null);
  const mobile = /@media \(max-width: 639px\) \{([\s\S]*?)\n\}\n/.exec(CSS);
  assert.ok(mobile, 'a max-width: 639px rule exists');
  assert.match(mobile[1], /\.data-table-stack tr[^{]*\{[^}]*display: block/);
  assert.match(mobile[1], /\.data-table-stack td[^{]*\{[^}]*display: block/);
  assert.match(mobile[1], /content: attr\(data-label\)/);
  assert.match(CSS, /\.data-table-stack th, \.data-table-stack td \{ overflow-wrap: anywhere; \}/, 'long wording wraps');
  assert.match(CSS, /\.table-scroll\s*\{[^}]*overflow-x:\s*auto/, 'other, numeric tables keep their scroll region');
});

// ---- TR-C-4: Delete request depends on a capability flag ---------------------------------------------------------------------------------------

test('TR-C-4: "Delete request" is offered only when the server reports capabilities.deleteRequest (request view first, then /api/config)', () => {
  const view = body('request-view-planned');
  delete view.capabilities; // the fixture carries the live flag now; this test is about the view WITHOUT it
  assert.equal(deleteRequestAvailable(view, null), false, 'no flag, no button');
  assert.equal(deleteRequestAvailable(view, body('config')), false, 'the config of today carries no capabilities');
  assert.equal(deleteRequestAvailable({ ...view, capabilities: { deleteRequest: true } }, null), true);
  assert.equal(deleteRequestAvailable(view, { capabilities: { deleteRequest: true } }), true, 'the config is the fallback');
  assert.equal(deleteRequestAvailable({ ...view, capabilities: { deleteRequest: false } }, { capabilities: { deleteRequest: true } }), false, 'the request view wins');
  assert.equal(deleteRequestAvailable({ ...view, capabilities: { deleteRequest: 'true' } }, null), false, 'only a boolean true counts');
  assert.equal(actionsModel(view).remove, null);
  assert.deepEqual({ ...actionsModel(view, { config: { capabilities: { deleteRequest: true } } }).remove }, { label: 'Delete request', testid: 'delete-request' });

  const on = { remove: () => {} };
  const hidden = renderRequestPage(buildRequestViewModel(view), on);
  assert.equal(allByTestId(hidden, 'delete-request').length, 0);
  const shown = renderRequestPage(buildRequestViewModel({ ...view, capabilities: { deleteRequest: true } }), on);
  assert.equal(textOf(byTestId(shown, 'delete-request')), 'Delete request');
  const viaConfig = renderRequestPage(buildRequestViewModel(view, { config: { capabilities: { deleteRequest: true } } }), on);
  assert.equal(allByTestId(viaConfig, 'delete-request').length, 1);
  assert.ok(allByTestId(renderRequestPage(buildRequestViewModel(body('request-view-degraded')), on), 'delete-request').length === 1, 'the degraded fixture serves the flag');
});

// ---- SEC-C-4: URLs ------------------------------------------------------------------------------------------------------------------------------

test('SEC-C-4: isAllowedUrl refuses backslashes, whitespace and control characters, and keeps app paths, hashes and http(s) links', () => {
  const ok = [
    '#/requests/12', '/api/requests/12/image', '?paypal=returned&order=3', 'https://www.sandbox.paypal.com/checkoutnow?token=ABC',
    'http://127.0.0.1:41233/fake-paypal/checkout/FAKE-1', '#', '/',
  ];
  for (const url of ok) assert.equal(isAllowedUrl(url), true, url);
  const backslash = String.fromCharCode(92);
  const tab = String.fromCharCode(9);
  const refused = [
    `/${backslash}evil.example/x`, `${backslash}${backslash}evil.example`, `https:${backslash}${backslash}evil.example`, `https://evil.example${backslash}@good.example`,
    `#/requests${backslash}12`, `/api${backslash}x`,
    '/ /evil.example', ' /api/x', '/api/x ', '#/a b', 'https://evil.example/a b',
    `ja${tab}vascript:alert(1)`, `/${tab}/evil.example`, `/${String.fromCharCode(10)}/evil.example`, `/${String.fromCharCode(13)}/evil.example`, `#a${String.fromCharCode(0)}b`,
    `#a${String.fromCharCode(0x7f)}b`, `#a${String.fromCharCode(0x85)}b`, `#a${String.fromCharCode(0xa0)}b`, `#a${String.fromCharCode(0x2028)}b`, `#a${String.fromCharCode(0x3000)}b`, `#a${String.fromCharCode(0xfeff)}b`,
    '//evil.example/x', 'javascript:alert(1)', 'data:text/html,hi', 'vbscript:x', 'evil.example/x', 'https://', 'https:///x', '', `/${'a'.repeat(2100)}`,
  ];
  for (const url of refused) assert.equal(isAllowedUrl(url), false, JSON.stringify(url).slice(0, 60));
  assert.equal(isAllowedUrl(null), false);
  assert.equal(isAllowedUrl(undefined), false);
  assert.equal(isAllowedUrl(42), false);
  const node = el('a');
  assert.throws(() => setAttr(node, 'href', `/${backslash}evil.example`), /URL/);
  assert.throws(() => setAttr(node, 'href', ' #/requests'), /URL/);
  assert.throws(() => setAttr(node, 'src', `/api/x${tab}y`), /URL/);
  assert.throws(() => setAttr(node, 'action', 'https://evil.example/a b'), /URL/);
  setAttr(node, 'href', '#/requests/12');
  assert.equal(node.getAttribute('href'), '#/requests/12');
});

test('SEC-C-4: the PayPal approval link is navigable only when it holds no backslash, whitespace or control character', () => {
  const backslash = String.fromCharCode(92);
  assert.equal(isNavigableUrl('https://www.sandbox.paypal.com/checkoutnow?token=ABC'), true);
  for (const bad of [`https:${backslash}${backslash}evil.example`, `https://evil.example${backslash}.good.example`, 'https://evil.example/a b', `https://evil.example/${String.fromCharCode(9)}x`, ' https://good.example', 'https://good.example\n']) {
    assert.equal(isNavigableUrl(bad), false, JSON.stringify(bad));
  }
  assert.equal(hasUnsafeUrlChars('abc-123/_'), false);
  assert.equal(hasUnsafeUrlChars('a b'), true);
  assert.equal(hasUnsafeUrlChars(null), true);
});

// ---- the new-request screen -----------------------------------------------------------------------------------------------------------------------

test('RS-02: a photo is accepted as PNG, JPEG or WebP up to 5 MB, mirroring the server\'s 415 and 413', () => {
  assert.deepEqual([...IMAGE_TYPES], ['image/png', 'image/jpeg', 'image/webp']);
  assert.equal(IMAGE_ACCEPT, 'image/png,image/jpeg,image/webp');
  assert.equal(MAX_IMAGE_BYTES, 5242880);
  assert.equal(validateImageFile(null), null, 'the photo is optional');
  assert.equal(validateImageFile({ name: 'a.png', type: 'image/png', size: 1 }), null);
  assert.equal(validateImageFile({ name: 'a.jpg', type: 'image/jpeg', size: MAX_IMAGE_BYTES }), null, 'exactly 5 MiB is allowed');
  assert.equal(validateImageFile({ name: 'a.webp', type: 'image/webp', size: 1000 }), null);
  assert.equal(validateImageFile({ name: 'a.gif', type: 'image/gif', size: 1000 }), 'Choose a PNG, JPEG or WebP photo.');
  assert.equal(validateImageFile({ name: 'a.pdf', type: 'application/pdf', size: 1000 }), 'Choose a PNG, JPEG or WebP photo.');
  assert.equal(validateImageFile({ name: 'a.png', type: '', size: 1000 }), 'Choose a PNG, JPEG or WebP photo.');
  assert.equal(validateImageFile({ name: 'a.png', type: 'image/png', size: 0 }), 'That file is empty. Choose another photo.');
  assert.equal(validateImageFile({ name: 'a.png', type: 'image/png', size: MAX_IMAGE_BYTES + 1 }), 'That photo is 5.0 MB. The limit is 5.0 MB. Choose a smaller photo.');
  assert.match(validateImageFile({ name: 'big.png', type: 'image/png', size: 9 * 1024 * 1024 }), /9\.0 MB.*Choose a smaller photo/);
  // the server's own refusals read well too
  assert.match(describeError(apiError('UNSUPPORTED_MEDIA_TYPE', 415)).action, /Choose another photo/);
  assert.match(describeError(apiError('PAYLOAD_TOO_LARGE', 413)).message, /5 MB/);
});

test('RS-03: a failed extract call is classified: cancelled, open the request page (degraded), or retry', () => {
  assert.deepEqual(classifyExtractFailure(new ApiError({ kind: 'cancelled', code: 'CLIENT_CANCELLED', message: 'x' })), { kind: 'cancelled' });
  assert.deepEqual(classifyExtractFailure(apiError('MODEL_BUDGET_EXHAUSTED', 503, { degraded: true, extraction: extractionOf('request-extract-degraded') })), { kind: 'open', reason: 'degraded' });
  assert.deepEqual(classifyExtractFailure(apiError('RATE_LIMITED', 429, { degraded: true, extraction: extractionOf('request-extract-degraded') })), { kind: 'open', reason: 'degraded' });
  assert.deepEqual(classifyExtractFailure(apiError('RATE_LIMITED', 429, { limit: 'general' })), { kind: 'retry' }, 'another rate limit stores no extraction');
  assert.deepEqual(classifyExtractFailure(apiError('NOT_FOUND', 404)), { kind: 'retry' }, 'FU-16: the route exists, so a 404 is an ordinary failure');
  assert.deepEqual(classifyExtractFailure(apiError('INTERNAL', 500)), { kind: 'retry' });
  assert.deepEqual(classifyExtractFailure(new ApiError({ kind: 'timeout', code: 'CLIENT_TIMEOUT', message: 'x' })), { kind: 'retry' });
});

test('RS-03: the progress states say what is happening, name the photo, and only uploading and extracting can be cancelled', () => {
  assert.equal(progressModel('idle'), null);
  assert.deepEqual(progressModel('creating'), { state: 'creating', text: 'Sending your request…', cancellable: false, indeterminate: true });
  assert.deepEqual(progressModel('uploading', { fileName: 'label.png', fileSize: 48213 }), {
    state: 'uploading', text: 'Uploading label.png (47.1 KB)…', cancellable: true, indeterminate: true,
  });
  assert.deepEqual(progressModel('extracting'), { state: 'extracting', text: 'Reading your request…', cancellable: true, indeterminate: true });
  assert.equal(progressModel('done').cancellable, false);
});

function mountNew(api) {
  const announced = [];
  const navigated = [];
  const container = el('main');
  const ctx = { api, container, announce: (t) => announced.push(t), navigate: (h) => navigated.push(h), document: fakeDocument };
  const view = mountRequestNew(ctx, parseRoute('#/requests/new'));
  return { ctx, container, announced, navigated, view };
}
const submitForm = (container) => byTestId(container, 'request-new-form').fire('submit');
const pngFile = (extra = {}) => ({ name: 'label.png', type: 'image/png', size: 48213, ...extra });
function choose(container, file) {
  const input = byTestId(container, 'input-image');
  input.files = file ? [file] : [];
  return input.fire('change');
}

test('RS-02: the idle screen has the labelled textarea (dir=auto) and an optional photo input that accepts png, jpeg and webp', () => {
  const { container } = mountNew({});
  const labels = container.all((n) => n.tagName === 'LABEL').map(textOf);
  assert.deepEqual(labels, ['Describe what you need, in Arabic or English', 'Photo of the package (optional)']);
  const area = byTestId(container, 'input-text');
  assert.equal(area.getAttribute('dir'), 'auto');
  const photo = byTestId(container, 'input-image');
  assert.equal(photo.getAttribute('type'), 'file');
  assert.equal(photo.getAttribute('accept'), 'image/png,image/jpeg,image/webp');
  assert.equal(photo.getAttribute('required'), null, 'the photo is optional');
  assert.equal(photo.getAttribute('aria-describedby'), 'request-image-hint');
  assert.equal(byTestId(container, 'extraction-state').children.length, 0, 'idle: no progress, no error');
  assert.ok(byTestId(container, 'request-new-submit'));
});

test('RS-02: submit with text only creates the request, extracts it, and opens the request page; no upload is made', async () => {
  const calls = [];
  const api = {
    createRequest: async (text) => { calls.push(['create', text]); return body('request-create'); },
    uploadRequestImage: async () => { calls.push(['upload']); return body('request-image-upload'); },
    extractRequest: async (id) => { calls.push(['extract', id]); return body('request-extract'); },
  };
  const { container, navigated, announced } = mountNew(api);
  byTestId(container, 'input-text').value = 'أحتاج 200 كوب مع أغطية';
  await submitForm(container);
  assert.deepEqual(calls, [['create', 'أحتاج 200 كوب مع أغطية'], ['extract', 12]]);
  assert.deepEqual(navigated, ['#/requests/12']);
  assert.ok(announced.includes('Sending your request…'));
  assert.ok(announced.includes('Reading your request…'));
  assert.ok(announced.includes('Details read. Opening your request…'));
});

test('RS-02: submit with a photo creates, uploads the file, extracts, in that order, and opens the request page', async () => {
  const calls = [];
  const file = pngFile();
  const api = {
    createRequest: async (text) => { calls.push(['create', text]); return body('request-create'); },
    uploadRequestImage: async (id, f, opts) => { calls.push(['upload', id, f === file, opts.signal instanceof AbortSignal]); return body('request-image-upload'); },
    extractRequest: async (id, opts) => { calls.push(['extract', id, opts.signal instanceof AbortSignal]); return body('request-extract'); },
  };
  const { container, navigated, announced } = mountNew(api);
  byTestId(container, 'input-text').value = '200 cups and lids';
  await choose(container, file);
  await submitForm(container);
  assert.deepEqual(calls, [['create', '200 cups and lids'], ['upload', 12, true, true], ['extract', 12, true]]);
  assert.deepEqual(navigated, ['#/requests/12']);
  assert.ok(announced.includes('Uploading label.png (47.1 KB)…'));
});

test('RS-02: a photo of the wrong type or size is refused in the browser before anything is sent, with the reason and a label', async () => {
  const calls = [];
  const api = { createRequest: async () => { calls.push('create'); return body('request-create'); } };
  const { container, announced } = mountNew(api);
  byTestId(container, 'input-text').value = '200 cups';
  await choose(container, { name: 'a.gif', type: 'image/gif', size: 5000 });
  assert.match(container.textContent, /Choose a PNG, JPEG or WebP photo\./);
  assert.equal(byTestId(container, 'input-image').getAttribute('aria-invalid'), 'true');
  assert.ok(announced.includes('Choose a PNG, JPEG or WebP photo.'));
  assert.equal(allByTestId(container, 'input-image').length, 1, 'the refused choice is dropped, one photo input remains');
  await choose(container, { name: 'big.png', type: 'image/png', size: MAX_IMAGE_BYTES + 1 });
  assert.match(container.textContent, /Choose a smaller photo\./);
  // a refused photo cannot be submitted either (the chooser was reset, and the check runs again on submit)
  const input = byTestId(container, 'input-image');
  input.files = [{ name: 'big.png', type: 'image/png', size: MAX_IMAGE_BYTES + 1 }];
  await submitForm(container);
  assert.deepEqual(calls, []);
  assert.match(container.textContent, /Choose a smaller photo\./);
});

test('RS-03: while extracting, a Cancel button stops the call; the request is kept and the user can try again or enter the details by hand', async () => {
  let creates = 0;
  let extracts = 0;
  const api = {
    createRequest: async () => { creates += 1; return body('request-create'); },
    extractRequest: (id, { signal }) => {
      extracts += 1;
      if (extracts > 1) return Promise.resolve(body('request-extract'));
      return new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => reject(new ApiError({ kind: 'cancelled', code: 'CLIENT_CANCELLED', message: 'You cancelled this step.' })));
      });
    },
  };
  const { container, navigated, announced } = mountNew(api);
  byTestId(container, 'input-text').value = '200 cups';
  const pending = submitForm(container);
  await tick();
  const state = byTestId(container, 'extraction-extracting');
  assert.ok(state, 'extracting state');
  assert.equal(state.getAttribute('aria-busy'), 'true');
  assert.equal(state.getAttribute('role'), 'status');
  assert.equal(textOf(state.querySelector('p')), 'Reading your request…');
  assert.ok(byTestId(container, 'extraction-progress'), 'a progress element');
  assert.equal(byTestId(container, 'extraction-progress').getAttribute('aria-label'), 'Reading your request…');
  await byTestId(container, 'extraction-cancel').fire('click');
  await pending;
  assert.deepEqual(navigated, [], 'cancel does not leave the screen');
  assert.match(textOf(byTestId(container, 'extraction-cancelled')), /You cancelled\. Your request was saved/);
  assert.equal(byTestId(container, 'extraction-open').getAttribute('href'), '#/requests/12');
  assert.ok(announced.includes('You cancelled. Your request was saved.'));
  await byTestId(container, 'extraction-retry').fire('click');
  assert.equal(creates, 1, 'Try again does not create a second request');
  assert.equal(extracts, 2);
  assert.deepEqual(navigated, ['#/requests/12']);
});

test('RS-03: while uploading, Cancel stops the upload; Try again uploads the photo again and then extracts', async () => {
  const log = [];
  let uploads = 0;
  const api = {
    createRequest: async () => { log.push('create'); return body('request-create'); },
    uploadRequestImage: (id, file, { signal }) => {
      uploads += 1;
      log.push('upload');
      if (uploads > 1) return Promise.resolve(body('request-image-upload'));
      return new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => reject(new ApiError({ kind: 'cancelled', code: 'CLIENT_CANCELLED', message: 'x' })));
      });
    },
    extractRequest: async () => { log.push('extract'); return body('request-extract'); },
  };
  const { container, navigated } = mountNew(api);
  byTestId(container, 'input-text').value = '200 cups';
  await choose(container, pngFile());
  const pending = submitForm(container);
  await tick();
  assert.match(textOf(byTestId(container, 'extraction-uploading')), /Uploading label\.png \(47\.1 KB\)…/);
  await byTestId(container, 'extraction-cancel').fire('click');
  await pending;
  assert.ok(byTestId(container, 'extraction-cancelled'));
  await byTestId(container, 'extraction-retry').fire('click');
  assert.deepEqual(log, ['create', 'upload', 'upload', 'extract']);
  assert.deepEqual(navigated, ['#/requests/12']);
});

test('RS-03: an extract error shows what to do and a Retry button; Retry repeats only the failed step', async () => {
  const log = [];
  let extracts = 0;
  const api = {
    createRequest: async () => { log.push('create'); return body('request-create'); },
    uploadRequestImage: async () => { log.push('upload'); return body('request-image-upload'); },
    extractRequest: async () => {
      extracts += 1;
      log.push('extract');
      if (extracts === 1) throw new ApiError({ kind: 'timeout', code: 'CLIENT_TIMEOUT', message: 'The server is taking too long.' });
      return body('request-extract');
    },
  };
  const { container, navigated, announced } = mountNew(api);
  byTestId(container, 'input-text').value = '200 cups';
  await choose(container, pngFile());
  await submitForm(container);
  const error = byTestId(container, 'state-timeout');
  assert.ok(error, 'the timeout state');
  assert.equal(error.getAttribute('role'), 'alert');
  assert.match(error.textContent, /The server is taking too long\./);
  assert.match(error.textContent, /Try again in a moment\./);
  assert.ok(byTestId(container, 'extraction-open'), 'the user can leave for the request page');
  assert.ok(announced.some((t) => /taking too long/.test(t)));
  assert.deepEqual(navigated, []);
  await byTestId(container, 'retry').fire('click');
  assert.deepEqual(log, ['create', 'upload', 'extract', 'extract'], 'no second create, no second upload');
  assert.deepEqual(navigated, ['#/requests/12']);

  // a refused upload (415 from the server) offers Retry and the way out, and leaves the request in place
  const refusing = { createRequest: async () => body('request-create'), uploadRequestImage: async () => { throw apiError('UNSUPPORTED_MEDIA_TYPE', 415); } };
  const second = mountNew(refusing);
  byTestId(second.container, 'input-text').value = '200 cups';
  await choose(second.container, pngFile());
  await submitForm(second.container);
  assert.match(byTestId(second.container, 'state-error').textContent, /not a PNG, JPEG or WebP photo/);
  assert.match(byTestId(second.container, 'state-error').textContent, /Request id: req-err-00000001/);
  assert.ok(byTestId(second.container, 'retry'));
});

test('RS-03: when the request cannot be created the form keeps the text and Retry sends it again', async () => {
  let attempts = 0;
  const api = {
    createRequest: async (text) => {
      attempts += 1;
      if (attempts === 1) throw apiError('DB_BUSY', 503);
      assert.equal(text, 'محتاج 100 كوب');
      return body('request-create');
    },
    extractRequest: async () => body('request-extract'),
  };
  const { container, navigated } = mountNew(api);
  byTestId(container, 'input-text').value = 'محتاج 100 كوب';
  await submitForm(container);
  assert.ok(byTestId(container, 'state-error'));
  assert.equal(allByTestId(container, 'extraction-open').length, 0, 'nothing exists yet to open');
  assert.equal(byTestId(container, 'input-text').value, 'محتاج 100 كوب');
  await byTestId(container, 'retry').fire('click');
  assert.equal(attempts, 2);
  assert.deepEqual(navigated, ['#/requests/12']);
});

test('RS-03: a degraded answer (503 MODEL_BUDGET_EXHAUSTED or 429 with a stored extraction) opens the request page', async () => {
  for (const failure of [
    apiError('MODEL_BUDGET_EXHAUSTED', 503, { degraded: true, extraction: extractionOf('request-extract-degraded') }),
    apiError('RATE_LIMITED', 429, { degraded: true, extraction: extractionOf('request-extract-degraded') }),
  ]) {
    const api = { createRequest: async () => body('request-create'), extractRequest: async () => { throw failure; } };
    const { container, navigated } = mountNew(api);
    byTestId(container, 'input-text').value = '200 cups';
    await submitForm(container);
    assert.deepEqual(navigated, ['#/requests/12'], failure.code);
    assert.equal(allByTestId(container, 'state-error').length, 0, failure.code);
  }
});

test('FU-16: a 404 from the extract call is an ordinary failure: the error with what to do and Retry, no navigation', async () => {
  const api = { createRequest: async () => body('request-create'), extractRequest: async () => { throw apiError('NOT_FOUND', 404); } };
  const { container, navigated } = mountNew(api);
  byTestId(container, 'input-text').value = '200 cups';
  await submitForm(container);
  assert.deepEqual(navigated, [], 'the request page is not opened as if the reading had degraded');
  const error = byTestId(container, 'state-error');
  assert.ok(error, 'the error is shown');
  assert.match(error.textContent, /That item was not found\./);
  assert.match(error.textContent, /Go back to your list and open it again\./);
  assert.ok(byTestId(container, 'retry'), 'Retry is offered');
});

test('RS-02: an empty or over-long text is refused in the browser and nothing is sent', async () => {
  const calls = [];
  const api = { createRequest: async () => { calls.push('create'); return body('request-create'); } };
  const { container, announced } = mountNew(api);
  await submitForm(container);
  assert.match(container.textContent, /Describe what you need before you send\./);
  byTestId(container, 'input-text').value = 'x'.repeat(4001);
  await submitForm(container);
  assert.match(container.textContent, /Use at most 4000 characters\./);
  assert.deepEqual(calls, []);
  assert.ok(announced.includes('Describe what you need before you send.'));
});

// ---- api.js: upload, extract, cancel -----------------------------------------------------------------------------------------------------------

function jsonResponse(status, payload) {
  return { ok: status >= 200 && status < 300, status, headers: { get: () => null }, text: async () => JSON.stringify(payload) };
}

test('RS-02: uploadRequestImage sends the raw file with its own Content-Type and the CSRF token, not JSON', async () => {
  const calls = [];
  const api = createApi({ base: '/api', fetchImpl: async (url, init) => { calls.push({ url, init }); return jsonResponse(201, body('request-image-upload')); } });
  api.setCsrfToken('tok-123');
  const file = { name: 'label.png', type: 'image/png', size: 48213 };
  const answer = await api.uploadRequestImage(12, file);
  assert.equal(answer.image.mime, 'image/png');
  assert.equal(calls[0].url, '/api/requests/12/image');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.body, file, 'the file itself is the body');
  assert.equal(calls[0].init.headers['Content-Type'], 'image/png');
  assert.equal(calls[0].init.headers['X-CSRF-Token'], 'tok-123');
  assert.equal(calls[0].init.credentials, 'same-origin');
  assert.equal(UPLOAD_TIMEOUT_MS, 65000);
  assert.equal(EXTRACT_TIMEOUT_MS, 45000);
});

test('RS-03: a cancelled extract call ends as CLIENT_CANCELLED, not as a network or timeout error, and the timer is cleared', async () => {
  const api = createApi({
    base: '/api',
    timeoutMs: 20,
    // like fetch: an already aborted signal rejects at once, a later abort rejects the pending call
    fetchImpl: (url, init) => new Promise((resolve, reject) => {
      const abort = () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
      if (init.signal.aborted) abort();
      else init.signal.addEventListener('abort', abort);
    }),
  });
  api.setCsrfToken('tok-123');
  const controller = new AbortController();
  const pending = api.extractRequest(12, { signal: controller.signal });
  await tick();
  controller.abort();
  await assert.rejects(pending, (err) => err instanceof ApiError && err.kind === 'cancelled' && err.code === 'CLIENT_CANCELLED');
  const already = new AbortController();
  already.abort();
  await assert.rejects(api.extractRequest(12, { signal: already.signal }), (err) => err.code === 'CLIENT_CANCELLED');
  // without a cancel the ordinary 15 s rule (here 20 ms for the test) still applies to other calls
  await assert.rejects(api.getRequest(12), (err) => err.code === 'CLIENT_TIMEOUT');
  assert.match(describeError(new ApiError({ kind: 'cancelled', code: 'CLIENT_CANCELLED', message: 'x' })).action, /Try again/);
});

// ---- FU-13: the corrected contract fixtures ----------------------------------------------------------------------------------------------------------

test('FU-13: plan create (feasible, infeasible), approve and reserve carry the top-level labels object of the live API', () => {
  const keys = Object.keys(body('config').labels).sort();
  for (const name of ['plan-create-feasible', 'plan-create-infeasible', 'plan-approve', 'plan-reserve']) {
    const response = body(name);
    assert.ok(response.labels && typeof response.labels === 'object', `${name}: labels`);
    assert.deepEqual(Object.keys(response.labels).sort(), keys, name);
    assert.equal(response.labels.priceNotice, 'Test prices, not market prices', name);
    assert.equal(typeof response.requestId, 'string', name);
  }
});

test('FU-13: a supplier order that is confirmed but not yet executed reads canMarkReady false; the timeline cursor is an opaque string', () => {
  assert.equal(body('supplier-order-confirm').order.canMarkReady, false);
  assert.equal(body('supplier-order-confirm').order.fulfilmentStatus, 'confirmed');
  const events = body('admin-timeline').events;
  assert.ok(events.length > 0);
  for (const e of events) {
    assert.equal(typeof e.cursor, 'string');
    assert.match(e.cursor, /^\d+\.\d+\.\d+$/, 'an opaque string such as 1728600000000.0.12');
  }
  assert.equal(events[0].cursor, '1728600000000.0.12');
  assert.equal(new Set(events.map((e) => e.cursor)).size, events.length, 'cursors are distinct');
  assert.equal(body('config').reservationTtlMin, 30);
  assert.equal(body('config-sandbox-test-mode').reservationTtlMin, 30);
});

test('FU-13: the order-owned supplier name is the seeded "Demo Supplier X", the plan total keeps the planner\'s "Supplier X"', () => {
  const reserved = body('request-view-reserved');
  assert.deepEqual(reserved.orders.map((o) => o.supplier.name), ['Demo Supplier A', 'Demo Supplier B']);
  assert.deepEqual(reserved.orders.map((o) => o.totals.supplierName), ['Supplier A', 'Supplier B']);
});

// ---- contract fixtures for the new routes ------------------------------------------------------------------------------------------------------------

test('RS-03: the extract fixtures cover success and degraded (both HTTP 200), the image upload fixture 201; a 404 is not a fixture', () => {
  const success = fixtures.get('request-extract');
  const degraded = fixtures.get('request-extract-degraded');
  const upload = fixtures.get('request-image-upload');
  assert.equal(success.route, 'POST /api/requests/:id/extract');
  assert.equal(degraded.route, 'POST /api/requests/:id/extract');
  assert.equal(upload.route, 'POST /api/requests/:id/image');
  assert.deepEqual([success.status, degraded.status, upload.status], [200, 200, 201]);
  assert.equal(success.response.extraction.degraded, false);
  assert.equal(success.response.extraction.schemaOk, true);
  assert.equal(success.response.extraction.errorCode, null);
  assert.equal(degraded.response.extraction.degraded, true);
  assert.equal(degraded.response.extraction.schemaOk, false);
  assert.match(degraded.response.extraction.errorCode, /^PROVIDER_(TIMEOUT|UNAVAILABLE|BAD_OUTPUT|BUSY)$/);
  assert.deepEqual(Object.keys(upload.response.image).sort(), ['bytes', 'id', 'mime', 'sha256']);
  assert.deepEqual(Object.keys(upload.response).sort(), ['image', 'requestId']);
  for (const fx of [success, degraded]) {
    const e = fx.response.extraction;
    assert.deepEqual(Object.keys(e).sort(), ['addressedToAssistant', 'createdAt', 'degraded', 'errorCode', 'fields', 'id', 'model', 'provider', 'questions', 'schemaOk', 'simulated']);
    assert.equal(Object.keys(e.fields).length, 9);
    for (const fv of Object.values(e.fields)) {
      assert.deepEqual(Object.keys(fv).sort(), ['originalWording', 'provenance', 'status', 'value']);
      assert.equal(fv.value === null, fv.provenance === 'none', 'value null iff provenance none');
      assert.equal(fv.status === 'known', fv.value !== null);
    }
  }
  assert.ok(Object.values(degraded.response.extraction.fields).every((f) => f.status === 'unknown'), 'every field unknown when degraded');
  assert.deepEqual(degraded.response.extraction.questions, []);
  const provenances = new Set(Object.values(success.response.extraction.fields).map((f) => f.provenance));
  assert.deepEqual([...provenances].sort(), ['image', 'none', 'user_text']);
  for (const fx of fixtures.values()) assert.notEqual(fx.status, 404, `${fx.route}: a 404 for a route that d3 has not built is not a fixture`);
});
