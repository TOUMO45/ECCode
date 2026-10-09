#!/usr/bin/env node
'use strict';
// Reproduction/verification check for the nested-root guard defect found in the RescueStock pilot.
// Usage: node nested-root-check.js <path-to-guard.js>
// Builds a throwaway outer project with its own record and a nested examples/app project with its
// own record, then asks the guard (as the harness would, with CLAUDE_PROJECT_DIR = the outer
// repository) whether the nested project's architecture-reviewer may write its own draft area, and
// whether anyone may write the nested record. Exit 0 when both answers are right (draft allowed,
// record denied), 1 when the guard misjudges, 2 on a harness error.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const guard = path.resolve(process.argv[2] || path.join(__dirname, '..', '..', 'scripts', 'hooks', 'guard.js'));
const repo = path.resolve(__dirname, '..', '..');
const { init } = require(path.join(repo, 'lib', 'project'));
// Pin the file under test in the evidence log: the record's tree digest excludes .eccode/, so only
// this line shows which guard copy ran.
const guardSha256 = require('crypto').createHash('sha256').update(fs.readFileSync(guard)).digest('hex');
console.log(`guard under test: ${guard}\nguard sha256: ${guardSha256}`);

function hook(payload, env) {
  const res = spawnSync(process.execPath, [guard], { input: JSON.stringify(payload), encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: '', ECCODE_ACTOR: '', ECCODE_HOOKS: '', ...env } });
  if (res.status !== 0 || res.stderr.trim()) { console.error('guard error:', res.stderr); process.exit(2); }
  return res.stdout ? JSON.parse(res.stdout).hookSpecificOutput : null;
}

const outer = fs.mkdtempSync(path.join(os.tmpdir(), 'nested-root-check-'));
try {
  spawnSync('git', ['init', '-q'], { cwd: outer });
  init(outer, { name: 'Outer', idea: 'outer repository with its own record' });
  const inner = path.join(outer, 'examples', 'app');
  fs.mkdirSync(inner, { recursive: true });
  init(inner, { name: 'App', idea: 'nested example app' });
  const env = { CLAUDE_PROJECT_DIR: outer };
  const draft = path.join(inner, '.eccode', 'reviews', 'drafts', 'architecture-1.json');
  const record = path.join(inner, '.eccode', 'state.json');
  const draftDecision = hook({ cwd: outer, tool_name: 'Write', agent_type: 'eccode:architecture-reviewer', tool_input: { file_path: draft } }, env);
  const recordDecision = hook({ cwd: outer, tool_name: 'Write', agent_type: 'eccode:architecture-reviewer', tool_input: { file_path: record } }, env);
  const draftOk = draftDecision === null;
  const recordOk = Boolean(recordDecision && recordDecision.permissionDecision === 'deny');
  console.log(JSON.stringify({ guard, nestedDraftWrite: draftOk ? 'allowed (correct)' : `denied (wrong): ${draftDecision && draftDecision.permissionDecisionReason}`, nestedRecordWrite: recordOk ? 'denied (correct)' : 'allowed (wrong)' }, null, 1));
  process.exit(draftOk && recordOk ? 0 : 1);
} finally {
  fs.rmSync(outer, { recursive: true, force: true });
}
