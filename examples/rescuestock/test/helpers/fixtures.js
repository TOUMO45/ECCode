// Shared test data: the RS-FIX-1 loader, the demo users, and a cookie-keeping
// client with the sign-in flow of the spec (Authentication, ARCH-25).
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const FIXTURE_DIR = resolve(HERE, '..', 'fixtures');

// A fresh deep copy on every call, so a test may change it freely.
export function loadRsFix1() {
  return JSON.parse(readFileSync(resolve(FIXTURE_DIR, 'rs-fix-1.json'), 'utf8'));
}

// The seven demo accounts (`npm run seed`): one supplier user per supplier and two customers.
export const SUPPLIER_USERS = Object.freeze(['A', 'B', 'C', 'D', 'E'].map((k) => ({ username: `supplier-${k.toLowerCase()}`, role: 'supplier', supplierCode: k })));
export const CUSTOMER_USERS = Object.freeze(['cafe1', 'cafe2'].map((username) => ({ username, role: 'customer' })));
export const DEMO_USERS = Object.freeze([...CUSTOMER_USERS, ...SUPPLIER_USERS]);

let uniqueCounter = 0;
// A username that is valid under POST /api/auth/register (3-40 of [A-Za-z0-9_.-]) and unique within the process.
export function uniqueUsername(prefix = 'tester') {
  uniqueCounter += 1;
  return `${prefix}-${process.pid}-${uniqueCounter}`.slice(0, 40);
}

function parseSetCookie(headers) {
  const raw = headers['set-cookie'];
  const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
  return list.map((line) => {
    const [pair, ...attrs] = line.split(';').map((s) => s.trim());
    const eq = pair.indexOf('=');
    const maxAge = attrs.map((a) => /^max-age=(-?\d+)$/i.exec(a)).find(Boolean);
    return { name: pair.slice(0, eq), value: pair.slice(eq + 1), expired: maxAge ? Number(maxAge[1]) <= 0 : false };
  });
}

// createClient(request): `request` is harness.request or server.request. The client
// keeps the session cookie and the CSRF token for the signed-in user.
export function createClient(request) {
  const cookies = new Map();
  const state = { csrfToken: null, user: null };

  function absorb(response) {
    for (const cookie of parseSetCookie(response.headers)) {
      if (cookie.expired || cookie.value === '') cookies.delete(cookie.name);
      else cookies.set(cookie.name, cookie.value);
    }
    if (response.json && typeof response.json.csrfToken === 'string') state.csrfToken = response.json.csrfToken;
    return response;
  }

  async function send({ method = 'GET', path, headers = {}, jsonBody, body, host } = {}) {
    const h = { ...headers };
    if (cookies.size > 0) h.Cookie = [...cookies].map(([k, v]) => `${k}=${v}`).join('; ');
    if (method !== 'GET' && method !== 'HEAD' && state.csrfToken && h['X-CSRF-Token'] === undefined) h['X-CSRF-Token'] = state.csrfToken;
    const response = await request({ method, path, headers: h, jsonBody, body, host });
    return absorb(response);
  }

  async function signIn(username, password) {
    await send({ path: '/api/auth/csrf' });
    const response = await send({ method: 'POST', path: '/api/auth/signin', jsonBody: { username, password } });
    if (response.status !== 200) {
      throw new Error(`sign-in as ${username} failed with ${response.status}${response.json?.error ? ` ${response.json.error.code}` : ''}`);
    }
    state.user = response.json.user;
    return response;
  }

  async function register({ username = uniqueUsername(), password, displayName = 'Test Customer' }) {
    await send({ path: '/api/auth/csrf' });
    const response = await send({ method: 'POST', path: '/api/auth/register', jsonBody: { username, password, displayName } });
    if (response.status !== 201) {
      throw new Error(`register ${username} failed with ${response.status}${response.json?.error ? ` ${response.json.error.code}` : ''}`);
    }
    state.user = response.json.user;
    return response;
  }

  async function signOut() {
    const response = await send({ method: 'POST', path: '/api/auth/signout', jsonBody: {} });
    state.user = null;
    state.csrfToken = null;
    return response;
  }

  return {
    send,
    get: (path, extra = {}) => send({ ...extra, method: 'GET', path }),
    post: (path, jsonBody = {}, extra = {}) => send({ ...extra, method: 'POST', path, jsonBody }),
    signIn,
    register,
    signOut,
    cookies: () => Object.fromEntries(cookies),
    get csrfToken() {
      return state.csrfToken;
    },
    get user() {
      return state.user;
    },
  };
}
