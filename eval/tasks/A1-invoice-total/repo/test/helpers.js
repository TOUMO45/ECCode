'use strict';
const { createApp } = require('../src/app');

/** Start the app on an ephemeral port; returns { get, close }. */
async function start() {
  const server = createApp();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    async get(path) {
      const res = await fetch(base + path);
      const text = await res.text();
      let body = text;
      try {
        body = JSON.parse(text);
      } catch {}
      return { status: res.status, headers: res.headers, body };
    },
    close: () => new Promise((r) => server.close(r)),
  };
}

module.exports = { start };
