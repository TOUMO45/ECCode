// Routing by method + template. Path params are integers (^\d{1,10}$) or the
// route does not match. HEAD is served by GET routes.
import { LIMITS } from '../api/contract-schemas.js';

const PARAM_RE = /^\d{1,10}$/;

export class Router {
  constructor() {
    this.routes = [];
    this.fallback = null; // (req, res, rc) for non-/api GET/HEAD (static files)
  }

  /**
   * @param {string} method
   * @param {string} template e.g. /api/incidents/:id
   * @param {object} opts { auth: 'session'|'none', action?: string (RBAC), body?: schema|fn, query?: schema }
   * @param {Function} handler async (rc) => { status, body, headers } | undefined
   */
  add(method, template, opts, handler) {
    if (typeof handler !== 'function') throw new TypeError('handler required');
    const options = { auth: 'session', ...opts };
    if (options.auth === 'session' && !options.action) {
      throw new TypeError(`route ${method} ${template} needs an RBAC action (default deny)`);
    }
    const segs = template.split('/').filter(Boolean);
    this.routes.push({ method: method.toUpperCase(), template, segs, opts: options, handler });
    return this;
  }

  get(t, o, h) { return this.add('GET', t, o, h); }
  post(t, o, h) { return this.add('POST', t, o, h); }
  put(t, o, h) { return this.add('PUT', t, o, h); }
  patch(t, o, h) { return this.add('PATCH', t, o, h); }
  delete(t, o, h) { return this.add('DELETE', t, o, h); }

  /**
   * @returns {{route, params}|{allow:string[]}|null}
   */
  match(method, pathname) {
    const parts = pathname.split('/').filter(Boolean);
    const m = method === 'HEAD' ? 'GET' : method;
    const allow = new Set();
    let hit = null;
    for (const r of this.routes) {
      if (r.segs.length !== parts.length) continue;
      const params = {};
      let ok = true;
      for (let i = 0; i < parts.length; i++) {
        const s = r.segs[i];
        if (s[0] === ':') {
          if (!PARAM_RE.test(parts[i])) { ok = false; break; }
          const n = Number(parts[i]);
          if (n < 1 || n > LIMITS.maxInt) { ok = false; break; }
          params[s.slice(1)] = n;
        } else if (s !== parts[i]) { ok = false; break; }
      }
      if (!ok) continue;
      allow.add(r.method);
      if (r.method === m && !hit) hit = { route: r, params };
    }
    if (hit) return hit;
    if (allow.size) {
      if (allow.has('GET')) allow.add('HEAD');
      return { allow: [...allow].sort() };
    }
    return null;
  }
}
