// Security probe, phase B HTTP boundary (security-reviewer). Runs the real createApp on a real
// node:http server over a temporary database and a temporary public/ directory, and sends raw
// bytes over sockets so that nothing is normalised by a client library.
// Usage: node --disable-warning=ExperimentalWarning .eccode/drafts/sec-phb-http.mjs [--slowloris]
// Exit 0 when every expectation holds; exit 1 lists the failures.
import net from 'node:net';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const ROOT = resolve(process.argv[1], '../../..');
const imp = (p) => import(join(ROOT, p));
const { createApp } = await imp('src/app.js');
const { loadConfig } = await imp('src/config.js');
const { openDb } = await imp('src/db/connection.js');
const { migrate } = await imp('src/db/migrate.js');
const { createLogger } = await imp('src/log.js');
const { canonicalJson } = await imp('src/http/body.js');
const { AppError: DomainAppError } = await imp('src/domain/errors.js');

const failures = [];
const expect = (cond, label, info = '') => {
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${label}${info ? ` | ${info}` : ''}`);
  if (!cond) failures.push(label);
};

const work = mkdtempSync(join(tmpdir(), 'sec-phb-http-'));
const pub = join(work, 'public');
mkdirSync(join(pub, 'sub'), { recursive: true });
mkdirSync(join(work, 'outside'));
writeFileSync(join(pub, 'index.html'), '<!doctype html><title>idx</title>');
writeFileSync(join(pub, 'sub', 'x.txt'), 'inner file');
writeFileSync(join(pub, '.env'), 'DOTFILE_SECRET');
writeFileSync(join(work, 'secret.txt'), 'TOPSECRET_OUTSIDE');
writeFileSync(join(work, 'outside', 'secret.txt'), 'TOPSECRET_OUTSIDE');
symlinkSync(join(work, 'secret.txt'), join(pub, 'link-out'));
symlinkSync(join(work, 'outside'), join(pub, 'linkdir'));

const db = openDb(join(work, 'app.db'), { busyTimeoutMs: 0 });
migrate(db);
const lines = [];
const log = createLogger({ write: (l) => lines.push(l) });
const config = loadConfig({ PORT: '0', RS_TEST_OFFLINE: '1', RS_DB_BUSY_TIMEOUT_MS: '0' });

const probeRoutes = (router, deps) => {
  router.add('POST', '/api/probe/echo', async (ctx) => {
    const body = await ctx.body();
    let fp;
    try { fp = canonicalJson(body).length; } catch (e) { fp = `throws ${e.name}`; }
    return { body: { keys: Object.keys(body), polluted: ({}).polluted === undefined ? 'no' : 'YES', fp: String(fp) } };
  }, { policy: 'public' });
  for (const policy of ['session', 'customer', 'supplier', 'admin', 'signature']) {
    router.add('GET', `/api/probe/${policy}`, () => ({ body: { reached: true } }), { policy });
    router.add('POST', `/api/probe/${policy}`, () => ({ body: { reached: true } }), { policy });
  }
  router.add('GET', '/api/probe/throw', () => { throw new Error('at /home/user/secret/path.js SELECT password_hash FROM users'); }, { policy: 'public' });
  router.add('GET', '/api/probe/domain', () => { throw new DomainAppError(409, 'INVALID_STATE', 'leak <b>input</b>', { from: 'a', to: 'b' }); }, { policy: 'public' });
  router.add('GET', '/api/probe/domain-unknown', () => { throw new DomainAppError(418, 'TEAPOT_LEAK', 'leak'); }, { policy: 'public' });
  router.add('GET', '/api/probe/constraint', () => {
    deps.db.prepare("INSERT INTO meta (key, value) VALUES ('dup', 'x')").run();
    deps.db.prepare("INSERT INTO meta (key, value) VALUES ('dup', 'x')").run();
    return { body: {} };
  }, { policy: 'public' });
  router.add('GET', '/api/probe/busy', () => {
    deps.db.tx(() => deps.db.prepare("INSERT OR IGNORE INTO meta (key, value) VALUES ('busy', 'x')").run());
    return { body: {} };
  }, { policy: 'public' });
};

const app = createApp({ db, config, log, publicDir: pub, routes: [probeRoutes] });
const port = await app.listen(0, '127.0.0.1');
const H = `127.0.0.1:${port}`;

function raw(text, { timeoutMs = 3000 } = {}) {
  return new Promise((res) => {
    const sock = net.connect(port, '127.0.0.1');
    const chunks = [];
    const t = setTimeout(() => { sock.destroy(); res(Buffer.concat(chunks).toString('latin1')); }, timeoutMs);
    sock.on('data', (c) => chunks.push(c));
    sock.on('close', () => { clearTimeout(t); res(Buffer.concat(chunks).toString('latin1')); });
    sock.on('error', () => {});
    sock.write(typeof text === 'string' ? Buffer.from(text, 'latin1') : text);
  });
}
function parse(resp) {
  const [head, ...rest] = resp.split('\r\n\r\n');
  const [statusLine, ...hs] = head.split('\r\n');
  const headers = {};
  for (const h of hs) {
    const i = h.indexOf(':');
    if (i > 0) {
      const k = h.slice(0, i).toLowerCase();
      headers[k] = (headers[k] ? `${headers[k]}, ` : '') + h.slice(i + 1).trim();
    }
  }
  return { status: Number(statusLine.split(' ')[1]), headers, body: rest.join('\r\n\r\n') };
}
const get = async (path, extra = '', host = H) => parse(await raw(`GET ${path} HTTP/1.1\r\nHost: ${host}\r\n${extra}Connection: close\r\n\r\n`));

const SEC_HEADERS = {
  'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
  'cross-origin-opener-policy': 'same-origin',
  'permissions-policy': 'camera=(), microphone=(), geolocation=()',
};
function headersOk(r, label, api) {
  const missing = Object.entries(SEC_HEADERS).filter(([k, v]) => r.headers[k] !== v).map(([k]) => k);
  const cors = Object.keys(r.headers).filter((k) => k.startsWith('access-control-'));
  const cache = api ? r.headers['cache-control'] === 'no-store' : true;
  expect(missing.length === 0 && cors.length === 0 && cache && /^[A-Za-z0-9-]{8,64}$/.test(r.headers['x-request-id'] || ''),
    `security headers, no CORS, X-Request-Id: ${label}`, `status ${r.status}; missing [${missing}] cors [${cors}] cache ${r.headers['cache-control']}`);
}

console.log('# A. Routes registered by phase B (no probe routes)');
{
  const plain = createApp({ db, config, log: createLogger({ write: () => {} }), publicDir: pub });
  const list = plain.router.list();
  console.log(JSON.stringify(list));
  expect(list.every((r) => r.policy === 'public') && list.length === 2, 'only GET /api/health and GET /api/config are registered, both public');
}

console.log('# B. Default deny (no authorize hook)');
for (const policy of ['session', 'customer', 'supplier', 'admin', 'signature']) {
  for (const method of ['GET', 'POST']) {
    const r = parse(await raw(`${method} /api/probe/${policy} HTTP/1.1\r\nHost: ${H}\r\nOrigin: http://evil.example\r\nContent-Type: application/json\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}`));
    expect(r.status === 401 && r.body.includes('"UNAUTHENTICATED"') && !r.body.includes('reached'), `${method} ${policy} route -> 401 without authorize`, `got ${r.status}`);
  }
}

