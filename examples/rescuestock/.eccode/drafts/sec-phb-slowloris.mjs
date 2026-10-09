// Security probe, phase B: does the server close a connection whose header block never completes, or whose body never
// completes (slowloris / slow POST)? Uses the project's createHttpServer (src/http/server.js) and the full createApp.
// Each scenario runs on its own fresh server, all in parallel, for up to 75 s:
//   A: partial header block once, then silent
//   B: partial header block, then one more header line every second
//   C: complete headers with Content-Length: 100, body never sent
//   D: complete headers with Content-Length: 1000, one body byte per second
//   B after X: scenario B, started right after one earlier request of kind X on the same server
//             (X = ok request, 431 header overflow, 400 parse error); this isolates what the app probe hit.
// Usage: node --disable-warning=ExperimentalWarning .eccode/drafts/sec-phb-slowloris.mjs
import net from 'node:net';
import { join, resolve } from 'node:path';

const ROOT = resolve(process.argv[1], '../../..');
const { createHttpServer, listen, closeServer } = await import(join(ROOT, 'src/http/server.js'));

const LIMIT = 75000;
const once = (port, text) => new Promise((done) => {
  const s = net.connect(port, '127.0.0.1');
  let out = '';
  s.on('data', (c) => { out += c.toString('latin1'); });
  s.on('error', () => {});
  s.on('close', () => done(out.split('\r\n')[0]));
  s.write(text);
  setTimeout(() => s.destroy(), 3000);
});
function slow(port, first, drip) {
  return new Promise((done) => {
    const started = Date.now();
    const sock = net.connect(port, '127.0.0.1');
    let reply = '';
    sock.on('error', () => {});
    sock.on('data', (c) => { reply += c.toString('latin1'); });
    sock.write(first);
    const iv = drip ? setInterval(() => { if (!sock.destroyed) sock.write(drip); }, 1000) : null;
    let settled = false;
    const finish = (ms) => { if (settled) return; settled = true; if (iv) clearInterval(iv); sock.destroy(); done({ ms, reply: reply.split('\r\n')[0] || '(no response)' }); };
    sock.on('close', () => finish(Date.now() - started));
    setTimeout(() => finish(-1), LIMIT);
  });
}

async function scenario(name, prior, first, drip) {
  const server = createHttpServer(async (req, res) => { for await (const _ of req) { /* drain */ } res.end('ok'); });
  const port = await listen(server, 0, '127.0.0.1');
  let priorStatus = '';
  if (prior) priorStatus = await once(port, prior);
  const r = await slow(port, first, drip);
  await closeServer(server);
  return { name: prior ? `${name} (prior: ${priorStatus})` : name, ...r };
}

const H = 'GET / HTTP/1.1\r\nHost: x\r\n';
const results = await Promise.all([
  scenario('A partial headers, silent', null, H, null),
  scenario('B partial headers, one line per second', null, H, 'X-a: b\r\n'),
  scenario('C complete headers, body never sent', null, 'POST / HTTP/1.1\r\nHost: x\r\nContent-Length: 100\r\n\r\n', null),
  scenario('D complete headers, one body byte per second', null, 'POST / HTTP/1.1\r\nHost: x\r\nContent-Length: 1000\r\n\r\n', 'a'),
  scenario('B after an ok request', 'GET / HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n', H, 'X-a: b\r\n'),
  scenario('B after a 431', `GET / HTTP/1.1\r\nHost: x\r\nX-Big: ${'a'.repeat(17000)}\r\n\r\n`, H, 'X-a: b\r\n'),
  scenario('B after a 400', 'GET / HTTP/1.1\r\nHost: x\r\nContent-Length: 1\r\nContent-Length: 2\r\n\r\n', H, 'X-a: b\r\n'),
  scenario('A after a 431', `GET / HTTP/1.1\r\nHost: x\r\nX-Big: ${'a'.repeat(17000)}\r\n\r\n`, H, null),
]);
console.log(`node ${process.version}; headersTimeout 10000, requestTimeout 30000, connectionsCheckingInterval 30000 (default)`);
for (const r of results) console.log(`${r.name}: ${r.ms < 0 ? `STILL OPEN at ${LIMIT / 1000} s` : `closed after ${(r.ms / 1000).toFixed(1)} s`} (${r.reply})`);
const open = results.filter((r) => r.ms < 0).map((r) => r.name);
console.log(open.length ? `REPRO connections never closed by the server: ${open.join('; ')}` : 'every slow connection was closed');
process.exitCode = open.length ? 1 : 0;
