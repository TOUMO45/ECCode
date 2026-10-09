// Method + path-template routing. Templates look like /api/plans/:id/reserve.
//   * no match for the path                  -> 404 NOT_FOUND
//   * path matches but not for this method   -> 405 METHOD_NOT_ALLOWED + Allow
//   * every route must declare a policy; an undeclared policy fails at add()
//     time and assertPolicies() fails startup (default deny)
import { AppError } from './envelope.js';

export const POLICIES = Object.freeze(['public', 'session', 'customer', 'supplier', 'admin', 'signature']);
const METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);
const SEGMENT = /^[A-Za-z0-9._~-]+$/;
const PARAM = /^:[A-Za-z][A-Za-z0-9]*$/;

function compile(template) {
  if (typeof template !== 'string' || !template.startsWith('/')) throw new TypeError('Route template must start with /');
  const segments = template === '/' ? [] : template.slice(1).split('/');
  const names = new Set();
  const compiled = segments.map((segment) => {
    if (PARAM.test(segment)) {
      const name = segment.slice(1);
      if (names.has(name)) throw new TypeError(`Duplicate route parameter in ${template}`);
      names.add(name);
      return { param: name };
    }
    if (!SEGMENT.test(segment)) throw new TypeError(`Invalid route segment in ${template}`);
    return { literal: segment };
  });
  return compiled;
}

export function createRouter() {
  const routes = [];

  function add(method, template, handler, { policy } = {}) {
    if (!METHODS.has(method)) throw new TypeError(`Unsupported method ${method}`);
    if (typeof handler !== 'function') throw new TypeError(`Route ${method} ${template} needs a handler`);
    if (!POLICIES.includes(policy)) {
      throw new TypeError(`Route ${method} ${template} has no valid policy (one of ${POLICIES.join(', ')})`);
    }
    if (routes.some((r) => r.method === method && r.template === template)) {
      throw new TypeError(`Duplicate route ${method} ${template}`);
    }
    routes.push({ method, template, segments: compile(template), handler, policy });
  }

  function matchSegments(route, parts) {
    if (route.segments.length !== parts.length) return null;
    const params = Object.create(null);
    for (let i = 0; i < parts.length; i++) {
      const seg = route.segments[i];
      if (seg.literal !== undefined) {
        if (seg.literal !== parts[i]) return null;
      } else {
        let decoded;
        try {
          decoded = decodeURIComponent(parts[i]);
        } catch {
          throw new AppError(400, 'BAD_REQUEST');
        }
        if (decoded.length === 0 || decoded.length > 200 || /[\u0000-\u001f/\\]/.test(decoded)) {
          throw new AppError(400, 'BAD_REQUEST');
        }
        params[seg.param] = decoded;
      }
    }
    return params;
  }

  // Returns {route, params}; throws AppError 404 or 405.
  function match(method, pathname) {
    const parts = pathname === '/' ? [] : pathname.slice(1).split('/');
    const allowed = [];
    for (const route of routes) {
      const params = matchSegments(route, parts);
      if (!params) continue;
      if (route.method === method) return { route, params };
      allowed.push(route.method);
    }
    if (allowed.length > 0) {
      throw new AppError(405, 'METHOD_NOT_ALLOWED', { headers: { Allow: [...new Set(allowed)].sort().join(', ') } });
    }
    throw new AppError(404, 'NOT_FOUND');
  }

  // Startup check: no route without a policy (add() already enforces this).
  function assertPolicies() {
    for (const route of routes) {
      if (!POLICIES.includes(route.policy)) {
        throw new Error(`Route ${route.method} ${route.template} has no policy entry`);
      }
    }
  }

  return {
    add,
    match,
    assertPolicies,
    list: () => routes.map((r) => ({ method: r.method, template: r.template, policy: r.policy })),
  };
}
