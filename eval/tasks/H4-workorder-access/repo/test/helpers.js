'use strict';
const { createApp } = require('../src/app');

/** Start the app on an ephemeral port; returns { get(path, username), close }. */
async function start(options) {
  const server = createApp(options);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    async get(path, username) {
      const res = await fetch(base + path, { headers: username ? { 'X-Acme-User': username } : {} });
      const text = await res.text();
      let body = text;
      try {
        body = JSON.parse(text);
      } catch {}
      return { status: res.status, body };
    },
    close: () => new Promise((r) => server.close(r)),
  };
}

module.exports = { start };
