'use strict';
// acme-kit/http: routing, JSON bodies and the Acme error envelope.
//
// Every error response in an Acme service uses problem():
//   { "error": { "code": "<code>", "detail": "<human text>", ...extra } }
// Codes and statuses (README "Error envelope"):
//   400 bad_request            malformed request (e.g. invalid JSON)
//   404 not_found              unknown route or resource
//   405 method_not_allowed
//   409 conflict               state conflict (duplicate, overlapping booking, ...)
//   413 payload_too_large
//   415 unsupported_media_type body is not application/json
//   422 validation_failed      well-formed JSON that fails validation; extra: { fields: [names] }
//   500 internal_error         never includes stack traces or exception messages

const http = require('http');

class HttpError extends Error {
  constructor(status, code, detail, extra) {
    super(detail);
    this.status = status;
    this.code = code;
    this.extra = extra || {};
  }
}

function json(res, status, body, headers = {}) {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(text), ...headers });
  res.end(text);
}

function problem(res, status, code, detail, extra = {}) {
  json(res, status, { error: { code, detail, ...extra } });
}

async function readJson(req, { limit = 16384 } = {}) {
  const type = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  if (type !== 'application/json') throw new HttpError(415, 'unsupported_media_type', 'Content-Type must be application/json');
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw new HttpError(413, 'payload_too_large', `Body exceeds ${limit} bytes`);
    chunks.push(c);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null');
  } catch {
    throw new HttpError(400, 'bad_request', 'Body is not valid JSON');
  }
}

/**
 * validate(body, schema) -> { ok, fields }
 * schema: { field: { type: 'string'|'number'|'integer'|'boolean', required, min, max, pattern } }
 * min/max are lengths for strings and values for numbers.
 */
function validate(body, schema) {
  const fields = [];
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false, fields: Object.keys(schema) };
  for (const [name, rule] of Object.entries(schema)) {
    const v = body[name];
    if (v === undefined || v === null || v === '') {
      if (rule.required) fields.push(name);
      continue;
    }
    let bad = false;
    if (rule.type === 'string') bad = typeof v !== 'string' || (rule.min !== undefined && v.trim().length < rule.min) || (rule.max !== undefined && v.length > rule.max) || (rule.pattern && !rule.pattern.test(v));
    else if (rule.type === 'number') bad = typeof v !== 'number' || !Number.isFinite(v) || (rule.min !== undefined && v < rule.min) || (rule.max !== undefined && v > rule.max);
    else if (rule.type === 'integer') bad = !Number.isInteger(v) || (rule.min !== undefined && v < rule.min) || (rule.max !== undefined && v > rule.max);
    else if (rule.type === 'boolean') bad = typeof v !== 'boolean';
    if (bad) fields.push(name);
  }
  return { ok: fields.length === 0, fields };
}

/** createRouter() -> { add(method, pattern, handler), handle(req, res) }. Patterns: '/api/items/:id'. */
function createRouter() {
  const routes = [];
  const compile = (pattern) => {
    const keys = [];
    const re = new RegExp(`^${pattern.replace(/\/:([A-Za-z_]\w*)/g, (_, k) => (keys.push(k), '/([^/]+)'))}/?$`);
    return { re, keys };
  };
  return {
    add(method, pattern, handler) {
      routes.push({ method: method.toUpperCase(), ...compile(pattern), handler });
      return this;
    },
    async handle(req, res) {
      const url = new URL(req.url, 'http://localhost');
      const matching = routes.map((r) => ({ r, m: r.re.exec(url.pathname) })).filter((x) => x.m);
      if (!matching.length) return problem(res, 404, 'not_found', 'No such route');
      const hit = matching.find((x) => x.r.method === req.method);
      if (!hit) return problem(res, 405, 'method_not_allowed', `Use ${[...new Set(matching.map((x) => x.r.method))].join(', ')}`);
      const params = Object.fromEntries(hit.r.keys.map((k, i) => [k, decodeURIComponent(hit.m[i + 1])]));
      try {
        await hit.r.handler(req, res, { params, query: url.searchParams });
      } catch (err) {
        if (err instanceof HttpError) return problem(res, err.status, err.code, err.message, err.extra);
        if (!res.headersSent) problem(res, 500, 'internal_error', 'Internal error');
      }
    },
  };
}

function createServer(router) {
  return http.createServer((req, res) => router.handle(req, res));
}

module.exports = { HttpError, json, problem, readJson, validate, createRouter, createServer };
