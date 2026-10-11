// Section 8, actions on the request page. Which button shows comes from the server's next step and plan state:
//   Approve plan (shows the total; sends planHash and total)      next step APPROVE_PLAN
//   Reserve (Idempotency-Key kept under reserve:<planVersionId>)   next step RESERVE
//   "PayPal approvals: 1 of 2 — Supplier A — Approve with PayPal"  next step APPROVE_PAYMENTS
//   Try approval again / Abandon purchase                          next step RETRY_APPROVAL_OR_ABANDON
//   Complete purchase                                              next step COMPLETE_PURCHASE
//   Record receipt                                                 an order that is ready or collected
//   Delete request                                                 when capabilities.deleteRequest is true
// Every payment element carries its provider badge ("Simulated" or "PayPal Sandbox — no real money"). In
// single-credential mode the list also says "All demo suppliers are paid to one Sandbox account". An order of a plan
// that became non-executable reads "Cancelled — payment did not complete" and gets no approval button (F-TR-11).

import { el } from '../dom.js';
import { formatUsd, paymentStatusText } from '../format.js';
import { EXACT } from '../texts.js';
import { currentPlan, deleteRequestAvailable, isReservationExpired, sortedOrders, supplierDirectory, supplierName } from '../view-helpers.js';
import { reserveStorageKey } from '../reserve-key.js';
import { badgeNodes, providerBadgeModels } from './badges.js';
import { emptyNode, noticeNode } from './notice.js';

// True when the server reports that every supplier is paid to one Sandbox account (labels or any payment object).
function singleCredential(view, orders) {
  return view?.labels?.merchantMode === 'single-credential' || orders.some((o) => o.payment?.merchantMode === 'single-credential');
}

// Rescue statuses in which this customer's reservation is live, so a second reservation hits RESERVATION_LIMIT.
export const HOLDING_STATUSES = Object.freeze(['stock_reserved', 'payment_authorized']);

/**
 * RESERVATION_LIMIT (SEC-2): the sentence and a link to the request that holds the stock.
 *   error     the ApiError (details.reservationIds is all the contract promises)
 *   requests  GET /api/requests -> requests[] (looked up because a reservation id is not a request id)
 * details.requestIds is used when the server sends it; otherwise the list is searched for a request that holds stock.
 * The link falls back to the whole list when the other request cannot be found.
 */
export function reservationLimitModel({ error = null, requests = [], currentRequestId = null } = {}) {
  const fromError = Array.isArray(error?.details?.requestIds) ? error.details.requestIds : [];
  const fromList = (Array.isArray(requests) ? requests : [])
    .filter((r) => HOLDING_STATUSES.includes(r?.rescueStatus?.status))
    .map((r) => r.id);
  const ids = [...new Set([...fromError, ...fromList])]
    .filter((id) => Number.isInteger(id) && id > 0 && id !== Number(currentRequestId));
  const links = ids.length > 0
    ? ids.map((id) => ({ href: `#/requests/${id}`, label: `Open request #${id}` }))
    : [{ href: '#/requests', label: 'Open your requests' }];
  return { message: EXACT.RESERVATION_LIMIT, links, found: ids.length > 0 };
}

// What to tell the user when an action worked. Honest: it says what was done, never that money moved when it has not.
export function successText(kind, answer = null) {
  switch (kind) {
    case 'approve': return 'Plan approved.';
    case 'reserve': return 'Stock reserved for you.';
    case 'paypal': return answer?.payment?.simulated === true
      ? 'Taking you to the simulated approval page (not PayPal)…'
      : 'Taking you to PayPal Sandbox (no real money)…';
    case 'abandon': return 'Purchase abandoned. Nothing was charged; any PayPal authorizations are being released.';
    case 'execute': return answer?.claimed === false
      ? 'This purchase is already being completed. This page updates by itself.'
      : 'Purchase started. Payments are being captured; this page updates by itself.';
    case 'receipt': return 'Receipt recorded.';
    default: return 'Done.';
  }
}

function missingInput(view) {
  const f = view.requirements?.fields ?? {};
  // The server checks the budget first (RS-04), so the message names the budget first.
  if ((f.budgetCents?.status ?? 'unknown') !== 'known') return 'Add a budget under “What you need” before you approve the plan.';
  if ((f.deadline?.status ?? 'unknown') !== 'known') return 'Add a deadline under “What you need” before you approve the plan.';
  return null;
}

