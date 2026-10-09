import { api, describeError } from '../api.js';
import { h, clear, announce, announceError, skeleton, focusHeading, formatDate } from '../dom.js';
import { sourcePanel } from '../components/source.js';
import { sectionsEl, reasonText, SECTION_LABELS } from '../components/statements.js';

const LIMITATION = 'Verification checks that cited lines exist and contain the times, numbers and names used and most of the key words; it does not prove the statement means what the notes mean. Read the cited lines.';

export function incidentView(root, app, id) {
  let alive = true;
  const role = app.state.user.role;
  const isLead = role === 'lead';
  const s = { inc: null, lines: [], draft: null, providers: [], defaultProvider: null, ui: { editing: null, removing: null }, stale: false, panel: null };

  const head = h('div');
  const notesBox = h('section', { 'aria-labelledby': 'notes-h' });
  const genBox = h('section', { 'aria-labelledby': 'gen-h' });
  const reviewBox = h('section', { 'aria-labelledby': 'review-h' });
  const body = h('div', {}, notesBox, genBox, reviewBox);
  root.append(head, body);

  // ---------- load ----------
  async function load() {
    clear(head).append(h('h1', { text: 'Incident' }), skeleton(3));
    clear(notesBox); clear(genBox); clear(reviewBox);
    try {
      const [{ incident }, nres, dres, pres] = await Promise.all([
        api.incident(id),
        api.notes(id),
        api.draft(id).catch((e) => { if (e.code === 'NOT_FOUND') return { draft: null }; throw e; }),
        api.providers().catch(() => ({ providers: [], default: null })),
      ]);
      if (!alive) return;
      Object.assign(s, { inc: incident, lines: nres.lines, draft: dres.draft, providers: pres.providers, defaultProvider: pres.default, stale: false });
      s.ui = { editing: null, removing: null };
      s.panel = sourcePanel(s.lines);
      renderAll();
      focusHeading(head);
    } catch (e) {
      if (!alive) return;
      clear(head);
      if (e.code === 'NOT_FOUND') {
        head.append(h('h1', { text: 'Not found' }), h('p', {}, 'This incident does not exist or belongs to another team. ', h('a', { href: '#/incidents' }, 'Back to incidents')));
      } else {
        head.append(h('h1', { text: 'Incident' }), h('div', { class: 'panel-error', role: 'alert', testid: 'incident-error' },
          h('p', { text: `Could not load the incident. ${describeError(e)}` }), h('button', { type: 'button', onclick: load }, 'Retry')));
      }
      focusHeading(head);
    }
  }

  function renderAll() { renderHead(); renderNotes(); renderGenerate(); renderReview(); }

  function renderHead() {
    const i = s.inc;
    clear(head).append(
      h('p', {}, h('a', { href: '#/incidents' }, 'Back to incidents')),
      h('h1', { text: i.title }),
      h('p', {}, h('span', { class: 'badge', text: i.severity }), ` Started ${formatDate(i.startedAt)} by ${i.createdBy.displayName}`),
      i.description ? h('p', { text: i.description }) : null);
  }

  // ---------- notes ----------
  function renderNotes() {
    clear(notesBox).append(h('h2', { id: 'notes-h', text: 'Notes' }));
    if (s.draft) {
      notesBox.append(h('p', { class: 'hint', testid: 'notes-locked' }, `Notes are locked because a draft exists (${s.lines.length} lines).`));
      return;
    }
    if (s.lines.length === 0) {
      notesBox.append(h('p', { class: 'empty', testid: 'notes-empty' }, 'No notes yet. Paste lines like ', h('code', { text: '14:05 alice: deployed v2' }), '.'));
    } else {
      notesBox.append(h('p', { class: 'hint', text: `${s.lines.length} lines imported. Importing again replaces them.` }),
        h('div', { class: 'source card', tabindex: '0', role: 'region', 'aria-label': 'Imported notes' },
          h('ol', { testid: 'notes-list' }, s.lines.map((l) => h('li', { text: `[${l.n}] ${l.time} ${l.author}: ${l.text}` })))));
    }
    const ta = h('textarea', { id: 'notes-input', testid: 'notes-input', 'aria-describedby': 'notes-help notes-err', spellcheck: 'false' });
    const errBox = h('div', { id: 'notes-err', testid: 'notes-error' });
    const btn = h('button', { type: 'submit', testid: 'notes-import' }, 'Import notes');
    const form = h('form', { class: 'card', novalidate: true },
      h('label', { for: 'notes-input' }, 'Paste notes (one per line)'), ta,
      h('p', { id: 'notes-help', class: 'hint' }, 'Formats: HH:MM author: text, HH:MM:SS author: text, or an ISO timestamp then author: text. Up to 2,000 lines.'),
      errBox, h('div', { class: 'row' }, btn));
    form.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      clear(errBox); ta.removeAttribute('aria-invalid');
      if (!ta.value.trim()) {
        ta.setAttribute('aria-invalid', 'true');
        errBox.append(h('p', { class: 'field-error', role: 'alert', text: 'Paste at least one note line.' })); ta.focus(); return;
      }
      btn.disabled = true; form.setAttribute('aria-busy', 'true');
      try {
        const res = await api.putNotes(id, ta.value);
        s.lines = res.lines; s.panel = sourcePanel(s.lines); s.inc.noteCount = res.count;
        renderNotes(); renderGenerate();
        announce(`Imported ${res.count} lines`);
      } catch (e) {
        btn.disabled = false; form.removeAttribute('aria-busy');
        ta.setAttribute('aria-invalid', 'true');
        if (e.code === 'NOTES_INVALID' && Array.isArray(e.details?.lines)) {
          const more = (e.details.total ?? e.details.lines.length) - e.details.lines.length;
          errBox.append(h('div', { class: 'panel-error', role: 'alert' },
            h('p', { text: 'Some lines could not be parsed. Nothing was imported; fix these lines and try again.' }),
            h('ul', {}, e.details.lines.map((l) => h('li', { text: `Line ${l.line}: ${l.message}` }))),
            more > 0 ? h('p', { text: `...and ${more} more.` }) : null));
        } else if (e.code === 'NOTES_LOCKED') {
          errBox.append(h('p', { class: 'field-error', role: 'alert', text: 'Notes are locked because a draft exists. Reload the page.' }));
        } else errBox.append(h('p', { class: 'field-error', role: 'alert', text: describeError(e) }));
        ta.focus();
      }
    });
    notesBox.append(form);
  }

  // ---------- generate ----------
  function renderGenerate() {
    clear(genBox);
    if (s.draft?.state === 'published') return;
    genBox.append(h('h2', { id: 'gen-h', text: s.draft ? 'Regenerate draft' : 'Generate draft' }));
    const sel = h('select', { id: 'provider-select', testid: 'provider-select', 'aria-describedby': 'provider-hint' });
    const list = s.providers.length ? s.providers : [{ id: 'auto', label: 'Automatic', available: true, sendsNotesOffHost: false }];
    sel.append(h('option', { value: 'auto' }, 'Automatic'));
    for (const p of list) {
      if (p.id === 'auto') continue;
      sel.append(h('option', { value: p.id, disabled: !p.available },
        `${p.label}${p.sendsNotesOffHost ? ' (sends notes off host)' : ''}${p.available ? '' : ' (unavailable)'}`));
    }
    if (s.defaultProvider && [...sel.options].some((o) => o.value === s.defaultProvider && !o.disabled)) sel.value = s.defaultProvider;
    const status = h('p', { class: 'hint', testid: 'generate-status' });
    const out = h('div');
    const btn = h('button', { type: 'button', testid: 'generate', disabled: s.lines.length === 0 }, s.draft ? 'Regenerate' : 'Generate');
    const run = async (choice) => {
      clear(out); btn.disabled = true; sel.disabled = true;
      genBox.setAttribute('aria-busy', 'true');
      const msg = `Generating with ${choice}... this can take up to 2 minutes`;
      status.textContent = msg; announce(msg);
      try {
        const res = await api.generate(id, choice);
        s.draft = res.draft; s.ui = { editing: null, removing: null }; s.stale = false;
        s.inc.draft = null;
        renderNotes(); renderGenerate(); renderReview();
        announce(`Draft generated: ${countAll(s.draft)} statements, ${s.draft.flaggedCount} flagged`);
        document.getElementById('review-h')?.focus();
      } catch (e) {
        status.textContent = '';
        btn.disabled = false; sel.disabled = false;
        out.append(h('div', { class: 'panel-error', role: 'alert', testid: 'generate-error' },
          h('p', { text: describeError(e) }),
          e.details?.fallbackAvailable ? h('button', { type: 'button', testid: 'generate-fallback', onclick: () => run('fallback') }, 'Generate fallback draft') : null));
      } finally { genBox.removeAttribute('aria-busy'); }
    };
    btn.addEventListener('click', () => run(sel.value));
    genBox.append(h('div', { class: 'card' },
      h('label', { for: 'provider-select' }, 'Provider'), sel,
      h('p', { id: 'provider-hint', class: 'hint' }, s.draft ? 'Regenerating replaces all statements, including your edits.' : (s.lines.length ? 'Providers marked "sends notes off host" transmit the notes outside this machine.' : 'Import notes first.')),
      h('div', { class: 'row' }, btn), status, out));
  }

  const countAll = (d) => Object.values(d.sections).reduce((n, a) => n + a.length, 0);

  // ---------- review ----------
  function reload() {
    return api.draft(id).then((r) => { s.draft = r.draft; s.stale = false; s.ui = { editing: null, removing: null }; renderReview(); announce('Draft reloaded'); })
      .catch((e) => announceError(describeError(e)));
  }

  function applyDraft(d, focusSel) {
    s.draft = d; s.ui = { editing: null, removing: null }; s.stale = false;
    renderReview();
    if (focusSel) (document.querySelector(focusSel) || document.getElementById('review-h'))?.focus();
  }

  function guard(e) {
    if (e.code === 'STALE_VERSION') { s.stale = true; renderStale(); }
    throw e;
  }

  const staleBox = h('div');
  function renderStale() {
    clear(staleBox);
    if (!s.stale) return;
    staleBox.append(h('div', { class: 'banner banner-error', role: 'alert', testid: 'stale-banner' },
      'This draft changed. Reload to see the latest version before editing. ',
      h('button', { type: 'button', onclick: reload }, 'Reload')));
  }

  function renderReview() {
    clear(reviewBox);
    const d = s.draft;
    if (!d) {
      reviewBox.append(h('h2', { id: 'review-h', tabindex: '-1', text: 'Draft review' }), h('p', { class: 'empty', testid: 'draft-empty' }, 'No draft yet. Import notes, then generate a draft.'));
      return;
    }
    const published = d.state === 'published';
    const editable = !published;
    const lineSet = new Set(s.lines.map((l) => l.n));
    const sections = h('div', { testid: 'draft-sections' });
    const flagCount = h('p', { 'aria-live': 'polite', testid: 'flag-count', id: 'flag-count' });
    const note = h('p', { id: 'publish-note', class: 'hint', testid: 'publish-note', text: LIMITATION });
    const pubOut = h('div');

    const ctx = {
      lineSet, editable,
      get editing() { return s.ui.editing; },
      get removing() { return s.ui.removing; },
      onChip: (n, btn) => s.panel.highlight(n, btn),
      startEdit: (st) => { s.ui = { editing: st.id, removing: null }; drawSections(); document.getElementById(`edit-text-${st.id}`)?.focus(); },
      startRemove: (st) => { s.ui = { editing: null, removing: st.id }; drawSections(); document.querySelector('[data-testid="remove-confirm"]')?.focus(); },
      cancel: (st) => { s.ui = { editing: null, removing: null }; drawSections(); document.querySelector(`[data-testid="edit-${st.id}"]`)?.focus(); },
      save: async (st, text, cites) => {
        try {
          const r = await api.editStatement(d.id, st.id, { expectedVersion: s.draft.version, text, cites });
          applyDraft(r.draft, `[data-testid="edit-${st.id}"]`);
          announce(`Statement updated. ${r.draft.flaggedCount} not grounded.`);
        } catch (e) { guard(e); }
      },
      remove: async (st) => {
        try {
          const r = await api.removeStatement(d.id, st.id, s.draft.version);
          applyDraft(r.draft, '#review-h');
          announce('Statement removed');
        } catch (e) { guard(e); }
      },
    };
    function drawSections() { clear(sections).append(sectionsEl(s.draft, ctx)); }
    drawSections();

    const flagged = d.flaggedCount;
    flagCount.textContent = flagged > 0 ? `${flagged} statement${flagged === 1 ? '' : 's'} not grounded` : 'All statements grounded';

    const bar = h('div', { class: 'action-bar' }, flagCount);
    if (published) {
      bar.append(h('p', { class: 'status-verified status-line', testid: 'published-state' }, `✓ Published ${d.publishedAt ? formatDate(d.publishedAt) : ''}`),
        h('a', { href: `#/postmortems/${d.id}`, testid: 'postmortem-link' }, 'Open the postmortem'));
    } else if (isLead) {
      const pub = h('button', { type: 'button', testid: 'publish', 'aria-describedby': 'publish-note flag-count', disabled: flagged > 0 }, 'Publish');
      pub.addEventListener('click', async () => {
        clear(pubOut); pub.disabled = true; bar.setAttribute('aria-busy', 'true');
        try {
          const r = await api.publish(d.id, s.draft.version);
          s.draft = r.draft; s.ui = { editing: null, removing: null };
          renderGenerate(); renderReview();
          announce('Published');
          document.getElementById('review-h')?.focus();
        } catch (e) {
          pub.disabled = flagged > 0; bar.removeAttribute('aria-busy');
          if (e.code === 'STALE_VERSION') { s.stale = true; renderStale(); announceError(e.message); }
          else if (e.code === 'UNGROUNDED_STATEMENTS') {
            pubOut.append(h('div', { class: 'panel-error', role: 'alert', testid: 'publish-error' },
              h('p', { text: 'Publishing refused: these statements are not grounded. Edit or remove them, then publish again.' }),
              h('ul', {}, (e.details?.statements || []).map((x) => h('li', { text: `${SECTION_LABELS[x.section] || x.section}, statement ${x.id}: ${(x.reasons || []).map(reasonText).join('; ')}` })))));
          } else pubOut.append(h('div', { class: 'panel-error', role: 'alert' }, describeError(e)));
        }
      });
      bar.append(pub);
    } else {
      bar.append(h('p', { class: 'hint', text: 'Only a team lead can publish.' }));
    }

    reviewBox.append(
      h('h2', { id: 'review-h', tabindex: '-1', text: published ? 'Published postmortem' : 'Draft review' }),
      d.isFallback ? h('p', { class: 'banner', testid: 'fallback-banner', role: 'note' }, 'Fallback draft: no AI was used') : null,
      staleBox,
      h('p', { class: 'hint', text: `Version ${d.version}, provider ${d.provider}${d.model ? ` (${d.model})` : ''}. ${published ? 'Read-only.' : ''}` }),
      h('div', { class: 'grid-2' }, sections, s.panel.el),
      note, pubOut, bar);
    renderStale();
  }

  load();
  return () => { alive = false; };
}
