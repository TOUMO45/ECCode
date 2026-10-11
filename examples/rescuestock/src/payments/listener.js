// The fake approval listener (spec: Interface Contracts > Fake approval listener, SEC-12, F-TR-14). Only with
// RS_PAYMENT_PROVIDER=fake; it refuses to start with paypal-sandbox.
//
// A SECOND node:http listener on RS_FAKE_APPROVAL_HOST (127.0.0.1 outside test mode) and RS_FAKE_APPROVAL_PORT. Exactly three routes:
//   GET  /fake-paypal/checkout/:fakeOrderId           HTML page "Simulated payment approval — not PayPal", amount and merchant label
//   POST /fake-paypal/checkout/:fakeOrderId/approve   CREATED -> APPROVED (CAS), then 303 to the stored return_url + ?token=&PayerID=FAKEPAYER
//   POST /fake-paypal/checkout/:fakeOrderId/cancel    no state change, 303 to the stored cancel_url + ?token=
// Anything else is 404 (405 with Allow for a wrong method on one of these paths). Redirects go only to the URLs stored at
// createOrder; nothing is taken from the query string. There are no cookies, so CSRF does not apply: the unguessable fake order
// id (FAKE- + 128 random bits) is the capability, as PayPal's token is.
//
// Headers: the app's security headers, except that the one Content-Security-Policy is approvalPageCsp(appOrigin)
// (http/headers.js; F-TR-14), never the app's own policy: Chromium enforces form-action across the redirect chain, and two
// policies would both apply. The Host check is the app's, for this listener's own host and port.
import { applyApprovalListenerHeaders, securityHeaders } from '../http/headers.js';
import { hostAllowed } from '../http/host.js';
import { closeServer, createHttpServer, listen } from '../http/server.js';
import { silentLogger } from '../log.js';
import { APPROVAL_PATH_PREFIX, FAKE_ORDER_ID, FAKE_PAYER_ID, approveFakeOrder, loadFakeOrder } from './fake.js';
import { toPayPalValue } from './provider.js';

export const PAGE_TITLE = 'Simulated payment approval — not PayPal';
const MAX_POST_BODY_BYTES = 4096;
const MAX_URL_LENGTH = 2048;
const ROUTE = /^\/fake-paypal\/checkout\/([^/]+)(?:\/(approve|cancel))?$/;
const LOOPBACK_HOSTS = Object.freeze(['127.0.0.1', 'localhost', '::1']);
const FALLBACK_CSP = "default-src 'none'; frame-ancestors 'none'; base-uri 'none'";

export class ListenerRefusedError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ListenerRefusedError';
    this.code = 'APPROVAL_LISTENER_REFUSED';
  }
}

const escapeHtml = (text) => String(text).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function page(title, body) {
  return `<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title></head>` +
    `<body><h1>${escapeHtml(title)}</h1>${body}</body></html>\n`;
}

function checkoutPage(order) {
  const open = order.status === 'CREATED' || order.status === 'APPROVED';
  const base = `${APPROVAL_PATH_PREFIX}${order.id}`;
  const forms = open
    ? `<form method="post" action="${base}/approve"><button type="submit">Approve (simulated)</button></form>` +
      `<form method="post" action="${base}/cancel"><button type="submit">Cancel</button></form>`
    : '<p>This simulated order can no longer be approved.</p>';
  return page(
    PAGE_TITLE,
    '<p>This is a local simulation of a payment approval page. No real payment is made and PayPal is not involved.</p>' +
      `<p>Merchant: ${escapeHtml(order.merchant_key)} (simulated)</p>` +
      `<p>Amount: ${escapeHtml(toPayPalValue(order.amount_cents))} ${escapeHtml(order.currency)}</p>` +
      `<p>Order status: ${escapeHtml(order.status)}</p>${forms}`,
  );
}

// Reads and discards a small request body; rejects when it is larger than the cap.
function drain(req, limit = MAX_POST_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        req.removeAllListeners('data');
        reject(Object.assign(new Error('body too large'), { code: 'BODY_TOO_LARGE' }));
      }
    });
    req.on('end', resolve);
    req.on('error', reject);
  });
}

