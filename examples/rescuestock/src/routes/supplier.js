// Supplier routes (spec: Interface Contracts > Supplier routes). Policy 'supplier' on every route: the access hook has
// already done Origin -> session -> role -> CSRF, and every query below is scoped to ctx.user.supplierId.
//   GET   /api/supplier/orders?status=       the supplier's own orders (SupplierOrder[])
//   POST  /api/supplier/orders/:id/confirm   {lines:[{offerId, committedBundles}], committedReadyAt} -> 200 {order}
//   POST  /api/supplier/orders/:id/refuse    {reason} -> 200 {order}; the void rule fires and a re-plan is queued
//   POST  /api/supplier/orders/:id/ready     {} -> 200 {order}; 409 HANDOVER_BLOCKED until the plan is executed
//   POST  /api/supplier/orders/:id/handover  {} -> 200 {order}
//   GET   /api/supplier/inventory            {items, labels}
//   PATCH /api/supplier/inventory            {items:[...]} -> 200 {items, superseded}; 403 for any foreign product (nothing changes)
// Another supplier's order id is 404 (checked before the body is read).
import { idParam, validateObject } from '../http/validate.js';
import {
  assertOwnedOrder, checkCommittedReadyAt, checkConfirmLines, checkInventoryPatch, checkRefusalReason, confirmSupplierOrder, listSupplierInventory,
  listSupplierOrders, markOrderReady, patchSupplierInventory, recordHandover, refuseSupplierOrder,
} from '../services/orders.js';

export function register(router) {
  router.add(
    'GET',
    '/api/supplier/orders',
    (ctx) => ({ status: 200, body: { orders: listSupplierOrders(ctx, ctx.user.supplierId, ctx.query.status ?? null) } }),
    { policy: 'supplier' },
  );

  router.add(
    'POST',
    '/api/supplier/orders/:id/confirm',
    async (ctx) => {
      const orderId = idParam(ctx.params.id);
      assertOwnedOrder(ctx.db, ctx.user.supplierId, orderId);
      const input = validateObject(await ctx.body(), { lines: checkConfirmLines, committedReadyAt: checkCommittedReadyAt });
      return { status: 200, body: { order: confirmSupplierOrder(ctx, ctx.user, orderId, input) } };
    },
    { policy: 'supplier' },
  );

  router.add(
    'POST',
    '/api/supplier/orders/:id/refuse',
    async (ctx) => {
      const orderId = idParam(ctx.params.id);
      assertOwnedOrder(ctx.db, ctx.user.supplierId, orderId);
      const input = validateObject(await ctx.body(), { reason: checkRefusalReason });
      return { status: 200, body: { order: refuseSupplierOrder(ctx, ctx.user, orderId, input.reason) } };
    },
    { policy: 'supplier' },
  );

  router.add(
    'POST',
    '/api/supplier/orders/:id/ready',
    async (ctx) => {
      const orderId = idParam(ctx.params.id);
      assertOwnedOrder(ctx.db, ctx.user.supplierId, orderId);
      await ctx.body();
      return { status: 200, body: { order: markOrderReady(ctx, ctx.user, orderId) } };
    },
    { policy: 'supplier' },
  );

  router.add(
    'POST',
    '/api/supplier/orders/:id/handover',
    async (ctx) => {
      const orderId = idParam(ctx.params.id);
      assertOwnedOrder(ctx.db, ctx.user.supplierId, orderId);
      await ctx.body();
      return { status: 200, body: { order: recordHandover(ctx, ctx.user, orderId) } };
    },
    { policy: 'supplier' },
  );

  router.add('GET', '/api/supplier/inventory', (ctx) => ({ status: 200, body: listSupplierInventory(ctx, ctx.user.supplierId) }), { policy: 'supplier' });

  router.add(
    'PATCH',
    '/api/supplier/inventory',
    async (ctx) => {
      const items = checkInventoryPatch(await ctx.body());
      return { status: 200, body: patchSupplierInventory(ctx, ctx.user, items) };
    },
    { policy: 'supplier' },
  );
}
