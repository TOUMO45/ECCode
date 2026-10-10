// Section 1 of the request page: the rescue status as text, the next-step sentence and its button.

import { el } from '../dom.js';
import { EXACT } from '../texts.js';
import { rescueStatusText } from '../format.js';
import { pill, toneForStatus } from './badges.js';
import { expiredReservationNode, noticeNode } from './notice.js';
import { isReservationExpired } from '../view-helpers.js';

// nextStep.code -> the action its button starts. Codes without a button need nothing from the user here.
const ACTION_BY_CODE = Object.freeze({
  PLAN: 'plan',
  REPLAN: 'replan',
  REPLAN_OR_OTHER_ACCOUNT: 'replan',
  APPROVE_PLAN: 'approve',
  RESERVE: 'reserve',
  COMPLETE_PURCHASE: 'execute',
});

export function statusModel(view) {
  const rs = view.rescueStatus;
  const expired = isReservationExpired(view);
  let kind = Object.hasOwn(ACTION_BY_CODE, rs.nextStep.code) ? ACTION_BY_CODE[rs.nextStep.code] : null;
  if (expired && kind === 'replan') kind = null; // the expired-reservation notice carries its own Re-plan button
  return {
    status: rs.status,
    statusText: rescueStatusText(rs.status),
    tone: toneForStatus(rs.status),
    message: typeof rs.message === 'string' && rs.message.length > 0 ? rs.message : null,
    nextStep: { code: rs.nextStep.code, text: rs.nextStep.text },
    action: kind ? { kind, label: rs.nextStep.text } : null,
    replanning: rs.status === 'replanning',
    replanningText: EXACT.REPLANNING,
    expired,
  };
}

export function renderStatus(model, on = {}) {
  return [
    el('p', { class: 'status-line' }, [
      el('span', { class: 'label', text: 'Status: ' }),
      pill(model.statusText, model.tone, 'rescue-status'),
    ]),
    model.message ? el('p', { class: 'status-message', testid: 'rescue-message', text: model.message }) : null,
    model.replanning ? noticeNode({ text: model.replanningText, testid: 'replanning', role: 'status' }) : null,
    model.expired ? expiredReservationNode(on.replan) : null,
    el('p', { class: 'next-step' }, [
      el('span', { class: 'label', text: 'Next step: ' }),
      el('span', { testid: 'next-step', text: model.nextStep.text }),
    ]),
    model.action && on[model.action.kind]
      ? el('button', { type: 'button', class: 'button button-primary', testid: 'next-step-action', on: { click: on[model.action.kind] }, text: model.action.label })
      : null,
  ];
}
