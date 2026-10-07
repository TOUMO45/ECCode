#!/usr/bin/env node
'use strict';
// PreToolUse guard for Claude Code. Enforces, at tool-call time:
//   1. The project record (.eccode/events.jsonl, state.json, config.json,
//      evidence logs) is only written by the eccode CLI, never by hand.
//   2. Identity binding: inside a subagent, `eccode ... --actor X` must name
//      the subagent's own role; subagents can never act as `user` or
//      `orchestrator`. The main session may act as orchestrator/user, or as
//      any role only when ECCODE_SEQUENTIAL_ROLES=1 (disclosed sequential mode).
//   3. File ownership: implementation subagents may edit project files only
//      inside the globs of a task they have claimed; other roles may only
//      write drafts/artifacts under .eccode/.
// Decisions are returned as PreToolUse permissionDecision JSON. Unexpected
// internal errors fail open (logged to stderr) so a guard bug cannot brick a
// session; rule violations always deny. Disable with ECCODE_HOOKS=off.

const fs = require('fs');
const path = require('path');

const IMPLEMENTERS = new Set(['frontend-engineer', 'backend-engineer', 'ai-engineer', 'test-engineer', 'devops-engineer', 'learning-debugger', 'delivery-lead']);
const ROLES = new Set([...IMPLEMENTERS, 'product-architect', 'architecture-reviewer', 'technical-designer', 'technical-reviewer', 'security-reviewer']);
const RECORD_FILES = /(^|\/)\.eccode\/(events\.jsonl|state\.json|config\.json|evidence\/|improvements\/|memory\/records\/)/;
// Where each kind of role may write under .eccode/ (drafts are shared scratch).
const DOC_AUTHORS = new Set(['product-architect', 'technical-designer', 'delivery-lead']);
const REVIEWERS = new Set(['architecture-reviewer', 'technical-reviewer', 'security-reviewer']);
function draftAreas(role) {
  if (DOC_AUTHORS.has(role)) return ['.eccode/artifacts/**', '.eccode/drafts/**'];
  if (REVIEWERS.has(role)) return ['.eccode/reviews/drafts/**', '.eccode/drafts/**'];
  return ['.eccode/drafts/**'];
}

function out(decision, reason) {
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: decision, permissionDecisionReason: reason } }));
  process.exit(0);
}

function findRoot(start) {
  let dir = start;
  for (;;) {
    if (fs.existsSync(path.join(dir, '.eccode', 'events.jsonl'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function roleOf(agentType) {
  if (!agentType) return null;
  const name = String(agentType).split(':').pop();
  return ROLES.has(name) ? name : `other:${name}`;
}

function main(input) {
  if (process.env.ECCODE_HOOKS === 'off') return;
  const tool = input.tool_name;
  const ti = input.tool_input || {};
  const root = findRoot(process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd());
  if (!root) return; // not an ECCode project: no opinion
  const lib = path.join(__dirname, '..', '..', 'lib');
  const { matchesAny, toPosix } = require(path.join(lib, 'util'));
  const role = roleOf(input.agent_type);

  if (tool === 'Bash') {
    const cmd = String(ti.command || '');
    if (/(>|>>|\btee\b|\bsed\s+-i|\bmv\b|\bcp\b|\brm\b|\btruncate\b)[^|;&]*\.eccode\/(events\.jsonl|state\.json|config\.json)/.test(cmd)) {
      out('deny', 'ECCode project record files are written only by the eccode CLI. Use eccode commands; never edit the record directly.');
    }
    if (/\beccode(\.js)?\b/.test(cmd)) {
      const m = cmd.match(/--actor[= ]+["']?([\w-]+)/);
      const actor = m ? m[1] : process.env.ECCODE_ACTOR || null;
      if (role) {
        if (actor && actor !== role) {
          out('deny', `Identity mismatch: this subagent is ${role} but the command acts as "${actor}". Each agent records work only under its own role.`);
        }
      } else if (actor && ROLES.has(actor) && process.env.ECCODE_SEQUENTIAL_ROLES !== '1') {
        out('deny', `The main session is the orchestrator; dispatch the ${actor} subagent instead of acting as it. (Sequential single-context mode requires ECCODE_SEQUENTIAL_ROLES=1 and must be disclosed to the user.)`);
      }
    }
    return;
  }

  if (['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(tool)) {
    const target = ti.file_path || ti.notebook_path;
    if (!target) return;
    const abs = path.resolve(input.cwd || root, target);
    const rel = toPosix(path.relative(root, abs));
    if (rel.startsWith('..') || path.isAbsolute(rel)) return; // outside the project (e.g. scratch dirs)
    if (RECORD_FILES.test(rel)) out('deny', `${rel} is part of the ECCode record and is written only by the eccode CLI.`);
    if (!role || role.startsWith('other:')) return; // main session or non-ECCode agent
    if (matchesAny(rel, draftAreas(role))) return;
    if (IMPLEMENTERS.has(role)) {
      const { Store } = require(path.join(lib, 'store'));
      const state = new Store(root).state();
      const claimed = Object.values(state.tasks).filter((t) => t.status === 'claimed' && t.claim && t.claim.agent === role);
      if (!claimed.length) out('deny', `${role} has no claimed task. Claim one first (eccode task claim <id> --actor ${role}); edits are allowed only inside its file ownership.`);
      if (!claimed.some((t) => matchesAny(rel, t.files))) {
        out('deny', `${rel} is outside the ownership of ${role}'s claimed task(s): ${claimed.map((t) => `${t.id} [${t.files.join(', ')}]`).join('; ')}. Report the need to the orchestrator instead.`);
      }
      return;
    }
    out('deny', `${role} reviews/designs but does not edit project files; write drafts under .eccode/artifacts/ or .eccode/reviews/drafts/.`);
  }
}

let raw = '';
process.stdin.on('data', (c) => (raw += c));
process.stdin.on('end', () => {
  try {
    main(JSON.parse(raw || '{}'));
  } catch (err) {
    process.stderr.write(`eccode guard: internal error, allowing tool call: ${err.message}\n`);
  }
  process.exit(0);
});
