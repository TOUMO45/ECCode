// Hash routes and the role check that decides which screen a visitor may open. Pure: no DOM.
// The server stays authoritative for access; this only picks the right screen and the right redirect.

export const ROUTE_TABLE = Object.freeze([
  { name: 'signin', pattern: /^\/signin$/, role: 'anonymous', title: 'Sign in' },
  { name: 'register', pattern: /^\/register$/, role: 'anonymous', title: 'Create an account' },
  { name: 'requests', pattern: /^\/requests$/, role: 'customer', title: 'Your rescue requests' },
  { name: 'request-new', pattern: /^\/requests\/new$/, role: 'customer', title: 'New rescue request' },
  { name: 'request', pattern: /^\/requests\/(\d{1,12})$/, role: 'customer', title: 'Rescue request', params: ['id'] },
  { name: 'supplier-orders', pattern: /^\/supplier\/orders$/, role: 'supplier', title: 'Supplier orders' },
  { name: 'supplier-inventory', pattern: /^\/supplier\/inventory$/, role: 'supplier', title: 'Supplier inventory' },
  { name: 'admin', pattern: /^\/admin$/, role: 'admin', title: 'Admin' },
]);

export const HOME_BY_ROLE = Object.freeze({
  anonymous: '#/signin',
  customer: '#/requests',
  supplier: '#/supplier/orders',
  admin: '#/admin',
});

// "#/requests/12?paypal=returned&order=3" -> { name: 'request', params: { id: 12 }, query: { paypal, order }, ... }.
// A hash that is not a route ("#app", "") -> name 'none'; a route-shaped hash nobody serves -> 'not-found'.
export function parseRoute(hash) {
  const raw = typeof hash === 'string' ? hash : '';
  if (!raw.startsWith('#/')) return { name: 'none', params: {}, query: {}, title: '', role: 'anonymous', hash: raw };
  const [pathPart, queryPart = ''] = raw.slice(1).split('?', 2);
  const query = {};
  for (const [key, value] of new URLSearchParams(queryPart)) {
    if (Object.keys(query).length < 10) query[key] = value;
  }
  const path = pathPart.replace(/\/+$/, '') || '/';
  for (const route of ROUTE_TABLE) {
    const m = route.pattern.exec(path);
    if (!m) continue;
    const params = {};
    (route.params ?? []).forEach((name, i) => {
      params[name] = Number(m[i + 1]);
    });
    return { name: route.name, params, query, title: route.title, role: route.role, hash: raw };
  }
  return { name: 'not-found', params: {}, query, title: 'Page not found', role: 'anonymous', hash: raw };
}

export function roleOf(user) {
  return user && typeof user.role === 'string' ? user.role : 'anonymous';
}

// -> { allow: true } or { redirect: '#/...' }
export function resolveRoute(route, user) {
  const role = roleOf(user);
  if (route.name === 'none' || route.name === 'not-found') return { allow: true };
  if (route.role === 'anonymous') return role === 'anonymous' ? { allow: true } : { redirect: HOME_BY_ROLE[role] ?? HOME_BY_ROLE.anonymous };
  if (role === 'anonymous') return { redirect: HOME_BY_ROLE.anonymous };
  if (route.role === role) return { allow: true };
  return { redirect: HOME_BY_ROLE[role] ?? HOME_BY_ROLE.anonymous };
}

export function requestHash(id) {
  return `#/requests/${Number(id)}`;
}

// Navigation links for the header, by role.
export function navLinks(user) {
  switch (roleOf(user)) {
    case 'customer':
      return [{ href: '#/requests', label: 'My requests' }, { href: '#/requests/new', label: 'New request' }];
    case 'supplier':
      return [{ href: '#/supplier/orders', label: 'Orders' }, { href: '#/supplier/inventory', label: 'Inventory' }];
    case 'admin':
      return [{ href: '#/admin', label: 'Admin' }];
    default:
      return [{ href: '#/signin', label: 'Sign in' }, { href: '#/register', label: 'Create an account' }];
  }
}