console.log('# C. Host allow-list (SEC-13)');
for (const [host, want] of [
  [H, 200], [`localhost:${port}`, 200], [`LOCALHOST:${port}`, 200], ['evil.example', 421], [`evil.example:${port}`, 421],
  ['127.0.0.1', 421], ['localhost', 421], [`127.0.0.1:${port}.`, 421], [`127.0.0.1:${port}@evil.example`, 421], [`[::1]:${port}`, 421],
  [`127.0.0.1:${port} `, 200],
]) {
  const r = await get('/api/health', '', host);
  expect(r.status === want, `Host "${host}" -> ${want}`, `got ${r.status}`);
  if (want === 421) headersOk(r, `421 for ${host}`, true);
}
{
  const r = parse(await raw('GET /api/health HTTP/1.0\r\n\r\n'));
  expect(r.status === 421, 'HTTP/1.0 without Host -> 421', `got ${r.status}`);
  const r2 = parse(await raw(`GET http://evil.example/api/health HTTP/1.1\r\nHost: ${H}\r\nConnection: close\r\n\r\n`));
  expect(r2.status === 400, 'absolute-form request target -> 400', `got ${r2.status}`);
}

console.log('# D. Request id (pattern ^[A-Za-z0-9-]{8,64}$)');
for (const [value, echoed] of [
  ['abcdEFGH-1234', true], ['a'.repeat(64), true], ['a'.repeat(65), false], ['short', false], ['abc_defgh', false],
  ['aaaaaaaa"},"level":"admin', false], ['aaaaaaaa\tbbbb', false], ['aaaaaaaa%0d%0aSet-Cookie:x=1', false],
]) {
  const r = await get('/api/health', `X-Request-Id: ${value}\r\n`);
  const got = r.headers['x-request-id'];
  const bodyId = (/"requestId":"([^"]*)"/.exec(r.body) || [])[1];
  expect((got === value) === echoed && /^[A-Za-z0-9-]{8,64}$/.test(got) && bodyId === got, `X-Request-Id ${JSON.stringify(value).slice(0, 40)} ${echoed ? 'echoed' : 'replaced'}`, `got ${got}`);
}
{
  const r = await get('/api/health', 'X-Request-Id: aaaaaaaa1\r\nX-Request-Id: bbbbbbbb2\r\n');
  expect(/^[A-Za-z0-9-]{8,64}$/.test(r.headers['x-request-id']), 'duplicate X-Request-Id headers -> valid id', r.headers['x-request-id']);
  const crlf = await raw(`GET /api/health HTTP/1.1\r\nHost: ${H}\r\nX-Request-Id: aaaaaaaa\rSet-Cookie: x=1\r\nConnection: close\r\n\r\n`);
  expect(!/\r\nset-cookie/i.test(crlf), 'bare CR inside X-Request-Id cannot inject a response header', crlf.split('\r\n')[0]);
}

