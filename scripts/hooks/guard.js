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
//      write drafts/artifacts under .eccode/. This applies to the file tools
//      AND to literal shell write targets (redirections, tee, sed -i, cp, mv,
//      rm, truncate), so an implementer cannot route around ownership with
//      `echo code > other/file`.
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
// A call of the eccode CLI: eccode.js, or the command word eccode (bare or in
// a bin directory). The record directory (.eccode/), the toolkit directory
// (.claude/eccode) and paths that merely contain the word are not calls.
const CLI_REF = /eccode\.js\b|(^|[\s;&|(`'"=]|bin\/)eccode(?=$|[\s;&|)'"`])/;
// find's actions that write, delete or run something; without them find only lists.
const FIND_ACTIONS = /^-(delete|exec|execdir|ok|okdir|fprint|fprint0|fprintf|fls)$/;
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
function shellSkeleton(cmd) {
  return cmd
    // Heredoc bodies are data for the command that reads them, not commands.
    .replace(/<<-?\s*(['"]?)(\w+)\1[^\n]*\n[\s\S]*?\n[ \t]*\2[ \t]*(?=\n|$)/g, '<<$2')
    // Quoted text can neither redirect nor split commands: keep it as one word.
    // A backslash outside quotes makes the next character literal (\" is not a
    // quote); inside double quotes it escapes the next character too.
    .replace(/\\([\s\S])|'([^']*)'|"((?:[^"\\]|\\[\s\S])*)"/g, (m, e, a, b) => (e !== undefined ? e : a !== undefined ? a : b).replace(/[;|&<>\s]/g, '_'))
    // `>|` (noclobber override) is a redirection like `>`.
    .replace(/>\|/g, '> ');
}

// Command separators: ||, &&, ;, |, newline, and a single & (background).
const SEPARATORS = /\|\||&&|[;|\n]|(?<![>&])&(?![>&])/;

/**
 * Literal paths a shell command writes to: redirections and write-tool
 * arguments, each joined to the directory of the last literal `cd` before it
 * (a cd the text cannot resolve leaves targets where they were).
 */
function bashWriteTargets(cmd) {
  const targets = [];
  const skeleton = shellSkeleton(cmd);
  let dir = '';
  const at = (t) => (t && dir && !path.isAbsolute(t) ? path.join(dir, t) : t);
  // A cd moves later targets only along an && chain: if it fails, nothing
  // after it in the chain runs. Any other separator (;, newline, ||, |, &)
  // may run the next command where the shell already was; a subshell undoes it.
  const subshell = /[()]/.test(skeleton);
  const parts = skeleton.split(new RegExp(`(${SEPARATORS.source})`));
  for (let i = 0; i < parts.length; i += 2) {
    const segment = parts[i];
    if (i > 0 && parts[i - 1] !== '&&') dir = '';
    for (const m of segment.replace(/\d*>&\d+/g, '').matchAll(/>>?\s*([^\s;&|)]+)/g)) targets.push(at(m[1]));
    const words = segment.trim().replace(/^\(+/, '').split(/\s+/).filter((w) => w && !/^\w+=/.test(w));
    if (!words.length) continue;
    const name = path.basename(words[0]);
    const args = words.slice(1).filter((a) => !a.startsWith('-'));
    if (name === 'cd') {
      const to = words[1];
      const alone = !subshell && words.length === 2 && parts[i + 1] === '&&';
      dir = alone && to && !/[$`~*?]/.test(to) && !to.startsWith('-') ? (path.isAbsolute(to) ? to : path.join(dir, to)) : '';
    } else if (name === 'tee') targets.push(...args.map(at));
    else if (name === 'truncate' || name === 'unlink' || name === 'rm') targets.push(...args.map(at));
    else if ((name === 'cp' || name === 'mv') && args.length >= 2) targets.push(at(args[args.length - 1]));
    else if (name === 'sed' && /\ssed\s[^;|&]*(-i|--in-place)/.test(` ${segment} `)) targets.push(at(args[args.length - 1]));
  }
  return targets.filter((t) => t && t !== '/dev/null' && !t.startsWith('<'));
}

function writesRecord(cmd, { subagent }) {
  if (!RECORD_REF.test(cmd)) return false; // heredoc bodies count: `python3 - <<EOF` can write too
  const shell = shellSkeleton(cmd);
  for (const m of shell.matchAll(/>>?\s*([^\s;&|]+)/g)) if (RECORD_REF.test(m[1])) return true;
  for (const segment of shell.split(SEPARATORS)) {
    const words = segment.trim().split(/\s+/).filter((w) => w && !/^\w+=/.test(w));
    if (!words.length) continue;
    const name = path.basename(words[0]);
    const args = words.slice(1);
    if (READ_ONLY.has(name)) continue;
    if (name === 'sed' && !args.some((a) => /^(-i|--in-place)/.test(a))) continue;
    if (name === 'find' && !args.some((a) => FIND_ACTIONS.test(a) || /[\\$`]/.test(a))) continue; // find only lists
    if (/^eccode(\.js)?$/.test(name) || (['node', 'npx'].includes(name) && /(^|\/)eccode(\.js)?$/.test(args[0] || ''))) {
      // `evidence run … -- <cmd>` and `improve evaluate … -- <cmd>` execute <cmd>.
      const at = cmd.indexOf(' -- ');
      if (at !== -1 && writesRecord(cmd.slice(at + 4).trim().replace(/^(['"])([\s\S]*)\1$/, '$2'), { subagent })) return true;
      continue;
    }
    if (name === 'git') {
      // --output writes a file, whatever the subcommand.
      if (args.some((a) => /^--output(=|$)/.test(a))) return true;
      const subs = args.filter((a, i) => !a.startsWith('-') && !['-C', '-c'].includes(args[i - 1]));
      if (!subagent || GIT_READ.has(subs[0]) || (subs[0] === 'stash' && ['list', 'show'].includes(subs[1]))) continue;
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

/**
 * Every --actor value in a command, as the shell would see the word: quotes
 * removed and adjacent pieces joined (us''er -> user). A value containing
 * shell expansion is marked dynamic.
 */
function actorWords(cmd) {
  const out = [];
  const re = /--actor(?:=|\s+)/g;
  let m;
  while ((m = re.exec(cmd))) {
    let i = m.index + m[0].length;
    let value = '';
    let dynamic = false;
    while (i < cmd.length && !/[\s;|&]/.test(cmd[i])) {
      const ch = cmd[i];
      if (ch === "'") {
        const end = cmd.indexOf("'", i + 1);
        value += cmd.slice(i + 1, end === -1 ? cmd.length : end);
        i = end === -1 ? cmd.length : end + 1;
      } else if (ch === '"') {
        const end = cmd.indexOf('"', i + 1);
        const seg = cmd.slice(i + 1, end === -1 ? cmd.length : end);
        if (/[$`]/.test(seg)) dynamic = true;
        value += seg;
        i = end === -1 ? cmd.length : end + 1;
      } else {
        if (ch === '$' || ch === '`') dynamic = true;
        if (ch === '\\') { value += cmd[i + 1] || ''; i += 2; continue; }
        value += ch;
        i += 1;
      }
    }
    out.push({ value, dynamic });
  }
  return out;
}

function roleOf(agentType) {
  if (!agentType) return null;
  const name = String(agentType).split(':').pop();
  return ROLES.has(name) ? name : `other:${name}`;
}

function main(input) {
  if (process.env.ECCODE_HOOKS === 'off') return;
  const tool = input.tool_name;
  // eccode MCP servers are locked to one role each: an agent may call only its
  // own role's server, the main session only the orchestrator's. Structural:
  // the role is in the tool name, not in any text the agent writes.
  const server = /^mcp__eccode_([\w-]+)__/.exec(String(tool || ''));
  if (server) {
    const caller = input.agent_type ? String(input.agent_type).split(':').pop() : 'orchestrator';
    if (server[1] !== caller) out('deny', `This eccode MCP server acts as ${server[1]}; ${input.agent_type ? `this subagent is ${caller}` : 'the main session is the orchestrator'}. Use the eccode_${caller} server.`);
    return;
  }
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
    if (CLI_REF.test(cmd)) {
      const parsed = actorWords(cmd);
      const flagged = parsed.map((w) => w.value);
      const actors = flagged.length ? flagged : [process.env.ECCODE_ACTOR].filter(Boolean);
      // Identity must be literal: an --actor value or eccode argument built by
      // shell expansion ($VAR, $(...), backticks), a flag name written with
      // quotes or escapes ('--actor', --act""or), or arguments fed through
      // xargs or eval cannot be checked from text.
      const argvPart = cmd.split(/\s--\s/)[0];
      // More --actor flags once quotes and escapes are removed: one was hidden.
      const hidden = actorWords(argvPart.replace(/\\(.)/g, '$1').replace(/['"]/g, '')).length > actorWords(argvPart).length
        || /(^|[\s;&|(])(xargs|eval)\s/.test(argvPart);
      if (parsed.some((w) => w.dynamic) || /\$[\w{(]|`/.test(argvPart) || hidden) {
        if (role) out('deny', `Identity must be written literally: use --actor ${role} with no shell expansion in the eccode arguments.`);
        out('ask', 'ECCode: this eccode command builds its arguments with shell expansion, so the acting identity cannot be read from the command text. Approve only if you, the human, intend exactly what it will run.');
      }
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
    // Shell writes obey the same ownership policy as the file tools; nobody,
    // the main session included, writes a record file from the shell.
    for (const target of bashWriteTargets(cmd)) {
      const reason = ownershipDenial(root, lib, role, path.resolve(input.cwd || root, target));
      if (reason) out('deny', `Shell write to ${target}: ${reason}`);
    }
    return;
  }

  if (['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(tool)) {
    const target = ti.file_path || ti.notebook_path;
    if (!target) return;
    const reason = ownershipDenial(root, lib, role, path.resolve(input.cwd || root, target));
    if (reason) out('deny', reason);
  }
}

/** The shared ownership policy; returns a denial reason or null. */
function ownershipDenial(root, lib, role, abs) {
  const { matchesAny, toPosix } = require(path.join(lib, 'util'));
  const rel = toPosix(path.relative(root, abs));
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null; // outside the project (e.g. scratch dirs)
  if (RECORD_FILES.test(rel)) return `${rel} is part of the ECCode record and is written only by the eccode CLI.`;
  if (!role || role.startsWith('other:')) return null; // main session or non-ECCode agent
  if (matchesAny(rel, draftAreas(role))) return null;
  if (IMPLEMENTERS.has(role)) {
    const { Store } = require(path.join(lib, 'store'));
    const state = new Store(root).state();
    const claimed = Object.values(state.tasks).filter((t) => t.status === 'claimed' && t.claim && t.claim.agent === role);
    if (!claimed.length) return `${role} has no claimed task. Claim one first (eccode task claim <id> --actor ${role}); edits are allowed only inside its file ownership.`;
    if (!claimed.some((t) => matchesAny(rel, t.files))) {
      return `${rel} is outside the ownership of ${role}'s claimed task(s): ${claimed.map((t) => `${t.id} [${t.files.join(', ')}]`).join('; ')}. Report the need to the orchestrator instead.`;
    }
    return null;
  }
  return `${role} reviews/designs but does not edit project files; write drafts under .eccode/artifacts/ or .eccode/reviews/drafts/.`;
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
