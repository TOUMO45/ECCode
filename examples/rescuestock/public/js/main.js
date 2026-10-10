// Entry point: loads the labels and the session, draws the banner and the navigation, and mounts the view for the
// current hash route. On every route change the previous view is disposed, the new <h1> takes focus and the page
// title is announced in #announcer.

import { api } from './api.js';
import { createStore } from './store.js';
import { el, replaceContent } from './dom.js';
import { HOME_BY_ROLE, navLinks, parseRoute, resolveRoute, roleOf } from './router.js';
import { bannerModel, renderBanner } from './components/banner.js';
import { errorNode, loadingNode, emptyNode } from './components/notice.js';
import { describeError } from './errors.js';
import { mountSignIn } from './views/signin.js';
import { mountRegister } from './views/register.js';
import { mountRequestsList } from './views/requests-list.js';
import { mountRequestNew } from './views/request-new.js';
import { mountRequestDetail } from './views/request-detail.js';
import { mountSupplierOrders } from './views/supplier-orders.js';
import { mountSupplierInventory } from './views/supplier-inventory.js';
import { mountAdmin } from './views/admin.js';

const MOUNTS = Object.freeze({
  signin: mountSignIn,
  register: mountRegister,
  requests: mountRequestsList,
  'request-new': mountRequestNew,
  request: mountRequestDetail,
  'supplier-orders': mountSupplierOrders,
  'supplier-inventory': mountSupplierInventory,
  admin: mountAdmin,
});

const store = createStore();
const container = document.getElementById('app');
const bannerEl = document.getElementById('banner');
const announcerEl = document.getElementById('announcer');
const navLinksEl = document.getElementById('nav-links');
const sessionEl = document.getElementById('session-info');
let current = null;

function announce(text) {
  // Clearing first makes a screen reader read the same sentence again.
  announcerEl.textContent = '';
  globalThis.setTimeout(() => {
    announcerEl.textContent = text;
  }, 30);
}

function safeStorage() {
  try {
    return globalThis.sessionStorage;
  } catch {
    return null;
  }
}

function navigate(hash) {
  if (globalThis.location.hash === hash) route();
  else globalThis.location.hash = hash;
}

function drawNav() {
  const user = store.session;
  const active = globalThis.location.hash.split('?')[0];
  replaceContent(navLinksEl, navLinks(user).map((l) => el('li', {}, [
    el('a', { href: l.href, 'aria-current': l.href === active ? 'page' : null, text: l.label }),
  ])));
  replaceContent(sessionEl, user
    ? [el('span', { testid: 'session-user', text: `${user.displayName} (${user.role})` }), el('button', { type: 'button', class: 'button', testid: 'signout', on: { click: signOut }, text: 'Sign out' })]
    : []);
}

async function signOut() {
  try {
    await api.signOut();
  } catch {
    // The session may already be gone; the screen goes back to sign-in either way.
  }
  api.clearSession();
  store.setSession(null);
  store.clearViews();
  drawNav();
  announce('You are signed out.');
  navigate('#/signin');
}

function onSignedIn(user) {
  store.setSession(user);
  drawNav();
  announce(`Signed in as ${user.displayName}.`);
  navigate(HOME_BY_ROLE[roleOf(user)]);
}

api.setUnauthenticatedHandler(() => {
  if (store.session === null) return;
  api.clearSession();
  store.setSession(null);
  drawNav();
  announce('Your session has ended. Sign in again.');
  navigate('#/signin');
});

const ctx = {
  api,
  store,
  container,
  announce,
  navigate,
  onSignedIn,
  storage: safeStorage(),
  document: globalThis.document,
  assignLocation: (url) => globalThis.location.assign(url),
  confirm: (message) => globalThis.confirm(message),
  get config() {
    return store.config;
  },
};

function route() {
  const parsed = parseRoute(globalThis.location.hash);
  if (parsed.name === 'none') {
    if (globalThis.location.hash === '' || globalThis.location.hash === '#') {
      globalThis.location.replace(HOME_BY_ROLE[roleOf(store.session)]);
    }
    return; // some other fragment (for example the skip link): leave the page as it is
  }
  const decision = resolveRoute(parsed, store.session);
  if (decision.redirect) {
    globalThis.location.replace(decision.redirect);
    return;
  }
  if (current) current.dispose();
  current = null;
  drawNav();
  if (parsed.name === 'not-found') {
    replaceContent(container, [
      el('h1', { id: 'page-title', tabindex: '-1', text: 'Page not found' }),
      emptyNode({ title: 'There is no such page.', action: { href: HOME_BY_ROLE[roleOf(store.session)], label: 'Go to your start page' } }),
    ]);
  } else {
    current = MOUNTS[parsed.name](ctx, parsed);
  }
  globalThis.document.title = `${parsed.title} — RescueStock`;
  const heading = container.querySelector('h1');
  heading?.focus();
  announce(parsed.title);
}

async function boot() {
  replaceContent(container, [loadingNode()]);
  try {
    store.setConfig(await api.getConfig());
    renderBanner(bannerEl, bannerModel(store.config));
  } catch {
    renderBanner(bannerEl, bannerModel(null, { configFailed: true }));
  }
  try {
    const answer = await api.getSession();
    api.setCsrfToken(answer.csrfToken);
    store.setSession(answer.user);
  } catch (err) {
    replaceContent(container, [
      el('h1', { id: 'page-title', tabindex: '-1', text: 'RescueStock' }),
      errorNode(err, { onRetry: boot }),
    ]);
    announce(describeError(err).message);
    return;
  }
  route();
}

globalThis.addEventListener('hashchange', route);
document.querySelector('.skip-link')?.addEventListener('click', (event) => {
  event.preventDefault();
  container.focus();
});
boot();
