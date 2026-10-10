// Section 7, "If something fails": the payment status of every order as text, the compensation state (voids and
// refunds still outstanding, and how they ended) and the next step. Orders of a plan that became non-executable
// read "Cancelled — payment did not complete" (F-TR-11). Colour is never the only signal.

import { el } from '../dom.js';
import { EXACT } from '../texts.js';
import { fulfilmentText, paymentStatusText, presentationText } from '../format.js';
import { sortedOrders, supplierDirectory, supplierName } from '../view-helpers.js';
import { badgeNodes, demoBadge, pill, providerBadgeModels } from './badges.js';
import { emptyNode } from './notice.js';

const SETTLED = Object.freeze(['voided', 'authorization_failed', 'refunded', 'refund_failed']);

// -> { state: 'none'|'in_progress'|'done'|'failed', text } for one payment
export function compensationOf(order) {
  const p = order.payment;
  switch (p.status) {
    case 'voided': return { state: 'done', text: 'Authorization voided — no money was taken' };
    case 'authorization_failed': return { state: 'done', text: 'PayPal declined — no money was taken' };
    case 'refunded': return { state: 'done', text: 'Refunded in full' };
    case 'refund_requested':
    case 'refund_pending': return { state: 'in_progress', text: 'Refund in progress' };
    case 'refund_failed': return { state: 'failed', text: 'Refund failed — contact the organiser' };
    default: break;
  }
  if (p.voidFailed) return { state: 'failed', text: 'Voiding the authorization failed; it will be retried' };
  if (p.cancelRequested && !SETTLED.includes(p.status)) return { state: 'in_progress', text: 'Cancelling — waiting for PayPal' };
  return { state: 'none', text: 'Nothing to undo' };
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
    badges: providerBadgeModels(order.payment),
    compensation: compensationOf(order),
    testid: `failure-${order.supplier.code}${earlier ? '-earlier' : ''}`,
  };
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
    nextStepText: rs.nextStep.text,
    message: typeof rs.message === 'string' && rs.message ? rs.message : null,
    emptyText: 'No payment has been started, so there is nothing to undo.',
  };
}

export function renderFailure(model) {
  if (model.state === 'empty') {
    return [emptyNode({ title: model.emptyText, testid: 'failure-empty' }), el('p', { testid: 'failure-next-step', text: `Next step: ${model.nextStepText}` })];
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
      el('p', { testid: 'compensation', data: { state: r.compensation.state } }, [
        el('span', { class: 'label', text: 'Compensation: ' }),
        r.compensation.text,
      ]),
    ]))),
    el('p', { testid: 'failure-next-step' }, [el('span', { class: 'label', text: 'Next step: ' }), model.nextStepText]),
    model.message ? el('p', { testid: 'failure-message', text: model.message }) : null,
  ];
}
