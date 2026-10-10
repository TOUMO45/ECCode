// Small pure helpers shared by the request page components. They read a RequestView (the server's answer) and
// never compute a price, a total or a status.

import { EXACT } from './texts.js';
import { supplierLabel } from './format.js';

export function currentPlan(view) {
  if (!view || !Array.isArray(view.plans) || view.currentPlanId === null || view.currentPlanId === undefined) return null;
  return view.plans.find((p) => p.id === view.currentPlanId) ?? null;
}

// code -> { name, demo } from every place the view names a supplier.
export function supplierDirectory(view) {
  const dir = new Map();
  const add = (code, name, demo) => {
    if (typeof code !== 'string') return;
    const old = dir.get(code) ?? { name: null, demo: false };
    dir.set(code, { name: old.name ?? (typeof name === 'string' && name ? name : null), demo: old.demo || demo === true });
  };
  for (const plan of view?.plans ?? []) {
    for (const s of plan.body?.suppliers ?? []) add(s.supplierCode, s.supplierName, s.demo);
    for (const l of plan.body?.lines ?? []) add(l.supplierCode, null, l.demo);
  }
  for (const o of [...(view?.orders ?? []), ...(view?.cancellingOrders ?? [])]) add(o.supplier?.code, o.supplier?.name, o.supplier?.demo);
  return dir;
}

export function supplierName(dir, code) {
  return supplierLabel(code, dir.get(code)?.name ?? null);
}

// "A+B", "A×2+E": the supplier combination of a plan body, in the order the planner lists its lines.
export function bodyLabel(body) {
  const lines = Array.isArray(body?.lines) ? body.lines : [];
  const order = [...new Set(lines.map((l) => l.supplierCode))];
  return order.map((code) => {
    const bundles = lines.filter((l) => l.supplierCode === code).reduce((n, l) => n + l.bundles, 0);
    return bundles > 1 ? `${code}×${bundles}` : code;
  }).join('+');
}

export function isReservationExpired(view) {
  return view?.reservation?.status === 'expired' || view?.rescueStatus?.message === EXACT.RESERVATION_EXPIRED;
}

export function sortedOrders(orders) {
  return [...(orders ?? [])].sort((a, b) => (a.supplier.code < b.supplier.code ? -1 : a.supplier.code > b.supplier.code ? 1 : a.id - b.id));
}
