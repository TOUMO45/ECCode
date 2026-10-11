// Section 1 of the request page: the rescue status as text, the next-step sentence and its button.
//
// Recovery states (spec: Frontend section 7, States; derivation rows 2, 4a, 6, 12):
//   replanning + WAIT       "Finding a new plan with current stock…", the page keeps polling
//   replanning + REPLAN     (after five failed drains) the Re-plan button; nothing claims a search is running
//   plan_found + REVIEW_NEW_PLAN   "Prices changed: review plan vN" or the refusal message, and a "Review the new plan" button
//   cancelled + REPLAN with an expired reservation   the expired-reservation notice with its own Re-plan button
//   failed_needs_attention + CONTACT_ORGANISER   "Contact the organiser" and the request number to quote

import { el } from '../dom.js';
import { messageNodes } from '../isolate.js';
import { EXACT, nextStepSentence } from '../texts.js';
import { rescueStatusText } from '../format.js';
import { pill, toneForStatus } from './badges.js';
import { expiredReservationNode, noticeNode } from './notice.js';
import { isReservationExpired } from '../view-helpers.js';

// nextStep.code -> the action its button starts. Codes without a button need nothing from the user here.
const ACTION_BY_CODE = Object.freeze({
  PLAN: 'plan',
  REPLAN: 'replan',
  REPLAN_OR_OTHER_ACCOUNT: 'replan',
  REVIEW_NEW_PLAN: 'review',
  APPROVE_PLAN: 'approve',
  RESERVE: 'reserve',
  COMPLETE_PURCHASE: 'execute',
});

export function statusModel(view) {
  const rs = view.rescueStatus;
  const expired = isReservationExpired(view);
  const nextStepText = nextStepSentence(rs.nextStep);
  let kind = Object.hasOwn(ACTION_BY_CODE, rs.nextStep.code) ? ACTION_BY_CODE[rs.nextStep.code] : null;
  if (expired && kind === 'replan') kind = null; // the expired-reservation notice carries its own Re-plan button
  const needsOrganiser = rs.nextStep.code === 'CONTACT_ORGANISER' || rs.status === 'failed_needs_attention';
  return {
    status: rs.status,
    statusText: rescueStatusText(rs.status),
    tone: toneForStatus(rs.status),
    message: typeof rs.message === 'string' && rs.message.length > 0 ? rs.message : null,
    nextStep: { code: rs.nextStep.code, text: nextStepText },
    action: kind ? { kind, label: nextStepText } : null,
    // Only a search that is really running reads as one: after five failed drains the user starts it (REPLAN).
    replanning: rs.status === 'replanning' && rs.nextStep.code !== 'REPLAN',
    replanningText: EXACT.REPLANNING,
    expired,
    attention: needsOrganiser
      ? { text: EXACT.CONTACT_ORGANISER, detail: `Quote request #${view.request.id} when you do. The organiser can see what is still open.` }
      : null,
  };
}

export function renderStatus(model, on = {}) {
  return [
    el('p', { class: 'status-line' }, [
      el('span', { class: 'label', text: 'Status: ' }),
      pill(model.statusText, model.tone, 'rescue-status'),
    ]),
    // The message can carry a supplier's own words (a refusal reason): they are isolated from the sentence (FU-58).
    model.message ? el('p', { class: 'status-message', testid: 'rescue-message' }, messageNodes(model.message)) : null,
    model.replanning ? noticeNode({ text: model.replanningText, testid: 'replanning', role: 'status' }) : null,
    model.expired ? expiredReservationNode(on.replan) : null,
    model.attention ? noticeNode({ text: model.attention.text, tone: 'warn', role: 'alert', testid: 'contact-organiser', children: [el('p', { text: model.attention.detail })] }) : null,
    el('p', { class: 'next-step' }, [
      el('span', { class: 'label', text: 'Next step: ' }),
      el('span', { testid: 'next-step', text: model.nextStep.text }),
    ]),
    model.action && on[model.action.kind]
      ? el('button', { type: 'button', class: 'button button-primary', testid: 'next-step-action', on: { click: on[model.action.kind] }, text: model.action.label })
      : null,
  ];
}
