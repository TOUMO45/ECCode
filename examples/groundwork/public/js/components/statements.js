import { h } from '../dom.js';
import { describeError } from '../api.js';

export const SECTION_LABELS = {
  summary: 'Summary', impact: 'Impact', timeline: 'Timeline', contributingFactors: 'Contributing factors', actionItems: 'Action items',
};

export function reasonText(r) {
  const d = r.detail;
  switch (r.code) {
    case 'NO_CITE': return 'No source cited';
    case 'MISSING_LINE': return `Line ${d} does not exist`;
    case 'TIME_NOT_IN_SOURCE': return `Time ${d} not found in cited lines`;
    case 'NUMBER_NOT_IN_SOURCE': return `Number ${d} not found in cited lines`;
    case 'NAME_NOT_IN_SOURCE': return `Name ${d} not found in cited lines`;
    case 'WEAK_SUPPORT': {
      const pct = Math.round(Number(d) * 100);
      return Number.isFinite(pct) ? `Only ${pct}% of key words appear in the cited lines` : 'Too few key words appear in the cited lines';
    }
    default: return d ? `${r.code}: ${d}` : String(r.code);
  }
}

function chip(n, lineSet, ctx) {
  if (!lineSet.has(n)) {
    return h('button', { type: 'button', class: 'chip chip-missing', 'aria-disabled': 'true', 'data-line': n, testid: `chip-${n}`, 'aria-label': `Source line ${n} is missing` }, `[${n}] missing`);
  }
  const b = h('button', { type: 'button', class: 'chip', 'data-line': n, testid: `chip-${n}`, 'aria-label': `Show source line ${n}` }, `[${n}]`);
  b.addEventListener('click', () => ctx.onChip(n, b));
  return b;
}

function editForm(st, ctx) {
  const text = h('textarea', { id: `edit-text-${st.id}`, maxlength: '600', required: true, testid: 'edit-text', 'aria-describedby': `edit-err-${st.id}` });
  text.value = st.text;
  const cites = h('input', { id: `edit-cites-${st.id}`, type: 'text', inputmode: 'numeric', testid: 'edit-cites', 'aria-describedby': `edit-err-${st.id}` });
  cites.value = st.cites.join(', ');
  const err = h('p', { id: `edit-err-${st.id}`, class: 'field-error', role: 'alert' });
  const save = h('button', { type: 'submit', testid: 'edit-save' }, 'Save');
  const cancel = h('button', { type: 'button', class: 'secondary', testid: 'edit-cancel', onclick: () => ctx.cancel(st) }, 'Cancel');
  const form = h('form', { novalidate: true, 'aria-label': 'Edit statement' },
    h('label', { for: text.id }, 'Statement text (max 600 characters)'), text,
    h('label', { for: cites.id }, 'Cited line numbers, comma-separated'), cites,
    err, h('div', { class: 'actions' }, save, cancel));
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    err.textContent = '';
    text.removeAttribute('aria-invalid'); cites.removeAttribute('aria-invalid');
    const t = text.value.trim();
    if (!t) { err.textContent = 'Enter the statement text.'; text.setAttribute('aria-invalid', 'true'); text.focus(); return; }
    const raw = cites.value.split(',').map((x) => x.trim()).filter(Boolean);
    if (!raw.every((x) => /^\d{1,9}$/.test(x) && Number(x) >= 1) || raw.length > 20) {
      err.textContent = 'Cited lines must be up to 20 whole numbers of 1 or more, separated by commas.';
      cites.setAttribute('aria-invalid', 'true'); cites.focus(); return;
    }
    save.disabled = true; form.setAttribute('aria-busy', 'true');
    try { await ctx.save(st, t, [...new Set(raw.map(Number))]); } catch (e) {
      err.textContent = e.code === 'VALIDATION_FAILED' && e.details?.fields?.length
        ? e.details.fields.map((f) => `${f.path}: ${f.message}`).join('; ') : describeError(e);
      save.disabled = false; form.removeAttribute('aria-busy');
    }
  });
  return form;
}

function removeConfirm(st, ctx) {
  const err = h('p', { class: 'field-error', role: 'alert' });
  const yes = h('button', { type: 'button', class: 'danger', testid: 'remove-confirm' }, 'Confirm remove');
  yes.addEventListener('click', async () => {
    yes.disabled = true;
    try { await ctx.remove(st); } catch (e) { err.textContent = describeError(e); yes.disabled = false; }
  });
  return h('div', { class: 'actions', role: 'group', 'aria-label': 'Confirm removal' },
    h('span', { text: 'Remove this statement?' }), yes,
    h('button', { type: 'button', class: 'secondary', onclick: () => ctx.cancel(st) }, 'Keep'), err);
}

export function statementEl(st, ctx) {
  const flagged = st.status === 'flagged';
  const lineSet = ctx.lineSet;
  const li = h('li', { id: `statement-${st.id}`, class: `statement ${flagged ? 'is-flagged' : 'is-verified'}`, testid: `statement-${st.id}`, tabindex: '-1' });
  if (ctx.editing === st.id) { li.append(editForm(st, ctx)); return li; }
  li.append(h('p', { text: st.text }));
  li.append(h('p', { class: `status-line ${flagged ? 'status-flagged' : 'status-verified'}`, testid: `statement-flag-${st.id}` },
    flagged ? '⚠ Not grounded' : '✓ Verified', st.edited ? ' (edited)' : ''));
  if (flagged && st.reasons.length) {
    li.append(h('ul', { class: 'reasons', 'aria-label': 'Reasons' }, st.reasons.map((r) => h('li', { text: reasonText(r) }))));
  }
  if (st.cites.length) li.append(h('div', { class: 'chips', role: 'group', 'aria-label': 'Citations' }, st.cites.map((n) => chip(n, lineSet, ctx))));
  if (ctx.editable) {
    if (ctx.removing === st.id) li.append(removeConfirm(st, ctx));
    else {
      li.append(h('div', { class: 'actions' },
        h('button', { type: 'button', class: 'secondary', testid: `edit-${st.id}`, 'aria-label': `Edit statement ${st.id}`, onclick: () => ctx.startEdit(st) }, 'Edit'),
        h('button', { type: 'button', class: 'secondary', testid: `remove-${st.id}`, 'aria-label': `Remove statement ${st.id}`, onclick: () => ctx.startRemove(st) }, 'Remove')));
    }
  }
  return li;
}

/** Sections with statements, from a Draft. ctx: { lineSet, editable, editing, removing, onChip, startEdit, startRemove, save, remove, cancel }. */
export function sectionsEl(draft, ctx) {
  const frag = document.createDocumentFragment();
  for (const key of Object.keys(SECTION_LABELS)) {
    const items = draft.sections[key] || [];
    frag.append(h('section', { 'aria-labelledby': `sec-${key}` },
      h('h3', { id: `sec-${key}`, text: SECTION_LABELS[key] }),
      items.length === 0 ? h('p', { class: 'empty' }, 'No statements in this section')
        : h('ul', { class: 'list' }, items.map((s) => statementEl(s, ctx)))));
  }
  return frag;
}
