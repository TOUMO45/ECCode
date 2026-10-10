// Section 4, "What was rejected". Rows come from the planner's `rejections` array (supplier, offer, codes). The
// sentence for each code is the server's template line when the explanation has one for that supplier, else a
// fixed client template for the code. When no plan is feasible, the section also shows the blocking constraints,
// the per-candidate codes and one button per computed relaxation ("Raise budget to $95.00 → A+E").

import { el } from '../dom.js';
import {
  formatLocalDateTime, formatUsd, isCents, joinCodes, pluralize,
} from '../format.js';
import { currentPlan, supplierDirectory, supplierName } from '../view-helpers.js';
import { demoBadge } from './badges.js';
import { emptyNode } from './notice.js';

export const REJECTION_TEXT = Object.freeze({
  INCOMPATIBLE_LID_DIAMETER: 'Its lids do not fit its cups and no compatibility is confirmed',
  READY_AFTER_DEADLINE: 'It is ready after your deadline',
  OUT_OF_STOCK: 'It has no stock available',
  OFFER_WITHDRAWN: 'Its offer was withdrawn',
});

export const CANDIDATE_TEXT = Object.freeze({
  INSUFFICIENT_QTY: 'Its stock alone does not cover what you need',
  TOO_MANY_PICKUPS: 'The cheapest combination that includes it needs more pickups than you allow',
  OVER_BUDGET: 'The cheapest combination that includes it costs more than your budget',
});

export const BLOCKING_TEXT = Object.freeze({
  OVER_BUDGET: 'Your budget is too low for any plan',
  READY_AFTER_DEADLINE: 'Your deadline is earlier than any supplier can deliver',
  TOO_MANY_PICKUPS: 'Your pickup limit is lower than any plan needs',
  INSUFFICIENT_QTY: 'There is not enough stock in total',
});

const FIELD_BY_CONSTRAINT = Object.freeze({ budget: 'budgetCents', deadline: 'deadline', maxPickups: 'maxPickups' });

function text(map, code) {
  return Object.hasOwn(map, code) ? map[code] : String(code);
}

// The server's own sentence for (code, supplier) from an Explanation, or null.
function serverLine(lines, code, supplierCode) {
  const prefix = `Supplier ${supplierCode} `;
  const hit = (lines ?? []).find((l) => l.code === code && typeof l.text === 'string' && l.text.startsWith(prefix));
  return hit ? hit.text : null;
}

export function relaxationModels(planning) {
  return (planning?.relaxations ?? []).map((r) => {
    const target = joinCodes(r.plan?.supplierCodes);
    let label;
    if (r.constraint === 'budget') {
      label = `Raise budget to ${isCents(r.neededValue) ? formatUsd(r.neededValue) : String(r.neededValue)} → ${target}`;
    } else if (r.constraint === 'deadline') {
      label = `Move deadline to ${formatLocalDateTime(r.neededValue)} → ${target}`;
    } else {
      label = `Allow ${pluralize(r.neededValue, 'pickup', 'pickups')} → ${target}`;
    }
    return {
      constraint: r.constraint,
      code: r.code,
      fieldName: FIELD_BY_CONSTRAINT[r.constraint] ?? null,
      neededValue: r.neededValue,
      label,
      testid: `relax-${r.constraint}`,
      relaxation: r,
    };
  }).filter((m) => m.fieldName !== null);
}

export function rejectedModel(view) {
  const plan = currentPlan(view);
  const planning = view.planning;
  const infeasible = planning?.feasible === false;
  const source = infeasible ? planning : (plan ?? planning);
  if (!source) return { state: 'empty', text: 'There is no plan yet, so nothing has been rejected.' };
  const dir = supplierDirectory(view);
  const lines = source.explanation?.lines ?? [];
  const rows = [];
  for (const r of source.rejections ?? []) {
    for (const code of r.codes) {
      rows.push({
        supplierCode: r.supplierCode,
        supplierName: supplierName(dir, r.supplierCode),
        demo: dir.get(r.supplierCode)?.demo === true,
        offerId: r.offerId,
        code,
        text: serverLine(lines, code, r.supplierCode) ?? text(REJECTION_TEXT, code),
        testid: `rejection-${code}-${r.supplierCode}`,
      });
    }
  }
  const model = { state: 'ready', infeasible, rows, blocking: [], candidates: [], relaxations: [] };
  if (infeasible) {
    model.blocking = (planning.blocking ?? []).map((code) => ({ code, text: text(BLOCKING_TEXT, code), testid: `blocking-${code}` }));
    model.candidates = (planning.candidateCodes ?? []).map((c) => ({
      supplierCode: c.supplierCode,
      supplierName: supplierName(dir, c.supplierCode),
      codes: c.codes.map((code) => ({ code, text: text(CANDIDATE_TEXT, code), testid: `candidate-${code}-${c.supplierCode}` })),
    }));
    model.relaxations = relaxationModels(planning);
  }
  if (rows.length === 0 && !infeasible) {
    return { state: 'empty', text: 'Nothing was rejected: every supplier’s offer was considered.' };
  }
  return model;
}

export function renderRejected(model, on = {}) {
  if (model.state === 'empty') return [emptyNode({ title: model.text, testid: 'rejected-empty' })];
  return [
    model.infeasible
      ? el('div', { class: 'notice notice-warn', role: 'status', testid: 'infeasible' }, [
        el('p', { text: 'No plan satisfies every constraint. Nothing was reserved, ordered or paid.' }),
      ])
      : null,
    model.rows.length > 0
      ? el('ul', { class: 'plain-list', testid: 'rejections' }, model.rows.map((r) => el('li', { testid: r.testid, data: { code: r.code, supplier: r.supplierCode } }, [
        el('strong', { text: r.supplierName }),
        r.demo ? ' ' : null,
        r.demo ? demoBadge() : null,
        el('span', { class: 'code', text: ` ${r.code}` }),
        el('span', { text: ` — ${r.text}` }),
      ])))
      : null,
    model.blocking.length > 0
      ? el('div', { testid: 'blocking' }, [
        el('h3', { text: 'Blocking constraints' }),
        el('ul', {}, model.blocking.map((b) => el('li', { testid: b.testid }, [el('span', { class: 'code', text: b.code }), el('span', { text: ` — ${b.text}` })]))),
      ])
      : null,
    model.candidates.length > 0
      ? el('div', { testid: 'candidates' }, [
        el('h3', { text: 'Why each remaining offer does not work' }),
        el('ul', {}, model.candidates.map((c) => el('li', { testid: `candidate-${c.supplierCode}` }, [
          el('strong', { text: c.supplierName }),
          el('ul', {}, c.codes.map((x) => el('li', { testid: x.testid }, [el('span', { class: 'code', text: x.code }), el('span', { text: ` — ${x.text}` })]))),
        ]))),
      ])
      : null,
    model.relaxations.length > 0
      ? el('div', { testid: 'relaxations' }, [
        el('h3', { text: 'Changes that would give a plan' }),
        el('ul', { class: 'plain-list' }, model.relaxations.map((m) => el('li', {}, [
          el('button', {
            type: 'button',
            class: 'button',
            testid: m.testid,
            on: { click: () => on.relax?.(m.relaxation) },
            text: m.label,
          }),
        ]))),
      ])
      : null,
  ];
}