console.log('# E. Security headers on every kind of response');
headersOk(await get('/api/health'), '200 /api/health', true);
headersOk(await get('/api/config'), '200 /api/config', true);
headersOk(await get('/api/nope'), '404 /api/nope', true);
headersOk(parse(await raw(`DELETE /api/health HTTP/1.1\r\nHost: ${H}\r\nConnection: close\r\n\r\n`)), '405 DELETE /api/health', true);
{
  const r400a = await get('//x');
  const r400b = await get(`/api/${'a'.repeat(2100)}`);
  expect(r400a.status === 400 && r400b.status === 400, 'protocol-relative target and > 2048-char target -> 400 BAD_REQUEST', `${r400a.status} ${r400b.status}`);
  headersOk(r400a, '400 // target (rejected before routing)', true);
  headersOk(r400b, '400 over-long target', true);
}
headersOk(await get('/api/probe/throw'), '500 handler error', true);
headersOk(await get('/index.html'), 'static 200 /index.html', false);
headersOk(await get('/no-such-page'), 'static 404', false);
{
  const r = parse(await raw(`DELETE /api/health HTTP/1.1\r\nHost: ${H}\r\nConnection: close\r\n\r\n`));
  expect(r.status === 405 && r.headers.allow === 'GET', 'DELETE /api/health -> 405 Allow: GET', `${r.status} ${r.headers.allow}`);
  const p = parse(await raw(`PROPFIND /api/health HTTP/1.1\r\nHost: ${H}\r\nConnection: close\r\n\r\n`));
  expect(p.status === 405, 'PROPFIND /api/health -> 405', `${p.status}`);
  const o = parse(await raw(`OPTIONS /api/health HTTP/1.1\r\nHost: ${H}\r\nOrigin: http://evil.example\r\nAccess-Control-Request-Method: POST\r\nConnection: close\r\n\r\n`));
  expect(o.status === 405 && !Object.keys(o.headers).some((k) => k.startsWith('access-control-')), 'CORS preflight -> 405, no Access-Control-* (SEC-20)', `${o.status}`);
  const cfg = await get('/api/config', 'Origin: http://evil.example\r\n');
  expect(!Object.keys(cfg.headers).some((k) => k.startsWith('access-control-')), 'GET /api/config with foreign Origin has no Access-Control-*');
}

console.log('# F. Error envelope leaks nothing');
{
  const r = await get('/api/probe/throw');
  expect(r.status === 500 && !/home|SELECT|password|stack|at /.test(r.body), '500 INTERNAL body has no message, path, SQL or stack', r.body);
  const d = await get('/api/probe/domain');
  expect(d.status === 409 && !d.body.includes('leak') && d.body.includes('"INVALID_STATE"'), 'domain AppError -> catalog message, no echoed text', d.body);
  const u = await get('/api/probe/domain-unknown');
  expect(u.status === 500 && !u.body.includes('TEAPOT'), 'domain AppError with unknown code -> 500 INTERNAL', u.body);
  const c = await get('/api/probe/constraint');
  expect(c.status === 500 && !/UNIQUE|meta|constraint|INSERT/i.test(c.body), 'SQLITE_CONSTRAINT -> 500 with no SQL text', c.body);
  const leaked = lines.filter((l) => /home\/user|SELECT|UNIQUE constraint|leak/.test(l));
  expect(leaked.length === 0, 'log lines carry no error message, SQL or path', leaked.join(' '));
}

