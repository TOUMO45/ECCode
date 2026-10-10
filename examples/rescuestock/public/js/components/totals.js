// Section 5, "Total": per supplier subtotal, prep fee, tax and total, and the overall total, all formatted from the
// server's integer cents. Nothing is added up here. The notice "Test prices, not market prices" is always shown
// with prices (RS-34).

import { el } from '../dom.js';
import { EXACT, SECTION_TITLES } from '../texts.js';
import { formatUsd } from '../format.js';
import { currentPlan, supplierDirectory, supplierName } from '../view-helpers.js';
import { demoBadge } from './badges.js';
import { emptyNode } from './notice.js';

export function totalModel(view) {
  const plan = currentPlan(view);
  if (!plan) return { state: 'empty', text: 'There is no total yet: no plan has been found.' };
  const dir = supplierDirectory(view);
  return {
    state: 'ready',
    suppliers: plan.body.suppliers.map((s) => ({
      supplierCode: s.supplierCode,
      supplierName: supplierName(dir, s.supplierCode),
      demo: s.demo === true,
      subtotalText: formatUsd(s.subtotalCents),
      prepFeeText: formatUsd(s.prepFeeCents),
      taxText: formatUsd(s.taxCents),
      totalText: formatUsd(s.totalCents),
      testid: `total-${s.supplierCode}`,
    })),
    overall: { cents: plan.body.totalCents, text: formatUsd(plan.body.totalCents) },
    notice: EXACT.PRICE_NOTICE,
  };
}

export function renderTotal(model) {
  if (model.state === 'empty') return [emptyNode({ title: model.text, testid: 'total-empty' })];
  return [
    el('table', { class: 'data-table', testid: 'totals-table' }, [
      el('caption', { class: 'visually-hidden', text: SECTION_TITLES.total }),
      el('thead', {}, [el('tr', {}, ['Supplier', 'Subtotal', 'Prep fee', 'Tax', 'Total'].map((t) => el('th', { scope: 'col', text: t })))]),
      el('tbody', {}, model.suppliers.map((s) => el('tr', { testid: s.testid }, [
        el('th', { scope: 'row' }, [s.supplierName, s.demo ? ' ' : null, s.demo ? demoBadge() : null]),
        el('td', { text: s.subtotalText }),
        el('td', { text: s.prepFeeText }),
        el('td', { text: s.taxText }),
        el('td', { text: s.totalText }),
      ]))),
      el('tfoot', {}, [el('tr', {}, [
        el('th', { scope: 'row', colspan: '4', text: 'Overall total' }),
        el('td', { testid: 'total-overall', text: model.overall.text }),
      ])]),
    ]),
    el('p', { class: 'price-notice', testid: 'price-notice', text: model.notice }),
  ];
}
