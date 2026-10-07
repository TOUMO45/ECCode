'use strict';
// Fixture for helpers.test.js: a stand-in for src/server.js (which is built later) so spawn-server can
// be self-tested. It reports which environment variable NAMES it received (never their values, except
// the test-only MARKER) and logs JSON lines in the same `listening` / `request` shape as D1.6.
const http = require('node:http');

const mode = process.env.PROBE_MODE || 'serve';
if (mode === 'config-error') {
  process.stderr.write('config error: PROBE_MODE requested a startup failure\n');
  process.exit(1);
}
if (mode === 'silent') {
  setInterval(() => {}, 1000); // stays alive and never logs `listening`
} else {
  const envKeys = Object.keys(process.env).sort();
  const server = http.createServer((req, res) => {
    const body = JSON.stringify({ envKeys, marker: process.env.MARKER === undefined ? null : process.env.MARKER });
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
    res.end(body);
    process.stdout.write(JSON.stringify({ t: new Date().toISOString(), event: 'request', path: req.url, status: 200 }) + '\n');
  });
  server.listen(Number(process.env.PORT), '127.0.0.1', () => {
    process.stdout.write('not a json line\n');
    process.stdout.write(JSON.stringify({
      t: new Date().toISOString(), event: 'listening', host: '127.0.0.1', port: server.address().port,
      envKeys, portEnv: process.env.PORT, apiKeyEmpty: process.env.ANTHROPIC_API_KEY === '',
    }) + '\n');
    process.stderr.write('probe stderr line\n');
  });
  const shutdown = () => server.close(() => process.exit(0));
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}
