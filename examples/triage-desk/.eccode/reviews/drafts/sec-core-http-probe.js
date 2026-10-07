'use strict';
// security-reviewer probe for phase:core-modules — raw-socket HTTP guard checks against createServer.
// Usage: node sec-http-probe.js <project root>
const path = require('node:path');
const net = require('node:net');
const root = path.resolve(process.argv[2]);
const { createServer } = require(path.join(root, 'src/http-server.js'));
const { createLogger } = require(path.join(root, 'src/log.js'));

const CANARY = 'CANARY-SECRET-7731';
const lines = [];
const log = createLogger((l) => lines.push(l));
let calls = 0;
const service = {
  async analyse(ticket) {
    calls++;
    if (ticket.includes('THROW')) { const e = new Error('boom ' + ticket + ' sk-ant-' + CANARY); throw e; }
    return {
      response: { category: 'other', urgency: 'low', summary: 'Customer reports an issue.', suggestedReply: 'Thanks.',
        source: 'fallback', fallbackReason: 'no_api_key', injectionSuspected: false, model: null },
      meta: { ticketLength: ticket.length, redactions: { email: 0, card: 0, phone: 0 }, detail: ticket },
    };
  },
};
const config = { host: '127.0.0.1', port: 0, apiKey: 'sk-ant-' + CANARY, model: 'claude-haiku-5-5' };
const server = createServer({ config, service, log });

function raw(port, text, { endAfterMs = 400 } = {}) {
  return new Promise((resolve) => {
    const s = net.connect(port, '127.0.0.1');
    let data = '';
    let err = null;
    s.on('data', (d) => { data += d.toString('latin1'); });
    s.on('error', (e) => { err = e.code; });
    s.on('close', () => resolve({ data, err }));
    s.on('connect', () => {
      if (Array.isArray(text)) { for (const t of text) s.write(t); } else s.write(text);
    });
    setTimeout(() => s.destroy(), endAfterMs);
  });
}

function parse(r) {
  const [head, ...rest] = r.data.split('\r\n\r\n');
  const hl = head.split('\r\n');
  const status = Number((hl[0] || '').split(' ')[1]) || null;
  const headers = {};
  for (const l of hl.slice(1)) { const i = l.indexOf(':'); if (i > 0) headers[l.slice(0, i).toLowerCase()] = l.slice(i + 1).trim(); }
  return { status, headers, body: rest.join('\r\n\r\n'), first: hl[0], err: r.err, has100: /^HTTP\/1\.1 100/.test(r.data) };
}

const results = [];
let failures = 0;
function check(name, cond, info) {
  results.push(`${cond ? 'PASS' : 'FAIL'} ${name}${info !== undefined ? ' :: ' + info : ''}`);
  if (!cond) failures++;
}
const SEC = ['content-security-policy', 'x-content-type-options', 'referrer-policy', 'cache-control'];
const secOk = (p) => SEC.every((h) => p.headers[h]) && !Object.keys(p.headers).some((h) => h.startsWith('access-control-'));

function req({ method = 'POST', url = '/api/triage', host, origin, ct = 'application/json', body = '', extra = [], cl = true }) {
  const h = [`${method} ${url} HTTP/1.1`];
  if (host !== null) h.push(`Host: ${host}`);
  if (origin !== undefined) h.push(`Origin: ${origin}`);
  if (ct !== null) h.push(`Content-Type: ${ct}`);
  if (cl) h.push(`Content-Length: ${Buffer.byteLength(body)}`);
  h.push(...extra);
  return h.join('\r\n') + '\r\n\r\n' + body;
}