console.log('# G. SQLITE_BUSY -> 503 DB_BUSY + Retry-After: 1');
{
  const holder = openDb(join(work, 'app.db'), { busyTimeoutMs: 0 });
  holder.exec('BEGIN IMMEDIATE');
  const r = await get('/api/probe/busy');
  holder.exec('ROLLBACK');
  holder.close();
  expect(r.status === 503 && r.headers['retry-after'] === '1' && r.body.includes('"DB_BUSY"'), 'write while another connection holds the lock -> 503 DB_BUSY', `${r.status} ${r.headers['retry-after']}`);
}

console.log('# H. JSON body handling');
const post = async (body, { type = 'application/json', chunked = false, extra = '' } = {}) => {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf8');
  let req;
  if (chunked) {
    req = Buffer.concat([Buffer.from(`POST /api/probe/echo HTTP/1.1\r\nHost: ${H}\r\nContent-Type: ${type}\r\nTransfer-Encoding: chunked\r\n${extra}Connection: close\r\n\r\n${buf.length.toString(16)}\r\n`), buf, Buffer.from('\r\n0\r\n\r\n')]);
  } else {
    req = Buffer.concat([Buffer.from(`POST /api/probe/echo HTTP/1.1\r\nHost: ${H}\r\nContent-Type: ${type}\r\nContent-Length: ${buf.length}\r\n${extra}Connection: close\r\n\r\n`), buf]);
  }
  return parse(await raw(req));
};
{
  const big = `{"a":"${'x'.repeat(70000)}"}`;
  const r1 = await post(big);
  expect(r1.status === 413 && r1.body.includes('PAYLOAD_TOO_LARGE'), 'declared 70 kB JSON -> 413', `${r1.status}`);
  const r2 = await post(big, { chunked: true });
  expect(r2.status === 413, 'chunked 70 kB JSON (no Content-Length) -> 413 while streaming', `${r2.status}`);
  const exact = `{"a":"${'x'.repeat(65536 - 8)}"}`;
  const r3 = await post(exact);
  expect(r3.status === 200, 'exactly 65,536 bytes accepted', `${r3.status} len ${Buffer.byteLength(exact)}`);
  const r4 = await post('{"a":');
  expect(r4.status === 400 && r4.body.includes('INVALID_JSON'), 'truncated JSON -> 400 INVALID_JSON', `${r4.status}`);
  const r5 = await post(Buffer.from([0x7b, 0x22, 0x61, 0x22, 0x3a, 0x22, 0xff, 0x22, 0x7d]));
  expect(r5.status === 400 && r5.body.includes('INVALID_JSON'), 'invalid UTF-8 -> 400 INVALID_JSON', `${r5.status}`);
  const r6 = await post('{"a":1}', { type: 'text/plain' });
  expect(r6.status === 415, 'non-JSON content type -> 415', `${r6.status}`);
  const r7 = await post('[1,2]');
  expect(r7.status === 422, 'array body -> 422 VALIDATION_FAILED', `${r7.status}`);
  const r8 = await post('{"__proto__":{"polluted":1},"constructor":{"prototype":{"polluted":1}}}');
  expect(r8.status === 200 && r8.body.includes('"polluted":"no"') && ({}).polluted === undefined, '__proto__ / constructor keys do not pollute Object.prototype', r8.body);
  const r9 = await post('{"a":1}', { extra: 'Content-Length: 7\r\n' });
  expect(r9.status === 400, 'duplicate Content-Length rejected by the parser', `${r9.status}`);
  const depth = 20000;
  const deep = `{"a":${'['.repeat(depth)}${']'.repeat(depth)}}`;
  const r10 = await post(deep);
  console.log(`info deep nesting (${depth} levels, ${deep.length} bytes): status ${r10.status} body ${r10.body.slice(0, 160)}`);
  expect(r10.body.includes('throws RangeError'), 'reproduction: canonicalJson (the idempotency fingerprint) throws RangeError on a 40 kB nested body that readJsonObject accepted');
  const alive = await get('/api/health');
  expect(alive.status === 200, 'server still answers after the deep-nesting body', `${alive.status}`);
}

