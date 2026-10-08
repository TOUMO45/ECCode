#!/usr/bin/env node
'use strict';
// PreToolUse guard for Claude Code. Enforces, at tool-call time:
//   1. The project record (.eccode/events.jsonl, state.json, config.json,
//      memory, improvements, evidence, reviews, handoffs) is only written by
//      the eccode CLI, never by hand, and git may not roll it back or delete it.
//   2. Identity binding: inside a subagent, `eccode ... --actor X` must name
//      the subagent's own role; subagents can never act as `user` or
//      `orchestrator`. The actor is read exactly as the CLI will read it
//      (shell quoting, tabs, nested `sh -c`, the command after `--`), and
//      commands the guard cannot bind (repeated --actor, ECCODE_ACTOR set
//      inline, eccode behind a variable) are denied. The main session may act
//      as orchestrator/user, or as any role only when ECCODE_SEQUENTIAL_ROLES=1
//      (disclosed sequential mode).
//   3. File ownership: implementation subagents may edit project files only
//      inside the globs of a task they have claimed (never .eccode/ paths
//      other than drafts); other roles may only write drafts/artifacts under .eccode/.
// Decisions are returned as PreToolUse permissionDecision JSON. Unexpected
// internal errors fail open (logged to stderr) so a guard bug cannot brick a
// session; rule violations always deny, and so does a record that cannot be
// read. Disable with ECCODE_HOOKS=off.

const fs = require('fs');
const path = require('path');

const LIB = path.join(__dirname, '..', '..', 'lib');
const IMPLEMENTERS = new Set(['frontend-engineer', 'backend-engineer', 'ai-engineer', 'test-engineer', 'devops-engineer', 'learning-debugger', 'delivery-lead']);
const ROLES = new Set([...IMPLEMENTERS, 'product-architect', 'architecture-reviewer', 'technical-designer', 'technical-reviewer', 'security-reviewer']);
// Record areas written only by the CLI (review drafts are the reviewers' scratch area).
const RECORD_AREA = String.raw`\.eccode\/(?:events\.jsonl|state\.json|config\.json|\.lock|memory\/|improvements\/|evidence\/|handoffs\/|delivery\/|reviews\/(?!drafts\/))`;
const RECORD_FILES = new RegExp(String.raw`(^|\/)${RECORD_AREA}`);
// Shell commands that write their (later) path argument, and code that writes files.
const SHELL_WRITE = new RegExp(String.raw`(>|\btee\b|\b(?:sed|perl)\s+(?:-\w+\s+)*-\w*i|\bmv\b|\bcp\b|\brm\b|\btruncate\b|\bdd\b|\bln\b|\binstall\b|\brsync\b|\btouch\b)[^|;&]*${RECORD_AREA}`);
const CODE_WRITE = /\b(writeFileSync|writeFile|writeSync|appendFileSync|appendFile|createWriteStream|rmSync|rmdirSync|unlinkSync|unlink|renameSync|rename|copyFileSync|copyFile|cpSync|truncateSync|ftruncateSync|symlinkSync|write_text|write_bytes|os\.remove|os\.rename|os\.replace|shutil\.\w+)\b|\bopen\s*\([^)]*['"][wax]b?\+?['"]/;
// Variables that change who the CLI acts as, or its clock (order rules), when set inline.
const IDENTITY_ENV = /^(?:ECCODE_ACTOR|ECCODE_TEST|ECCODE_NOW)(?:=|$)/;
const ECCODE_WORD = /(^|\/)eccode(\.js)?$/;
// git subcommands that can revert, stash or delete working-tree files.
const GIT_REVERTING = new Set(['checkout', 'restore', 'reset', 'stash', 'clean', 'rm', 'mv']);
const MAX_DEPTH = 4;

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

// ---------------------------------------------------------------- shell parsing

/**
 * Split a command line into simple commands (arrays of words) the way sh does
 * for what matters here: '…' and "…" quoting, backslash escapes, any blank
 * (space, tab) between words, # comments, and ; & | && || ( ) newline between
 * commands. Expansions are not performed: a word that contained an unquoted or
 * double-quoted $ or ` keeps it in its text and is marked dynamic.
 */
function splitCommands(src) {
  const commands = [];
  let words = [];
  let word = null;
  const add = (s, dynamic = false) => {
    word = word || { text: '', dynamic: false };
    word.text += s;
    word.dynamic = word.dynamic || dynamic;
  };
  const endWord = () => {
    if (word) words.push(word);
    word = null;
  };
  const endCommand = () => {
    endWord();
    if (words.length) commands.push(words);
    words = [];
  };
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === '\\') {
      if (src[i + 1] !== undefined && src[i + 1] !== '\n') add(src[i + 1]);
      i++;
    } else if (c === "'") {
      const j = src.indexOf("'", i + 1);
      add(j === -1 ? src.slice(i + 1) : src.slice(i + 1, j));
      i = j === -1 ? src.length : j;
    } else if (c === '"') {
      let j = i + 1;
      let s = '';
      let dynamic = false;
      for (; j < src.length && src[j] !== '"'; j++) {
        if (src[j] === '\\' && '"\\$`\n'.includes(src[j + 1] || '')) s += src[++j];
        else {
          if (src[j] === '$' || src[j] === '`') dynamic = true;
          s += src[j];
        }
      }
      add(s, dynamic);
      i = j;
    } else if (c === '#' && !word) {
      while (i + 1 < src.length && src[i + 1] !== '\n') i++;
    } else if (c === ' ' || c === '\t' || c === '\r') {
      endWord();
    } else if ('\n;&|()'.includes(c)) {
      endCommand();
    } else {
      add(c, c === '$' || c === '`');
    }
  }
  endCommand();
  return commands;
}

