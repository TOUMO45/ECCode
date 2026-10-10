// Section 8, actions on the request page. Which button shows comes from the server's next step and plan state:
//   Approve plan (shows the total; sends planHash and total)      next step APPROVE_PLAN
//   Reserve (Idempotency-Key kept under reserve:<planVersionId>)   next step RESERVE
//   "PayPal approvals: 1 of 2 — Supplier A — Approve with PayPal"  next step APPROVE_PAYMENTS
//   Try approval again / Abandon purchase                          next step RETRY_APPROVAL_OR_ABANDON
//   Complete purchase                                              next step COMPLETE_PURCHASE
//   Record receipt                                                 an order that is ready or collected
//   Delete request                                                 always
// Every payment element carries its provider badge ("Simulated" or "PayPal Sandbox — no real money").

import { el } from '../dom.js';
import { formatUsd, paymentStatusText, supplierLabel } from '../format.js';
import { currentPlan, sortedOrders, supplierDirectory, supplierName } from '../view-helpers.js';
import { reserveStorageKey } from '../reserve-key.js';
import { badgeNodes, providerBadgeModels } from './badges.js';
import { emptyNode } from './notice.js';

function missingInput(view) {
  const f = view.requirements?.fields ?? {};
  // The server checks the budget first (RS-04), so the message names the budget first.
  if ((f.budgetCents?.status ?? 'unknown') !== 'known') return 'Add a budget under “What you need” before you approve the plan.';
  if ((f.deadline?.status ?? 'unknown') !== 'known') return 'Add a deadline under “What you need” before you approve the plan.';
  return null;
}

export function actionsModel(view) {
  const plan = currentPlan(view);
  const code = view.rescueStatus.nextStep.code;
  const dir = supplierDirectory(view);
  const orders = sortedOrders(view.orders);
  const model = {
    plan: code === 'PLAN' ? { label: 'Find a plan', testid: 'plan' } : null,
    replan: code === 'REPLAN' || code === 'REPLAN_OR_OTHER_ACCOUNT' ? { label: 'Re-plan with current stock', testid: 'replan' } : null,
    approve: null,
    reserve: null,
    paypal: [],
    abandon: null,
    execute: null,
    receipts: [],
    remove: { label: 'Delete request', testid: 'delete-request' },
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
      const needsApproval = o.payment.status === 'created';
      model.paypal.push({
        orderId: o.id,
        supplierCode: o.supplier.code,
        supplierName: name,
        index: i + 1,
        count: orders.length,
        step: `PayPal approvals: ${i + 1} of ${orders.length}`,
        totalText: formatUsd(o.totals.totalCents),
        state: needsApproval ? (retry ? 'retry' : 'todo') : 'done',
        buttonLabel: retry ? 'Try approval again' : 'Approve with PayPal',
        statusText: paymentStatusText(o.payment.status),
        badges: providerBadgeModels(o.payment),
        testid: `paypal-approve-${o.supplier.code}`,
      });
    });
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
        label: `Record receipt — ${supplierLabel(o.supplier.code, o.supplier.name)}`,
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
    disabledReason ? el('p', { id: reasonId, class: 'hint', text: disabledReason }) : null,
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
    items.push(el('ol', { class: 'plain-list', testid: 'paypal-approvals' }, model.paypal.map((p) => el('li', { class: 'card', testid: `paypal-${p.supplierCode}` }, [
      el('p', { text: `${p.step} — ${p.supplierName} — ${p.buttonLabel} (${p.totalText})` }),
      el('p', {}, [el('span', { class: 'label', text: 'Payment: ' }), p.statusText, ' ', ...badgeNodes(p.badges)]),
      p.state !== 'done' && on.paypal
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
  if (on.remove) items.push(...button(model.remove, on.remove));
  if (items.length === 0) return [emptyNode({ title: 'There is nothing for you to do right now.', testid: 'actions-empty' })];
  return [el('div', { class: 'actions', testid: 'actions' }, items)];
}
