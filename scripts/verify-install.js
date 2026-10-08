#!/usr/bin/env node
'use strict';
// Verify a clean installation by following docs/usage.md in a throwaway
// environment, then start a project through the documented entry point.
//
//   node scripts/verify-install.js [--source <repo path or owner/repo>] [--live]
//
// Steps (each prints PASS/FAIL; exit 1 if any fails):
//   1. fresh HOME and Claude config dir, no plugins
//   2. `claude plugin marketplace add <source>` and `claude plugin install eccode@eccode` (documented method A)
//   3. `claude plugin validate` of the installed manifest
//   4. the installed plugin lists 12 agents, 7 skills, 7 commands (headless session init event)
//   5. project-local copy (method B) into a scratch project, then `eccode init` and `eccode status`
//   6. configurable limits (concurrency, cost, runtime, retries) are present, enforced and overridable
//   7. with --live: `/eccode:status` in a headless session in an initialised project (the SessionStart hook injects the brief)

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const arg = (n, d) => {
  const i = process.argv.indexOf(`--${n}`);
  return i === -1 ? d : process.argv[i + 1];
};
const source = arg('source', ROOT);
const live = process.argv.includes('--live');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'eccode-verify-'));
const home = path.join(tmp, 'home');
const cfg = path.join(tmp, 'claude-config');
fs.mkdirSync(home);
fs.mkdirSync(cfg);
const env = { ...process.env, HOME: home, CLAUDE_CONFIG_DIR: cfg, IS_SANDBOX: '1' };
for (const k of ['CLAUDE_CODE_SYNC_PLUGINS', 'CLAUDE_CODE_SYNC_SKILLS', 'CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD', 'CLAUDE_ADDITIONAL_DIRECTORIES', 'ECCODE_LEARNING', 'ECCODE_ROOT']) delete env[k];

const results = [];
function step(name, fn) {
  let detail = '';
  let ok = false;
  try {
    const r = fn();
    ok = r.ok;
    detail = r.detail || '';
  } catch (e) {
    detail = String(e.message || e);
  }
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
}
const sh = (cmd, args, opts = {}) => spawnSync(cmd, args, { env, encoding: 'utf8', timeout: 240000, maxBuffer: 64 * 1024 * 1024, ...opts });

step('node >= 18.17', () => {
  const [maj, min] = process.versions.node.split('.').map(Number);
  return { ok: maj > 18 || (maj === 18 && min >= 17), detail: process.version };
});

step('marketplace add (documented method A)', () => {
  const r = sh('claude', ['plugin', 'marketplace', 'add', source]);
  return { ok: r.status === 0, detail: (r.stdout + r.stderr).trim().split('\n').pop() };
});

step('plugin install eccode@eccode', () => {
  const r = sh('claude', ['plugin', 'install', 'eccode@eccode']);
  return { ok: r.status === 0, detail: (r.stdout + r.stderr).trim().split('\n').pop() };
});

step('plugin validate --strict (source manifest)', () => {
  const r = sh('claude', ['plugin', 'validate', path.join(ROOT, '.claude-plugin', 'plugin.json'), '--strict']);
  return { ok: r.status === 0, detail: (r.stdout + r.stderr).trim().split('\n').pop() };
});

let initEvent = null;
step('installed plugin loads 12 agents, 7 skills, 7 commands', () => {
  const work = path.join(tmp, 'probe');
  fs.mkdirSync(work);
  const r = sh('claude', ['-p', 'Reply with exactly: OK', '--output-format', 'stream-json', '--verbose'], { cwd: work });
  for (const line of (r.stdout || '').split('\n')) {
    try {
      const j = JSON.parse(line);
      if (j.type === 'system' && j.subtype === 'init') initEvent = j;
    } catch {}
  }
  if (!initEvent) return { ok: false, detail: `no init event (exit ${r.status}) ${(r.stderr || '').slice(0, 200)}` };
  const agents = (initEvent.agents || []).filter((a) => a.startsWith('eccode:')).length;
  const skills = (initEvent.skills || []).filter((s) => s.startsWith('eccode:')).length;
  const cmds = (initEvent.slash_commands || []).filter((s) => /^eccode:(start|change|resume|status|investigate|deliver|improve)$/.test(s)).length;
  return { ok: agents === 12 && skills === 7 && cmds === 7, detail: `${agents} agents, ${skills} skills, ${cmds} commands` };
});

