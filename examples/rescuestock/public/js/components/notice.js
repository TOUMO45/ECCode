// The states every data section renders: loading, empty, error (message + request id + Retry), timeout and
// expired reservation. Plus the section wrapper. All text goes in through textContent.

import { el, replaceContent } from '../dom.js';
import { EXACT } from '../texts.js';
import { describeError } from '../errors.js';

export function loadingNode(label = EXACT.LOADING) {
  return el('div', { class: 'state state-loading', role: 'status', 'aria-busy': 'true', testid: 'state-loading', text: label });
}

// action: { href, label } | null
export function emptyNode({ title, body = null, action = null, testid = 'state-empty' }) {
  return el('div', { class: 'state state-empty', testid }, [
    el('p', { class: 'state-title', text: title }),
    body ? el('p', { text: body }) : null,
    action ? el('a', { class: 'button', href: action.href, text: action.label }) : null,
  ]);
}

// err is an ApiError (or anything with code/message/requestId). onRetry runs when the Retry button is used.
export function errorNode(err, { onRetry = null, headingId = null } = {}) {
  const d = describeError(err);
  const timeout = d.code === 'CLIENT_TIMEOUT';
  return el('div', { class: `state ${timeout ? 'state-timeout' : 'state-error'}`, role: 'alert', testid: timeout ? 'state-timeout' : 'state-error', id: headingId }, [
    el('p', { class: 'state-title', text: d.message }),
    el('p', { text: d.action }),
    d.linkHash ? el('p', {}, [el('a', { href: d.linkHash, text: 'Open your requests' })]) : null,
    d.requestId ? el('p', { class: 'muted', text: `Request id: ${d.requestId}` }) : null,
    onRetry ? el('button', { type: 'button', class: 'button', testid: 'retry', on: { click: onRetry }, text: 'Retry' }) : null,
  ]);
}

// A message in the page flow. tone: info | warn | ok. role "alert" interrupts, "status" is announced politely.
export function noticeNode({ text, tone = 'info', testid = null, role = 'status', children = [] }) {
  return el('div', { class: `notice notice-${tone}`, role, testid }, [el('p', { text }), ...children]);
}

export function expiredReservationNode(onReplan) {
  return el('div', { class: 'notice notice-warn', role: 'status', testid: 'reservation-expired' }, [
    el('p', { text: EXACT.RESERVATION_EXPIRED }),
    onReplan ? el('button', { type: 'button', class: 'button', testid: 'replan', on: { click: onReplan }, text: 'Re-plan' }) : null,
  ]);
}

// <section aria-labelledby=...><h2 id=...>title</h2>children</section>
export function sectionEl(id, title, children, { testid = null } = {}) {
  const headingId = `section-${id}-title`;
  return el('section', { class: `panel panel-${id}`, id: `section-${id}`, 'aria-labelledby': headingId, testid: testid ?? `section-${id}` }, [
    el('h2', { id: headingId, text: title }),
    ...children,
  ]);
}

// Replaces the content of `container` with a loading, error or ready state. `renderReady` returns the nodes.
export function showState(container, state) {
  if (state.kind === 'loading') {
    container.setAttribute('aria-busy', 'true');
    replaceContent(container, [loadingNode()]);
    return;
  }
  container.removeAttribute('aria-busy');
  if (state.kind === 'error') replaceContent(container, [errorNode(state.error, { onRetry: state.onRetry })]);
  else replaceContent(container, state.nodes);
}