(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const P = server.address().port;
  const H = `127.0.0.1:${P}`;
  const okBody = JSON.stringify({ ticket: 'hello ' + CANARY });

  // --- Host allowlist and ordering
  const big = 'x'.repeat(20000);
  let p = parse(await raw(P, req({ host: `evil.example:${P}`, body: big })));
  check('foreign Host + 20KB body -> 403 forbidden_host (not 413)', p.status === 403 && /forbidden_host/.test(p.body) && p.headers.connection === 'close', `${p.status} ${p.err}`);
  p = parse(await raw(P, req({ host: `evil.example:${P}`, ct: 'text/plain', body: big, extra: [] })));
  check('foreign Host + bad CT + big body -> 403 (Host first)', p.status === 403, p.status);
  p = parse(await raw(P, req({ host: `evil.example:${P}`, cl: false, extra: ['Transfer-Encoding: chunked'], body: '4e20\r\n' + big + '\r\n0\r\n\r\n' })));
  check('foreign Host + chunked 20KB -> 403', p.status === 403, p.status);
  p = parse(await raw(P, req({ host: `evil.example:${P}`, body: '', cl: false, extra: ['Content-Length: 99999999', 'Expect: 100-continue'] })));
  check('foreign Host + Expect:100-continue -> 403 without 100 Continue', p.status === 403 && !p.has100, `${p.first} has100=${p.has100}`);
  p = parse(await raw(P, req({ host: H, cl: false, body: '', extra: ['Content-Length: 99999999', 'Expect: 100-continue'] })));
  check('allowed Host + CL 99999999 + Expect -> 413 without 100 Continue', p.status === 413 && !p.has100, `${p.first} has100=${p.has100}`);

  const hostCases = [
    [`localhost.:${P}`, 403], [`LOCALHOST:${P}`, 200], [`localhost:${P}`, 200], [`[::1]:${P}`, 200],
    [`[0:0:0:0:0:0:0:1]:${P}`, 403], [`127.1:${P}`, 403], [`0x7f000001:${P}`, 403], [`2130706433:${P}`, 403],
    ['127.0.0.1', 403], [`127.0.0.1:0${P}`, 403], [`127.0.0.1:${P + 1}`, 403], [`evil.com:${P}`, 403],
    [`127.0.0.1.nip.io:${P}`, 403], [`localhost:${P}@evil.com`, 403], [`evil.com#@127.0.0.1:${P}`, 403],
    [`127.0.0.1:${P}.evil.com`, 403], [`[::ffff:127.0.0.1]:${P}`, 403], [`::1:${P}`, 403], ['', 403],
    [`127.0.0.1:${P} evil`, 403], [`localhost:${P}\t`, 200],
  ];
  for (const [host, want] of hostCases) {
    p = parse(await raw(P, req({ method: 'GET', url: '/api/health', host, ct: null, cl: false })));
    check(`Host ${JSON.stringify(host)} -> ${want}`, p.status === want && secOk(p), p.status);
  }
  p = parse(await raw(P, `GET /api/health HTTP/1.1\r\n\r\n`));
  check('missing Host (HTTP/1.1) -> 403', p.status === 403, p.status);
  p = parse(await raw(P, `GET /api/health HTTP/1.0\r\n\r\n`));
  check('missing Host (HTTP/1.0) -> 403', p.status === 403, p.status);
  p = parse(await raw(P, `GET /api/health HTTP/1.1\r\nHost: evil.com:${P}\r\nHost: ${H}\r\n\r\n`));
  check('duplicate Host (foreign first) -> 403 or parser 400', p.status === 403 || p.status === 400, p.status);
  p = parse(await raw(P, `GET /api/health HTTP/1.1\r\nHost: ${H}\r\nHost: evil.com:${P}\r\n\r\n`));
  results.push(`INFO duplicate Host (allowed first) -> ${p.status}`);
  p = parse(await raw(P, `GET http://evil.com/api/health HTTP/1.1\r\nHost: ${H}\r\n\r\n`));
  check('absolute-form request-target -> 404 (exact path match)', p.status === 404, p.status);

  // --- Origin
  const originCases = [
    ['null', 403], ['', 403], [`http://evil.com`, 403], [`https://${H}`, 403], [`http://${H}/`, 403],
    [`http://localhost.:${P}`, 403], [`http://LOCALHOST:${P}`, 403], [`http://${H}`, 200], [`http://localhost:${P}`, 200],
    [`http://[::1]:${P}`, 200], [`http://${H}.evil.com`, 403], [`http://evil.com, http://${H}`, 403],
  ];
  for (const [origin, want] of originCases) {
    p = parse(await raw(P, req({ host: H, origin, body: okBody })));
    check(`POST Origin ${JSON.stringify(origin)} -> ${want}`, p.status === want && secOk(p), p.status);
  }
  p = parse(await raw(P, `POST /api/triage HTTP/1.1\r\nHost: ${H}\r\nOrigin: http://evil.com\r\nOrigin: http://${H}\r\nContent-Type: application/json\r\nContent-Length: ${okBody.length}\r\n\r\n${okBody}`));
  check('duplicate Origin (evil first) -> 403', p.status === 403, p.status);
  p = parse(await raw(P, req({ host: H, origin: 'http://evil.com', body: big })));
  check('cross-origin POST with 20KB body -> 403 forbidden_origin (not 413)', p.status === 403 && /forbidden_origin/.test(p.body), p.status);
  for (const m of ['PUT', 'DELETE', 'PATCH']) {
    p = parse(await raw(P, req({ method: m, host: H, origin: 'http://evil.com', body: okBody })));
    check(`${m} cross-origin -> 403 before 405`, p.status === 403, p.status);
  }
  p = parse(await raw(P, req({ method: 'OPTIONS', host: H, origin: `http://${H}`, ct: null, cl: false, extra: ['Access-Control-Request-Method: POST'] })));
  check('OPTIONS preflight -> 405, Allow: POST, no ACAO', p.status === 405 && p.headers.allow === 'POST' && secOk(p), `${p.status} allow=${p.headers.allow}`);
  p = parse(await raw(P, req({ method: 'OPTIONS', host: H, origin: 'http://evil.com', ct: null, cl: false })));
  check('OPTIONS cross-origin -> 403', p.status === 403, p.status);

  // --- Content-Type and size
  const ctCases = [['text/plain', 415], ['application/x-www-form-urlencoded', 415], ['multipart/form-data; boundary=x', 415],
    ['application/json-patch+json', 415], ['application/jsonx', 415], ['application/json; charset=utf-8', 200],
    ['APPLICATION/JSON', 200], [' application/json ;x=y', 200], ['text/plain; application/json', 415], [null, 415]];
  for (const [ct, want] of ctCases) {
    p = parse(await raw(P, req({ host: H, ct, body: okBody })));
    check(`Content-Type ${JSON.stringify(ct)} -> ${want}`, p.status === want && secOk(p), p.status);
  }
  p = parse(await raw(P, req({ host: H, ct: 'text/plain', body: big })));
  check('415 with 20KB body (before body read)', p.status === 415, p.status);
  const exact = JSON.stringify({ ticket: 'a'.repeat(7990) }) + ' '.repeat(16384 - JSON.stringify({ ticket: 'a'.repeat(7990) }).length);
  p = parse(await raw(P, req({ host: H, body: exact })));
  check('exactly 16384 bytes -> 200', p.status === 200, `${p.status} len=${exact.length}`);
  p = parse(await raw(P, req({ host: H, body: exact + ' ' })));
  check('16385 bytes (CL) -> 413', p.status === 413 && secOk(p), p.status);
  p = parse(await raw(P, req({ host: H, cl: false, extra: ['Transfer-Encoding: chunked'], body: '4001\r\n' + exact + ' \r\n0\r\n\r\n' })));
  check('16385 bytes chunked -> 413', p.status === 413, p.status);
  p = parse(await raw(P, req({ host: H, cl: false, extra: ['Transfer-Encoding: chunked'], body: '2000\r\n' + 'x'.repeat(8192) + '\r\n2000\r\n' + 'x'.repeat(8192) + '\r\n1\r\nx\r\n0\r\n\r\n' })));
  check('multi-chunk total 16385 -> 413', p.status === 413, p.status);
  p = parse(await raw(P, req({ host: H, body: JSON.stringify({ ticket: 'é'.repeat(8000) }) })));
  check('8000 two-byte chars (16014 B) -> 200', p.status === 200, p.status);

  // --- JSON / validation / error leakage
  for (const [body, code] of [['{', 'invalid_json'], ['', 'invalid_json'], ['[]', 'invalid_request'], ['null', 'invalid_request'],
    ['"x"', 'invalid_request'], ['{"ticket":1}', 'invalid_request'], ['{"__proto__":{"ticket":"x"}}', 'invalid_request'],
    ['{"ticket":"   "}', 'ticket_empty'], [JSON.stringify({ ticket: 'a'.repeat(8001) }), 'ticket_too_long'],
    ['{"ticket":"' + CANARY + '"', 'invalid_json']]) {
    p = parse(await raw(P, req({ host: H, body })));
    check(`body ${JSON.stringify(body.slice(0, 30))} -> 400 ${code}, no echo`, p.status === 400 && p.body.includes(`"${code}"`) && !p.body.includes(CANARY), p.status);
  }
  p = parse(await raw(P, req({ host: H, body: JSON.stringify({ ticket: 'THROW ' + CANARY }) })));
  check('service throws -> 500 Internal error., no message/stack/canary', p.status === 500 && p.body === '{"error":{"code":"internal_error","message":"Internal error."}}' && secOk(p), p.body);

  // --- Routes / static
  for (const url of ['/../package.json', '/%2e%2e/package.json', '//index.html', '/index.html/', '/INDEX.HTML', '/app.js%00', '/public/app.js', '/favicon.ico', '/api/health/']) {
    p = parse(await raw(P, req({ method: 'GET', url, host: H, ct: null, cl: false })));
    check(`GET ${url} -> 404`, p.status === 404 && secOk(p), p.status);
  }
  p = parse(await raw(P, req({ method: 'GET', url: '/index.html?x=<script>', host: H, ct: null, cl: false })));
  check('GET /index.html?query -> 200 html with security headers', p.status === 200 && /text\/html/.test(p.headers['content-type']) && secOk(p), p.status);
  p = parse(await raw(P, req({ method: 'HEAD', url: '/api/health', host: H, ct: null, cl: false })));
  check('HEAD health -> 200 headers, no body', p.status === 200 && p.body === '' && secOk(p), p.status);
  p = parse(await raw(P, req({ method: 'GET', url: '/api/health', host: H, ct: null, cl: false })));
  check('health body never contains the key', p.status === 200 && !p.body.includes(CANARY) && !p.body.includes('sk-ant'), p.body);
  p = parse(await raw(P, req({ method: 'POST', url: '/api/health', host: H, body: '{}' })));
  check('POST /api/health -> 405 Allow: GET, HEAD', p.status === 405 && p.headers.allow === 'GET, HEAD', p.status);

  // --- Node-parser-level 400 (delivery-lead note): header set
  p = parse(await raw(P, `GET /api/health HTTP/1.1\r\nHost: ${H}\r\nContent-Length: abc\r\n\r\n`));
  results.push(`INFO parser-rejected request -> ${p.first}; security headers present: ${secOk(p)}; body=${JSON.stringify(p.body.slice(0, 60))}`);
  p = parse(await raw(P, `GET /api/health HTTP/1.1\r\nHost: ${H}\r\nContent-Length: 5\r\nTransfer-Encoding: chunked\r\n\r\n0\r\n\r\n`));
  results.push(`INFO CL+TE smuggling attempt -> ${p.first}`);

  // --- Logs: never content, headers, key or messages
  const all = lines.join('\n');
  check('log lines contain no canary/key/ticket text/host/origin/error message', !all.includes(CANARY) && !all.includes('evil') && !all.includes('boom') && !all.includes('hello') && !all.includes('sk-ant'), `${lines.length} lines`);
  const keys = new Set(); for (const l of lines) for (const k of Object.keys(JSON.parse(l))) keys.add(k);
  results.push('INFO log keys: ' + [...keys].join(','));
  check('meta.detail carrying ticket text is dropped (detail regex)', lines.every((l) => JSON.parse(l).detail === null || /^[A-Za-z0-9_:,]+$/.test(JSON.parse(l).detail)));
  results.push(`INFO service.analyse called ${calls} times`);

  console.log(results.join('\n'));
  console.log(`\n${failures} failure(s)`);
  server.close();
  process.exit(failures ? 1 : 0);
})();
