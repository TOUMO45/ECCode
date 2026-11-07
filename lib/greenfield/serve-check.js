'use strict';
// GF-RUN-2's serve form (design 18.4): start an ASGI app with uvicorn, wait for its port, run one check against it,
// then stop the server. Usage: node serve-check.js <python> <module:app> <port> -- <check words...>
// The server is a child in the same process group, so the frozen evidence runner's timeout stops it too.
const net = require('net');
const { spawn, spawnSync } = require('child_process');

const [py, target, port, sep, ...check] = process.argv.slice(2);
if (sep !== '--' || !check.length) { process.stderr.write('usage: serve-check.js <python> <module:app> <port> -- <check>\n'); process.exit(64); }
const answers = () => new Promise((res) => { const c = net.connect(Number(port), '127.0.0.1'); c.on('connect', () => { c.destroy(); res(true); }); c.on('error', () => res(false)); });
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  if (await answers()) { process.stderr.write(`[serve] port ${port} is already in use\n`); process.exit(125); }
  const server = spawn(py, ['-m', 'uvicorn', target, '--host', '127.0.0.1', '--port', port], { stdio: ['ignore', 'inherit', 'inherit'] });
  let exited = false;
  server.on('exit', () => { exited = true; });
  server.on('error', (e) => { exited = true; process.stderr.write(`[serve] could not start ${py}: ${e.message}\n`); });
  const stop = async () => {
    if (!exited) server.kill('SIGTERM');
    for (let i = 0; i < 50 && !exited; i++) await pause(100);
    if (!exited) server.kill('SIGKILL');
  };
  let up = false;
  for (const deadline = Date.now() + 20000; Date.now() < deadline && !exited && !up;) { up = await answers(); if (!up) await pause(200); }
  if (!up) { process.stderr.write(`[serve] ${target} did not answer on 127.0.0.1:${port} within 20 s\n`); await stop(); process.exit(125); }
  const r = spawnSync(check[0], check.slice(1), { stdio: 'inherit' });
  await stop();
  process.exit(typeof r.status === 'number' ? r.status : 1);
})();
