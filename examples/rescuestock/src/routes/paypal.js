// PayPal return and cancel routes (spec: Customer routes; Return handler and authorization). The buyer arrives here as a top-level
// GET from the approval page with the session cookie (SameSite=Lax) and no CSRF token, so both routes are policy 'public' and
// identify the user themselves (c1 routing contract).
//   GET /api/paypal/return?token=<providerOrderId>&PayerID=...   303 /#/requests/<requestId>?paypal=returned&order=<soId>
//   GET /api/paypal/cancel?token=<providerOrderId>               303 /#/requests/<requestId>?paypal=cancelled&order=<soId>
//     no session            -> 303 /#/signin?notice=paypal-return (no state change, no provider call)
//     supplier or admin     -> 403 FORBIDDEN
//     unknown token, or the token of another customer's order -> 404 NOT_FOUND, no provider call, no state change (RS-27)
//     missing or malformed token -> 400 BAD_REQUEST
//     more than 30 hits (return and cancel together) per user per window -> 429 RATE_LIMITED (SEC-E-2), before any provider call
// Only `token` is read; PayerID and every other query parameter are ignored and never stored.
import { AppError } from '../http/envelope.js';
import { handlePaypalCancel, handlePaypalReturn, takeReturnSlot } from '../services/payments.js';

const SIGN_IN = '/#/signin?notice=paypal-return';

function redirect(location) {
  return { status: 303, headers: { Location: location, 'Cache-Control': 'no-store' } };
}

function buyerRoute(handle) {
  return async (ctx) => {
    const user = ctx.auth.identify(ctx);
    if (!user) return redirect(SIGN_IN);
    if (user.role !== 'customer') throw new AppError(403, 'FORBIDDEN');
    takeReturnSlot(ctx, user.id); // SEC-E-2: 429 before any lookup or provider call
    const { location } = await handle(ctx, user, ctx.query.token);
    return redirect(location);
  };
}

export function register(router) {
  router.add('GET', '/api/paypal/return', buyerRoute(handlePaypalReturn), { policy: 'public' });
  router.add('GET', '/api/paypal/cancel', buyerRoute(handlePaypalCancel), { policy: 'public' });
}
