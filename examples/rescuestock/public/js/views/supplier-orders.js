// #/supplier/orders — order cards with confirm (bundles, ready time), refuse (reason), mark ready and record
// handover. An order of a plan that became non-executable reads "Cancelled — payment did not complete" and offers
// no action (F-TR-11). The buyer is shown by display name only; nothing else about them reaches this screen.

import { el, replaceContent } from '../dom.js';
import { EXACT } from '../texts.js';
import {
  formatLocalDateTime, formatLocalTime, formatUsd, fulfilmentText, localToTs, paymentStatusText, presentationText, utcToLocal,
} from '../format.js';
import { describeError } from '../errors.js';
import { badgeNodes, demoBadge, pill, providerBadgeModels } from '../components/badges.js';
import { inputField, selectField, submitButton } from '../components/form.js';
import { emptyNode, errorNode, loadingNode, noticeNode, showState } from '../components/notice.js';

export const STATUS_FILTERS = Object.freeze([
  ['', 'All orders'], ['awaiting_supplier', 'Waiting for me'], ['confirmed', 'Confirmed'], ['ready', 'Ready'],
  ['collected', 'Collected'], ['refused', 'Refused'], ['cancelled', 'Cancelled'],
]);

export function buildSupplierOrdersViewModel(answer) {
  const cards = (answer.orders ?? []).map((o) => {
    const cancelled = o.presentation === 'cancelled_payment_incomplete';
    const open = !cancelled && (o.fulfilmentStatus === 'awaiting_supplier' || o.fulfilmentStatus === 'confirmed');
    return {
      id: o.id,
      ref: o.ref,
      buyerName: o.buyer.displayName,
      lines: o.lines.map((l) => ({ offerId: l.offerId, productName: l.productName, bundles: l.bundles, cups: l.cups, lids: l.lids })),
      totalText: formatUsd(o.totalCents),
      catalogReadyText: formatLocalTime(o.catalogReadyAt),
      deadlineText: formatLocalDateTime(o.deadlineAt),
      fulfilmentStatus: o.fulfilmentStatus,
      statusText: cancelled ? EXACT.ORDER_NOT_PAID : fulfilmentText(o.fulfilmentStatus),
      presentationText: presentationText(o.presentation),
      cancelled,
      commitmentText: o.commitment ? `${o.commitment.bundles} bundle${o.commitment.bundles === 1 ? '' : 's'}, ready ${formatLocalTime(o.commitment.readyAt)}` : null,
      refusalReason: o.refusalReason ?? null,
      paymentText: paymentStatusText(o.payment.status),
      badges: providerBadgeModels(o.payment),
      demo: o.demo === true,
      testid: `order-${o.id}`,
      actions: {
        confirm: !cancelled && o.canConfirm
          ? { readyDefault: utcToLocal(o.catalogReadyAt), lines: o.lines.map((l) => ({ offerId: l.offerId, productName: l.productName, planned: l.bundles })) }
          : null,
        refuse: open ? { maxLength: 300 } : null,
        ready: !cancelled && o.canMarkReady,
        handover: !cancelled && o.canHandover,
      },
    };
  });
  return { state: cards.length === 0 ? 'empty' : 'ready', cards, priceNotice: EXACT.PRICE_NOTICE };
}

// values: { bundles: { [offerId]: string }, readyLocal: string } -> { ok, body, errors }
export function buildSupplierConfirmBody(confirmSpec, values) {
  const errors = {};
  const lines = [];
  for (const l of confirmSpec.lines) {
    const raw = String(values.bundles?.[l.offerId] ?? '').trim();
    if (!/^\d{1,6}$/.test(raw) || Number(raw) < 1) errors[`bundles-${l.offerId}`] = 'Enter a whole number of bundles, 1 or more.';
    else if (Number(raw) < l.planned) errors[`bundles-${l.offerId}`] = `The buyer planned ${l.planned}; confirm at least that many.`;
    else lines.push({ offerId: l.offerId, committedBundles: Number(raw) });
  }
  const ts = localToTs(String(values.readyLocal ?? '').trim());
  if (ts === null) errors.ready = 'Enter a real date and time, like 2026-10-20 10:30 (Amman time).';
  return { ok: Object.keys(errors).length === 0, body: { lines, committedReadyAt: ts }, errors };
}