// options.config: the GET /api/config answer, a fallback for the capability flag.
export function actionsModel(view, { config = null } = {}) {
  const plan = currentPlan(view);
  const code = view.rescueStatus.nextStep.code;
  const dir = supplierDirectory(view);
  const orders = sortedOrders(view.orders);
  const model = {
    plan: code === 'PLAN' ? { label: 'Find a plan', testid: 'plan' } : null,
    // After an expired reservation the status section carries the one Re-plan button.
    replan: (code === 'REPLAN' || code === 'REPLAN_OR_OTHER_ACCOUNT') && !isReservationExpired(view)
      ? { label: 'Re-plan with current stock', testid: 'replan' }
      : null,
    approve: null,
    reserve: null,
    paypal: [],
    // [{ testid, tone, text }] shown above the approvals: the single-credential notice.
    paypalNotices: [],
    abandon: null,
    execute: null,
    receipts: [],
    // TR-C-4: shown only when the server reports capabilities.deleteRequest (DELETE /api/requests/:id exists).
    remove: deleteRequestAvailable(view, config) ? { label: 'Delete request', testid: 'delete-request' } : null,
  };

  if (plan && plan.status === 'proposed' && code === 'APPROVE_PLAN') {
    model.approve = {
      planId: plan.id,
      expectedTotalCents: plan.body.totalCents,
      planHash: plan.planHash,
      label: `Approve plan (${formatUsd(plan.body.totalCents)})`,
      blockedReason: missingInput(view),
      testid: 'approve-plan',
    };
  }

  if (plan && code === 'RESERVE') {
    model.reserve = {
      planId: plan.id,
      storageKey: reserveStorageKey(plan.id),
      label: `Reserve stock for ${formatUsd(plan.body.totalCents)}`,
      testid: 'reserve',
    };
  }

  if (code === 'APPROVE_PAYMENTS' || code === 'RETRY_APPROVAL_OR_ABANDON') {
    orders.forEach((o, i) => {
      const name = supplierName(dir, o.supplier.code);
      const retry = o.payment.buyerCancelledAt !== null && o.payment.buyerCancelledAt !== undefined;
      const cancelled = o.presentation === 'cancelled_payment_incomplete';
      const needsApproval = !cancelled && o.payment.status === 'created';
      model.paypal.push({
        orderId: o.id,
        supplierCode: o.supplier.code,
        supplierName: name,
        index: i + 1,
        count: orders.length,
        step: `PayPal approvals: ${i + 1} of ${orders.length}`,
        totalText: formatUsd(o.totals.totalCents),
        state: cancelled ? 'cancelled' : (needsApproval ? (retry ? 'retry' : 'todo') : 'done'),
        buttonLabel: retry ? 'Try approval again' : 'Approve with PayPal',
        statusText: cancelled ? EXACT.ORDER_NOT_PAID : paymentStatusText(o.payment.status),
        badges: providerBadgeModels(o.payment),
        testid: `paypal-approve-${o.supplier.code}`,
      });
    });
    if (orders.length > 0 && singleCredential(view, orders)) {
      model.paypalNotices.push({ testid: 'single-credential-notice', tone: 'info', text: EXACT.SINGLE_CREDENTIAL });
    }
    if (model.paypal.some((p) => p.state === 'retry') || code === 'RETRY_APPROVAL_OR_ABANDON') {
      model.abandon = { planId: plan?.id ?? null, label: 'Abandon purchase', testid: 'abandon' };
    }
  }

  if (plan && code === 'COMPLETE_PURCHASE') {
    model.execute = { planId: plan.id, label: 'Complete purchase', testid: 'execute' };
  }

  for (const o of orders) {
    if ((o.fulfilmentStatus === 'ready' || o.fulfilmentStatus === 'collected') && !o.receiptRecorded) {
      model.receipts.push({
        orderId: o.id,
        supplierCode: o.supplier.code,
        label: `Record receipt — ${supplierName(dir, o.supplier.code)}`,
        testid: `receipt-${o.supplier.code}`,
      });
    }
  }
  return model;
}

function button(spec, onClick, { primary = false, disabledReason = null } = {}) {
  const reasonId = disabledReason ? `${spec.testid}-reason` : null;
  return [
    el('button', {
      type: 'button',
      class: `button${primary ? ' button-primary' : ''}`,
      testid: spec.testid,
      'aria-disabled': disabledReason ? 'true' : null,
      'aria-describedby': reasonId,
      on: { click: (event) => { if (!disabledReason) onClick(event); } },
      text: spec.label,
    }),
    disabledReason ? el('p', { id: reasonId, class: 'hint', testid: reasonId, text: disabledReason }) : null,
  ];
}

export function renderActions(model, on = {}) {
  const items = [];
  if (model.plan && on.plan) items.push(...button(model.plan, on.plan, { primary: true }));
  if (model.replan && on.replan) items.push(...button(model.replan, on.replan, { primary: true }));
  if (model.approve && on.approve) {
    items.push(...button(model.approve, () => on.approve(model.approve), { primary: true, disabledReason: model.approve.blockedReason }));
  }
  if (model.reserve && on.reserve) items.push(...button(model.reserve, () => on.reserve(model.reserve), { primary: true }));
  if (model.paypal.length > 0) {
    for (const n of model.paypalNotices) items.push(noticeNode({ text: n.text, tone: n.tone, testid: n.testid }));
    items.push(el('ol', { class: 'plain-list paypal-approvals', testid: 'paypal-approvals' }, model.paypal.map((p) => el('li', { class: 'card', testid: `paypal-${p.supplierCode}` }, [
      p.state === 'cancelled'
        ? el('p', { text: `${p.step} — ${p.supplierName} — ${p.statusText}` })
        : el('p', { text: `${p.step} — ${p.supplierName} — ${p.buttonLabel} (${p.totalText})` }),
      el('p', {}, [el('span', { class: 'label', text: 'Payment: ' }), p.statusText, ' ', ...badgeNodes(p.badges)]),
      p.state !== 'done' && p.state !== 'cancelled' && on.paypal
        ? el('button', {
          type: 'button',
          class: 'button button-primary',
          testid: p.testid,
          on: { click: () => on.paypal(p) },
          text: `${p.buttonLabel} — ${p.supplierName}`,
        })
        : null,
    ]))));
  }
  if (model.abandon && on.abandon) items.push(...button(model.abandon, () => on.abandon(model.abandon)));
  if (model.execute && on.execute) items.push(...button(model.execute, () => on.execute(model.execute), { primary: true }));
  for (const r of model.receipts) if (on.receipt) items.push(...button(r, () => on.receipt(r)));
  if (model.remove && on.remove) items.push(...button(model.remove, on.remove));
  if (items.length === 0) return [emptyNode({ title: 'There is nothing for you to do right now.', testid: 'actions-empty' })];
  return [el('div', { class: 'actions', testid: 'actions' }, items)];
}
