'use strict';
const { createApp } = require('../src/app');

/** Start the app on an ephemeral port; returns { get, post, close }. */
async function start(options) {
  const server = createApp(options);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, path, body, headers = { 'content-type': 'application/json' }) => {
    const res = await fetch(base + path, { method, headers, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) });
    const text = await res.text();
    let parsed = text;
    try {
      parsed = JSON.parse(text);
    } catch {}
    return { status: res.status, headers: res.headers, body: parsed };
  };
  return { get: (p) => call('GET', p), post: (p, b, h) => call('POST', p, b, h), close: () => new Promise((r) => server.close(r)) };
}

module.exports = { start };