/**
 * Walk every simple command of a command line, including command strings run
 * by a nested shell or interpreter (sh -c '…', eval, node -e "…execSync('…')")
 * and the command an eccode invocation runs after `--` (evidence run, improve
 * evaluate). visit(words, raw) is called for each.
 */
function walkCommands(src, visit, depth = 0) {
  if (depth > MAX_DEPTH) return;
  for (const words of splitCommands(src)) walkWords(words, src, visit, depth);
}

function walkWords(words, raw, visit, depth) {
  visit(words, raw);
  for (const w of words) if (/\s/.test(w.text)) walkCommands(w.text, visit, depth + 1);
  const at = words.findIndex((w) => ECCODE_WORD.test(w.text));
  const dd = at === -1 ? -1 : words.findIndex((w, i) => i > at && w.text === '--');
  if (dd !== -1 && dd + 1 < words.length && depth < MAX_DEPTH) {
    const rest = words.slice(dd + 1);
    // One argument is a shell command string; several are an argv vector (see bin/eccode.js).
    if (rest.length === 1) walkCommands(rest[0].text, visit, depth + 1);
    else walkWords(rest, raw, visit, depth + 1);
  }
}

// ------------------------------------------------------------------- identity

/**
 * Actors asserted by the eccode invocations in a command line, bound exactly
 * as the CLI binds them (lib/cli-args.js: last-wins is refused, --actor=x,
 * nothing after `--`). Returns {actors, problems}.
 */
function eccodeActors(cmd) {
  const { parseArgs } = require(path.join(LIB, 'cli-args'));
  const actors = new Set();
  const problems = [];
  const mentionsEccode = /eccode/.test(cmd);
  walkCommands(cmd, (words) => {
    if (words.some((w) => IDENTITY_ENV.test(w.text))) problems.push('ECCODE_ACTOR / ECCODE_TEST / ECCODE_NOW may not be set inline; pass --actor <your role> explicitly');
    const at = words.findIndex((w) => ECCODE_WORD.test(w.text));
    if (at === -1) {
      // The command word is the first word that is not a NAME=value assignment.
      const commandWord = words.find((w) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(w.text));
      if (mentionsEccode && commandWord && commandWord.dynamic) problems.push(`"${commandWord.text}" runs a command through a variable or substitution; call the eccode CLI directly so its --actor can be checked`);
      return;
    }
    const args = words.slice(at + 1).map((w) => w.text);
    let flags;
    try {
      ({ flags } = parseArgs(args));
    } catch (err) {
      problems.push(`the eccode command is malformed (${err.message}); give --actor exactly once`);
      return;
    }
    const actor = typeof flags.actor === 'string' ? flags.actor : process.env.ECCODE_ACTOR || null;
    if (actor !== null && !/^[A-Za-z0-9_-]+$/.test(actor)) problems.push(`--actor must be a literal role name (got ${JSON.stringify(actor)})`);
    else if (actor) actors.add(actor);
  });
  return { actors: [...actors], problems };
}

// ----------------------------------------------------------- record protection

/** Why a git command would revert, stash or delete the record (null = it would not). */
function gitRecordRisk(words) {
  const gi = words.findIndex((w) => /(^|\/)git$/.test(w.text));
  if (gi === -1) return null;
  let i = gi + 1;
  while (i < words.length && words[i].text.startsWith('-')) i += ['-C', '-c', '--git-dir', '--work-tree', '--namespace'].includes(words[i].text) ? 2 : 1;
  const sub = words[i] && words[i].text;
  if (!GIT_REVERTING.has(sub)) return null;
  const args = words.slice(i + 1).map((w) => w.text);
  const paths = args.filter((a) => !a.startsWith('-'));
  const wholeTree = (p) => ['.', './', '*', ':/', ':(top)'].includes(p);
  if (args.some((a) => /(^|[/=:])\.eccode(\/|$)/.test(a))) return `git ${sub} on .eccode/`;
  if (sub === 'reset' && args.some((a) => ['--hard', '--merge', '--keep'].includes(a))) return `git reset ${args.find((a) => a.startsWith('--'))}`;
  if (sub === 'stash' && !['list', 'show'].includes(paths[0])) return 'git stash';
  if (sub === 'clean' && (!paths.length || paths.some(wholeTree))) return 'git clean of the whole tree';
  if (['checkout', 'restore', 'rm'].includes(sub) && paths.some(wholeTree)) return `git ${sub} of the whole tree`;
  return null;
}

