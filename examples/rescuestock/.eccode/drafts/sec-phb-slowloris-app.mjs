// Security probe, phase B: slow-header connection against the full createApp after earlier requests of a given
// kind, each scenario on its own fresh app server (temporary database), all in parallel, up to 100 s each.
// Isolates which earlier request lets a never-finished header block stay open past headersTimeout + one check interval.
// Usage: node --disable-warning=ExperimentalWarning .eccode/drafts/sec-phb-slowloris-app.mjs
import net from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
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

const LIMIT = 100000;
const once = (port, text) => new Promise((done) => {
  const s = net.connect(port, '127.0.0.1');
  let out = '';
  s.on('data', (c) => { out += c.toString('latin1'); });
  s.on('error', () => {});
  const t = setTimeout(() => s.destroy(), 3000);
  s.on('close', () => { clearTimeout(t); done(out.split('\r\n')[0] || '(none)'); });
  s.write(typeof text === 'string' ? Buffer.from(text, 'latin1') : text);
});
function slow(port, host) {
  return new Promise((done) => {
    const started = Date.now();
    const sock = net.connect(port, '127.0.0.1');
    let reply = '';
    sock.on('error', () => {});
    sock.on('data', (c) => { reply += c.toString('latin1'); });
    sock.write(`GET /api/health HTTP/1.1\r\nHost: ${host}\r\n`);
    const iv = setInterval(() => { if (!sock.destroyed) sock.write('X-a: b\r\n'); }, 1000);
    let settled = false;
    const finish = (ms) => { if (settled) return; settled = true; clearInterval(iv); sock.destroy(); done({ ms, reply: reply.split('\r\n')[0] || '(no response)' }); };
    sock.on('close', () => finish(Date.now() - started));
    setTimeout(() => finish(-1), LIMIT);
  });
}
const echo = (router) => router.add('POST', '/api/probe/echo', async (ctx) => {
  const body = await ctx.body();
  let fp;
  try { fp = canonicalJson(body).length; } catch (e) { fp = e.name; }
  return { body: { fp: String(fp) } };
}, { policy: 'public' });

async function scenario(name, priors) {
  const work = mkdtempSync(join(tmpdir(), 'sec-phb-slow-'));
  const db = openDb(join(work, 'app.db'));
  migrate(db);
  const app = createApp({ db, config: loadConfig({ PORT: '0', RS_TEST_OFFLINE: '1' }), log: createLogger({ write: () => {} }), publicDir: work, routes: [echo] });
  const port = await app.listen(0, '127.0.0.1');
  const host = `127.0.0.1:${port}`;
  const statuses = [];
  for (const p of priors) statuses.push(await once(port, p(host)));
  const r = await slow(port, host);
  await app.close();
  db.close();
  rmSync(work, { recursive: true, force: true });
  return { name: `${name} [${statuses.join(' | ')}]`, ...r };
}

const post = (h, body, extra = '') => Buffer.concat([Buffer.from(`POST /api/probe/echo HTTP/1.1\r\nHost: ${h}\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n${extra}Connection: close\r\n\r\n`), Buffer.from(body)]);
const deep = (h) => post(h, `{"a":${'['.repeat(20000)}${']'.repeat(20000)}}`);
const big413 = (h) => post(h, `{"a":"${'x'.repeat(70000)}"}`);
const chunked413 = (h) => { const b = Buffer.from(`{"a":"${'x'.repeat(70000)}"}`); return Buffer.concat([Buffer.from(`POST /api/probe/echo HTTP/1.1\r\nHost: ${h}\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n${b.length.toString(16)}\r\n`), b, Buffer.from('\r\n0\r\n\r\n')]); };
const bareCr = (h) => `GET /api/health HTTP/1.1\r\nHost: ${h}\r\nX-Request-Id: aaaaaaaa\rSet-Cookie: x=1\r\nConnection: close\r\n\r\n`;
const dupCl = (h) => post(h, '{"a":1}', 'Content-Length: 7\r\n');
const big431 = (h) => `GET /api/health HTTP/1.1\r\nHost: ${h}\r\nX-Big: ${'a'.repeat(17000)}\r\nConnection: close\r\n\r\n`;
const results = await Promise.all([
  scenario('no prior request', []),
  scenario('after a 20000-deep JSON body (canonicalJson RangeError)', [deep]),
  scenario('after a declared 70 kB body (413)', [big413]),
  scenario('after a chunked 70 kB body (413)', [chunked413]),
  scenario('after a bare CR in a header (400)', [bareCr]),
  scenario('after duplicate Content-Length (400)', [dupCl]),
  scenario('after a 431', [big431]),
]);
console.log(`node ${process.version}; app server: headersTimeout 10000, requestTimeout 30000, keepAliveTimeout 5000, connectionsCheckingInterval 30000`);
for (const r of results) console.log(`${r.name}: ${r.ms < 0 ? `STILL OPEN at ${LIMIT / 1000} s` : `closed after ${(r.ms / 1000).toFixed(1)} s`} (${r.reply})`);
const late = results.filter((r) => r.ms < 0 || r.ms > 41000).map((r) => r.name);
console.log(late.length ? `REPRO slow-header connections open beyond 41 s: ${late.join('; ')}` : 'every slow connection was closed within 41 s');
process.exitCode = late.length ? 1 : 0;
