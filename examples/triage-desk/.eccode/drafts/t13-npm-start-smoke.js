'use strict';
// t13 smoke: run `npm start` (fallback mode, explicit env, PORT=0), GET /api/health with a correct Host, stop with SIGTERM.
const { spawn } = require('node:child_process');
const http = require('node:http');
const path = require('node:path');
const root = path.resolve(__dirname, '..', '..');
const env = { PATH: process.env.PATH, HOME: process.env.HOME || '/tmp', PORT: '0' };
const child = spawn('npm', ['start', '--silent'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
let out = ''; let err = '';
child.stderr.on('data', (d) => { err += d; });
const fail = (m) => { console.log('FAIL', m, '\nstdout:', out, '\nstderr:', err); try { process.kill(-child.pid, 'SIGKILL'); } catch {} process.exit(1); };
const timer = setTimeout(() => fail('no listening line in 10 s'), 10000);
let done = false;
child.stdout.on('data', (d) => {
  out += d;
  if (done) return;
  const rec = out.split('\n').map((l) => { try { return JSON.parse(l); } catch { return null; } }).find((r) => r && r.event === 'listening');
  if (!rec) return;
  done = true; clearTimeout(timer);
  console.log('listening line:', JSON.stringify(rec));
  const req = http.request({ host: '127.0.0.1', port: rec.port, path: '/api/health', headers: { host: `127.0.0.1:${rec.port}` }, agent: false }, (res) => {
    let body = ''; res.on('data', (c) => { body += c; });
    res.on('end', () => {
      console.log('GET /api/health ->', res.statusCode, body);
      if (res.statusCode !== 200 || JSON.parse(body).mode !== 'fallback') fail('unexpected health response');
      const t0 = Date.now();
      // Signal the whole process group (npm, its `sh -c` wrapper and the node server), as a terminal Ctrl-C or a
      // process manager does. dash does not exec the script, so signalling npm alone orphans the server.
      process.kill(-child.pid, 'SIGTERM');
      child.once('exit', (code, signal) => console.log(`npm exited: code=${code} signal=${signal} (npm's own signal handling)`));
      const check = () => {
        const { execFileSync } = require('node:child_process');
        let rows = '';
        try { rows = execFileSync('ps', ['-o', 'pid=,stat=,args=', '-g', String(child.pid)], { encoding: 'utf8' }); } catch { rows = ''; }
        const alive = rows.split('\n').filter((r) => r.trim() !== '' && !/^\s*\d+\s+Z/.test(r));
        if (alive.length === 0) {
          console.log(`server process group fully exited (no live process) within ${Date.now() - t0} ms of SIGTERM`);
          console.log('stdout lines:', out.trim().split('\n').length, 'stderr bytes:', err.length);
          process.exit(0);
        }
        if (Date.now() - t0 > 2500) fail('process still alive 2.5 s after SIGTERM: ' + alive.join(' | '));
        setTimeout(check, 50);
      };
      setTimeout(check, 50);
    });
  });
  req.on('error', (e) => fail(e.code));
  req.end();
});