export function validateRefusalReason(reason) {
  const value = String(reason ?? '').trim();
  if (value.length < 1) return 'Say why you are refusing.';
  if (value.length > 300) return 'Use at most 300 characters.';
  return null;
}

function renderCard(card, on) {
  const parts = [
    el('h2', {}, [
      `Order ${card.ref}`,
      card.demo ? ' ' : null,
      card.demo ? demoBadge() : null,
    ]),
    el('p', {}, [el('span', { class: 'label', text: 'Status: ' }), pill(card.statusText, card.cancelled ? 'warn' : 'neutral', `${card.testid}-status`)]),
    el('p', { text: `Buyer: ${card.buyerName}` }),
    el('ul', { class: 'plain-list' }, card.lines.map((l) => el('li', {}, [
      el('span', { dir: 'auto', text: l.productName }),
      el('span', { text: ` — ${l.bundles} bundle${l.bundles === 1 ? '' : 's'} (${l.cups} cups, ${l.lids} lids)` }),
    ]))),
    el('p', { text: `Total: ${card.totalText}` }),
    el('p', { text: `Your catalog ready time: ${card.catalogReadyText}. Buyer’s deadline: ${card.deadlineText} (Amman time).` }),
    el('p', {}, [el('span', { class: 'label', text: 'Payment: ' }), card.paymentText, ' ', ...badgeNodes(card.badges)]),
    card.commitmentText ? el('p', { testid: `${card.testid}-commitment`, text: `You confirmed: ${card.commitmentText}` }) : null,
    card.refusalReason ? el('p', { dir: 'auto', text: `Reason you gave: ${card.refusalReason}` }) : null,
  ];
  const a = card.actions;
  if (a.confirm) parts.push(renderConfirmForm(card, a.confirm, on));
  if (a.refuse) parts.push(renderRefuseForm(card, on));
  if (a.ready) parts.push(el('button', { type: 'button', class: 'button button-primary', testid: `ready-${card.testid}`, on: { click: () => on.ready(card) }, text: 'Mark ready for pickup' }));
  if (a.handover) parts.push(el('button', { type: 'button', class: 'button button-primary', testid: `handover-${card.testid}`, on: { click: () => on.handover(card) }, text: 'Record handover to the buyer' }));
  return el('li', { class: 'card', testid: card.testid }, parts);
}

function renderConfirmForm(card, spec, on) {
  const refs = {};
  const fields = spec.lines.map((l) => {
    const f = inputField({
      id: `confirm-${card.id}-${l.offerId}`,
      name: `bundles-${l.offerId}`,
      label: `Bundles you can supply — ${l.productName}`,
      type: 'number',
      value: String(l.planned),
      min: '1',
      step: '1',
      inputmode: 'numeric',
      hint: `The buyer planned ${l.planned}.`,
    });
    refs[l.offerId] = f.input;
    return f.row;
  });
  const ready = inputField({ id: `confirm-${card.id}-ready`, name: 'ready', label: 'Ready for pickup at (Amman time)', type: 'datetime-local', value: spec.readyDefault ?? '' });
  const form = el('form', {
    novalidate: true,
    'aria-label': `Confirm order ${card.ref}`,
    testid: `confirm-form-${card.testid}`,
    on: {
      submit: (event) => {
        event.preventDefault();
        const bundles = {};
        for (const [offerId, input] of Object.entries(refs)) bundles[offerId] = input.value;
        on.confirm(card, spec, { bundles, readyLocal: ready.input.value });
      },
    },
  }, [...fields, ready.row, submitButton('Confirm order', { testid: `confirm-${card.testid}` })]);
  return el('details', { class: 'inline-details' }, [el('summary', { text: 'Confirm this order' }), form]);
}

