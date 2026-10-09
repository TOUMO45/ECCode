// DOM helpers. All text goes through textContent / text nodes; never innerHTML.
export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'testid') el.setAttribute('data-testid', v);
    else if (k === 'text') el.textContent = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children.flat()) {
    if (c === undefined || c === null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

/** Append children to an existing element, skipping null/undefined/false like h() does.
 *  Native Element.append would render a null child as the literal text "null". */
export function appendAll(el, ...children) {
  for (const c of children.flat()) {
    if (c === undefined || c === null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

export function clear(el) { el.replaceChildren(); return el; }

const $ = (id) => document.getElementById(id);

/** Polite status message; clears first so repeats are re-announced. */
export function announce(msg) {
  const el = $('live-status');
  el.textContent = '';
  if (msg) setTimeout(() => { el.textContent = msg; }, 30);
}
export function announceError(msg) {
  const el = $('live-alert');
  el.textContent = '';
  if (msg) setTimeout(() => { el.textContent = msg; }, 30);
}
export function clearLive() { $('live-status').textContent = ''; $('live-alert').textContent = ''; }

export function skeleton(rows = 3) {
  return h('div', { 'aria-busy': 'true', 'aria-label': 'Loading', role: 'group' },
    Array.from({ length: rows }, () => h('div', { class: 'skeleton' })));
}

export function focusHeading(root) {
  const hd = root.querySelector('h1');
  if (hd) { hd.setAttribute('tabindex', '-1'); hd.focus(); }
}

export function formatDate(iso) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? String(iso) : d.toLocaleString();
}
