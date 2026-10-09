import { api, describeError } from '../api.js';
import { h, clear, skeleton, focusHeading, formatDate } from '../dom.js';
import { sourcePanel } from '../components/source.js';
import { sectionsEl } from '../components/statements.js';

export function postmortemsView(root) {
  let alive = true;
  const box = h('div', { 'aria-live': 'polite' });
  async function load() {
    clear(box).append(skeleton(3));
    box.setAttribute('aria-busy', 'true');
    try {
      const { postmortems } = await api.postmortems();
      if (!alive) return;
      box.removeAttribute('aria-busy'); clear(box);
      if (postmortems.length === 0) {
        box.append(h('p', { class: 'empty', testid: 'postmortems-empty' }, 'No published postmortems for your team yet.'));
        return;
      }
      box.append(h('ul', { class: 'list', testid: 'postmortem-list' }, postmortems.map((p) => h('li', { testid: `postmortem-${p.draftId}` },
        h('a', { href: `#/postmortems/${p.draftId}`, text: p.title }), ' ',
        h('span', { class: 'badge', text: p.severity }), ' ',
        h('span', { class: 'hint', text: `Published ${formatDate(p.publishedAt)} by ${p.publishedBy.displayName}${p.isFallback ? ' | fallback draft, no AI used' : ''}` })))));
    } catch (e) {
      if (!alive) return;
      box.removeAttribute('aria-busy');
      clear(box).append(h('div', { class: 'panel-error', role: 'alert', testid: 'postmortems-error' },
        h('p', { text: `Could not load postmortems. ${describeError(e)}` }), h('button', { type: 'button', onclick: load }, 'Retry')));
    }
  }
  root.append(h('h1', { text: 'Postmortems' }), box);
  focusHeading(root);
  load();
  return () => { alive = false; };
}

export function postmortemView(root, app, draftId) {
  let alive = true;
  const box = h('div', { 'aria-live': 'polite' });
  async function load() {
    clear(box).append(skeleton(4));
    box.setAttribute('aria-busy', 'true');
    try {
      const { postmortem: pm } = await api.postmortem(draftId);
      if (!alive) return;
      box.removeAttribute('aria-busy'); clear(root);
      const panel = sourcePanel(pm.lines);
      const ctx = { lineSet: new Set(pm.lines.map((l) => l.n)), editable: false, editing: null, removing: null, onChip: (n, b) => panel.highlight(n, b) };
      const d = pm.draft;
      root.append(
        h('p', {}, h('a', { href: '#/postmortems' }, 'Back to postmortems')),
        h('h1', { text: pm.incident.title }),
        h('p', {}, h('span', { class: 'badge', text: pm.incident.severity }), ` Started ${formatDate(pm.incident.startedAt)}. Published ${formatDate(d.publishedAt)}.`),
        pm.incident.description ? h('p', { text: pm.incident.description }) : null,
        d.isFallback ? h('p', { class: 'banner', testid: 'fallback-banner', role: 'note' }, 'Fallback draft: no AI was used') : null,
        h('div', { class: 'grid-2' }, h('div', { testid: 'draft-sections' }, sectionsEl(d, ctx)), panel.el));
      focusHeading(root);
    } catch (e) {
      if (!alive) return;
      box.removeAttribute('aria-busy');
      if (e.code === 'NOT_FOUND') {
        clear(root).append(h('h1', { text: 'Not found' }), h('p', {}, 'This postmortem does not exist or is not published. ', h('a', { href: '#/postmortems' }, 'Back to postmortems')));
        focusHeading(root);
      } else {
        clear(box).append(h('div', { class: 'panel-error', role: 'alert' }, h('p', { text: `Could not load the postmortem. ${describeError(e)}` }),
          h('button', { type: 'button', onclick: load }, 'Retry')));
      }
    }
  }
  root.append(h('h1', { text: 'Postmortem' }), box);
  load();
  return () => { alive = false; };
}
