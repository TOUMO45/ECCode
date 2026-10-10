// Section 2 of the request page, "What you need": a table of field, value, provenance badge and original wording,
// the clarification questions (server templates, never model text), and a manual input for every field.
// In the degraded state (automatic reading failed) the form is open and the notice says why.

import { el } from '../dom.js';
import { EXACT, SECTION_TITLES } from '../texts.js';
import {
  FIELD_NAMES, CORE_FIELD_NAMES, FIELD_LABELS, centsToDollarInput, fieldValueText, localToTs, parseUsdToCents, provenanceText,
} from '../format.js';
import { currentPlan } from '../view-helpers.js';
import { noticeNode } from './notice.js';
import { badgeNodes, extractionBadgeModels, pill } from './badges.js';

const UNKNOWN_FIELD = Object.freeze({ value: null, status: 'unknown', provenance: 'none', originalWording: null });
const PRODUCT_TYPES = Object.freeze([['cups_and_lids', 'Cups and lids'], ['cups', 'Cups only'], ['lids', 'Lids only']]);
const MATERIALS = Object.freeze([['', 'Not specified'], ['paper', 'Paper'], ['plastic', 'Plastic'], ['other', 'Other']]);
const INTEGER_FIELDS = Object.freeze(['cupQuantity', 'lidQuantity', 'capacityMl', 'diameterMm', 'maxPickups']);
const LOCAL_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;

function wordingLabel(fieldValue) {
  if (fieldValue.provenance === 'image') return EXACT.PHOTO_WORDING;
  return 'Your words';
}

function inputValue(name, fieldValue) {
  if (fieldValue.status !== 'known' || fieldValue.value === null || fieldValue.value === undefined) return '';
  if (name === 'budgetCents') return Number.isSafeInteger(fieldValue.value) && fieldValue.value >= 0 ? centsToDollarInput(fieldValue.value) : '';
  return String(fieldValue.value);
}

function inputSpec(name, fieldValue) {
  const base = {
    name,
    label: FIELD_LABELS[name],
    required: CORE_FIELD_NAMES.includes(name),
    value: inputValue(name, fieldValue),
    inputId: `need-${name}`,
    testid: `input-${name}`,
  };
  if (name === 'productType') {
    return { ...base, control: 'select', options: [['', 'Choose…'], ...PRODUCT_TYPES].map(([value, label]) => ({ value, label })) };
  }
  if (name === 'material') return { ...base, control: 'select', options: MATERIALS.map(([value, label]) => ({ value, label })) };
  if (name === 'deadline') return { ...base, control: 'datetime-local', hint: 'Amman time, for example 2026-10-20 11:00' };
  if (name === 'budgetCents') return { ...base, control: 'text', hint: 'US dollars, for example 95.00' };
  return { ...base, control: 'number' };
}

// The values a form shows or a confirm call sends, taken from a Fields object.
export function valuesFromFields(fields) {
  const out = {};
  for (const name of FIELD_NAMES) {
    const fv = fields?.[name] ?? UNKNOWN_FIELD;
    out[name] = fv.status === 'known' && fv.value !== undefined ? fv.value : null;
  }
  return out;
}

export function needModel(view) {
  const fields = view.requirements?.fields ?? view.extraction?.fields ?? null;
  const rows = FIELD_NAMES.map((name) => {
    const fv = fields?.[name] ?? UNKNOWN_FIELD;
    const wording = typeof fv.originalWording === 'string' && fv.originalWording.length > 0 ? fv.originalWording : null;
    return {
      name,
      label: FIELD_LABELS[name],
      known: fv.status === 'known' && fv.value !== null,
      valueText: fieldValueText(name, fv),
      provenance: fv.provenance,
      provenanceText: provenanceText(fv),
      wording,
      wordingLabel: wording ? wordingLabel(fv) : null,
      testid: `field-${name}`,
    };
  });
  const questions = (view.extraction?.questions ?? [])
    .filter((q) => (fields?.[q.field]?.status ?? 'unknown') !== 'known')
    .map((q) => ({ field: q.field, label: FIELD_LABELS[q.field] ?? q.field, question: q.question }));
  const degraded = view.extraction?.degraded === true;
  const plan = currentPlan(view);
  const locked = plan !== null && (plan.status === 'executing' || plan.status === 'executed');
  return {
    rows,
    questions,
    degraded,
    degradedText: EXACT.DEGRADED_EXTRACTION,
    extractionBadges: extractionBadgeModels(view.extraction),
    form: {
      locked,
      open: !locked && (view.requirements === null || degraded),
      inputs: FIELD_NAMES.map((name) => inputSpec(name, fields?.[name] ?? UNKNOWN_FIELD)),
    },
  };
}

