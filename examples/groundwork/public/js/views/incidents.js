import { api, describeError } from '../api.js';
import { h, clear, appendAll, announce, skeleton, focusHeading, formatDate } from '../dom.js';

const SEVS = ['SEV1', 'SEV2', 'SEV3', 'SEV4'];

function localNow() {
  const d = new Date();
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 16);
}

export function incidentsView(root, app) {
  let alive = true;
  const canCreate = app.state.user.role === 'responder' || app.state.user.role === 'lead';
  const listBox = h('div', { id: 'incident-list', 'aria-live': 'polite' });
  const title = h('input', { id: 'inc-title', type: 'text', maxlength: '140', required: true, testid: 'incident-title', 'aria-describedby': 'err-title' });
  const sev = h('select', { id: 'inc-sev', testid: 'incident-severity' }, SEVS.map((s) => h('option', { value: s }, s)));
  sev.value = 'SEV3';
  const started = h('input', { id: 'inc-started', type: 'datetime-local', required: true, testid: 'incident-started', 'aria-describedby': 'err-started' });
  started.value = localNow();
  const desc = h('textarea', { id: 'inc-desc', maxlength: '4000', testid: 'incident-description', 'aria-describedby': 'err-description' });
  const errs = {
    title: h('p', { id: 'err-title', class: 'field-error' }),
    startedAt: h('p', { id: 'err-started', class: 'field-error' }),
    description: h('p', { id: 'err-description', class: 'field-error' }),
  };
  const formErr = h('p', { class: 'error-text', role: 'alert' });
  const btn = h('button', { type: 'submit', testid: 'incident-create' }, 'Create incident');
  const inputs = { title, startedAt: started, description: desc };

  const form = h('form', { class: 'card', novalidate: true, 'aria-labelledby': 'create-h' },
    h('h2', { id: 'create-h', text: 'New incident' }),
    h('label', { for: 'inc-title' }, 'Title'), title, errs.title,
    h('label', { for: 'inc-sev' }, 'Severity'), sev,
    h('label', { for: 'inc-started' }, 'Started at (your local time)'), started, errs.startedAt,
    h('label', { for: 'inc-desc' }, 'Description (optional)'), desc, errs.description,
    formErr, h('div', { class: 'row' }, btn));

  function setFieldError(name, msg) {
    errs[name].textContent = msg || '';
    if (msg) inputs[name].setAttribute('aria-invalid', 'true'); else inputs[name].removeAttribute('aria-invalid');
  }

  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    formErr.textContent = '';
    Object.keys(inputs).forEach((k) => setFieldError(k, ''));
    const t = title.value.trim();
    const when = new Date(started.value);
    let bad = null;
    if (!t) { setFieldError('title', 'Enter a title.'); bad = title; }
    if (!started.value || Number.isNaN(when.getTime())) { setFieldError('startedAt', 'Enter when the incident started.'); bad ??= started; }
    if (bad) { bad.focus(); return; }
    btn.disabled = true; form.setAttribute('aria-busy', 'true');
    try {
      const { incident } = await api.createIncident({ title: t, severity: sev.value, startedAt: when.toISOString(), description: desc.value });
      title.value = ''; desc.value = '';
      announce('Incident created');
      await load(incident.id);
    } catch (e) {
      const fields = e.details?.fields;
      if (e.code === 'VALIDATION_FAILED' && Array.isArray(fields)) {
        let first = null;
        for (const f of fields) {
          if (inputs[f.path]) { setFieldError(f.path, f.message); first ??= inputs[f.path]; }
        }
        if (first) first.focus(); else formErr.textContent = describeError(e);
      } else formErr.textContent = describeError(e);
    } finally { btn.disabled = false; form.removeAttribute('aria-busy'); }
  });

  function item(inc) {
    const d = inc.draft;
    return h('li', { id: `incident-${inc.id}`, tabindex: '-1', testid: `incident-${inc.id}` },
      h('a', { href: `#/incidents/${inc.id}`, text: inc.title }), ' ',
      h('span', { class: 'badge', text: inc.severity }), ' ',
      h('span', { class: 'hint', text: `Started ${formatDate(inc.startedAt)} | ${inc.noteCount} notes | ${d ? `draft ${d.state}${d.flaggedCount ? `, ${d.flaggedCount} not grounded` : ''}` : 'no draft'}` }));
  }

  async function load(focusId) {
    clear(listBox).append(skeleton(3));
    listBox.setAttribute('aria-busy', 'true');
    try {
      const { incidents } = await api.incidents();
      if (!alive) return;
      listBox.removeAttribute('aria-busy');
      clear(listBox);
      if (incidents.length === 0) {
        listBox.append(h('p', { class: 'empty', testid: 'incidents-empty' }, 'No incidents yet. Create the first one.'));
        if (canCreate) title.focus();
      } else {
        listBox.append(h('ul', { class: 'list' }, incidents.map(item)));
        if (focusId) document.getElementById(`incident-${focusId}`)?.focus();
      }
    } catch (e) {
      if (!alive) return;
      listBox.removeAttribute('aria-busy');
      clear(listBox).append(h('div', { class: 'panel-error', role: 'alert', testid: 'incidents-error' },
        h('p', { text: `Could not load incidents. ${describeError(e)}` }),
        h('button', { type: 'button', onclick: () => load() }, 'Retry')));
    }
  }

  appendAll(root, h('h1', { text: 'Incidents' }), canCreate ? form : null, h('h2', { text: 'Your team\'s incidents' }), listBox);
  focusHeading(root);
  load();
  return () => { alive = false; };
}
