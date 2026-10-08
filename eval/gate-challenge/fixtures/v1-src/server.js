'use strict';
const http = require('http');
const { createStore } = require('./store');

function send(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text) });
  res.end(text);
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => resolve(data));
  });
}

function createApp({ store = createStore() } = {}) {
  return http.createServer(async (req, res) => {
    try {
      const user = req.headers['x-user'];
      if (!user) return send(res, 401, { error: { code: 'unauthorized', message: 'X-User header required' } });
      const url = new URL(req.url, 'http://localhost');
      const m = /^\/notes(?:\/(\d+))?$/.exec(url.pathname);
      if (!m) return send(res, 404, { error: { code: 'not_found', message: 'No such route' } });
      const id = m[1];

      if (!id && req.method === 'POST') {
        const input = JSON.parse(await readBody(req));
        return send(res, 201, store.create(user, input));
      }
      if (!id && req.method === 'GET') return send(res, 200, store.listByOwner(user));
      if (id && req.method === 'GET') {
        const note = store.get(id);
        if (!note) return send(res, 404, { error: { code: 'not_found', message: 'Note not found' } });
        return send(res, 200, note);
      }
      if (id && req.method === 'DELETE') {
        const note = store.get(id);
        if (!note || note.owner !== user) return send(res, 404, { error: { code: 'not_found', message: 'Note not found' } });
        store.remove(id);
        return send(res, 204, {});
      }
      return send(res, 405, { error: { code: 'method_not_allowed', message: 'Method not allowed' } });
    } catch (err) {
      return send(res, 500, { error: { code: 'internal_error', message: err.stack } });
    }
  });
}

module.exports = { createApp };

if (require.main === module) {
  createApp().listen(Number(process.env.PORT || 3000), '127.0.0.1');
}