const project = path.join(tmp, 'project');
fs.mkdirSync(project);
sh('git', ['init', '-q'], { cwd: project });
step('project-local install (documented method B) into a scratch project', () => {
  const r = sh(process.execPath, [path.join(ROOT, 'bin', 'eccode.js'), 'install', '--target', project]);
  const ok = r.status === 0 && fs.existsSync(path.join(project, '.claude', 'agents', 'product-architect.md')) && fs.existsSync(path.join(project, '.claude', 'eccode', 'bin', 'eccode.js'));
  return { ok, detail: (r.stdout + r.stderr).trim().split('\n').pop() };
});

const cli = (...a) => sh(process.execPath, [path.join(project, '.claude', 'eccode', 'bin', 'eccode.js'), ...a, '--root', project]);
step('eccode init + status from the installed copy; memory initialised', () => {
  const i = cli('init', '--name', 'Verify', '--idea', 'A small app that proves the installation works');
  const s = cli('status', '--brief');
  const m = cli('memory', 'status');
  return { ok: i.status === 0 && s.status === 0 && /NEXT/.test(s.stdout) && m.status === 0 && /learning: on/.test(m.stdout), detail: s.stdout.trim().split('\n').pop().slice(0, 100) };
});

step('limits are configurable: concurrency, cost, runtime, retries', () => {
  const file = path.join(project, '.eccode', 'config.json');
  const c = JSON.parse(fs.readFileSync(file, 'utf8'));
  const keys = ['maxConcurrency', 'maxCostUsd', 'maxRuntimeMinutes', 'maxTaskRetries'];
  if (!keys.every((k) => typeof c.limits[k] === 'number')) return { ok: false, detail: 'missing limit keys' };
  // Enforcement: a tiny cost limit blocks the next run once spend is recorded.
  c.limits.maxCostUsd = 0.5;
  fs.writeFileSync(file, JSON.stringify(c));
  const a = cli('run', 'start', '--actor', 'delivery-lead');
  const id = a.stdout.trim();
  const e = cli('run', 'end', id, '--actor', 'orchestrator', '--status', 'ok', '--tokens', '10', '--cost-usd', '0.6');
  const b = cli('run', 'start', '--actor', 'delivery-lead');
  return { ok: a.status === 0 && e.status === 0 && b.status === 2 && /BUDGET_EXCEEDED|Budget exhausted/.test(b.stderr), detail: (b.stderr || '').trim().split('\n')[0].slice(0, 90) };
});

if (live) {
  step('live: /eccode:status in a headless session shows the project record (SessionStart hook)', () => {
    const r = sh('claude', ['-p', 'Run /eccode:status and report the NEXT line verbatim.', '--output-format', 'json', '--permission-mode', 'bypassPermissions', '--plugin-dir', ROOT], { cwd: project });
    let j = {};
    try {
      j = JSON.parse(r.stdout);
    } catch {}
    const text = String(j.result || '');
    // The answer must quote the record's real next action and must not be an excuse.
    return { ok: r.status === 0 && /start-gate/.test(text) && /architecture/.test(text) && !/couldn't|could not|can't|cannot|not installed|not on PATH/i.test(text), detail: text.slice(0, 120).replace(/\n/g, ' ') };
  });
}

fs.rmSync(tmp, { recursive: true, force: true });
const failed = results.filter((r) => !r.ok);
console.log(failed.length ? `\n${failed.length} step(s) FAILED` : '\nAll installation steps passed.');
process.exit(failed.length ? 1 : 0);
