'use strict';
// t16 smoke: exercises the README's documented run/health/config commands. Run from the project root.
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const fails = [];
const check = (ok, msg) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`); if (!ok) fails.push(msg); };
const baseEnv = { PATH: process.env.PATH, HOME: process.env.HOME };

function get(port, p) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: p }, (res) => {
      let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => resolve({ status: res.statusCode, body: b }));
    }).on('error', reject);
  });
}

function startAndProbe(label, cmd, args, env) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    let out = '';
    const timer = setTimeout(() => { check(false, `${label}: no listening line in 10s`); try { process.kill(-child.pid, 'SIGKILL'); } catch {} resolve(); }, 10000);
    child.stdout.on('data', async (c) => {
      out += c;
      const line = out.split('\n').find((l) => l.includes('"event":"listening"'));
      if (!line || child._probed) return;
      child._probed = true;
      const ev = JSON.parse(line);
      const h = await get(ev.port, '/api/health');
      check(h.status === 200, `${label}: GET /api/health 200`);
      check(JSON.parse(h.body).mode === 'fallback' && JSON.parse(h.body).model === null, `${label}: health mode fallback, model null`);
      child.on('exit', (code) => { clearTimeout(timer); check(code === 0 || label.startsWith('npm'), `${label}: exit after group SIGINT (code ${code})`); resolve(); });
      process.kill(-child.pid, 'SIGINT');
    });
  });
}

(async () => {
  // Documented default: npm start on 127.0.0.1:3000 is skipped to avoid port clashes; use PORT=0 for the same command.
  await startAndProbe('npm start', 'npm', ['start'], { ...baseEnv, PORT: '0' });
  await startAndProbe('node src/server.js', process.execPath, ['src/server.js'], { ...baseEnv, PORT: '0' });

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't16-'));
  const envFile = path.join(dir, '.env');
  fs.writeFileSync(envFile, fs.readFileSync('.env.example', 'utf8').replace('PORT=3000', 'PORT=0'));
  await startAndProbe('node --env-file=.env src/server.js', process.execPath, [`--env-file=${envFile}`, 'src/server.js'], baseEnv);

  const r1 = spawnSync(process.execPath, ['src/server.js'], { env: { ...baseEnv, PORT: '' }, encoding: 'utf8' });
  check(r1.status === 1 && r1.stderr.trim() === 'config error: PORT must be an integer from 0 to 65535', 'PORT= is a config error (exact README text)');
  const r2 = spawnSync(process.execPath, ['src/server.js'], { env: { ...baseEnv, HOST: '0.0.0.0' }, encoding: 'utf8' });
  check(r2.status === 1 && /TRIAGE_ALLOW_REMOTE=1/.test(r2.stderr), 'non-loopback HOST refused without TRIAGE_ALLOW_REMOTE');
  const r3 = spawnSync(process.execPath, ['src/server.js'], { env: { ...baseEnv, TRIAGE_ALLOW_REMOTE: ' 1' }, encoding: 'utf8' });
  check(r3.status === 1 && /TRIAGE_ALLOW_REMOTE/.test(r3.stderr), "TRIAGE_ALLOW_REMOTE=' 1' is a config error");
  const r4 = spawnSync(process.execPath, ['src/server.js'], { env: { ...baseEnv, TRIAGE_ANTHROPIC_BASE_URL: 'http://example.com' }, encoding: 'utf8' });
  check(r4.status === 1 && /TRIAGE_ANTHROPIC_BASE_URL is invalid/.test(r4.stderr) && !/example\.com/.test(r4.stderr), 'http non-loopback base URL refused, value not echoed');

  const { loadConfig } = require(path.resolve('src/config.js'));
  check(loadConfig({ ANTHROPIC_API_KEY: '' }).apiKey === null, 'empty ANTHROPIC_API_KEY -> fallback (null)');
  check(loadConfig({ ANTHROPIC_BASE_URL: 'https://evil.example' }).baseUrl === 'https://api.anthropic.com', 'ANTHROPIC_BASE_URL ignored');
  check(loadConfig({ TRIAGE_ANTHROPIC_BASE_URL: '' }).baseUrlCustom === false, 'empty TRIAGE_ANTHROPIC_BASE_URL -> default');

  console.log(fails.length ? `t16-smoke FAIL ${fails.length}` : 't16-smoke PASS');
  process.exit(fails.length ? 1 : 0);
})();
