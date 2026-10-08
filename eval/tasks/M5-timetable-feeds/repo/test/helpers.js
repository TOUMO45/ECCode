'use strict';
const { createApp } = require('../src/app');

/** Start the app on an ephemeral port with a fixed clock; returns { get, post, close, clock }. */
async function start({ now = '2026-03-10T03:00:00Z' } = {}) {
  const clock = { t: new Date(now) };
  const server = createApp({ now: () => new Date(clock.t) });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, path, body, headers = {}) => {
    const h = { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers };
    const res = await fetch(base + path, { method, headers: h, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) });
    const text = await res.text();
    let parsed = text;
    try {
      parsed = JSON.parse(text);
    } catch {}
    return { status: res.status, headers: res.headers, body: parsed };
  };
  return {
    clock,
    get: (p, h) => call('GET', p, undefined, h),
    post: (p, b, h) => call('POST', p, b, h),
    close: () => {
      if (server.closeAllConnections) server.closeAllConnections();
      return new Promise((r) => server.close(r));
    },
  };
}

module.exports = { start };
