// Labelled form controls. Every control has a <label for>, hints and errors are tied to the control with
// aria-describedby, and an invalid control carries aria-invalid. Returns the row and the control so the caller can
// read `.value` on submit.

import { el } from '../dom.js';

function describedBy(id, hint, error) {
  return [hint ? `${id}-hint` : null, error ? `${id}-error` : null].filter(Boolean).join(' ') || null;
}

function extras(id, hint, error) {
  return [
    hint ? el('p', { id: `${id}-hint`, class: 'hint', text: hint }) : null,
    error ? el('p', { id: `${id}-error`, class: 'field-error', role: 'alert', text: error }) : null,
  ];
}

// type: text | password | number | datetime-local | textarea
export function inputField({
  id, name = id, label, type = 'text', value = '', required = true, hint = null, error = null,
  autocomplete = null, inputmode = null, minlength = null, maxlength = null, rows = null, dir = null, min = null, step = null,
}) {
  const props = {
    id,
    name,
    required,
    autocomplete,
    inputmode,
    minlength,
    maxlength,
    dir,
    min,
    step,
    testid: `input-${name}`,
    'aria-describedby': describedBy(id, hint, error),
    'aria-invalid': error ? 'true' : null,
  };
  const input = type === 'textarea'
    ? el('textarea', { ...props, rows: rows ?? 6, text: value })
    : el('input', { ...props, type, value });
  const row = el('div', { class: 'form-row' }, [
    el('label', { for: id, text: label }),
    input,
    ...extras(id, hint, error),
  ]);
  return { row, input };
}

export function selectField({ id, name = id, label, options, value = '', required = false, hint = null, error = null }) {
  const input = el('select', {
    id,
    name,
    required,
    testid: `input-${name}`,
    'aria-describedby': describedBy(id, hint, error),
    'aria-invalid': error ? 'true' : null,
  }, options.map((o) => el('option', { value: o.value, selected: o.value === value, text: o.label })));
  const row = el('div', { class: 'form-row' }, [el('label', { for: id, text: label }), input, ...extras(id, hint, error)]);
  return { row, input };
}

export function checkboxField({ id, name = id, label, checked = false, hint = null }) {
  const input = el('input', { id, name, type: 'checkbox', checked, testid: `input-${name}`, 'aria-describedby': describedBy(id, hint, null) });
  const row = el('div', { class: 'form-row form-row-check' }, [input, el('label', { for: id, text: label }), ...extras(id, hint, null)]);
  return { row, input };
}

export function submitButton(label, { testid = 'submit', busy = false } = {}) {
  return el('button', { type: 'submit', class: 'button button-primary', testid, 'aria-disabled': busy ? 'true' : null, text: label });
}