// Form strings -> { ok, fields, errors }. Client checks are for the user's convenience; the server decides.
export function buildConfirmBody(values) {
  const errors = [];
  const fields = {};
  for (const name of FIELD_NAMES) {
    const raw = String(values?.[name] ?? '').trim();
    if (raw === '') {
      fields[name] = null;
      if (CORE_FIELD_NAMES.includes(name)) errors.push({ field: name, message: 'Required.' });
      continue;
    }
    if (INTEGER_FIELDS.includes(name)) {
      if (/^\d{1,9}$/.test(raw) && Number(raw) >= 1) fields[name] = Number(raw);
      else errors.push({ field: name, message: 'Enter a whole number, 1 or more.' });
    } else if (name === 'productType') {
      if (PRODUCT_TYPES.some(([v]) => v === raw)) fields[name] = raw;
      else errors.push({ field: name, message: 'Choose one of the listed types.' });
    } else if (name === 'material') {
      if (MATERIALS.some(([v]) => v === raw && v !== '')) fields[name] = raw;
      else errors.push({ field: name, message: 'Choose paper, plastic or other.' });
    } else if (name === 'deadline') {
      if (LOCAL_RE.test(raw) && localToTs(raw) !== null) fields[name] = raw;
      else errors.push({ field: name, message: 'Enter a real date and time, like 2026-10-20 11:00.' });
    } else if (name === 'budgetCents') {
      const cents = parseUsdToCents(raw);
      if (cents !== null) fields[name] = cents;
      else errors.push({ field: name, message: 'Enter an amount in dollars, like 95.00.' });
    }
  }
  return { ok: errors.length === 0, fields, errors };
}

function controlNode(spec, error, refs) {
  const describedBy = [spec.hint ? `${spec.inputId}-hint` : null, error ? `${spec.inputId}-error` : null].filter(Boolean).join(' ') || null;
  const common = {
    id: spec.inputId,
    name: spec.name,
    testid: spec.testid,
    required: spec.required,
    'aria-describedby': describedBy,
    'aria-invalid': error ? 'true' : null,
  };
  let node;
  if (spec.control === 'select') {
    node = el('select', common, spec.options.map((o) => el('option', { value: o.value, selected: o.value === spec.value, text: o.label })));
  } else if (spec.control === 'number') {
    node = el('input', { ...common, type: 'number', inputmode: 'numeric', min: '1', step: '1', value: spec.value });
  } else if (spec.control === 'datetime-local') {
    node = el('input', { ...common, type: 'datetime-local', value: spec.value });
  } else {
    node = el('input', { ...common, type: 'text', inputmode: 'decimal', autocomplete: 'off', value: spec.value });
  }
  refs[spec.name] = node;
  return node;
}

// errors: { fieldName: message }. on.confirm(values) is called with the strings currently in the form.
export function renderManualForm(form, errors, on) {
  const refs = {};
  const rows = form.inputs.map((spec) => el('div', { class: 'form-row' }, [
    el('label', { for: spec.inputId, text: `${spec.label}${spec.required ? ' (required)' : ''}` }),
    controlNode(spec, errors[spec.name], refs),
    spec.hint ? el('p', { id: `${spec.inputId}-hint`, class: 'hint', text: spec.hint }) : null,
    errors[spec.name] ? el('p', { id: `${spec.inputId}-error`, class: 'field-error', role: 'alert', text: errors[spec.name] }) : null,
  ]));
  const formNode = el('form', {
    class: 'manual-form',
    novalidate: true,
    testid: 'manual-form',
    'aria-label': 'Enter or correct the details',
    on: {
      submit: (event) => {
        event.preventDefault();
        const values = {};
        for (const name of FIELD_NAMES) values[name] = refs[name].value;
        on.confirm?.(values);
      },
    },
  }, [
    ...rows,
    el('button', { type: 'submit', class: 'button button-primary', testid: 'confirm-requirements', text: 'Confirm these details' }),
  ]);
  return formNode;
}

export function renderNeed(model, on = {}, errors = {}) {
  const table = el('table', { class: 'data-table', testid: 'fields-table' }, [
    el('caption', { class: 'visually-hidden', text: SECTION_TITLES.need }),
    el('thead', {}, [el('tr', {}, ['Field', 'Value', 'Source', 'Original wording'].map((t) => el('th', { scope: 'col', text: t })))]),
    el('tbody', {}, model.rows.map((r) => el('tr', { testid: r.testid }, [
      el('th', { scope: 'row', text: r.label }),
      el('td', { testid: `${r.testid}-value`, text: r.valueText }),
      el('td', {}, [pill(r.provenanceText, r.known ? 'info' : 'neutral', `${r.testid}-provenance`)]),
      el('td', {}, r.wording
        ? [el('span', { class: 'wording-label', text: `${r.wordingLabel}: ` }), el('span', { dir: 'auto', testid: `${r.testid}-wording`, text: r.wording })]
        : [el('span', { class: 'muted', text: '—' })]),
    ]))),
  ]);
  const formNode = on.confirm ? renderManualForm(model.form, errors, on) : null;
  return [
    model.degraded ? noticeNode({ text: model.degradedText, tone: 'warn', testid: 'degraded-notice', role: 'status' }) : null,
    model.extractionBadges.length > 0 ? el('p', {}, badgeNodes(model.extractionBadges)) : null,
    table,
    model.questions.length > 0
      ? el('div', { class: 'questions', testid: 'questions' }, [
        el('h3', { text: 'Questions to answer' }),
        el('ul', {}, model.questions.map((q) => el('li', { testid: `question-${q.field}`, text: `${q.label}: ${q.question}` }))),
      ])
      : null,
    formNode && !model.form.locked
      ? (model.form.open
        ? el('div', {}, [el('h3', { text: 'Enter or correct the details' }), formNode])
        : el('details', { testid: 'manual-details', open: Object.keys(errors).length > 0 }, [el('summary', { text: 'Change the details' }), formNode]))
      : null,
  ];
}
