'use strict';
// Shared pieces of the Phase 3 guards: shell quoting, the project's probe
// environment (from .eccode/behavior.json and .eccode/guards.json), running a
// probe script in a worktree as recorded evidence, and content-hashed artifacts.
const fs = require('fs');
const path = require('path');
const evidence = require('../evidence');
const { EccodeError, sha256, writeFileAtomic, exists, readJson } = require('../util');

function sh(cmd) {
  return /^[\w./:@+=,-]+$/.test(cmd) ? cmd : `'${String(cmd).replace(/'/g, "'\\''")}'`;
}

function behaviorConfig(root) {
  return readJson(path.join(root, '.eccode', 'behavior.json'), {});
}

function guardsConfig(root) {
  return readJson(path.join(root, '.eccode', 'guards.json'), {});
}

function sideEnv(cfg, tmp, extra = {}) {
  const env = {};
  for (const [k, v] of Object.entries(cfg.env || {})) env[k] = String(v).replace(/\{tmp\}/g, tmp);
  for (const [k, v] of Object.entries(extra)) env[k] = String(v).replace(/\{tmp\}/g, tmp);
  env.PYTHONDONTWRITEBYTECODE = '1';
  return env;
}

/** Run `command` in a worktree as recorded evidence under `env`, after the configured setup; throws on an integrity violation. */
function runInSide(store, actor, { guard, label, side, command, env, setup, task, timeoutMs, evs }) {
  const envPrefix = Object.entries(env || {}).map(([k, v]) => `${k}=${sh(v)}`).join(' ');
  const full = `${envPrefix ? `env ${envPrefix} ` : ''}sh -c ${sh(`${setup ? `${setup} && ` : ''}${command}`)}`;
  const ev = evidence.runCommand(store, actor, { label: `${guard}: ${label}`, command: full, task, purpose: 'check', timeoutMs: timeoutMs || 900000, externalCwd: side.root, cwdLabel: `${label} worktree`, extra: { [guard]: label } });
  if (evs) evs.push(ev.id);
  if (ev.integrity) throw new EccodeError('INTEGRITY', `${guard} ${label}: ${ev.integrity.join('; ')}`);
  return ev;
}

/** Write a guard artifact under .eccode/guards/ and return {artifact, artifactSha256}. */
function writeArtifact(store, id, body) {
  const rel = `.eccode/guards/${id}.json`;
  const text = JSON.stringify(body, null, 2) + '\n';
  fs.mkdirSync(path.join(store.root, '.eccode', 'guards'), { recursive: true });
  writeFileAtomic(path.join(store.root, rel), text);
  return { artifact: rel, artifactSha256: sha256(text) };
}

function assertActive(state) {
  if (!state.work) throw new EccodeError('NOT_INITIALIZED', 'No work item');
  if (state.work.status !== 'active') throw new EccodeError('INVALID_TRANSITION', `Work item ${state.work.id} is ${state.work.status}`);
}

/** The role headers configured in .eccode/behavior.json, by role name. */
function roleHeaders(cfg, role) {
  const r = (cfg.roles || []).find((x) => x.name === role);
  return r ? r.headers || {} : {};
}

function fingerprint(root, state) {
  return require('../behavior').treeFingerprint(root, state);
}

module.exports = { sh, behaviorConfig, guardsConfig, sideEnv, runInSide, writeArtifact, assertActive, roleHeaders, fingerprint, exists };