console.log('# I. Static handler confinement');
const staticCases = [
  '/../secret.txt', '/%2e%2e/secret.txt', '/%2e%2e%2fsecret.txt', '/..%2fsecret.txt', '/sub/..%2f..%2fsecret.txt',
  '/sub/%2e%2e/%2e%2e/secret.txt', '/%2E%2E/%2E%2E/secret.txt', '/link-out', '/linkdir/secret.txt', '/linkdir/', '/.env', '/%2eenv',
  '/sub/.%2e/.%2e/secret.txt', '/index.html%00.txt', '/%00', '/..%5csecret.txt', '/sub%5c..%5c..%5csecret.txt', '//secret.txt',
  '/%252e%252e/secret.txt', '/%c0%ae%c0%ae/secret.txt', '/sub/x.txt/..%2f..%2f..%2fsecret.txt',
];
for (const p of staticCases) {
  const r = await get(p);
  expect(!r.body.includes('TOPSECRET') && !r.body.includes('DOTFILE_SECRET') && r.status !== 200, `static ${p} not served`, `${r.status}`);
}
{
  const ok1 = await get('/');
  const ok2 = await get('/sub/x.txt');
  const ok3 = await get('/sub/./x.txt');
  expect(ok1.status === 200 && ok1.body.includes('idx') && ok2.status === 200 && ok3.status === 200, 'static control: /, /sub/x.txt and /sub/./x.txt served', `${ok1.status} ${ok2.status} ${ok3.status}`);
  const head = parse(await raw(`HEAD /index.html HTTP/1.1\r\nHost: ${H}\r\nConnection: close\r\n\r\n`));
  expect(head.status === 200 && head.body === '', 'HEAD on a static file: 200 without a body');
  const postStatic = parse(await raw(`POST /index.html HTTP/1.1\r\nHost: ${H}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`));
  expect(postStatic.status === 404, 'POST to a static path -> 404', `${postStatic.status}`);
  const apiStatic = await get('/api/../index.html');
  console.log(`info /api/../index.html -> ${apiStatic.status} (URL normalisation resolves to /index.html)`);
}

console.log('# J. Log lines');
{
  await get('/api/nothing%0a%7b%22level%22:%22forged%22%7d', 'X-Request-Id: aaaaaaaa"}\r\n');
  await new Promise((r) => setTimeout(r, 50));
  let allJson = true;
  for (const l of lines) { try { JSON.parse(l); } catch { allJson = false; } }
  const forged = lines.filter((l) => l.includes('forged'));
  expect(allJson && lines.every((l) => l.endsWith('\n') && l.indexOf('\n') === l.length - 1), 'every log line is one JSON object on one line', `${lines.length} lines`);
  expect(forged.length === 0, 'the raw request path never reaches a log line', forged.join(''));
  const keys = new Set(lines.flatMap((l) => Object.keys(JSON.parse(l))));
  console.log(`info log keys seen: ${[...keys].join(',')}`);
}

console.log('# K. Server timeouts');
{
  const s = app.server;
  console.log(`info headersTimeout=${s.headersTimeout} requestTimeout=${s.requestTimeout} keepAliveTimeout=${s.keepAliveTimeout} maxHeaderSize=16384 connectionsCheckingInterval=${s.connectionsCheckingInterval ?? 'default 30000'} maxConnections=${s.maxConnections}`);
  expect(s.headersTimeout === 10000 && s.requestTimeout === 30000 && s.keepAliveTimeout === 5000, 'server timeouts 10 s / 30 s / 5 s as specified');
  const big = parse(await raw(`GET /api/health HTTP/1.1\r\nHost: ${H}\r\nX-Big: ${'a'.repeat(17000)}\r\nConnection: close\r\n\r\n`));
  expect(big.status === 431, 'header block > 16 KiB -> 431', `${big.status}`);
  if (process.argv.includes('--slowloris')) {
    const started = Date.now();
    const closedAfter = await new Promise((res) => {
      const sock = net.connect(port, '127.0.0.1');
      sock.on('error', () => {});
      sock.write(`GET /api/health HTTP/1.1\r\nHost: ${H}\r\n`);
      const iv = setInterval(() => { if (!sock.destroyed) sock.write('X-a: b\r\n'); }, 1000);
      sock.on('close', () => { clearInterval(iv); res(Date.now() - started); });
      setTimeout(() => { clearInterval(iv); sock.destroy(); res(-1); }, 50000);
    });
    console.log(`info slow-header connection (one header line per second) closed after ${closedAfter} ms (-1 = still open at 50 s)`);
    expect(closedAfter > 0 && closedAfter <= 41000, 'a never-finished header block is closed within headersTimeout + check interval (<= 41 s)', `${closedAfter} ms`);
  }
}

await app.close();
db.close();
rmSync(work, { recursive: true, force: true });
console.log(failures.length === 0 ? '\nALL HTTP PROBES PASSED' : `\n${failures.length} FAILED:\n- ${failures.join('\n- ')}`);
process.exitCode = failures.length === 0 ? 0 : 1;
