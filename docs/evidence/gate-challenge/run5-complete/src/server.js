'use strict';
const http = require('http');
const { createStore } = require('./store');

// Cap on request body size. Override with MAX_BODY_BYTES (default 1 MiB).
const MAX_BODY = Number(process.env.MAX_BODY_BYTES || 1024 * 1024);

class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function send(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text) });
  res.end(text);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let done = false;
    req.on('data', (c) => {
      if (done) return;
      size += c.length;
      if (size > MAX_BODY) {
        done = true;
        reject(new HttpError(413, 'payload_too_large', 'Request body too large'));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!done) resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', () => {
      if (!done) {
        done = true;
        reject(new HttpError(400, 'bad_request', 'Request error'));
      }
    });
  });
}

function parseNote(text) {
  let input;
  try {
    input = JSON.parse(text);
  } catch (e) {
    throw new HttpError(400, 'invalid_json', 'Request body must be valid JSON');
  }
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new HttpError(400, 'validation_error', 'Body must be a JSON object');
  }
  const { title, body } = input;
  if (typeof title !== 'string' || title.trim() === '' || title.length > 200) {
    throw new HttpError(400, 'validation_error', 'title must be a non-empty string (max 200 chars)');
  }
  if (typeof body !== 'string' || body.length > 100000) {
    throw new HttpError(400, 'validation_error', 'body must be a string (max 100000 chars)');
  }
  return { title, body };
}

const notFound = (res) => send(res, 404, { error: { code: 'not_found', message: 'Note not found' } });

function createApp({ store = createStore() } = {}) {
  return http.createServer(async (req, res) => {
    try {
      // NOTE: X-User is a placeholder identity, trusted as-is until real authn exists.
      const user = req.headers['x-user'];
      if (!user) return send(res, 401, { error: { code: 'unauthorized', message: 'X-User header required' } });
      const url = new URL(req.url, 'http://localhost');
      const m = /^\/notes(?:\/(\d+))?$/.exec(url.pathname);
      if (!m) return send(res, 404, { error: { code: 'not_found', message: 'No such route' } });
      const id = m[1];

      if (!id && req.method === 'POST') {
        const input = parseNote(await readBody(req));
        return send(res, 201, store.create(user, input));
      }
      if (!id && req.method === 'GET') return send(res, 200, store.listByOwner(user));
      if (id && req.method === 'GET') {
        const note = store.get(id);
        if (!note || note.owner !== user) return notFound(res);
        return send(res, 200, note);
      }
      if (id && req.method === 'DELETE') {
        const note = store.get(id);
        if (!note || note.owner !== user) return notFound(res);
        store.remove(id);
        res.writeHead(204);
        return res.end();
      }
      return send(res, 405, { error: { code: 'method_not_allowed', message: 'Method not allowed' } });
    } catch (err) {
      if (err instanceof HttpError) {
        return send(res, err.status, { error: { code: err.code, message: err.message } });
      }
      console.error('internal error:', err && err.stack);
      return send(res, 500, { error: { code: 'internal_error', message: 'Internal server error' } });
    }
  });
}

module.exports = { createApp, MAX_BODY };

if (require.main === module) {
  createApp().listen(Number(process.env.PORT || 3000), '127.0.0.1');
}
