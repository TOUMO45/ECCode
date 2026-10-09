import { h } from '../dom.js';
import { announce } from '../dom.js';

/** Source notes panel with line highlighting. Returns { el, highlight(n, opener) }. */
export function sourcePanel(lines) {
  let lastChip = null;
  let current = null;
  const body = h('div', { id: 'src-body', class: 'source source-body', testid: 'source-panel', tabindex: '-1' });
  const toggle = h('button', {
    type: 'button', class: 'secondary source-toggle', 'aria-expanded': 'false', 'aria-controls': 'src-body', testid: 'source-toggle',
  }, 'Show source notes');
  toggle.addEventListener('click', () => setOpen(!body.classList.contains('is-open')));

  function setOpen(open) {
    body.classList.toggle('is-open', open);
    toggle.setAttribute('aria-expanded', String(open));
    toggle.textContent = open ? 'Hide source notes' : 'Show source notes';
  }

  if (lines.length === 0) body.append(h('p', { class: 'empty' }, 'No source notes.'));
  else {
    body.append(h('ol', { 'aria-label': 'Source note lines' }, lines.map((l) => h('li', { id: `line-${l.n}`, tabindex: '-1', testid: `source-line-${l.n}` },
      h('span', { class: 'marker', text: 'Cited: ' }),
      h('span', { text: `[${l.n}] ${l.time} ${l.author}: ${l.text}` })))));
  }

  body.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Escape' || !lastChip) return;
    const target = lastChip.isConnected ? lastChip : document.querySelector(`[data-line="${lastChip.dataset.line}"]`);
    if (target) { ev.preventDefault(); target.focus(); }
  });

  function highlight(n, opener) {
    const li = document.getElementById(`line-${n}`);
    if (!li) { announce(`Source line ${n} does not exist`); return; }
    lastChip = opener || lastChip;
    if (!body.classList.contains('is-open') && getComputedStyle(body).display === 'none') setOpen(true);
    if (current) current.classList.remove('is-highlighted');
    li.classList.add('is-highlighted');
    current = li;
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    li.scrollIntoView({ block: 'center', behavior: reduce ? 'auto' : 'smooth' });
    li.focus({ preventScroll: true });
    announce(`Source line ${n} highlighted`);
  }

  const el = h('aside', { class: 'card source-pane', 'aria-labelledby': 'src-h' }, h('h2', { id: 'src-h', text: 'Source notes' }), toggle, body);
  return { el, highlight };
}