function checkBash(cmd, role) {
  if (SHELL_WRITE.test(cmd) || (new RegExp(RECORD_AREA).test(cmd) && CODE_WRITE.test(cmd))) {
    out('deny', 'ECCode project record files are written only by the eccode CLI. Use eccode commands; never edit the record directly.');
  }
  let gitRisk = null;
  walkCommands(cmd, (words) => {
    gitRisk = gitRisk || gitRecordRisk(words);
  });
  if (gitRisk) {
    out('deny', `${gitRisk} can roll back or delete the ECCode record (.eccode/). Restore or discard specific project files by path instead (e.g. git checkout -- src/x.js); record repairs are the user's decision.`);
  }
  if (!/eccode|ECCODE_/.test(cmd)) return;
  const { actors, problems } = eccodeActors(cmd);
  if (problems.length) out('deny', `The guard cannot verify who this eccode command acts as: ${problems[0]}.`);
  if (role) {
    const other = actors.find((a) => a !== role);
    if (other) out('deny', `Identity mismatch: this subagent is ${role} but the command acts as "${other}". Each agent records work only under its own role.`);
  } else if (process.env.ECCODE_SEQUENTIAL_ROLES !== '1') {
    const other = actors.find((a) => ROLES.has(a));
    if (other) out('deny', `The main session is the orchestrator; dispatch the ${other} subagent instead of acting as it. (Sequential single-context mode requires ECCODE_SEQUENTIAL_ROLES=1 and must be disclosed to the user.)`);
  }
}

// ------------------------------------------------------------------ file edits

function checkEdit(root, rel, role) {
  const { matchesAny } = require(path.join(LIB, 'util'));
  if (RECORD_FILES.test(rel)) out('deny', `${rel} is part of the ECCode record and is written only by the eccode CLI.`);
  if (!role || role.startsWith('other:')) return; // main session or non-ECCode agent
  if (matchesAny(rel, draftAreas(role))) return;
  if (IMPLEMENTERS.has(role)) {
    const { Store } = require(path.join(LIB, 'store'));
    const { owns } = require(path.join(LIB, 'tasks'));
    let state;
    try {
      state = new Store(root).state();
    } catch (err) {
      // Fail closed: without a readable record there is no claim to authorize the edit.
      out('deny', `The ECCode record cannot be read (${err.code || 'error'}: ${err.message}); edits are denied until it is repaired. Run "eccode audit" and report to the orchestrator.`);
    }
    const claimed = Object.values(state.tasks).filter((t) => t.status === 'claimed' && t.claim && t.claim.agent === role);
    if (!claimed.length) out('deny', `${role} has no claimed task. Claim one first (eccode task claim <id> --actor ${role}); edits are allowed only inside its file ownership.`);
    if (!claimed.some((t) => owns(t.files, rel))) {
      out('deny', `${rel} is outside the ownership of ${role}'s claimed task(s): ${claimed.map((t) => `${t.id} [${t.files.join(', ')}]`).join('; ')} (tasks never own .eccode/ paths other than drafts). Report the need to the orchestrator instead.`);
    }
    return;
  }
  out('deny', `${role} reviews/designs but does not edit project files; write drafts under .eccode/artifacts/ or .eccode/reviews/drafts/.`);
}

function main(input) {
  if (process.env.ECCODE_HOOKS === 'off') return;
  const tool = input.tool_name;
  const ti = input.tool_input || {};
  const root = findRoot(process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd());
  if (!root) return; // not an ECCode project: no opinion
  const { toPosix } = require(path.join(LIB, 'util'));
  const role = roleOf(input.agent_type);

  if (tool === 'Bash') return checkBash(String(ti.command || ''), role);

  if (['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(tool)) {
    const target = ti.file_path || ti.notebook_path;
    if (!target) return;
    const abs = path.resolve(input.cwd || root, target);
    const rel = toPosix(path.relative(root, abs));
    if (rel.startsWith('..') || path.isAbsolute(rel)) return; // outside the project (e.g. scratch dirs)
    checkEdit(root, rel, role);
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
