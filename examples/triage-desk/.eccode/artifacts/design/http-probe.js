// Probe for spec §Interface Contracts C1/C5 and §Testing Strategy: can a node:http server answer 403
// before reading a 20 KB body without the client seeing ECONNRESET, and can a node:http client
// send an arbitrary / missing Host and an Origin header? Run: node http-probe.js
'use strict';
const http = require('node:http');
const assert = require('node:assert');

function makeServer(drain) {
  // requireHostHeader:false — Node >=20 otherwise answers a Host-less HTTP/1.1 request with its own 400 before the handler runs.
  return http.createServer({ requireHostHeader: false }, (req, res) => {
    if (req.headers.host !== 'localhost:' + req.socket.localPort) {
      const body = JSON.stringify({ error: { code: 'forbidden_host', message: 'Host not allowed' } });
      res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body), Connection: 'close' });
      res.end(body);
      if (drain) req.resume(); // discard without buffering or parsing
      return;
    }
    let n = 0;
    req.on('data', (c) => { n += c.length; });
    req.on('end', () => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ n, origin: req.headers.origin || null })); });
  });
}

function request(port, { method = 'POST', host, setHost = true, headers = {}, body }) {
  return new Promise((resolve) => {
    const h = { ...headers };
    if (host !== undefined) h.host = host;
    const req = http.request({ host: '127.0.0.1', port, method, path: '/api/triage', headers: h, setHost, agent: false }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
      res.on('error', (e) => resolve({ error: e.code }));
    });
    req.on('error', (e) => resolve({ error: e.code }));
    if (body) req.write(body);
    req.end();
  });
}

(async () => {
  const results = {};
  for (const drain of [false, true]) {
    const srv = makeServer(drain);
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const port = srv.address().port;
    let ok = 0; let err = 0; const errs = new Set();
    for (let i = 0; i < 200; i++) {
      const r = await request(port, { host: 'attacker.example:3000', headers: { 'content-type': 'application/json' }, body: 'x'.repeat(20 * 1024) });
      if (r.status === 403) ok++; else { err++; errs.add(r.error || r.status); }
    }
    results[drain ? 'with_req_resume' : 'without_drain'] = { got403: ok, failed: err, errors: [...errs] };
    if (drain) {
      const noHost = await request(port, { setHost: false });
      const good = await request(port, { host: 'localhost:' + port, headers: { origin: 'http://localhost:' + port, 'content-type': 'application/json' }, body: '{"ticket":"x"}' });
      results.missingHost = noHost.status;
      results.customHostAndOrigin = good;
      assert.strictEqual(noHost.status, 403);
      assert.strictEqual(good.status, 200);
      assert.strictEqual(JSON.parse(good.body).origin, 'http://localhost:' + port);
    }
    await new Promise((r) => srv.close(r));
  }
  // Can global fetch (undici) set Host / Origin? (decides which client the contract tests must use)
  const srv = http.createServer((req, res) => { res.end(JSON.stringify({ host: req.headers.host, origin: req.headers.origin || null })); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  try {
    const r = await fetch('http://127.0.0.1:' + port + '/', { headers: { host: 'attacker.example:3000', origin: 'http://attacker.example:3000' } });
    results.fetchHeaders = await r.json();
  } catch (e) { results.fetchHeaders = 'error: ' + e.message; }
  await new Promise((r) => srv.close(r));
  console.log(JSON.stringify(results, null, 2));
  assert.strictEqual(results.with_req_resume.got403, 200, 'drained 403 must be reliable');
  console.log('http probe pass');
})();
