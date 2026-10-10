// Read-only access to the server's database file, for the browser tests' database checks.
import { DatabaseSync } from 'node:sqlite';

export function openReadOnlyDb(path) {
  return new DatabaseSync(path, { readOnly: true });
}

// Tables that hold a purchase: a reservation (and its items), a supplier order, a payment operation, a provider
// call, a fake PayPal call, a plan version. RS-33: none of them has a row for an infeasible request.
export const PURCHASE_TABLES = Object.freeze([
  'reservations',
  'reservation_items',
  'supplier_orders',
  'payment_operations',
  'provider_calls',
  'fake_paypal_calls',
  'plan_versions',
  'plan_approvals',
]);

// { table: row count } for the purchase tables.
export function purchaseCounts(db) {
  const counts = {};
  for (const table of PURCHASE_TABLES) counts[table] = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
  return counts;
}
