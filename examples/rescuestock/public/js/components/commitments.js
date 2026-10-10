// Section 6, "Supplier commitments": two labelled columns per supplier. "Catalog offer" is what the supplier
// advertised; "Supplier confirmed" is what the supplier committed to, or "Not yet confirmed". They are shown
// separately and never merged (RS-35).

import { el } from '../dom.js';
import { COLUMN_TITLES, EXACT } from '../texts.js';
import { formatLocalTime, fulfilmentText, pluralize } from '../format.js';
import { currentPlan, sortedOrders, supplierDirectory, supplierName } from '../view-helpers.js';
import { demoBadge, pill } from './badges.js';
import { emptyNode } from './notice.js';

function bundlesText(n) {
  return pluralize(n, 'bundle', 'bundles');
}

function confirmedColumn(order) {
  if (order.commitment) {
    return {
      state: 'confirmed',
      text: `${bundlesText(order.commitment.bundles)}, ready ${formatLocalTime(order.commitment.readyAt)}`,
      differs: order.commitment.bundles !== order.offer.bundles || order.commitment.readyAt !== order.offer.readyAt,
    };
  }
  if (order.fulfilmentStatus === 'refused') {
    return { state: 'refused', text: 'Refused by the supplier', reason: order.refusalReason ?? null, differs: false };
  }
  return { state: 'pending', text: EXACT.NOT_YET_CONFIRMED, differs: false };
}

export function commitmentsModel(view) {
  const plan = currentPlan(view);
  const dir = supplierDirectory(view);
  const orders = sortedOrders(view.orders);
  let rows;
  if (orders.length > 0) {
    rows = orders.map((o) => ({
      supplierCode: o.supplier.code,
      supplierName: supplierName(dir, o.supplier.code),
      demo: o.supplier.demo === true,
      catalog: { text: `${bundlesText(o.offer.bundles)}, ready ${formatLocalTime(o.offer.readyAt)}` },
      confirmed: confirmedColumn(o),
      fulfilmentText: fulfilmentText(o.fulfilmentStatus),
      testid: `commit-${o.supplier.code}`,
    }));
  } else if (plan) {
    rows = plan.body.suppliers.map((s) => {
      const bundles = plan.body.lines.filter((l) => l.supplierCode === s.supplierCode).reduce((n, l) => n + l.bundles, 0);
      return {
        supplierCode: s.supplierCode,
        supplierName: supplierName(dir, s.supplierCode),
        demo: s.demo === true,
        catalog: { text: `${bundlesText(bundles)}, ready ${formatLocalTime(s.catalogReadyAt)}` },
        confirmed: { state: 'pending', text: EXACT.NOT_YET_CONFIRMED, differs: false },
        fulfilmentText: null,
        testid: `commit-${s.supplierCode}`,
      };
    });
  } else {
    return { state: 'empty', text: 'No supplier has been asked yet: there is no plan.' };
  }
  return { state: 'ready', rows, columns: COLUMN_TITLES };
}

export function renderCommitments(model) {
  if (model.state === 'empty') return [emptyNode({ title: model.text, testid: 'commitments-empty' })];
  return [
    el('ul', { class: 'cards', testid: 'commitments' }, model.rows.map((r) => el('li', { class: 'card', testid: r.testid }, [
      el('h3', {}, [r.supplierName, r.demo ? ' ' : null, r.demo ? demoBadge() : null]),
      el('dl', { class: 'columns' }, [
        el('div', { class: 'column', testid: `${r.testid}-catalog` }, [
          el('dt', { text: model.columns.catalog }),
          el('dd', { text: r.catalog.text }),
        ]),
        el('div', { class: 'column', testid: `${r.testid}-confirmed` }, [
          el('dt', { text: model.columns.confirmed }),
          el('dd', {}, [
            pill(r.confirmed.text, r.confirmed.state === 'confirmed' ? 'ok' : (r.confirmed.state === 'refused' ? 'warn' : 'neutral')),
            r.confirmed.differs ? el('span', { class: 'muted', text: ' Differs from the catalog offer.' }) : null,
            r.confirmed.reason ? el('span', { dir: 'auto', class: 'muted', text: ` Reason: ${r.confirmed.reason}` }) : null,
          ]),
        ]),
      ]),
      r.fulfilmentText ? el('p', { class: 'muted', text: `Order status: ${r.fulfilmentText}` }) : null,
    ]))),
  ];
}
