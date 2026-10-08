'use strict';
const { createApp } = require('../src/app');

async function start() {
  const server = createApp();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, path, body, headers = { 'content-type': 'application/json' }) => {
    const res = await fetch(base + path, { method, headers, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) });
    const text = await res.text();
    let parsed = text;
    try {
      parsed = JSON.parse(text);
    } catch {}
    return { status: res.status, body: parsed };
  };
  return { get: (p) => call('GET', p), post: (p, b, h) => call('POST', p, b, h), close: () => new Promise((r) => server.close(r)) };
}

module.exports = { start };