function renderRefuseForm(card, on) {
  const reason = inputField({ id: `refuse-${card.id}-reason`, name: 'reason', label: 'Reason for refusing (up to 300 characters)', type: 'textarea', rows: 3, maxlength: '300', dir: 'auto' });
  const form = el('form', {
    novalidate: true,
    'aria-label': `Refuse order ${card.ref}`,
    testid: `refuse-form-${card.testid}`,
    on: {
      submit: (event) => {
        event.preventDefault();
        on.refuse(card, reason.input.value);
      },
    },
  }, [reason.row, submitButton('Refuse order', { testid: `refuse-${card.testid}` })]);
  return el('details', { class: 'inline-details' }, [el('summary', { text: 'Refuse this order' }), form]);
}

export function renderSupplierOrders(model, on, filter) {
  const filterField = selectField({
    id: 'orders-filter',
    name: 'status',
    label: 'Show',
    value: filter,
    options: STATUS_FILTERS.map(([value, label]) => ({ value, label })),
  });
  filterField.input.addEventListener('change', () => on.filter(filterField.input.value));
  return [
    el('div', { class: 'toolbar' }, [filterField.row]),
    model.state === 'empty'
      ? emptyNode({ title: 'No orders to show.', body: 'Orders appear here when a buyer reserves stock from your catalog.', testid: 'orders-empty' })
      : el('ul', { class: 'cards', testid: 'orders-list' }, model.cards.map((c) => renderCard(c, on))),
    model.state === 'ready' ? el('p', { class: 'price-notice', testid: 'price-notice', text: model.priceNotice }) : null,
  ];
}

/** ctx: { api, container, announce } */
export function mountSupplierOrders(ctx, route) {
  const title = el('h1', { id: 'page-title', tabindex: '-1', text: 'Orders' });
  const feedback = el('div', {});
  const slot = el('div', { testid: 'orders-slot' });
  replaceContent(ctx.container, [title, feedback, slot]);
  let filter = '';
  let busy = false;

  async function load() {
    showState(slot, { kind: 'loading' });
    try {
      const answer = await ctx.api.listSupplierOrders(filter);
      const model = buildSupplierOrdersViewModel(answer);
      showState(slot, { kind: 'ready', nodes: renderSupplierOrders(model, on, filter) });
      ctx.announce(model.state === 'empty' ? 'No orders to show.' : `${model.cards.length} orders loaded.`);
    } catch (err) {
      showState(slot, { kind: 'error', error: err, onRetry: load });
      ctx.announce('Orders could not be loaded.');
    }
  }

  async function act(workingText, task) {
    if (busy) return;
    busy = true;
    replaceContent(feedback, [loadingNode(workingText)]);
    ctx.announce(workingText);
    try {
      await task();
      replaceContent(feedback, []);
      ctx.announce('Done.');
    } catch (err) {
      replaceContent(feedback, [errorNode(err)]);
      ctx.announce(`${describeError(err).message} ${describeError(err).action}`);
    } finally {
      busy = false;
    }
    await load();
  }

  const on = {
    filter: (value) => {
      filter = value;
      load();
    },
    confirm: (card, spec, values) => {
      const built = buildSupplierConfirmBody(spec, values);
      if (!built.ok) {
        const text = Object.values(built.errors).join(' ');
        replaceContent(feedback, [noticeNode({ text, tone: 'warn', role: 'alert', testid: 'form-problem' })]);
        ctx.announce(text);
        return;
      }
      act('Confirming the order…', () => ctx.api.confirmSupplierOrder(card.id, built.body));
    },
    refuse: (card, reason) => {
      const problem = validateRefusalReason(reason);
      if (problem) {
        replaceContent(feedback, [noticeNode({ text: problem, tone: 'warn', role: 'alert', testid: 'form-problem' })]);
        ctx.announce(problem);
        return;
      }
      act('Refusing the order…', () => ctx.api.refuseSupplierOrder(card.id, reason.trim()));
    },
    ready: (card) => act('Marking the order ready…', () => ctx.api.markSupplierOrderReady(card.id)),
    handover: (card) => act('Recording the handover…', () => ctx.api.recordHandover(card.id)),
  };

  load();
  return { dispose() {} };
}
