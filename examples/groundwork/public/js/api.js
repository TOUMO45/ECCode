// Fetch wrapper: same-origin credentials, CSRF header on non-GET, envelope parsing.
export class ApiError extends Error {
  constructor(status, error, fallbackMessage) {
    super(error?.message || fallbackMessage || 'Request failed');
    this.status = status;
    this.code = error?.code || 'NETWORK';
    this.details = error?.details || {};
    this.requestId = error?.requestId || null;
    this.retryAfter = null;
  }
}

let csrfToken = null;
let onUnauthenticated = () => {};
export function setCsrfToken(t) { csrfToken = t; }
export function setUnauthenticatedHandler(fn) { onUnauthenticated = fn; }

export async function request(method, path, { body, query, signal } = {}) {
  const headers = { Accept: 'application/json' };
  let url = path;
  if (query) url += `?${new URLSearchParams(query)}`;
  const init = { method, credentials: 'same-origin', headers, signal };
  if (method !== 'GET' && method !== 'HEAD') {
    if (csrfToken) headers['X-CSRF-Token'] = csrfToken;
    if (body !== undefined) { headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(body); }
  }
  let res;
  try { res = await fetch(url, init); } catch (e) {
    if (e?.name === 'AbortError') throw e;
    throw new ApiError(0, null, 'Cannot reach the server. Check your connection and try again.');
  }
  let json = null;
  try { json = await res.json(); } catch { json = null; }
  if (!res.ok) {
    const err = new ApiError(res.status, json?.error, 'Unexpected response from the server.');
    err.retryAfter = Number(res.headers.get('Retry-After')) || err.details.retryAfterSeconds || null;
    if (res.status === 401 && err.code === 'UNAUTHENTICATED') onUnauthenticated();
    throw err;
  }
  if (json === null) throw new ApiError(res.status, null, 'Unexpected response from the server.');
  return json;
}

export const api = {
  csrf: () => request('GET', '/api/csrf'),
  me: () => request('GET', '/api/me'),
  login: (username, password) => request('POST', '/api/auth/login', { body: { username, password } }),
  logout: () => request('POST', '/api/auth/logout', { body: {} }),
  providers: () => request('GET', '/api/providers'),
  incidents: () => request('GET', '/api/incidents'),
  incident: (id) => request('GET', `/api/incidents/${id}`),
  createIncident: (body) => request('POST', '/api/incidents', { body }),
  notes: (id) => request('GET', `/api/incidents/${id}/notes`),
  putNotes: (id, content) => request('PUT', `/api/incidents/${id}/notes`, { body: { format: 'text', content } }),
  generate: (id, provider) => request('POST', `/api/incidents/${id}/draft`, { body: { provider } }),
  draft: (id) => request('GET', `/api/incidents/${id}/draft`),
  editStatement: (draftId, sid, body) => request('PATCH', `/api/drafts/${draftId}/statements/${sid}`, { body }),
  removeStatement: (draftId, sid, expectedVersion) =>
    request('DELETE', `/api/drafts/${draftId}/statements/${sid}`, { query: { expectedVersion } }),
  publish: (draftId, expectedVersion) => request('POST', `/api/drafts/${draftId}/publish`, { body: { expectedVersion } }),
  postmortems: () => request('GET', '/api/postmortems'),
  postmortem: (draftId) => request('GET', `/api/postmortems/${draftId}`),
};

/** Human-readable text for an error, with what to do next. */
export function describeError(e) {
  if (e.code === 'RATE_LIMITED') return `Too many attempts, try again in ${e.retryAfter ?? 'a few'} s.`;
  if (e.code === 'FORBIDDEN') return 'Your role does not allow this action. Ask a team lead if you need access.';
  if (e.code === 'CSRF_FAILED') return 'Your session security token expired. Reload the page and try again.';
  if (e.code === 'INTERNAL') return `Something went wrong on the server. Try again; if it persists, report request id ${e.requestId ?? 'unknown'}.`;
  if (e.code === 'NETWORK') return e.message;
  return e.message;
}
