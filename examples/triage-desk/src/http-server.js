'use strict';
// HTTP request pipeline (spec C1–C5, C6.5, D1.6; Security T2, T6, T7, T8, T9).
// Order for every request: Host allowlist → Origin check (non-GET/HEAD) → exact route → method → handler.
// The first failing step responds and nothing after it runs. Rejections before the body is read are sent with
// `Connection: close`, then req.resume() discards the incoming bytes without buffering or parsing them.

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { performance } = require('node:perf_hooks');

const { validateTicketInput } = require('./ticket-input.js');
const { createLogger } = require('./log.js');

const MAX_BODY_BYTES = 16384;
const JSON_CT = 'application/json; charset=utf-8';

const SECURITY_HEADERS = Object.freeze({
  'Content-Security-Policy': "default-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cache-Control': 'no-store',
});

// C5: status and fixed message per code. Messages never echo input, err.message or a stack.
const ERRORS = Object.freeze({
  invalid_json: [400, 'Request body must be valid JSON.'],
  invalid_request: [400, 'Request body must be a JSON object with a string "ticket".'],
  ticket_empty: [400, 'Ticket text is empty.'],
  ticket_too_long: [400, 'Ticket text exceeds 8000 characters.'],
  forbidden_host: [403, 'Host header is not allowed.'],
  forbidden_origin: [403, 'Origin is not allowed.'],
  not_found: [404, 'Not found.'],
  method_not_allowed: [405, 'Method not allowed.'],
  payload_too_large: [413, 'Request body exceeds 16384 bytes.'],
  unsupported_media_type: [415, 'Content-Type must be application/json.'],
  internal_error: [500, 'Internal error.'],
});

// C4: fixed file map. Request data never reaches the filesystem.
const STATIC_FILES = Object.freeze({
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/styles.css': ['styles.css', 'text/css; charset=utf-8'],
});

const GET_HEAD = Object.freeze({ methods: new Set(['GET', 'HEAD']), allow: 'GET, HEAD' });
const ROUTES = new Map([
  ['/api/health', { kind: 'health', ...GET_HEAD }],
  ['/api/triage', { kind: 'triage', methods: new Set(['POST']), allow: 'POST' }],
  ...Object.keys(STATIC_FILES).map((p) => [p, { kind: 'static', ...GET_HEAD }]),
]);

const LOG_METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS']);
const LOOPBACK_NAMES = ['127.0.0.1', 'localhost', '[::1]'];
const LOOPBACK_CONFIG_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

const DEFAULT_STATIC_DIR = path.join(__dirname, '..', 'public');

/** Host names (without port) for the allowlist: the three loopback names plus config.host when it is not one. */
function allowlistNames(configHost) {
  const names = [...LOOPBACK_NAMES];
  const h = String(configHost).trim().toLowerCase();
  if (!LOOPBACK_CONFIG_HOSTS.has(h)) {
    names.push(h.includes(':') && !h.startsWith('[') ? `[${h}]` : h); // IPv6 HOST is written [addr]
  }
  return names;
}

function readStatic(dir) {
  const files = new Map();
  const cache = new Map();
  for (const [route, [name, type]] of Object.entries(STATIC_FILES)) {
    if (!cache.has(name)) cache.set(name, fs.readFileSync(path.join(dir, name)));
    files.set(route, { body: cache.get(name), type });
  }
  return files;
}

function mediaType(contentType) {
  if (typeof contentType !== 'string') return null;
  return contentType.split(';')[0].trim().toLowerCase();
}

/**
 * Reads the request body, counting bytes. Resolves {kind:'ok', body:Buffer}, {kind:'too_large'} as soon as the
 * total exceeds `limit` (remaining bytes are left for req.resume() to discard), or {kind:'aborted'}.
 */
function readBody(req, limit) {
  return new Promise((resolve) => {
    const chunks = [];
    let total = 0;
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      req.removeListener('data', onData);
      req.removeListener('end', onEnd);
      req.removeListener('error', onAbort);
      req.removeListener('close', onClose);
      resolve(result);
    };
    function onData(chunk) {
      total += chunk.length;
      if (total > limit) { chunks.length = 0; finish({ kind: 'too_large' }); return; }
      chunks.push(chunk);
    }
    function onEnd() { finish({ kind: 'ok', body: Buffer.concat(chunks, total) }); }
    function onAbort() { finish({ kind: 'aborted' }); }
    function onClose() { if (!req.complete) finish({ kind: 'aborted' }); }
    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onAbort);
    req.on('close', onClose);
  });
}

