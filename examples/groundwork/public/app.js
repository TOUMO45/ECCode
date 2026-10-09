// Entry point: tiny store, hash router, boot. Server responses are the source of truth.
import { api, setCsrfToken, setUnauthenticatedHandler } from './js/api.js';
import { h, clear, announce, announceError, clearLive, focusHeading } from './js/dom.js';
import { loginView } from './js/views/login.js';
import { incidentsView } from './js/views/incidents.js';
import { incidentView } from './js/views/incident.js';
import { postmortemsView, postmortemView } from './js/views/postmortems.js';

const listeners = new Set();
export const state = { user: null, csrfToken: null, route: '', status: '' };
export function subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); }
function setState(patch) { Object.assign(state, patch); listeners.forEach((fn) => fn(state)); }

const main = document.getElementById('main');
const nav = document.getElementById('nav');
const userbox = document.getElementById('userbox');
let cleanup = null;

export const app = {
  state,
  navigate(hash) { if (location.hash === hash) route(); else location.hash = hash; },
  home() { return state.user?.role === 'viewer' ? '#/postmortems' : '#/incidents'; },
  setSession(user, token) { setCsrfToken(token); setState({ user, csrfToken: token }); renderChrome(); },
};

function clearSession() {
  setCsrfToken(null);
  setState({ user: null, csrfToken: null });
  renderChrome();
}

function renderChrome() {
  clear(nav); clear(userbox);
  const u = state.user;
  nav.hidden = !u; userbox.hidden = !u;
  if (!u) return;
  const cur = location.hash;
  const link = (href, label, testid) => h('a', { href, testid, 'aria-current': cur.startsWith(href) ? 'page' : false }, label);
  if (u.role !== 'viewer') nav.append(link('#/incidents', 'Incidents', 'nav-incidents'));
  nav.append(link('#/postmortems', 'Postmortems', 'nav-postmortems'));
  userbox.append(
    h('span', { text: `${u.displayName} (${u.role})` }),
    h('button', { type: 'button', class: 'secondary', testid: 'signout', onclick: signOut }, 'Sign out'),
  );
}

async function signOut() {
  try { await api.logout(); } catch { /* session may already be gone; clear locally either way */ }
  clearSession();
  clearLive();
  app.navigate('#/login');
  announce('Signed out');
}

function parse(hash) {
  const parts = hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  return parts;
}

function route() {
  if (cleanup) { cleanup(); cleanup = null; }
  const parts = parse(location.hash);
  clearLive();
  clear(main);
  renderChrome();
  const u = state.user;
  const [a, b] = parts;
  const num = b && /^\d+$/.test(b) ? Number(b) : null;
  if (!u) {
    if (a !== 'login') { location.replace('#/login'); return; }
    cleanup = loginView(main, app) || null;
  } else if (a === 'login' || !a) {
    location.replace(app.home()); return;
  } else if (a === 'incidents' && u.role === 'viewer') {
    location.replace('#/postmortems'); return;
  } else if (a === 'incidents' && !b) cleanup = incidentsView(main, app);
  else if (a === 'incidents' && num) cleanup = incidentView(main, app, num);
  else if (a === 'postmortems' && !b) cleanup = postmortemsView(main, app);
  else if (a === 'postmortems' && num) cleanup = postmortemView(main, app, num);
  else notFound();
  document.title = 'Groundwork';
}

function notFound() {
  main.append(h('h1', { text: 'Not found' }), h('p', {}, 'This page does not exist. ', h('a', { href: app.home() }, 'Go to the start page')));
  focusHeading(main);
}

async function boot() {
  setUnauthenticatedHandler(() => {
    if (state.user) {
      clearSession();
      app.navigate('#/login');
      announceError('Your session has ended. Sign in again.');
    }
  });
  main.append(h('p', { 'aria-busy': 'true' }, 'Loading...'));
  try {
    const me = await api.me();
    app.setSession(me.user, me.csrfToken);
  } catch (e) {
    if (e.code !== 'UNAUTHENTICATED') {
      clear(main);
      main.append(h('h1', { text: 'Cannot load the application' }), h('div', { class: 'panel-error', role: 'alert' }, e.message),
        h('button', { type: 'button', onclick: () => location.reload() }, 'Retry'));
      return;
    }
  }
  window.addEventListener('hashchange', route);
  route();
}

boot();
