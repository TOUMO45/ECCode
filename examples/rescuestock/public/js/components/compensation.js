// Section 7, "If something fails": the payment status of every order as text, the compensation state (voids and
// refunds still outstanding, and how they ended) and the next step. Orders of a plan that became non-executable
// read "Cancelled — payment did not complete" (F-TR-11). Colour is never the only signal. Every sentence says only
// what the view says: "no money was taken" appears for a void or a decline, and a refund is never called done
// before the payment reads refunded.

import { el } from '../dom.js';
import { messageNodes, reasonNodes } from '../isolate.js';
import { EXACT, nextStepSentence } from '../texts.js';
import { fulfilmentText, paymentStatusText, presentationText } from '../format.js';
import { sortedOrders, supplierDirectory, supplierName } from '../view-helpers.js';
import { badgeNodes, demoBadge, pill, providerBadgeModels } from './badges.js';
import { emptyNode, noticeNode } from './notice.js';

const SETTLED = Object.freeze(['voided', 'authorization_failed', 'refunded', 'refund_failed']);

// -> { state: 'none'|'in_progress'|'done'|'failed', kind: 'void'|'refund'|null, text } for one payment
export function compensationOf(order) {
  const p = order.payment;
  switch (p.status) {
    case 'voided': return {
      state: 'done',
      kind: 'void',
      text: p.voidedLocally === true ? 'Cancelled before authorization — no money was taken' : 'Authorization voided — no money was taken',
    };
    case 'authorization_failed': return { state: 'done', kind: null, text: 'PayPal declined — no money was taken' };
    case 'refunded': return { state: 'done', kind: 'refund', text: 'Refunded in full' };
    case 'refund_requested':
    case 'refund_pending': return { state: 'in_progress', kind: 'refund', text: 'Refund in progress' };
    case 'refund_failed': return { state: 'failed', kind: 'refund', text: 'Refund failed — contact the organiser' };
    default: break;
  }
  if (p.voidFailed) return { state: 'failed', kind: 'void', text: 'Voiding the authorization failed — contact the organiser' };
  if (p.cancelRequested && !SETTLED.includes(p.status)) {
    if (p.status === 'authorized') return { state: 'in_progress', kind: 'void', text: 'Void queued — the authorization is being released; no money has been taken' };
    if (p.status === 'captured') return { state: 'in_progress', kind: 'refund', text: 'Refund queued — the captured payment is being returned' };
    return { state: 'in_progress', kind: 'void', text: 'Cancelling — waiting for PayPal' };
  }
  return { state: 'none', kind: null, text: 'Nothing to undo' };
}

function orderRow(order, dir, earlier) {
  const notPaid = order.presentation === 'cancelled_payment_incomplete';
  return {
    orderId: order.id,
    supplierCode: order.supplier.code,
    supplierName: supplierName(dir, order.supplier.code),
    demo: order.supplier.demo === true,
    earlierPlan: earlier,
    presentationText: notPaid ? EXACT.ORDER_NOT_PAID : presentationText(order.presentation),
    notPaid,
    paymentText: paymentStatusText(order.payment.status),
    fulfilmentText: fulfilmentText(order.fulfilmentStatus),
    // The supplier's own words, shown as text under their name (RS-17: the buyer sees why).
    refusalReason: typeof order.refusalReason === 'string' && order.refusalReason.length > 0 ? order.refusalReason : null,
    badges: providerBadgeModels(order.payment),
    compensation: compensationOf(order),
    testid: `failure-${order.supplier.code}${earlier ? '-earlier' : ''}`,
  };
}

// Counts over the rows: what is still outstanding and how the rest ended.
export function compensationSummary(rows) {
  const count = (kind, state) => rows.filter((r) => r.compensation.kind === kind && r.compensation.state === state).length;
  const voids = { outstanding: count('void', 'in_progress'), done: count('void', 'done'), failed: count('void', 'failed') };
  const refunds = { outstanding: count('refund', 'in_progress'), done: count('refund', 'done'), failed: count('refund', 'failed') };
  const failed = voids.failed + refunds.failed;
  const parts = [
    `Voids: ${voids.outstanding} outstanding, ${voids.done} done.`,
    `Refunds: ${refunds.outstanding} outstanding, ${refunds.done} done.`,
  ];
  if (failed > 0) parts.push(`${failed} failed: ${EXACT.CONTACT_ORGANISER}.`);
  return { voids, refunds, failed, text: parts.join(' ') };
}

export function failureModel(view) {
  const dir = supplierDirectory(view);
  const current = sortedOrders(view.orders).map((o) => orderRow(o, dir, false));
  const earlier = sortedOrders(view.cancellingOrders).map((o) => orderRow(o, dir, true));
  const rows = [...current, ...earlier];
  const rs = view.rescueStatus;
  return {
    state: rows.length === 0 ? 'empty' : 'ready',
    rows,
    summary: compensationSummary(rows),
    nextStepText: nextStepSentence(rs.nextStep),
    nextStepCode: rs.nextStep.code,
    message: typeof rs.message === 'string' && rs.message ? rs.message : null,
    emptyText: 'No payment has been started, so there is nothing to undo.',
  };
}

export function renderFailure(model) {
  if (model.state === 'empty') {
    return [
      emptyNode({ title: model.emptyText, testid: 'failure-empty' }),
      model.message ? el('p', { testid: 'failure-message' }, messageNodes(model.message)) : null,
      el('p', { testid: 'failure-next-step', text: `Next step: ${model.nextStepText}` }),
    ];
  }
  return [
    el('ul', { class: 'cards', testid: 'failure-list' }, model.rows.map((r) => el('li', { class: 'card', testid: r.testid }, [
      el('h3', {}, [
        r.supplierName,
        r.demo ? ' ' : null,
        r.demo ? demoBadge() : null,
        r.earlierPlan ? el('span', { class: 'muted', text: ' (earlier plan)' }) : null,
      ]),
      el('p', {}, [el('span', { class: 'label', text: 'Order: ' }), pill(r.presentationText, r.notPaid ? 'warn' : 'neutral', `${r.testid}-presentation`)]),
      el('p', { testid: `${r.testid}-payment` }, [el('span', { class: 'label', text: 'Payment: ' }), r.paymentText, ' ', ...badgeNodes(r.badges)]),
      el('p', { class: 'muted', text: `Supplier: ${r.fulfilmentText}` }),
      r.refusalReason ? el('p', { testid: `${r.testid}-refusal` }, reasonNodes('Reason the supplier gave: ', r.refusalReason)) : null,
      el('p', { testid: 'compensation', data: { state: r.compensation.state, kind: r.compensation.kind ?? 'none' } }, [
        el('span', { class: 'label', text: 'Compensation: ' }),
        r.compensation.text,
      ]),
    ]))),
    noticeNode({ text: model.summary.text, tone: model.summary.failed > 0 ? 'warn' : 'info', testid: 'compensation-summary', role: null }),
    el('p', { testid: 'failure-next-step' }, [el('span', { class: 'label', text: 'Next step: ' }), model.nextStepText]),
    model.message ? el('p', { testid: 'failure-message' }, messageNodes(model.message)) : null,
  ];
}
