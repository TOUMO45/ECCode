// #/requests — the customer's requests, newest first, each with a text status pill and the next step.

import { el, replaceContent } from '../dom.js';
import { EXACT } from '../texts.js';
import { formatLocalDateTime, formatUsd, rescueStatusText } from '../format.js';
import { requestHash } from '../router.js';
import { pill, toneForStatus } from '../components/badges.js';
import { emptyNode, showState } from '../components/notice.js';

export function buildRequestsListViewModel(answer) {
  const rows = (answer.requests ?? []).map((r) => ({
    id: r.id,
    href: requestHash(r.id),
    label: `Request #${r.id}`,
    createdText: formatLocalDateTime(r.createdAt),
    status: r.rescueStatus.status,
    statusText: rescueStatusText(r.rescueStatus.status),
    tone: toneForStatus(r.rescueStatus.status),
    nextStepText: r.rescueStatus.nextStep.text,
    totalText: r.totalCents === null || r.totalCents === undefined ? null : formatUsd(r.totalCents),
    testid: `request-row-${r.id}`,
  }));
  return {
    state: rows.length === 0 ? 'empty' : 'ready',
    rows,
    empty: { title: EXACT.NO_REQUESTS, action: { href: '#/requests/new', label: EXACT.START_REQUEST } },
    // Seeded prices are shown when any row has a total (RS-34).
    showPriceNotice: rows.some((r) => r.totalText !== null),
    priceNotice: EXACT.PRICE_NOTICE,
  };
}

export function renderRequestsList(model) {
  if (model.state === 'empty') return [emptyNode({ ...model.empty, testid: 'requests-empty' })];
  return [
    el('p', {}, [el('a', { class: 'button', href: '#/requests/new', text: EXACT.START_REQUEST })]),
    el('table', { class: 'data-table', testid: 'requests-table' }, [
      el('caption', { class: 'visually-hidden', text: 'Your rescue requests, newest first' }),
      el('thead', {}, [el('tr', {}, ['Request', 'Created (Amman)', 'Status', 'Next step', 'Total'].map((t) => el('th', { scope: 'col', text: t })))]),
      el('tbody', {}, model.rows.map((r) => el('tr', { testid: r.testid }, [
        el('th', { scope: 'row' }, [el('a', { href: r.href, text: r.label })]),
        el('td', { text: r.createdText }),
        el('td', {}, [pill(r.statusText, r.tone, `${r.testid}-status`)]),
        el('td', { text: r.nextStepText }),
        el('td', { text: r.totalText ?? '—' }),
      ]))),
    ]),
    model.showPriceNotice ? el('p', { class: 'price-notice', testid: 'price-notice', text: model.priceNotice }) : null,
  ];
}

/** ctx: { api, container, announce } */
export function mountRequestsList(ctx, route) {
  const title = el('h1', { id: 'page-title', tabindex: '-1', text: 'Your rescue requests' });
  const slot = el('div', { testid: 'requests-slot' });
  replaceContent(ctx.container, [title, slot]);

  async function load() {
    showState(slot, { kind: 'loading' });
    try {
      const answer = await ctx.api.listRequests();
      const model = buildRequestsListViewModel(answer);
      showState(slot, { kind: 'ready', nodes: renderRequestsList(model) });
      ctx.announce(model.state === 'empty' ? EXACT.NO_REQUESTS : `${model.rows.length} requests loaded.`);
    } catch (err) {
      showState(slot, { kind: 'error', error: err, onRetry: load });
      ctx.announce('Your requests could not be loaded.');
    }
  }
  load();
  return { dispose() {} };
}