// startApprovalListener({ db, clock, config, log, appOrigin })
//   appOrigin  the origin of the app (string, or a function evaluated per request because the app's port may be known only after
//              it listens): the origin of the stored return/cancel URLs, listed in the CSP form-action.
// Resolves with { server, host, port, origin, close }. `origin` is what the fake provider puts in approvalUrl.
export async function startApprovalListener({ db, clock: _clock, config, log = silentLogger(), appOrigin }) {
  if (!db || !config) throw new TypeError('startApprovalListener needs db and config');
  if (config.paymentProvider !== 'fake') {
    throw new ListenerRefusedError('The fake approval listener runs only with RS_PAYMENT_PROVIDER=fake.');
  }
  const host = config.fakeApprovalHost ?? '127.0.0.1';
  if (!LOOPBACK_HOSTS.includes(host) || (!config.testOffline && host !== '127.0.0.1')) {
    throw new ListenerRefusedError('The fake approval listener binds 127.0.0.1 only (loopback hosts only in test mode).');
  }
  if (appOrigin === undefined || appOrigin === null) throw new TypeError('startApprovalListener needs the app origin');
  const currentAppOrigin = () => String(typeof appOrigin === 'function' ? appOrigin() : appOrigin);

  function send(res, status, body, extra = {}) {
    res.statusCode = status;
    if (body === null) {
      for (const [name, value] of Object.entries(extra)) res.setHeader(name, value);
      res.end();
      return;
    }
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Content-Length', Buffer.byteLength(body));
    for (const [name, value] of Object.entries(extra)) res.setHeader(name, value);
    res.end(body);
  }
  const message = (res, status, text, extra) => send(res, status, page(PAGE_TITLE, `<p>${escapeHtml(text)}</p>`), extra);

  function redirect(res, target) {
    res.statusCode = 303;
    res.setHeader('Location', target);
    res.setHeader('Content-Length', '0');
    res.end();
  }

  // The stored URL plus the query the approval adds; null when the stored value is somehow unusable.
  function returnTarget(order, kind) {
    try {
      const url = new URL(kind === 'approve' ? order.return_url : order.cancel_url);
      url.searchParams.set('token', order.id);
      if (kind === 'approve') url.searchParams.set('PayerID', FAKE_PAYER_ID);
      return url.toString();
    } catch {
      return null;
    }
  }

  async function handle(req, res) {
    const started = process.hrtime.bigint();
    let routeName = 'unmatched';
    res.once('close', () => {
      log.info('fake_approval.request', {
        route: routeName, method: req.method, status: res.statusCode, durationMs: Number((process.hrtime.bigint() - started) / 1000n),
      });
    });
    try {
      applyApprovalListenerHeaders(res, currentAppOrigin());
    } catch {
      // An unusable app origin: still exactly one CSP header, the most restrictive one.
      for (const [name, value] of Object.entries(securityHeaders({ csp: FALLBACK_CSP }))) res.setHeader(name, value);
      res.setHeader('Cache-Control', 'no-store');
      log.error('fake_approval.origin_invalid', { code: 'APP_ORIGIN_INVALID' });
      return message(res, 500, 'The simulated approval page is misconfigured.');
    }
    res.setHeader('Cache-Control', 'no-store');

    const target = req.url;
    if (typeof target !== 'string' || target.length === 0 || target.length > MAX_URL_LENGTH || !target.startsWith('/') || target.startsWith('//')) {
      return message(res, 400, 'Bad request.');
    }
    if (!hostAllowed(req.headers.host, {
      publicUrl: null,
      configuredPort: server.address()?.port,
      localPort: req.socket?.localPort,
      extraHosts: host === '::1' ? [`[::1]:${server.address()?.port}`] : [],
    })) {
      return message(res, 421, 'This host is not served here.');
    }

    let pathname;
    try {
      pathname = new URL(target, 'http://placeholder.invalid').pathname;
    } catch {
      return message(res, 400, 'Bad request.');
    }
    const match = ROUTE.exec(pathname);
    if (!match || !FAKE_ORDER_ID.test(match[1])) return message(res, 404, 'Not found.');
    const [, id, action] = match;
    const allowed = action ? 'POST' : 'GET';
    if (req.method !== allowed) return message(res, 405, 'This method is not allowed here.', { Allow: allowed });

    if (!action) {
      routeName = 'checkout.page';
      const order = loadFakeOrder(db, id);
      return order ? send(res, 200, checkoutPage(order)) : message(res, 404, 'Unknown simulated order.');
    }

    routeName = `checkout.${action}`;
    try {
      await drain(req);
    } catch (err) {
      if (err && err.code === 'BODY_TOO_LARGE') {
        res.setHeader('Connection', 'close');
        message(res, 413, 'The request body is too large.');
        return req.destroy();
      }
      return res.destroy();
    }

    if (action === 'cancel') {
      const order = loadFakeOrder(db, id);
      if (!order) return message(res, 404, 'Unknown simulated order.');
      const url = returnTarget(order, 'cancel');
      return url ? redirect(res, url) : message(res, 500, 'The simulated order has no usable cancel address.');
    }

    const { result, order } = approveFakeOrder(db, id);
    if (result === 'not_found') return message(res, 404, 'Unknown simulated order.');
    if (result === 'approved' || result === 'already_approved') {
      const url = returnTarget(order, 'approve');
      return url ? redirect(res, url) : message(res, 500, 'The simulated order has no usable return address.');
    }
    return message(res, 409, 'This simulated order cannot be approved.');
  }

  const server = createHttpServer(async (req, res) => {
    try {
      await handle(req, res);
    } catch (err) {
      log.error('fake_approval.error', { code: 'INTERNAL', kind: err?.name });
      if (!res.headersSent) message(res, 500, 'Something went wrong.');
      else res.destroy();
    }
  });
  const port = await listen(server, config.fakeApprovalPort ?? 0, host);
  const shownHost = host.includes(':') ? `[${host}]` : host;
  log.info('fake_approval.listening', { port });
  return {
    server,
    host,
    port,
    origin: `http://${shownHost}:${port}`,
    close: () => closeServer(server),
  };
}
