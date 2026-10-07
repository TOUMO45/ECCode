'use strict';
// Loopback stand-in for the Anthropic Messages API (spec §Testing Strategy, C7). Used with
// TRIAGE_ANTHROPIC_BASE_URL=http://127.0.0.1:<port> for spawned-process and redirect tests.
// It records every request, serves programmed responses and can answer with a 3xx redirect.
// A second instance can act as the redirect target and count the requests it receives (DES-1).
const http = require('node:http');
const { messageBody } = require('./fake-fetch.js');

const UNPROGRAMMED = Object.freeze({
  status: 500,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ type: 'error', error: { type: 'api_error', message: 'fake-anthropic: no response programmed' } }),
});

function jsonResponse(status, jsonOrText) {
  const isText = typeof jsonOrText === 'string';
  return {
    status,
    headers: { 'content-type': isText ? 'text/plain; charset=utf-8' : 'application/json' },
    body: isText ? jsonOrText : JSON.stringify(jsonOrText),
  };
}

/**
 * @param {{host?:string}} [opts] bind address; defaults to and must be a loopback address.
 * @returns {Promise<FakeAnthropic>} listening on an ephemeral port.
 *
 * FakeAnthropic:
 *   port, address, url ('http://127.0.0.1:<port>')
 *   requests: [{method, path, headers, body (raw string), json (parsed or null)}], recorded before responding
 *   count: requests received (incremented on arrival, before the body is read)
 *   reply(status, jsonOrText, {once?, headers?}) — program a response
 *   replyMessage(obj, messageBodyOpts, {once?}) — program a 200 Messages API body (fake-fetch messageBody)
 *   redirect(status, location, {once?}) — program a 3xx with Location (307/308 for DES-1 tests)
 *   Without {once:true} the response becomes the default for every later request; with it, it is
 *   queued and served once, in order, before the default. Before anything is programmed: 500 api_error.
 *   reset() — clear recorded requests, the count, the queue and the default
 *   close() — stop listening and drop open connections
 */
async function startFakeAnthropic({ host = '127.0.0.1' } = {}) {
  if (!['127.0.0.1', '::1', 'localhost'].includes(host)) throw new Error('fake-anthropic: loopback hosts only');
  const requests = [];
  const queue = [];
  let fallback = UNPROGRAMMED;
  let count = 0;

  const server = http.createServer((req, res) => {
    count += 1;
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      let json = null;
      try { json = body.length ? JSON.parse(body) : null; } catch { json = null; }
      requests.push({ method: req.method, path: req.url, headers: { ...req.headers }, body, json });
      const spec = queue.length ? queue.shift() : fallback;
      const headers = { ...spec.headers, 'content-length': String(Buffer.byteLength(spec.body)) };
      res.writeHead(spec.status, headers);
      res.end(spec.body);
    });
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, host, () => { server.off('error', reject); resolve(); });
  });
  const { port, address } = server.address();
  const urlHost = address.includes(':') ? `[${address}]` : address;

  function program(spec, { once = false } = {}) {
    if (once) queue.push(spec); else fallback = spec;
  }

  return {
    port,
    address,
    url: `http://${urlHost}:${port}`,
    requests,
    get count() { return count; },
    reply(status, jsonOrText, { once = false, headers = {} } = {}) {
      if (!Number.isInteger(status) || status < 100 || status > 599) throw new RangeError('reply: status must be an integer 100-599');
      const spec = jsonResponse(status, jsonOrText === undefined ? '' : jsonOrText);
      spec.headers = { ...spec.headers, ...headers };
      program(spec, { once });
    },
    replyMessage(obj, messageOpts, { once = false } = {}) {
      program(jsonResponse(200, messageBody(obj, messageOpts)), { once });
    },
    redirect(status, location, { once = false } = {}) {
      if (!Number.isInteger(status) || status < 300 || status > 399) throw new RangeError('redirect: status must be 3xx');
      if (typeof location !== 'string' || location === '') throw new TypeError('redirect: location must be a non-empty string');
      program({ status, headers: { location, 'content-type': 'application/json' }, body: '{}' }, { once });
    },
    reset() {
      requests.length = 0;
      queue.length = 0;
      count = 0;
      fallback = UNPROGRAMMED;
    },
    close() {
      return new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      });
    },
  };
}

module.exports = { startFakeAnthropic };
