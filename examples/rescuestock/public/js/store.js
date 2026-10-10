// Client state: {session, config, views: Map<route, {data, status, error}>}. Everything in it is a copy of a
// server answer; nothing is computed here. The CSRF token is kept by api.js, in memory only.

export const VIEW_STATUS = Object.freeze({ IDLE: 'idle', LOADING: 'loading', READY: 'ready', ERROR: 'error' });

export function createStore() {
  const state = { session: null, config: null, views: new Map() };
  return {
    get session() {
      return state.session;
    },
    get config() {
      return state.config;
    },
    setSession(user) {
      state.session = user ?? null;
    },
    setConfig(config) {
      state.config = config ?? null;
    },
    getView(key) {
      return state.views.get(key) ?? { data: null, status: VIEW_STATUS.IDLE, error: null };
    },
    setView(key, patch) {
      const next = { ...this.getView(key), ...patch };
      state.views.set(key, next);
      return next;
    },
    clearViews() {
      state.views.clear();
    },
  };
}
