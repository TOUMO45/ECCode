'use strict';
// HTTP client for contract tests (spec §Testing Strategy). Built on node:http with agent:false, because
// global fetch cannot set or omit the Host header (ev:ev-muymgxxk-01aac351) and AC17 needs both.
const http = require('node:http');

function hasHeader(headers, name) {
  const lower = name.toLowerCase();
  return Object.keys(headers).some((k) => k.toLowerCase() === lower);
}

/**
 * @param {{port:number, method?:string, path?:string, headers?:Record<string,string>,
 *          body?:string|Buffer|object, setHost?:boolean, hostname?:string, timeoutMs?:number}} opts
 *   - headers: sent as given. A `host` entry (any case) replaces the default Host, so a foreign Host
 *     is just `headers: {host: 'attacker.example'}`. `origin` likewise.
 *   - setHost: default true. When true and no `host` header is given, Node sends `127.0.0.1:<port>`.
 *     When false and no `host` header is given, the request carries NO Host header at all.
 *   - body: a string or Buffer is sent byte-for-byte. Any other value is JSON.stringify'd, and
 *     `content-type: application/json` is added only if the caller set no content-type.
 *     `content-length` is always set from the bytes sent unless the caller supplied one.
 *   - hostname: TCP target, default 127.0.0.1 (loopback only).
 * @returns {Promise<{status:number, headers:Record<string,string|string[]>, body:string, json:any}>}
 *   `json` is the parsed body, or null when the body is empty or not valid JSON.
 *   Rejects on a transport error (ECONNREFUSED, ECONNRESET, timeout) instead of resolving a status.
 */
function request({ port, method = 'GET', path = '/', headers = {}, body, setHost = true, hostname = '127.0.0.1', timeoutMs = 10000 } = {}) {
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    return Promise.reject(new TypeError('request: port must be an integer 1-65535'));
  }
  const h = { ...headers };
  let payload = null;
  if (body !== undefined && body !== null) {
    if (typeof body === 'string' || Buffer.isBuffer(body)) {
      payload = Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf8');
    } else {
      payload = Buffer.from(JSON.stringify(body), 'utf8');
      if (!hasHeader(h, 'content-type')) h['content-type'] = 'application/json';
    }
    if (!hasHeader(h, 'content-length')) h['content-length'] = String(payload.length);
  }

  return new Promise((resolve, reject) => {
    const req = http.request({ hostname, port, method, path, headers: h, setHost, agent: false }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('error', reject);
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        if (text.length > 0) {
          try { json = JSON.parse(text); } catch { json = null; }
        }
        resolve({ status: res.statusCode, headers: res.headers, body: text, json });
      });
    });
    req.setTimeout(timeoutMs, () => {
      const err = new Error(`request: no response within ${timeoutMs} ms`);
      err.code = 'ETIMEDOUT';
      req.destroy(err);
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

module.exports = { request };
