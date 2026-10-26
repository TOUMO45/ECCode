#!/usr/bin/env node
'use strict';
// A7: `eccode stack` on Mealie at one commit. The stacks it detects, the
// checks it lists, each check run through ECCode and the same tool run
// directly the way Mealie's own CI runs it (Taskfile.yml), and the secrets
// scan's hits for the hand labels (labels/secrets.json).
// usage: node a7-stack.js <commit>
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, execFileSync } = require('child_process');
const lib = require('../lib');
const stack = require('../../../lib/stack');
const { loadConfig } = require('../../../lib/config');
const env = require('../../suites/mealie/_tools/env');

// How Mealie's own Taskfile.yml runs each tool at the commit, from the
// repository root (Python tools there run through `uv run`; here the venv is
// first on PATH; `test` is vitest, and test:ci is its no-watch form). The
// frontend's package manager is the one its lockfile names: yarn at the
// pilot's pin, pnpm at the rerun's.
const PYTHON_DIRECT = {
  pytest: 'python -m pytest -q -p no:cacheprovider',
  ruff: 'ruff check mealie',
  mypy: 'mypy mealie',
};
const frontendDirect = (manager) => ({
  eslint: `cd frontend && ${manager} lint --max-warnings=0`,
  vitest: `cd frontend && ${manager} test:ci`,
});

function directFor(root) {
  const lock = env.lockfileOf(path.join(root, 'frontend'));
  return { ...PYTHON_DIRECT, ...frontendDirect(lock ? lock.manager : 'yarn') };
}

function toolOf(check) {
  return Object.keys({ ...PYTHON_DIRECT, ...frontendDirect('') }).find((t) => new RegExp(`\\b${t}\\b`).test(`${check.id} ${check.command || ''} ${check.script || ''}`)) || null;
}

function main(argv) {
  const commit = argv[0];
  if (!/^[0-9a-f]{40}$/.test(commit || '')) throw new Error('usage: a7-stack.js <full commit sha>');
  const root = lib.treeAt(lib.MEALIE, commit, fs.mkdtempSync(path.join(os.tmpdir(), 'pilot-a7-')));
  try {
    const g = (args) => execFileSync('git', ['-c', 'user.email=p@p', '-c', 'user.name=p', ...args], { cwd: root, stdio: 'ignore' });
    g(['init', '-q']);
    g(['add', '-A']);
    g(['commit', '-qm', 'tree']);
    const venvEnv = env.taskEnvVars(env.pythonEnv(root));
    env.nodeModules(root);
    const saved = { ...process.env };
    Object.assign(process.env, venvEnv);
    try {
      const config = loadConfig(root);
      const stacks = stack.detect(root);
      const checks = stack.checks(root, config);
      const DIRECT = directFor(root);
      const rows = checks.filter((c) => c.id !== 'eccode-secrets').map((c) => {
        if (!c.available) return { id: c.id, command: c.command, available: false };
        const started = Date.now();
        const via = stack.runCheck(root, config, c.id);
        const ms = Date.now() - started;
        const tool = toolOf(c);
        const direct = tool ? spawnSync(DIRECT[tool], { cwd: root, shell: true, encoding: 'utf8', timeout: 1800000, maxBuffer: 64 * 1024 * 1024, env: process.env }) : null;
        return { id: c.id, command: c.command, source: c.source, available: true, eccodeExit: via.exitCode, ms, tool, directCommand: tool ? DIRECT[tool] : null, directExit: direct ? direct.status : null, equal: direct ? (via.exitCode === 0) === (direct.status === 0) : null };
      });
      const secrets = stack.scanSecrets(root);
      // scanSecrets names each hit as "file:line" (the line itself is never copied out).
      const hits = [...secrets.code.map((id) => ({ id, where: 'code' })), ...secrets.tests.map((id) => ({ id, where: 'tests' }))];
      const result = { commit, stacks: stacks.map((s) => s.id), checks: rows, secrets: { code: secrets.code.length, tests: secrets.tests.length, hits } };
      const file = lib.writeResult('a7-stack', result, process.env.ECCODE_PILOT_RESULTS || lib.RESULTS);
      process.stdout.write(`${file}\n${JSON.stringify({ stacks: result.stacks, checks: rows.map((r) => `${r.id}:${r.available === false ? 'unavailable' : `${r.eccodeExit}/${r.directExit}`}`), secrets: result.secrets.code + result.secrets.tests })}\n`);
    } finally {
      for (const k of Object.keys(venvEnv)) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

module.exports = { toolOf, directFor };

if (require.main === module) main(process.argv.slice(2));
