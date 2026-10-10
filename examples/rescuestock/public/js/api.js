// The only module that talks to the network. It adds X-CSRF-Token to every non-GET call, parses the error
// envelope {"error":{code,message,requestId,details?}} into an ApiError, and aborts a call after 15 s.
// The CSRF token lives in memory only. The API base comes from <meta name="rs-api-base"> (default "/api").

export const API_TIMEOUT_MS = 15000;
export const DEFAULT_API_BASE = '/api';
export const TIMEOUT_MESSAGE = 'The server is taking too long.';

export class ApiError extends Error {
  // kind: 'http' (the server answered with an error envelope), 'timeout', 'network' or 'protocol'.
  constructor({ kind, status = 0, code, message, requestId = null, details = null }) {
    super(message);
    this.name = 'ApiError';
    this.kind = kind;
    this.status = status;
    this.code = code;
    this.requestId = requestId;
    this.details = details;
  }
}

function readBaseFromPage() {
  const meta = globalThis.document?.querySelector?.('meta[name="rs-api-base"]');
  const content = meta?.getAttribute?.('content');
  return content && content.length > 0 ? content : DEFAULT_API_BASE;
}

/**
 * createApi({ fetchImpl, base, timeoutMs, onUnauthenticated })
 * Every request returns the parsed JSON body of a 2xx answer, or throws ApiError.
 */
