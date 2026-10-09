#!/usr/bin/env node
'use strict';
// Static validation of the toolkit's Claude Code components: agent/skill/
// command frontmatter, role coverage, schemas, templates and hook wiring.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { DEFAULT_CONFIG } = require('../lib/config');

const ROOT = path.join(__dirname, '..');
const errors = [];
const fm = (file) => {
  const text = fs.readFileSync(file, 'utf8');
  const m = text.match(/^---\n([\s\S]*?)\n---\n/);
  if (!m) {
    errors.push(`${path.relative(ROOT, file)}: missing frontmatter`);
    return {};
  }
  const meta = {};
  for (const line of m[1].split('\n')) {
    const i = line.indexOf(':');
    if (i > 0 && !line.startsWith(' ')) meta[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return meta;
};

const agentNames = new Set();
for (const f of fs.readdirSync(path.join(ROOT, 'agents'))) {
  const meta = fm(path.join(ROOT, 'agents', f));
  for (const k of ['name', 'description', 'tools', 'model']) if (!meta[k]) errors.push(`agents/${f}: missing ${k}`);
  if (meta.name && meta.name !== f.replace(/\.md$/, '')) errors.push(`agents/${f}: name "${meta.name}" must match file name`);
  if (/\bAgent\b/.test(meta.tools || '')) errors.push(`agents/${f}: subagents must not spawn agents (remove Agent from tools)`);
  if (agentNames.has(meta.name)) errors.push(`duplicate agent ${meta.name}`);
  agentNames.add(meta.name);
}
const roles = new Set(Object.values(DEFAULT_CONFIG.roles).flatMap((r) => [...r.authors, ...r.reviewers]));
for (const r of roles) if (!agentNames.has(r)) errors.push(`config role ${r} has no agent definition`);

for (const s of fs.readdirSync(path.join(ROOT, 'skills'))) {
  const file = path.join(ROOT, 'skills', s, 'SKILL.md');
  if (!fs.existsSync(file)) {
    errors.push(`skills/${s}: missing SKILL.md`);
    continue;
  }
  const meta = fm(file);
  if (!meta.name || !meta.description) errors.push(`skills/${s}: needs name and description`);
  if (meta.name && meta.name !== s) errors.push(`skills/${s}: name must equal directory`);
}
for (const f of fs.readdirSync(path.join(ROOT, 'commands'))) if (!fm(path.join(ROOT, 'commands', f)).description) errors.push(`commands/${f}: missing description`);

for (const f of fs.readdirSync(path.join(ROOT, 'schemas'))) {
  try {
    JSON.parse(fs.readFileSync(path.join(ROOT, 'schemas', f), 'utf8'));
  } catch (e) {
    errors.push(`schemas/${f}: ${e.message}`);
  }
}
for (const f of fs.readdirSync(path.join(ROOT, 'templates')).filter((x) => x.endsWith('.json'))) {
  try {
    JSON.parse(fs.readFileSync(path.join(ROOT, 'templates', f), 'utf8'));
  } catch (e) {
    errors.push(`templates/${f}: ${e.message}`);
  }
}
const hooks = JSON.parse(fs.readFileSync(path.join(ROOT, 'hooks', 'hooks.json'), 'utf8'));
for (const groups of Object.values(hooks.hooks)) {
  for (const g of groups) {
    for (const h of g.hooks) {
      const m = h.command.match(/\$\{CLAUDE_PLUGIN_ROOT\}\/([^"]+)/);
      if (!m || !fs.existsSync(path.join(ROOT, m[1]))) errors.push(`hooks.json: missing script for "${h.command}"`);
    }
  }
}
const plugin = JSON.parse(fs.readFileSync(path.join(ROOT, '.claude-plugin', 'plugin.json'), 'utf8'));
const marketplace = JSON.parse(fs.readFileSync(path.join(ROOT, '.claude-plugin', 'marketplace.json'), 'utf8'));

// Release reproducibility: the package entry point and every published path
// exist, the manifests carry the package version, and `npm pack` ships the
// entry point and the CLI (the exact release is what gets installed, not the checkout).
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
if (!pkg.main || !fs.existsSync(path.join(ROOT, pkg.main))) errors.push(`package.json: main "${pkg.main}" does not exist`);
for (const f of pkg.files || []) if (!fs.existsSync(path.join(ROOT, f))) errors.push(`package.json: files entry "${f}" does not exist`);
if (plugin.version !== pkg.version) errors.push(`.claude-plugin/plugin.json: version ${plugin.version} must equal package.json version ${pkg.version} (bump them together)`);
for (const p of marketplace.plugins || []) if (p.version !== pkg.version) errors.push(`.claude-plugin/marketplace.json: plugin ${p.name} version ${p.version} must equal package.json version ${pkg.version} (bump them together)`);

/** Paths `npm pack` would ship, or null when npm is not installed. */
function npmPackFiles() {
  const npm = process.env.npm_execpath; // set under `npm run`: run that npm with this node, no shell
  const opts = { cwd: ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 };
  const res = npm && /[\\/]npm-cli\.js$/.test(npm)
    ? spawnSync(process.execPath, [npm, 'pack', '--dry-run', '--json'], opts)
    : spawnSync('npm', ['pack', '--dry-run', '--json'], { ...opts, shell: process.platform === 'win32' });
  if (res.error && res.error.code === 'ENOENT') return null;
  if (res.status !== 0) {
    errors.push(`npm pack --dry-run failed: ${(res.stderr || res.error && res.error.message || '').trim()}`);
    return [];
  }
  try {
    return JSON.parse(res.stdout)[0].files.map((f) => f.path);
  } catch (e) {
    errors.push(`npm pack --dry-run --json: unreadable output (${e.message})`);
    return [];
  }
}
const packed = npmPackFiles();
if (packed === null) console.error('note: npm not found on PATH; the npm pack content check was skipped');
else for (const f of ['lib/index.js', 'bin/eccode.js']) if (!packed.includes(f)) errors.push(`npm pack would not ship ${f}: add its directory to package.json "files"`);

if (errors.length) {
  console.error(`Toolkit validation FAILED (${errors.length}):\n- ${errors.join('\n- ')}`);
  process.exit(1);
}
console.log(`Toolkit validation passed: ${agentNames.size} agents, ${fs.readdirSync(path.join(ROOT, 'skills')).length} skills, ${fs.readdirSync(path.join(ROOT, 'commands')).length} commands, hooks wired, package ${pkg.version}${packed ? ` (${packed.length} files)` : ''}.`);
