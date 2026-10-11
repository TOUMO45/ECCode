// Order routes (spec: Interface Contracts > Customer routes). Policy 'customer'; every order is looked up through the caller's
// own request, so another customer's order id is 404 (no existence leak) before the body is read.
//   POST /api/orders/:id/paypal/create  {} (any amount, currency or supplier field is ignored; the amount is supplier_orders.total_cents)
//     -> 200 {payment, approvalUrl, approvalIndex, approvalsNeeded}
//     404 | 409 MISSING_BUDGET, MISSING_DEADLINE, RESERVATION_EXPIRED, PLAN_SUPERSEDED, PLAN_NOT_EXECUTABLE, INVALID_STATE
//     | 502 PROVIDER_ERROR | 503 PROVIDER_UNAVAILABLE
//   POST /api/orders/:id/receipt        {} -> 200 {order}; allowed when the order is ready or collected, a repeat is 200 unchanged
//     404 | 409 INVALID_STATE
import { idParam } from '../http/validate.js';
import { findOwnedOrder, recordReceipt } from '../services/orders.js';
import { createPaymentForOrder } from '../services/payments.js';

export function register(router) {
  router.add(
    'POST',
    '/api/orders/:id/paypal/create',
    async (ctx) => {
      const orderId = idParam(ctx.params.id);
      findOwnedOrder(ctx.db, ctx.user.id, orderId); // 404 for a foreign order before the body is read
      await ctx.body();
      return { status: 200, body: await createPaymentForOrder(ctx, ctx.user, orderId) };
    },
    { policy: 'customer' },
  );

  router.add(
    'POST',
    '/api/orders/:id/receipt',
    async (ctx) => {
      const orderId = idParam(ctx.params.id);
      findOwnedOrder(ctx.db, ctx.user.id, orderId);
      await ctx.body();
      return { status: 200, body: { order: recordReceipt(ctx, ctx.user, orderId) } };
    },
    { policy: 'customer' },
  );
}
