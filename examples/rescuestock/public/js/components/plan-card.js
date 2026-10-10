// Section 3, "Why this plan": the plan lines and the decision trace. The trace sentences are built from the
// planner's own comparisons (rank, decidedBy, best, alternative), so every number and supplier code comes from the
// server's trace. Offers the planner skipped for capacity or cup diameter (SPEC_MISMATCH) are listed here, in the
// trace, and not under "What was rejected" (FU-3 default).

import { el } from '../dom.js';
import { SECTION_TITLES } from '../texts.js';
import { formatLocalTime, formatUsd, isCents, planStatusText, pluralize, supplierLabel } from '../format.js';
import { bodyLabel, currentPlan, supplierDirectory, supplierName } from '../view-helpers.js';
import { demoBadge } from './badges.js';
import { emptyNode } from './notice.js';

export const SPEC_MISMATCH_TEXT = 'Not a match for your cups (capacity or size)';

function money(value) {
  return isCents(value) ? formatUsd(value) : String(value);
}

function comparisonValue(decidedBy, value) {
  switch (decidedBy) {
    case 'total': return money(value);
    case 'pickups': return pluralize(value, 'pickup', 'pickups');
    case 'readyAt': return `ready by ${formatLocalTime(value)}`;
    default: return String(value);
  }
}

// "A+B beats A+E: total $84.00 < $95.00"
export function comparisonText(comparison, best, alternative) {
  const head = `${bodyLabel(best) || 'The best plan'} beats ${alternative ? bodyLabel(alternative) : `alternative ${comparison.rank}`}`;
  if (comparison.decidedBy === 'supplierCodes') {
    return `${head}: tie broken by supplier order (${comparison.best} before ${comparison.alternative})`;
  }
  const label = comparison.decidedBy === 'total' ? 'total ' : '';
  return `${head}: ${label}${comparisonValue(comparison.decidedBy, comparison.best)} < ${comparisonValue(comparison.decidedBy, comparison.alternative)}`;
}

export function whyModel(view) {
  const plan = currentPlan(view);
  if (!plan) {
    const infeasible = view.planning?.feasible === false;
    return {
      state: 'empty',
      text: infeasible ? 'No plan satisfies your constraints, so there is no plan to explain.' : 'There is no plan yet.',
    };
  }
  const dir = supplierDirectory(view);
  const trace = plan.trace ?? { candidates: [], comparisons: [] };
  const best = (plan.explanation?.lines ?? []).find((l) => l.code === 'PLAN_BEST');
  return {
    state: 'ready',
    planId: plan.id,
    version: plan.version,
    statusText: planStatusText(plan.status),
    title: `Plan v${plan.version} — ${bodyLabel(plan.body) || 'no lines'}`,
    summary: best ? best.text : null,
    lines: plan.body.lines.map((l) => ({
      supplierCode: l.supplierCode,
      supplierName: supplierName(dir, l.supplierCode),
      productName: l.productName,
      bundles: l.bundles,
      cups: l.cups,
      lids: l.lids,
      unitPriceText: formatUsd(l.unitPriceCents),
      demo: l.demo === true,
    })),
    comparisons: (trace.comparisons ?? []).map((c) => ({
      rank: c.rank,
      decidedBy: c.decidedBy,
      text: comparisonText(c, plan.body, plan.alternatives?.[c.rank - 1] ?? null),
      testid: `trace-comparison-${c.rank}`,
    })),
    skipped: (trace.candidates ?? [])
      .filter((c) => c.skipped === 'SPEC_MISMATCH')
      .map((c) => ({ supplierCode: c.supplierCode, text: `${supplierLabel(c.supplierCode)}: ${SPEC_MISMATCH_TEXT}`, testid: `trace-skipped-${c.supplierCode}` })),
    alternatives: (plan.alternatives ?? []).map((a, i) => ({
      rank: i + 1,
      label: bodyLabel(a),
      totalText: money(a.totalCents),
      pickupsText: pluralize(a.pickupCount, 'pickup', 'pickups'),
      readyText: formatLocalTime(a.readyAt),
    })),
  };
}

export function renderWhy(model) {
  if (model.state === 'empty') return [emptyNode({ title: model.text, testid: 'why-empty' })];
  return [
    el('h3', { text: model.title }),
    el('p', { testid: 'plan-status', text: `Plan status: ${model.statusText}` }),
    model.summary ? el('p', { testid: 'plan-summary', text: model.summary }) : null,
    el('table', { class: 'data-table', testid: 'plan-lines' }, [
      el('caption', { class: 'visually-hidden', text: SECTION_TITLES.why }),
      el('thead', {}, [el('tr', {}, ['Supplier', 'Product', 'Bundles', 'Cups', 'Lids', 'Price per bundle'].map((t) => el('th', { scope: 'col', text: t })))]),
      el('tbody', {}, model.lines.map((l) => el('tr', { testid: `plan-line-${l.supplierCode}` }, [
        el('th', { scope: 'row' }, [l.supplierName, l.demo ? ' ' : null, l.demo ? demoBadge() : null]),
        el('td', { dir: 'auto', text: l.productName }),
        el('td', { text: String(l.bundles) }),
        el('td', { text: String(l.cups) }),
        el('td', { text: String(l.lids) }),
        el('td', { text: l.unitPriceText }),
      ]))),
    ]),
    model.comparisons.length > 0
      ? el('div', { testid: 'trace' }, [
        el('h3', { text: 'How it was chosen' }),
        el('ol', {}, model.comparisons.map((c) => el('li', { testid: c.testid, data: { decided: c.decidedBy }, text: c.text }))),
      ])
      : null,
    model.alternatives.length > 0
      ? el('div', { testid: 'alternatives' }, [
        el('h3', { text: 'Other plans considered' }),
        el('ul', {}, model.alternatives.map((a) => el('li', {
          testid: `alternative-${a.rank}`,
          text: `${a.label}: ${a.totalText}, ${a.pickupsText}, ready by ${a.readyText}`,
        }))),
      ])
      : null,
    model.skipped.length > 0
      ? el('div', { testid: 'trace-skipped' }, [
        el('h3', { text: 'Offers that were not considered' }),
        el('ul', {}, model.skipped.map((s) => el('li', { testid: s.testid, text: s.text }))),
      ])
      : null,
  ];
}