/**
 * @param {{config:import('./config.js').Config, service:{analyse:(ticket:string)=>Promise<{response:object, meta:object}>},
 *          log?:ReturnType<typeof createLogger>, staticDir?:string}} opts
 *   staticDir: directory holding index.html, app.js and styles.css (default public/). Files are read once, here.
 * @returns {import('node:http').Server} not listening
 */
function createServer({ config, service, log = createLogger(), staticDir = DEFAULT_STATIC_DIR } = {}) {
  if (!config || typeof config !== 'object') throw new TypeError('createServer: config is required');
  if (!service || typeof service.analyse !== 'function') throw new TypeError('createServer: service.analyse is required');

  const staticFiles = readStatic(staticDir);
  const hostNames = allowlistNames(config.host);
  const live = typeof config.apiKey === 'string' && config.apiKey !== '';
  const healthBody = Buffer.from(JSON.stringify({ status: 'ok', mode: live ? 'live' : 'fallback', model: live ? config.model : null }), 'utf8');

  // requireHostHeader:false so a Host-less HTTP/1.1 request reaches the handler and gets 403, not Node's own 400.
  const server = http.createServer({ requireHostHeader: false }, (req, res) => handle(req, res, false));
  // Expect: 100-continue — never invite a body before the request has passed every check (see triage()).
  server.on('checkContinue', (req, res) => handle(req, res, true));

  /** Allowlisted Host values for the port the server is actually listening on (read per request; port 0 works). */
  function allowedHosts() {
    const addr = server.address();
    const allowed = new Set();
    if (!addr || typeof addr !== 'object') return allowed;
    for (const name of hostNames) {
      allowed.add(`${name}:${addr.port}`);
      if (addr.port === 80) allowed.add(name);
    }
    return allowed;
  }

  function handle(req, res, expectContinue) {
    const ctx = {
      req, res, expectContinue,
      started: performance.now(),
      rid: crypto.randomBytes(4).toString('hex'),
      route: 'other',
      done: false,
      triage: null,
    };
    run(ctx).catch((err) => fail(ctx, err));
  }

  async function run(ctx) {
    const { req } = ctx;
    const pathname = typeof req.url === 'string' ? req.url.split('?', 1)[0] : '';
    const route = ROUTES.get(pathname);
    if (route) ctx.route = pathname;

    // 1. Host allowlist
    const allowed = allowedHosts();
    const host = req.headers.host;
    if (typeof host !== 'string' || !allowed.has(host.toLowerCase())) return sendError(ctx, 'forbidden_host', { close: true });

    // 2. Origin check for every method except GET and HEAD
    if (req.method !== 'GET' && req.method !== 'HEAD' && req.headers.origin !== undefined) {
      const origin = req.headers.origin;
      let ok = false;
      for (const value of allowed) if (origin === 'http://' + value) { ok = true; break; }
      if (!ok) return sendError(ctx, 'forbidden_origin', { close: true });
    }

    // 3. Route (exact match, query stripped, no decoding or normalisation)
    if (!route) return sendError(ctx, 'not_found', { close: true });

    // 4. Method
    if (!route.methods.has(req.method)) return sendError(ctx, 'method_not_allowed', { close: true, headers: { Allow: route.allow } });

    // 5. Handler
    if (route.kind === 'health') return send(ctx, 200, JSON_CT, healthBody);
    if (route.kind === 'static') {
      const file = staticFiles.get(pathname);
      return send(ctx, 200, file.type, file.body);
    }
    return triage(ctx);
  }

  async function triage(ctx) {
    const { req, res } = ctx;
    if (mediaType(req.headers['content-type']) !== 'application/json') {
      return sendError(ctx, 'unsupported_media_type', { close: true });
    }
    const declared = req.headers['content-length'];
    if (declared !== undefined && Number(declared) > MAX_BODY_BYTES) {
      return sendError(ctx, 'payload_too_large', { close: true });
    }

    if (ctx.expectContinue) res.writeContinue();
    const read = await readBody(req, MAX_BODY_BYTES);
    if (read.kind === 'too_large') return sendError(ctx, 'payload_too_large', { close: true });
    if (read.kind === 'aborted') return abandon(ctx);

    const text = read.body.toString('utf8');
    let parsed;
    if (text.length === 0) return sendError(ctx, 'invalid_json');
    try {
      parsed = JSON.parse(text);
    } catch {
      return sendError(ctx, 'invalid_json'); // the parser message quotes input, so it is never used
    }

    const input = validateTicketInput(parsed);
    if (!input.ok) return sendError(ctx, input.code);

    const { response, meta } = await service.analyse(input.ticket);
    const body = Buffer.from(JSON.stringify(response), 'utf8');
    const m = meta && typeof meta === 'object' ? meta : {};
    ctx.triage = {
      ticketLength: Number.isInteger(m.ticketLength) ? m.ticketLength : input.ticket.length,
      source: response.source,
      fallbackReason: response.fallbackReason,
      injectionSuspected: response.injectionSuspected,
      redactions: m.redactions,
      upstreamStatus: m.upstreamStatus,
      detail: m.detail,
      usage: m.usage,
    };
    return send(ctx, 200, JSON_CT, body);
  }

  function sendError(ctx, code, { close = false, headers = {} } = {}) {
    const [status, message] = ERRORS[code];
    const body = Buffer.from(JSON.stringify({ error: { code, message } }), 'utf8');
    ctx.triage = null;
    send(ctx, status, JSON_CT, body, { close, headers, errorCode: code });
  }

  function send(ctx, status, contentType, body, { close = false, headers = {}, errorCode = null } = {}) {
    const { req, res } = ctx;
    if (ctx.done) return;
    ctx.done = true;
    const h = { ...SECURITY_HEADERS, 'Content-Type': contentType, 'Content-Length': body.length, ...headers };
    if (close) h.Connection = 'close';
    res.writeHead(status, h);
    if (req.method === 'HEAD') res.end();
    else res.end(body);
    if (close) req.resume(); // discard any unread body without buffering or parsing it
    writeRequestLog(ctx, status, errorCode);
  }

  /** The client went away mid-body: nothing to answer. Log the request without a status. */
  function abandon(ctx) {
    if (ctx.done) return;
    ctx.done = true;
    ctx.res.destroy();
    writeRequestLog(ctx, null, null);
  }

  function writeRequestLog(ctx, status, errorCode) {
    const t = ctx.triage || {};
    log.request({
      rid: ctx.rid,
      method: LOG_METHODS.has(ctx.req.method) ? ctx.req.method : 'OTHER',
      route: ctx.route,
      status,
      ms: Math.max(0, Math.round(performance.now() - ctx.started)),
      errorCode,
      ticketLength: t.ticketLength ?? null,
      source: t.source ?? null,
      fallbackReason: t.fallbackReason ?? null,
      injectionSuspected: t.injectionSuspected ?? null,
      redactions: t.redactions ?? null,
      upstreamStatus: t.upstreamStatus ?? null,
      detail: t.detail ?? null,
      usage: t.usage ?? null,
    });
  }

  /** A bug in local code: 500 with a fixed message, an `error` event with the error name only. */
  function fail(ctx, err) {
    const errorName = err instanceof Error && typeof err.name === 'string' ? err.name : 'Error';
    try {
      log.error({ rid: ctx.rid, errorCode: 'internal_error', errorName });
    } catch {
      // The log sink itself failed. There is nowhere left to report it, and an exception here would become an
      // unhandled rejection that stops the process; the 500 below is still sent.
    }
    if (!ctx.done && !ctx.res.headersSent) {
      try {
        sendError(ctx, 'internal_error');
      } catch {
        // Writing the 500 failed (socket gone, or the log sink threw after the response was sent).
        if (!ctx.res.writableEnded) ctx.res.destroy();
      }
    } else if (!ctx.done) {
      ctx.done = true;
      ctx.res.destroy();
    }
  }

  return server;
}

module.exports = { createServer };
