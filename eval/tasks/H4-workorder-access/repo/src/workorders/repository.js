'use strict';
// Data access for work orders. DECIMAL columns become integer cents here.
const money = require('../../vendor/acme-kit/money');

function getWorkOrder(db, id) {
  const r = db.get('work_orders', id);
  if (!r) return null;
  const site = db.get('sites', r.site_id);
  return { id: r.id, siteId: r.site_id, site: site ? site.name : null, title: r.title, status: r.status, priority: r.priority, openedAt: r.opened_at };
}

function costLines(db, workOrderId) {
  return db.all('work_order_costs', { work_order_id: Number(workOrderId) }).map((c) => ({ description: c.description, amountCents: money.fromDecimal(c.amount) }));
}

module.exports = { getWorkOrder, costLines };