export function createApi({ fetchImpl, base, timeoutMs = API_TIMEOUT_MS, onUnauthenticated = null } = {}) {
  const apiBase = base ?? readBaseFromPage();
  const doFetch = (...args) => (fetchImpl ?? globalThis.fetch)(...args);
  let csrfToken = null;

  async function send(method, path, { body, headers = {} } = {}) {
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    const init = {
      method,
      credentials: 'same-origin',
      headers: { Accept: 'application/json', ...headers },
      signal: controller.signal,
    };
    if (method !== 'GET' && method !== 'HEAD' && csrfToken) init.headers['X-CSRF-Token'] = csrfToken;
    if (body !== undefined) {
      init.headers['Content-Type'] = 'application/json; charset=utf-8';
      init.body = JSON.stringify(body);
    }
    let response;
    let text;
    try {
      response = await doFetch(`${apiBase}${path}`, init);
      text = await response.text();
    } catch (cause) {
      if (timedOut) {
        throw new ApiError({ kind: 'timeout', code: 'CLIENT_TIMEOUT', message: TIMEOUT_MESSAGE });
      }
      throw new ApiError({
        kind: 'network',
        code: 'NETWORK_ERROR',
        message: `The server could not be reached. ${cause?.name === 'AbortError' ? 'The request was cancelled.' : ''}`.trim(),
      });
    } finally {
      clearTimeout(timer);
    }

    let json = null;
    if (text.length > 0) {
      try {
        json = JSON.parse(text);
      } catch {
        json = null;
      }
    }
    if (response.ok) {
      if (json === null || typeof json !== 'object') {
        throw new ApiError({ kind: 'protocol', status: response.status, code: 'BAD_RESPONSE', message: 'The server sent an unreadable answer.' });
      }
      return json;
    }
    const envelope = json?.error;
    const err = envelope && typeof envelope.code === 'string'
      ? new ApiError({
        kind: 'http',
        status: response.status,
        code: envelope.code,
        message: typeof envelope.message === 'string' ? envelope.message : 'The request failed.',
        requestId: typeof envelope.requestId === 'string' ? envelope.requestId : null,
        details: envelope.details && typeof envelope.details === 'object' ? envelope.details : null,
      })
      : new ApiError({
        kind: 'protocol',
        status: response.status,
        code: 'BAD_RESPONSE',
        message: 'The server sent an unexpected answer.',
        requestId: response.headers?.get?.('X-Request-Id') ?? null,
      });
    if (err.code === 'UNAUTHENTICATED' && onUnauthenticated) onUnauthenticated(err);
    throw err;
  }

  // A non-GET call needs a token. Before sign-in the pre-login token comes from GET /auth/csrf.
  async function ensureCsrf() {
    if (csrfToken) return csrfToken;
    const answer = await send('GET', '/auth/csrf');
    csrfToken = typeof answer.csrfToken === 'string' ? answer.csrfToken : null;
    return csrfToken;
  }

  // A stale token (CSRF_FAILED) is replaced once, then the same call is repeated. The server refuses a bad token
  // before it does anything, so the repeat cannot double an effect.
  async function refreshCsrf() {
    const answer = await send('GET', '/auth/session');
    csrfToken = typeof answer.csrfToken === 'string' ? answer.csrfToken : null;
    await ensureCsrf();
  }

  async function mutate(method, path, body, headers) {
    await ensureCsrf();
    try {
      return await send(method, path, { body, headers });
    } catch (err) {
      if (!(err instanceof ApiError) || err.code !== 'CSRF_FAILED') throw err;
      await refreshCsrf();
      return send(method, path, { body, headers });
    }
  }

  const id = (value) => encodeURIComponent(String(value));

  return {
    setCsrfToken(token) {
      csrfToken = typeof token === 'string' && token.length > 0 ? token : null;
    },
    getCsrfToken: () => csrfToken,
    clearSession() {
      csrfToken = null;
    },

    // public and auth
    getConfig: () => send('GET', '/config'),
    getSession: () => send('GET', '/auth/session'),
    signIn: (username, password) => mutate('POST', '/auth/signin', { username, password }),
    register: (username, password, displayName) => mutate('POST', '/auth/register', { username, password, displayName }),
    signOut: () => mutate('POST', '/auth/signout', {}),

    // customer
    listRequests: () => send('GET', '/requests'),
    createRequest: (text) => mutate('POST', '/requests', { text }),
    getRequest: (requestId) => send('GET', `/requests/${id(requestId)}`),
    deleteRequest: (requestId) => mutate('DELETE', `/requests/${id(requestId)}`),
    extractRequest: (requestId) => mutate('POST', `/requests/${id(requestId)}/extract`, {}),
    confirmRequest: (requestId, fields) => mutate('POST', `/requests/${id(requestId)}/confirm`, { fields }),
    planRequest: (requestId) => mutate('POST', `/requests/${id(requestId)}/plan`, {}),
    approvePlan: (planId, expectedTotalCents, planHash) => mutate('POST', `/plans/${id(planId)}/approve`, { expectedTotalCents, planHash }),
    reservePlan: (planId, idempotencyKey) => mutate('POST', `/plans/${id(planId)}/reserve`, {}, { 'Idempotency-Key': idempotencyKey }),
    createPayPalOrder: (orderId) => mutate('POST', `/orders/${id(orderId)}/paypal/create`, {}),
    executePlan: (planId) => mutate('POST', `/plans/${id(planId)}/execute`, {}),
    abandonPlan: (planId) => mutate('POST', `/plans/${id(planId)}/abandon`, {}),
    recordReceipt: (orderId) => mutate('POST', `/orders/${id(orderId)}/receipt`, {}),

    // supplier
    listSupplierOrders: (status) => send('GET', `/supplier/orders${status ? `?status=${encodeURIComponent(status)}` : ''}`),
    confirmSupplierOrder: (orderId, body) => mutate('POST', `/supplier/orders/${id(orderId)}/confirm`, body),
    refuseSupplierOrder: (orderId, reason) => mutate('POST', `/supplier/orders/${id(orderId)}/refuse`, { reason }),
    markSupplierOrderReady: (orderId) => mutate('POST', `/supplier/orders/${id(orderId)}/ready`, {}),
    recordHandover: (orderId) => mutate('POST', `/supplier/orders/${id(orderId)}/handover`, {}),
    getSupplierInventory: () => send('GET', '/supplier/inventory'),
    patchSupplierInventory: (items) => mutate('PATCH', '/supplier/inventory', { items }),

    // admin
    resetDemo: (body) => mutate('POST', '/admin/reset', body),
    applyFault: (body) => mutate('POST', '/admin/faults', body),
    getTimeline: ({ requestId, afterId, limit } = {}) => {
      const q = new URLSearchParams();
      if (requestId !== undefined && requestId !== null && requestId !== '') q.set('requestId', String(requestId));
      if (afterId !== undefined && afterId !== null && afterId !== '') q.set('afterId', String(afterId));
      if (limit) q.set('limit', String(limit));
      const qs = q.toString();
      return send('GET', `/admin/timeline${qs ? `?${qs}` : ''}`);
    },
    getMetrics: () => send('GET', '/admin/metrics'),
  };
}

// The shared instance used by the app.
export const api = createApi();
