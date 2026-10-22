#!/usr/bin/env node
'use strict';
// PreToolUse guard for Claude Code. Enforces, at tool-call time:
//   1. The project record (.eccode/events.jsonl, state.json, config.json,
//      evidence logs, memory records) is only written by the eccode CLI: a
//      shell command that touches it may only read it (cat, jq, grep, git
//      diff/log/show, …) or call eccode. Interpreters, copies, deletes and
//      redirections are refused.
//   2. Identity binding: inside a subagent, every `--actor X` must name the
//      subagent's own role and ECCODE_ACTOR may not be set; subagents can never
//      act as `user` or `orchestrator`. The main session may act as
//      orchestrator, or as any role only when ECCODE_SEQUENTIAL_ROLES=1
//      (disclosed sequential mode). Acting as `user` makes Claude Code ask the
//      human to confirm the command.
//   3. File ownership: implementation subagents may edit project files only
//      inside the globs of a task they have claimed; other roles may only
//      write drafts/artifacts under .eccode/.
// Decisions are returned as PreToolUse permissionDecision JSON. Unexpected
// internal errors fail open (logged to stderr) so a guard bug cannot brick a
// session, unless ECCODE_STRICT=1, which fails closed. Rule violations always
// deny. Disable with ECCODE_HOOKS=off.
// Limit: this reads shell text. Deliberately obfuscated commands (quoting
// tricks, variables, scripts written to disk first) can get past it; the
// record's hash chain and `eccode audit --against <ref>` detect the result.

const fs = require('fs');
const path = require('path');

const IMPLEMENTERS = new Set(['frontend-engineer', 'backend-engineer', 'ai-engineer', 'test-engineer', 'devops-engineer', 'learning-debugger', 'delivery-lead']);
const ROLES = new Set([...IMPLEMENTERS, 'product-architect', 'architecture-reviewer', 'technical-designer', 'technical-reviewer', 'security-reviewer']);
const RECORD_FILES = /(^|\/)\.eccode\/(events\.jsonl|state\.json|config\.json|evidence\/|improvements\/|memory\/records\/)/;
// Shell text that refers to the record (bare `.eccode` covers `cd .eccode && …`).
const RECORD_REF = /events\.jsonl|state\.json|\.eccode\/(config\.json|evidence|improvements|memory)|\.eccode\/?(?=$|[\s"';&|)])/;
const READ_ONLY = new Set(['cat', 'head', 'tail', 'less', 'more', 'jq', 'grep', 'egrep', 'fgrep', 'rg', 'wc', 'ls', 'stat', 'file', 'diff', 'cmp', 'sha256sum', 'shasum', 'md5sum', 'cd', 'pwd', 'echo', 'printf', 'sort', 'uniq', 'cut', 'tr', 'test', '[', 'true']);
const GIT_READ = new Set(['diff', 'log', 'show', 'status', 'blame', 'grep', 'ls-files', 'rev-parse', 'cat-file']);
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

/**
 * True when a shell command that refers to the record does anything other than
 * read it or call the eccode CLI. Subagents may only use read-only git; the
 * main session may use any git command (commits, restores).
 */
function writesRecord(cmd, { subagent }) {
  if (!RECORD_REF.test(cmd)) return false; // heredoc bodies count: `python3 - <<EOF` can write too
  const shell = cmd
    // Heredoc bodies are data for the command that reads them, not commands.
    .replace(/<<-?\s*(['"]?)(\w+)\1[^\n]*\n[\s\S]*?\n[ \t]*\2[ \t]*(?=\n|$)/g, '<<$2')
    // Quoted text can neither redirect nor split commands: keep it as one word.
    .replace(/'([^']*)'|"([^"]*)"/g, (m, a, b) => (a !== undefined ? a : b).replace(/[;|&<>\s]/g, '_'));
  for (const m of shell.matchAll(/>>?\s*([^\s;&|]+)/g)) if (RECORD_REF.test(m[1])) return true;
  for (const segment of shell.split(/\|\||&&|[;|\n]/)) {
    const words = segment.trim().split(/\s+/).filter((w) => w && !/^\w+=/.test(w));
    if (!words.length) continue;
    const name = path.basename(words[0]);
    const args = words.slice(1);
    if (READ_ONLY.has(name)) continue;
    if (name === 'sed' && !args.some((a) => /^(-i|--in-place)/.test(a))) continue;
    if (/^eccode(\.js)?$/.test(name) || (['node', 'npx'].includes(name) && /(^|\/)eccode(\.js)?$/.test(args[0] || ''))) {
      // `evidence run … -- <cmd>` and `improve evaluate … -- <cmd>` execute <cmd>.
      const at = cmd.indexOf(' -- ');
      if (at !== -1 && writesRecord(cmd.slice(at + 4).trim().replace(/^(['"])([\s\S]*)\1$/, '$2'), { subagent })) return true;
      continue;
    }
    if (name === 'git') {
      const sub = args.find((a, i) => !a.startsWith('-') && !['-C', '-c'].includes(args[i - 1]));
      if (!subagent || GIT_READ.has(sub)) continue;
    }
    return true;
  }
  return false;
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
    if (writesRecord(cmd, { subagent: Boolean(role) })) {
      out('deny', 'This command touches the ECCode record (events.jsonl, state.json, config, evidence, improvements, memory records) with something other than a read-only tool or the eccode CLI. The record is written only by eccode commands; read it with cat, jq, grep or git diff/log/show.');
    }
    if (/\beccode(\.js)?\b/.test(cmd)) {
      const flagged = [...cmd.matchAll(/--actor[= ]+["']?([\w-]+)/g)].map((m) => m[1]);
      const actors = flagged.length ? flagged : [process.env.ECCODE_ACTOR].filter(Boolean);
      if (role) {
        if (/\bECCODE_ACTOR\s*=/.test(cmd)) {
          out('deny', `Subagents identify themselves with --actor ${role}; setting ECCODE_ACTOR inside a command is not allowed.`);
        }
        const other = actors.find((a) => a !== role);
        if (other) {
          out('deny', `Identity mismatch: this subagent is ${role} but the command acts as "${other}". Each agent records work only under its own role.`);
        }
      } else {
        const roleActor = actors.find((a) => ROLES.has(a));
        if (roleActor && process.env.ECCODE_SEQUENTIAL_ROLES !== '1') {
          out('deny', `The main session is the orchestrator; dispatch the ${roleActor} subagent instead of acting as it. (Sequential single-context mode requires ECCODE_SEQUENTIAL_ROLES=1 and must be disclosed to the user.)`);
        }
        if (actors.includes('user')) {
          out('ask', 'ECCode: this command records a decision as the USER (--actor user): accepting a risk, reopening a gate or task, raising limits or adopting a workflow change. Approve only if you, the human, made this decision. The record cannot tell who typed it.');
        }
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
    if (process.env.ECCODE_STRICT === '1') out('deny', `ECCode guard internal error (ECCODE_STRICT=1 fails closed): ${err.message}`);
    process.stderr.write(`eccode guard: internal error, allowing tool call: ${err.message}\n`);
  }
  process.exit(0);
});
