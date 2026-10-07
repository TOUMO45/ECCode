'use strict';
// Scratch probe (t06): client aborts mid-body, and aborts after a 413; the server must keep running and log once per request.
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const root = path.join(__dirname, '..', '..');
const { createServer } = require(path.join(root, 'src/http-server.js'));
const { loadConfig } = require(path.join(root, 'src/config.js'));
const { createLogger } = require(path.join(root, 'src/log.js'));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'abort-probe-'));
for (const f of ['index.html', 'app.js', 'styles.css']) fs.writeFileSync(path.join(dir, f), f);
const lines = [];
let calls = 0;
const server = createServer({ config: loadConfig({ PORT: '0' }), service: { analyse: async () => { calls++; return { response: {}, meta: {} }; } }, log: createLogger((l) => lines.push(JSON.parse(l))), staticDir: dir });
process.on('uncaughtException', (e) => { console.log('UNCAUGHT', e.code || e.name); process.exitCode = 1; });
process.on('unhandledRejection', (e) => { console.log('UNHANDLED', e && (e.code || e.name)); process.exitCode = 1; });
server.listen(0, '127.0.0.1', async () => {
  const port = server.address().port;
  const abortAfter = (headers, chunk) => new Promise((resolve) => {
    const req = http.request({ port, host: '127.0.0.1', method: 'POST', path: '/api/triage', headers: { host: `127.0.0.1:${port}`, 'content-type': 'application/json', ...headers }, agent: false });
    req.on('error', () => {});
    req.on('response', (res) => { res.resume(); });
    req.write(chunk);
    setTimeout(() => { req.destroy(); setTimeout(resolve, 50); }, 50);
  });
  await abortAfter({ 'content-length': '1000' }, '{"ticket":"par');
  await abortAfter({}, 'x'.repeat(17000));
  // Expect: 100-continue on a rejected request: the server must answer 403 without sending 100 Continue.
  const cont = await new Promise((resolve) => {
    const req = http.request({ port, host: '127.0.0.1', method: 'POST', path: '/api/triage', headers: { host: 'evil.example', 'content-type': 'application/json', 'content-length': '10', expect: '100-continue' }, agent: false });
    let continued = false;
    req.on('continue', () => { continued = true; });
    req.on('response', (res) => { res.resume(); res.on('end', () => resolve({ status: res.statusCode, continued })); });
    req.on('error', (e) => resolve({ error: e.code }));
    req.flushHeaders();
  });
  const cont2 = await new Promise((resolve) => {
    const req = http.request({ port, host: '127.0.0.1', method: 'POST', path: '/api/triage', headers: { host: `127.0.0.1:${port}`, 'content-type': 'application/json', 'content-length': '14', expect: '100-continue' }, agent: false });
    let continued = false;
    req.on('continue', () => { continued = true; req.end('{"ticket":"x"}'); });
    req.on('response', (res) => { res.resume(); res.on('end', () => resolve({ status: res.statusCode, continued })); });
    req.on('error', (e) => resolve({ error: e.code }));
    req.flushHeaders();
  });
  const health = await new Promise((resolve) => http.get({ port, host: '127.0.0.1', path: '/api/health', agent: false }, (res) => { res.resume(); resolve(res.statusCode); }));
  console.log(JSON.stringify({ requestLines: lines.filter((l) => l.event === 'request').map((l) => [l.route, l.status, l.errorCode]), errorEvents: lines.filter((l) => l.event === 'error').length, calls, expectContinueRejected: cont, expectContinueAccepted: cont2, healthAfter: health }));
  server.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
