'use strict';
// The planner suite's hidden check: node .bench-hidden/check.js <c1|c2|c3>
// Run in the project's root after the agent finished. It installs the
// project's npm dependencies when it has some, starts the fake Mealie (the
// hidden dataset) and the service (its npm start script, with PORT,
// MEALIE_URL and a fresh DATABASE_PATH), waits for GET /health, runs the acceptance tests of
// that item, and stops both. Exit 0 when every test of the item passed.
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const tag = process.argv[2];
if (!/^c[123]$/.test(tag || '')) {
  process.stderr.write('usage: node check.js <c1|c2|c3>\n');
  process.exit(2);
}
const root = process.cwd();
const fail = (msg) => {
  process.stderr.write(`check ${tag}: ${msg}\n`);
  process.exit(1);
};

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

async function waitHealthy(url, child, log) {
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) fail(`the service exited (${child.exitCode}) before it was ready:\n${log().slice(-2000)}`);
    try {
      const r = await fetch(`${url}/health`);
      if (r.status === 200) return;
    } catch {
      // not listening yet
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  fail(`no 200 from GET /health within 60 s:\n${log().slice(-2000)}`);
}

async function main() {
  const pkgFile = path.join(root, 'package.json');
  if (!fs.existsSync(pkgFile)) fail('no package.json: `npm start` cannot start the service');
  const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'));
  if (Object.keys(pkg.dependencies || {}).length && !fs.existsSync(path.join(root, 'node_modules'))) {
    const npm = spawnSync('npm', ['install', '--no-audit', '--no-fund', '--loglevel=error'], { cwd: root, encoding: 'utf8', timeout: 300000, shell: process.platform === 'win32' });
    if (npm.status !== 0) fail(`npm install failed:\n${`${npm.stdout}${npm.stderr}`.slice(-2000)}`);
  }
  const dataFile = path.join(__dirname, 'fake-mealie', 'data.json');
  const mealie = await require('./fake-mealie/server').start({ data: JSON.parse(fs.readFileSync(dataFile, 'utf8')) });
  const port = await freePort();
  const db = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'planner-db-')), 'planner.db');
  let out = '';
  // `npm start` as npm runs it (the start script, node_modules/.bin first on
  // PATH), but in a process group of its own so it can be stopped whole.
  const start = (pkg.scripts && pkg.scripts.start) || 'node server.js';
  const bin = path.join(root, 'node_modules', '.bin');
  const child = spawn(start, { cwd: root, shell: true, detached: process.platform !== 'win32', env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, PORT: String(port), MEALIE_URL: mealie.url, DATABASE_PATH: db } });
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (out += d));
  const stop = () => {
    try {
      if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F']);
      else process.kill(-child.pid, 'SIGKILL');
    } catch {
      // already gone
    }
  };
  try {
    const url = `http://127.0.0.1:${port}`;
    await waitHealthy(url, child, () => out);
    // A test runner of its own: inherited NODE_TEST_CONTEXT would make it report to a parent runner and exit 0.
    const testEnv = { ...process.env, PLANNER_URL: url, MEALIE_DATA: dataFile, PLANNER_DIR: root };
    delete testEnv.NODE_TEST_CONTEXT;
    // Asynchronous: the fake Mealie answers from this process's event loop.
    const status = await new Promise((resolve) => {
      const t = spawn(process.execPath, ['--test', `--test-name-pattern=^${tag}:`, path.join(__dirname, 'acceptance.test.js')], { cwd: root, env: testEnv, stdio: ['ignore', 'inherit', 'inherit'] });
      const timer = setTimeout(() => t.kill('SIGKILL'), 300000);
      t.on('exit', (code) => {
        clearTimeout(timer);
        resolve(code);
      });
    });
    process.exitCode = status === 0 ? 0 : 1;
  } finally {
    stop();
    await mealie.close();
  }
}

main().catch((e) => fail(e.stack || String(e)));
