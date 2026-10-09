#!/usr/bin/env node
'use strict';
// PreToolUse guard for Claude Code. Enforces, at tool-call time:
//   1. The project record (.eccode/events.jsonl, state.json, config.json,
//      memory, improvements, evidence, reviews, handoffs) is only written by
//      the eccode CLI, never by hand, and git may not roll it back or delete it.
//      This holds wherever such a file lives: this project, another project,
//      or the shared memory under ~/.eccode/ (paths outside the project are
//      otherwise nobody's business).
//   2. Identity binding: inside a subagent, `eccode ... --actor X` must name
//      the subagent's own role; subagents can never act as `orchestrator`. The
//      actor is read exactly as the CLI will read it (shell quoting, tabs,
//      nested `sh -c`, the command after `--`, an exported ECCODE_ACTOR), and
//      commands the guard cannot bind (repeated --actor, ECCODE_ACTOR set
//      inline, eccode behind a variable) are denied. `--actor user` is denied
//      from EVERY agent context, the main session included: it is reserved for
//      a person at a terminal, or for a bounded delegation the user granted
//      (eccode delegate grant) used with --actor orchestrator --delegation <id>.
//      The main session may act as orchestrator, or as any role only when
//      ECCODE_SEQUENTIAL_ROLES=1 (disclosed sequential mode).
//   3. File ownership: implementation subagents may edit project files only
//      inside the globs of a task they have claimed (never .eccode/ paths
//      other than drafts); other roles may only write drafts/artifacts under
//      .eccode/. A shell write gets the same answer as the Edit tool for every
//      ECCode role: redirects, tee, cp/mv/ln/install/rsync, sed/perl -i, dd and
//      touch targets are resolved from the hook's cwd (a relative path after a
//      cd inside the command cannot be bound and is denied). Inline interpreter
//      programs (node -e, python -c, perl/ruby -e, php -r, deno eval, a heredoc,
//      here-string or pipe into a bare interpreter) that call a file-writing
//      API are denied for every ECCode role, because the guard cannot see
//      which files they would change; the main session is not affected.
// Residual, stated in docs/threat-model.md: the guard reads commands without
// running them, so a program it cannot read (a script file, code held in a
// shell variable or built at run time, an interpreter it does not know) still
// escapes the ownership rules; completion's git accounting is the backstop.
// Decisions are returned as PreToolUse permissionDecision JSON. Unexpected
// internal errors fail open (logged to stderr) so a guard bug cannot brick a
// session; rule violations always deny, and so does a record that cannot be
// read. Disable with ECCODE_HOOKS=off.

const fs = require('fs');
const os = require('os');
const path = require('path');

const LIB = path.join(__dirname, '..', '..', 'lib');
const IMPLEMENTERS = new Set(['frontend-engineer', 'backend-engineer', 'ai-engineer', 'test-engineer', 'devops-engineer', 'learning-debugger', 'delivery-lead']);
const ROLES = new Set([...IMPLEMENTERS, 'product-architect', 'architecture-reviewer', 'technical-designer', 'technical-reviewer', 'security-reviewer']);
// Record areas written only by the CLI (review drafts are the reviewers' scratch area).
// Both separators are accepted, and repeated ones (a backslash doubled inside a quoted program): an agent on Windows writes native paths (C:\proj\.eccode\state.json)
// and a command string is read before any path normalisation.
const RECORD_AREA = String.raw`\.eccode[\\/]+(?:events\.jsonl|state\.json|config\.json|\.lock|memory[\\/]+|improvements[\\/]+|evidence[\\/]+|handoffs[\\/]+|delivery[\\/]+|reviews[\\/]+(?!drafts[\\/]+))`;
const RECORD_FILES = new RegExp(String.raw`(^|[\\/])${RECORD_AREA}`);
// Shell commands that write their (later) path argument, and code that writes files.
const SHELL_WRITE = new RegExp(String.raw`(>{1,2}\|?|\btee\b|\b(?:sed|perl)\s+(?:-\w+\s+)*-\w*i|\bmv\b|\bcp\b|\brm\b|\btruncate\b|\bdd\b|\bln\b|\binstall\b|\brsync\b|\btouch\b)[^|;&]*${RECORD_AREA}`);
const CODE_WRITE = /\b(writeFileSync|writeFile|writeSync|appendFileSync|appendFile|createWriteStream|rmSync|rmdirSync|unlinkSync|unlink|renameSync|rename|copyFileSync|copyFile|cpSync|truncateSync|ftruncateSync|symlinkSync|fs\.rm|promises\.rm|write_text|write_bytes|os\.remove|os\.rename|os\.replace|os\.rmdir|os\.truncate|shutil\.\w+|File\.(?:write|delete)|IO\.write|FileUtils\.\w+|file_put_contents|fwrite|Deno\.(?:write\w*|remove\w*|rename|copyFile\w*|truncate\w*))\b|\bopen\s*\([^)]*['"][wax]b?\+?['"]/;
// Variables that change who the CLI acts as, or its clock (order rules), when set inline.
const IDENTITY_ENV = /^(?:ECCODE_ACTOR|ECCODE_TEST|ECCODE_NOW|ECCODE_ROOT|ECCODE_SHARED_MEMORY|ECCODE_SEQUENTIAL_ROLES|ECCODE_HOOKS)(?:=|$)/;
// A shell function or alias defined in the same command line can hide the CLI from the words the
// guard binds (`e() { eccode "$@"; }; e … --actor user`).
// Unanchored: a definition can follow `then`, a `{`, a leading blank, sit inside `bash -c '…'` (checked at every
// nesting depth) and take any compound body (`{ … }`, `( … )`, `if … fi`, `while`, `case`, `[[`).
// A function name is any run of characters bash accepts (digits first, unicode, + % . - included).
const SHELL_WRAPPER = /(?:^|[\s;&|(){}])(?:function\s+[^\s;&|(){}<>"'$`=]+(?:\s*\(\s*\))?|[^\s;&|(){}<>"'$`=]+\s*\(\s*\))\s*(?:\{|\(|\bif\b|\bwhile\b|\buntil\b|\bfor\b|\bcase\b|\[\[|\n)|(?:^|[\s;&|(){}])alias\s+[^\s=]+=/;
/** The text of a word with its expansions removed, to see whether it names the CLI (`bin/$'eccode'.js`, `eccode.js${X}`). */
function stripDynamic(text) {
  return text.replace(/\$\{[^}]*\}|\$\([^)]*\)|`[^`]*`|\$\w+|[$`]/g, '');
}
const ECCODE_WORD = /(^|[\\/])eccode(\.js)?$/;
// git subcommands that can revert, stash or delete working-tree files.
const GIT_REVERTING = new Set(['checkout', 'restore', 'reset', 'stash', 'clean', 'rm', 'mv']);
// Words that run the command after them (their own flags and numeric arguments are skipped).
const WRAPPERS = new Set(['env', 'exec', 'command', 'builtin', 'nohup', 'nice', 'time', 'timeout', 'sudo', 'npx', 'xargs', 'stdbuf']);
const CHDIR = new Set(['cd', 'pushd', 'popd']);
const MAX_DEPTH = 4;
// The tokenizer reads a command line the way the Bash tool's shell does on every platform,
// including Git Bash on Windows: an unquoted backslash is an escape, so an unquoted native path
// (C:\Users\me\x.json) is read as C:Usersmex.json, which is what bash would write. A native path the
// agent quotes keeps its backslashes, and then the record patterns and the CLI word pattern above
// accept both separators. Keeping backslashes unconditionally was tried and rejected in review: it
// made `.eccode/drafts/.\./state.json` look like a draft while bash writes the record.

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

/** Is any segment of this absolute path a record directory? */
function insideRecord(abs) {
  return abs.split(/[\\/]/).includes('.eccode');
}

/**
 * Where a path really lands: the deepest existing ancestor resolved through symlinks, plus the
 * segments that do not exist yet. Every decision about a write target is made on this path, so an
 * alias (`ln -s "$PWD/.eccode" rec`), a quoted or escaped spelling, or a `..` cannot change it.
 */
function realize(abs) {
  let dir = path.resolve(abs);
  const rest = [];
  for (let hops = 0; hops < 64; hops++) {
    try {
      dir = fs.realpathSync(dir);
      break;
    } catch {
      // Not resolvable as a whole: a dangling link (its target does not exist yet) is followed by
      // hand so that `dangle -> .eccode/new.json` still lands in the record; otherwise climb.
      let link = null;
      try {
        if (fs.lstatSync(dir).isSymbolicLink()) link = fs.readlinkSync(dir);
      } catch {
        // does not exist at all
      }
      if (link !== null) {
        dir = path.resolve(path.dirname(dir), link);
        continue;
      }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      rest.unshift(path.basename(dir));
      dir = parent;
    }
  }
  return path.join(dir, ...rest);
}

/**
 * Does the command line create a link (ln, cp -s/-l, mklink), and is any operand of that link
 * computed (`ln -s $D lk`)? A write through a link made in the same line cannot be bound.
 */
function createsLink(cmd, base) {
  const out = { found: false, computed: false, intoRecord: false };
  walkCommands(cmd, (words) => {
    const texts = words.map((w) => w.text);
    const at = commandIndex(texts);
    if (at === -1) return;
    const name = texts[at].split('/').pop();
    if (name === 'ln' || name === 'mklink' || (name === 'cp' && texts.slice(at + 1).some((t) => /^-[a-zA-Z]*[sl]/.test(t)))) {
      out.found = true;
      for (const w of words.slice(at + 1)) {
        if (w.dynamic) out.computed = true;
        // An operand that already resolves into a record through existing links (`a -> .eccode`, then
        // `ln -s a b`) is a record operand, whatever its spelling.
        else if (!w.text.startsWith('-') && base && recordHit(path.resolve(base, w.text.replace(/^["']|["']$/g, '')))) out.intoRecord = true;
      }
    }
  });
  return out;
}

// Everything under a record directory is the record, except the three draft areas. Judged on real and
// lexical paths alike (a symlink planted inside the record is itself a record write).
const RECORD_SEGMENT = /(^|\/)\.eccode(\/|$)/;
const DRAFT_AREA = /(^|\/)\.eccode\/(?:drafts|artifacts|reviews\/drafts)(\/|$)/;
function recordPath(posixAbs) {
  return RECORD_SEGMENT.test(posixAbs) && !DRAFT_AREA.test(posixAbs);
}
function recordHit(abs) {
  const { toPosix } = require(path.join(LIB, 'util'));
  return recordPath(toPosix(path.resolve(abs))) || recordPath(toPosix(realize(abs)));
}

/**
 * The nearest project root above `start`, judged on real paths: `<dir>/.eccode` must be a real
 * directory (not a link) holding events.jsonl, and `dir` itself must not lie inside a record. A
 * record planted inside another record (`.eccode/.eccode/`, by `cp -r` or `init --root .eccode`) or
 * reached through a link therefore never counts: the guard would otherwise judge the outer record's
 * files as that bogus project's ordinary files.
 */
function findRoot(start) {
  let dir = realize(start);
  for (;;) {
    if (!insideRecord(dir)) {
      try {
        const rec = path.join(dir, '.eccode');
        if (!fs.lstatSync(rec).isSymbolicLink() && fs.statSync(rec).isDirectory() && fs.existsSync(path.join(rec, 'events.jsonl'))) return dir;
      } catch {
        // no record here
      }
    }
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

/** An ECCode role the ownership rules apply to (not the main session, not a non-ECCode agent). */
function eccodeRole(role) {
  return Boolean(role) && !role.startsWith('other:');
}

/** A project-relative path (from path.relative) that lies outside the project. */
function outsideProject(rel) {
  return rel === '..' || rel.startsWith('../') || path.isAbsolute(rel);
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
    } else if (c === '$' && (src[i + 1] === "'" || src[i + 1] === '"')) {
      // $'…' (ANSI-C quoting) and $"…" (locale quoting) are quotes, not expansions: the word stays literal.
      i++;
      if (src[i] === "'") {
        const j = src.indexOf("'", i + 1);
        add(j === -1 ? src.slice(i + 1) : src.slice(i + 1, j));
        i = j === -1 ? src.length : j;
      } else {
        const j = src.indexOf('"', i + 1);
        add(j === -1 ? src.slice(i + 1) : src.slice(i + 1, j));
        i = j === -1 ? src.length : j;
      }
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
    } else if (c === '|' && word && /^\d?>{1,2}$/.test(word.text)) {
      add('|'); // `>|` is the clobber redirect operator, not a pipe: the target follows it
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

/** Does any word the shell would see (at any nesting depth) name the CLI or one of its variables? */
function mentionsCli(cmd) {
  let found = false;
  walkCommands(cmd, (words) => {
    if (words.some((w) => /eccode|ECCODE_/.test(w.text))) found = true;
  });
  return found;
}

/**
 * Actors asserted by the eccode invocations in a command line, bound exactly
 * as the CLI binds them (lib/cli-args.js: last-wins is refused, --actor=x,
 * nothing after `--`). Returns {actors, problems}.
 */
function eccodeActors(cmd) {
  const { parseArgs } = require(path.join(LIB, 'cli-args'));
  const actors = new Set();
  const problems = [];
  // "Mentions the CLI" is decided on the words the shell would see (quotes removed, comments dropped),
  // so `ecc"ode".js` counts and `# see the eccode docs` does not.
  const mentionsEccode = mentionsCli(cmd);
  const wrapperSeen = new Set();
  walkCommands(cmd, (words, raw) => {
    if (mentionsEccode && !wrapperSeen.has(raw) && SHELL_WRAPPER.test(raw)) {
      wrapperSeen.add(raw);
      problems.push('a shell function or alias is defined in the same command line, so the eccode invocation behind it cannot be bound; call the eccode CLI directly');
    }
    if (words.some((w) => IDENTITY_ENV.test(w.text))) problems.push('ECCODE_ACTOR / ECCODE_TEST / ECCODE_NOW / ECCODE_ROOT / ECCODE_SHARED_MEMORY / ECCODE_SEQUENTIAL_ROLES / ECCODE_HOOKS may not be set inline; pass --actor <your role> and --root explicitly');
    // `V=ECCODE_SHARED_MEMORY; export $V=/tmp/x`, `declare "$N"=…`, `printf -v "$N" …`, `declare -n`:
    // an assignment whose NAME is computed (a computed VALUE after a literal name is fine).
    const texts = words.map((w) => w.text);
    const computedName = words.some((w) => w.dynamic && /^[^=]*[$`][^=]*=/.test(w.text))
      || (/^(?:printf)$/.test(texts[0]) && texts.some((t, i) => t === '-v' && words[i + 1] && words[i + 1].dynamic))
      || (/^(?:declare|typeset|local)$/.test(texts[0]) && texts.some((t) => /^-\w*n/.test(t)))
      || (/^(?:export|declare|typeset|readonly|local)$/.test(texts[0]) && words.slice(1).some((x) => x.dynamic && !/=/.test(x.text)));
    if (mentionsEccode && computedName) {
      problems.push('a variable with a computed name is assigned in the same command line as the eccode CLI; set variables by their literal name, or not inline');
    }
    const at = words.findIndex((w) => ECCODE_WORD.test(w.dynamic ? stripDynamic(w.text) : w.text));
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

// Commands whose non-flag arguments (or the last one) are written to.
const WRITE_ALL_ARGS = new Set(['tee', 'touch', 'truncate', 'rm', 'rmdir', 'mv', 'unlink', 'shred']); // mv removes its sources
const WRITE_LAST_ARG = new Set(['cp', 'ln', 'install', 'rsync']);
// Writers that take their targets from elsewhere (stdin, a found list): the guard cannot bind them.
const UNBOUND_WRITERS = /\b(?:rm|rmdir|mv|cp|tee|sed|perl|truncate|shred|unlink)\b/;
const WRITE_INPLACE = new Set(['sed', 'perl']);

/**
 * Index of the command word of a simple command: the first word that is not a
 * NAME=value assignment, looking through wrappers (env, exec, nohup, npx, …)
 * and their own flags or numeric arguments. -1 when there is none.
 */
function commandIndex(texts) {
  for (let i = 0; i < texts.length; i++) {
    const t = texts[i];
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(t)) continue;
    if (!WRAPPERS.has(t.split('/').pop())) return i;
    while (i + 1 < texts.length && /^(?:-|\d+$)/.test(texts[i + 1])) i++;
  }
  return -1;
}

/** Paths a shell command line writes to, as literally as the guard can read them. */
function bashWriteTargets(cmd) {
  const targets = [];
  walkCommands(cmd, (words) => {
    const texts = words.map((w) => w.text);
    for (let i = 0; i < texts.length; i++) {
      const w = texts[i];
      if (/^\d?>{1,2}\|?$/.test(w) && texts[i + 1]) targets.push(texts[++i]);
      else if (/^\d?>{1,2}\|?[^&].*/.test(w)) targets.push(w.replace(/^\d?>{1,2}\|?/, ''));
    }
    const cmdIdx = commandIndex(texts);
    if (cmdIdx === -1) return;
    const name = texts[cmdIdx].split('/').pop();
    const args = texts.slice(cmdIdx + 1).filter((t) => !/^[<>|&;]/.test(t));
    const positional = args.filter((a) => !a.startsWith('-'));
    if (WRITE_ALL_ARGS.has(name)) targets.push(...positional);
    else if (WRITE_LAST_ARG.has(name) && positional.length) targets.push(positional[positional.length - 1]);
    else if (WRITE_INPLACE.has(name) && args.some((a) => /^-\w*i/.test(a))) targets.push(...positional.filter((p) => !/^(s|y)[^A-Za-z0-9]/.test(p) && !/[;{}]/.test(p)));
    else if (name === 'dd') targets.push(...args.filter((a) => a.startsWith('of=')).map((a) => a.slice(3)));
    else if (name === 'find' && args.some((a) => /^-(?:delete|exec|execdir|ok|okdir)$/.test(a))) targets.push(...positional.filter((p, i) => i === 0 || !p.startsWith('-')).slice(0, 1).concat(positional.length ? [] : ['.']));
    else if (name === 'tar' && args.some((a) => /^-?[a-zA-Z]*x/.test(a) && !a.startsWith('--'))) {
      const c = args.findIndex((a) => a === '-C' || a === '--directory');
      targets.push(c !== -1 && args[c + 1] ? args[c + 1] : '.');
    } else if (name === 'unzip') {
      const d = args.findIndex((a) => a === '-d');
      targets.push(d !== -1 && args[d + 1] ? args[d + 1] : '.');
    }
  });
  return targets.filter((t) => t && !t.startsWith('/dev/'));
}

/** Does the command line change directory anywhere (cd, pushd, popd), so a later relative path cannot be bound? */
function changesDirectory(cmd) {
  let found = false;
  walkCommands(cmd, (words) => {
    const at = commandIndex(words.map((w) => w.text));
    if (at !== -1 && CHDIR.has(words[at].text)) found = true;
  });
  return found;
}

/** The flag that makes an interpreter run the program given on its command line (null: not an interpreter). */
function inlineFlag(name) {
  if (/^(?:node|nodejs|bun)$/.test(name)) return /^-(?:[ep]+|-(?:eval|print)(?:=.*)?)$/;
  if (/^(?:python[\d.]*|pypy\d*)$/.test(name)) return /^-[A-Za-z]*c$/;
  if (name === 'perl') return /^-[A-Za-z0-9]*[eE]$/;
  if (name === 'ruby') return /^-[A-Za-z0-9]*e$/;
  if (name === 'php') return /^-r$/;
  return null;
}

/**
 * The first inline interpreter program in a command line that calls a file-writing
 * API (CODE_WRITE): node -e/-p/--eval, python -c, perl/ruby -e, php -r, deno eval,
 * or a bare interpreter fed by a heredoc, a here-string or a pipe (the program is
 * then somewhere on the same command line). A script file is invisible to the
 * guard and is not reported. Returns {name, api} or null.
 */
function inlineCodeWrite(cmd) {
  let found = null;
  walkCommands(cmd, (words, raw) => {
    if (found) return;
    const texts = words.map((w) => w.text);
    const at = commandIndex(texts);
    if (at === -1) return;
    const name = texts[at].split('/').pop();
    const flag = inlineFlag(name);
    if (!flag && name !== 'deno') return;
    const args = texts.slice(at + 1);
    let program = null;
    if (name === 'deno') {
      if (args[0] === 'eval') program = args.slice(1).join(' ');
    } else if (args.some((a) => flag.test(a))) {
      program = args.join(' ');
    } else {
      // No program flag: the program is a script file unless it arrives on stdin.
      const positional = [];
      for (let i = 0; i < args.length; i++) {
        const a = args[i];
        if (/^\d?<{1,3}-?$/.test(a)) i++; // redirection operator, operand follows
        else if (!/^\d?</.test(a) && !(a.startsWith('-') && a !== '-') && a !== '-') positional.push(a);
      }
      if (!positional.length) program = raw;
    }
    const api = program === null ? null : CODE_WRITE.exec(program);
    if (api) found = { name, api: api[0] };
  });
  return found;
}

function checkBash(cmd, role, root, cwd) {
  const RECORD_MSG = 'ECCode project record files are written only by the eccode CLI. Use eccode commands; never edit the record directly.';
  // First line: the raw text (fast, and it catches record paths inside inline programs).
  if (SHELL_WRITE.test(cmd) || (new RegExp(RECORD_AREA).test(cmd) && CODE_WRITE.test(cmd))) out('deny', RECORD_MSG);
  // Second line, for every context including the main session: every write target the shell would
  // see, resolved from the hook cwd and judged on its real path. Everything under a record directory
  // except the draft areas is the record, wherever that record lives (this project, a nested one,
  // another project, shared memory).
  const { toPosix } = require(path.join(LIB, 'util'));
  const targets = bashWriteTargets(cmd).map((t) => t.replace(/^["']|["']$/g, '').replace(/^~(?=\/|$)/, os.homedir()));
  for (const t of targets) {
    const lexical = path.resolve(cwd || root, t);
    if (!recordHit(lexical)) continue;
    const real = realize(lexical);
    out('deny', `${t}${real !== lexical ? ` is, or lies under, a symbolic link resolving to ${real}, which` : ''} is part of an ECCode record. ${RECORD_MSG}`);
  }
  // A link created in this command line does not exist when the guard runs, so a write through it
  // cannot be bound (`ln -s "$PWD/.eccode" lk && echo x > lk/state.json`): one line creates the link,
  // the next may use it, and then it is judged on its real path.
  // Writers that take their targets from a pipe or a found list cannot be bound; refused when the
  // command names a record anywhere.
  const mentionsRecord = (() => {
    let found = false;
    walkCommands(cmd, (words) => {
      // An assignment's value counts too (`D=.eccode; ln -s $D lk`).
      if (words.some((w) => RECORD_SEGMENT.test(toPosix(w.text.replace(/^[A-Za-z_]\w*=/, ''))))) found = true;
    });
    return found;
  })();
  if (mentionsRecord && /\bxargs\b/.test(cmd) && UNBOUND_WRITERS.test(cmd)) out('deny', `xargs feeds a writer from a pipe, so its targets cannot be bound, and the command names a record directory. ${RECORD_MSG}`);
  // A link created in this command line does not exist when the guard runs, so a write through it
  // cannot be bound (`ln -s "$PWD/.eccode" lk && echo x > lk/state.json`). Ordinary build lines
  // (`ln -sf ../lib/cli.js bin/cli && echo built > .build-stamp`) pass: the rule fires only when the
  // line names a record or the link's operands are computed.
  const link = targets.length > 1 ? createsLink(cmd, cwd || root) : null;
  if (link && link.found && (mentionsRecord || link.computed || link.intoRecord)) {
    out('deny', 'This command creates a link and writes files in the same command line, and the link points at a record or at a computed path; the guard cannot bind a write through a link that does not exist yet. Create the link in one command and write in the next, or use the Edit/Write tool.');
  }
  // Shell writes get the same answer as the Edit/Write tools for every ECCode role: a redirect,
  // tee, cp or sed -i lands only where that role may edit (a claimed task, a draft area).
  if (eccodeRole(role)) {
    const inline = inlineCodeWrite(cmd);
    if (inline) {
      out('deny', `Inline ${inline.name} code in this command calls a file-writing API (${inline.api}) and the guard cannot see which files it would change. Use the Edit/Write tool for file changes so ownership can be checked, or save the script under your draft area (.eccode/drafts/), run it from there and declare its outputs.`);
    }
    const relative = targets.find((t) => !path.isAbsolute(t));
    if (relative !== undefined && changesDirectory(cmd)) {
      out('deny', `This command changes directory (cd/pushd/popd) and then writes the relative path "${relative}", which the guard cannot bind to a file. Write it with a path relative to the project root in a command without cd, or use the Edit/Write tool so ownership can be checked.`);
    }
    for (const t of targets) {
      const abs = realize(path.resolve(cwd || root, t));
      // A project nested in a repository with its own record (an example app) is judged by its own
      // record: the nearest .eccode/ above the target decides, not the outer one.
      const targetRoot = findRoot(path.dirname(abs)) || root;
      const rel = toPosix(path.relative(targetRoot, abs));
      if (outsideProject(rel)) continue; // outside the project is not ours (record files there are caught above)
      checkEdit(targetRoot, rel, role);
    }
  }
  let gitRisk = null;
  walkCommands(cmd, (words) => {
    gitRisk = gitRisk || gitRecordRisk(words);
  });
  if (gitRisk) {
    out('deny', `${gitRisk} can roll back or delete the ECCode record (.eccode/). Restore or discard specific project files by path instead (e.g. git checkout -- src/x.js); record repairs are the user's decision.`);
  }
  if (!mentionsCli(cmd)) return;
  const { actors, problems } = eccodeActors(cmd);
  if (problems.length) out('deny', `The guard cannot verify who this eccode command acts as: ${problems[0]}.`);
  if (actors.includes('user')) {
    out('deny', `--actor user is reserved for a person at a terminal. Ask the user to run this command themselves: ${cmd.trim()}, or to grant a bounded delegation (eccode delegate grant ...) and rerun with --actor orchestrator --delegation <id>.`);
  }
  if (role) {
    const other = actors.find((a) => a !== role);
    if (other) out('deny', `Identity mismatch: this subagent is ${role} but the command acts as "${other}". Each agent records work only under its own role.`);
  } else if (process.env.ECCODE_SEQUENTIAL_ROLES !== '1') {
    const other = actors.find((a) => ROLES.has(a));
    if (other) out('deny', `The main session is the orchestrator; dispatch the ${other} subagent instead of acting as it. (Sequential single-context mode requires ECCODE_SEQUENTIAL_ROLES=1 and must be disclosed to the user.)`);
  }
}

// ------------------------------------------------------------------ file edits

/** Where a path really lands: through symlinks, relative to the project root (null if it does not exist yet). */
function realRel(root, rel) {
  const abs = path.join(root, rel);
  try {
    const { toPosix } = require(path.join(LIB, 'util'));
    const real = fs.realpathSync(abs);
    const out = toPosix(path.relative(fs.realpathSync(root), real));
    return { real: out, symlink: fs.lstatSync(abs).isSymbolicLink() };
  } catch {
    return null;
  }
}

function checkEdit(root, rel, role) {
  const { matchesAny } = require(path.join(LIB, 'util'));
  if (recordPath(rel)) out('deny', `${rel} is part of the ECCode record and is written only by the eccode CLI.`);
  // A symlink inside a task's ownership can point at the record or outside the project.
  const target = realRel(root, rel);
  if (target && (target.symlink || target.real.startsWith('..') || recordPath(target.real))) {
    out('deny', `${rel} ${target.symlink ? 'is a symbolic link' : 'resolves'} to ${target.real}; writes must target the file itself, inside the project and outside the record.`);
  }
  if (role && rel.startsWith('.git/')) out('deny', `${rel} is git metadata (ignore rules, hooks); subagents never write it.`);
  if (!role || role.startsWith('other:')) return; // main session or non-ECCode agent
  if (matchesAny(rel, draftAreas(role)) || matchesAny(`${rel}/x`, draftAreas(role))) return; // the area's directory itself (`mv x .eccode/drafts/`) too
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
  // The hook's cwd (the shell's) finds the project before the harness's project dir does: a project
  // nested inside a repository that has its own record (an example app) is its own project.
  const root = findRoot(input.cwd || process.cwd()) || findRoot(process.env.CLAUDE_PROJECT_DIR || process.cwd());
  if (!root) return; // not an ECCode project: no opinion
  const { toPosix } = require(path.join(LIB, 'util'));
  const role = roleOf(input.agent_type);

  if (tool === 'Bash') return checkBash(String(ti.command || ''), role, root, input.cwd);

  if (['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(tool)) {
    const target = ti.file_path || ti.notebook_path;
    if (!target) return;
    const lexical = path.resolve(input.cwd || root, target);
    // Record files are the CLI's wherever they live: judged on the lexical and the real path before any
    // root is chosen, so neither a record planted inside a record (.eccode/.eccode/) nor an alias
    // (`ln -s $PWD/.eccode rec`) can turn the record into "project files".
    const abs = realize(lexical);
    if (recordHit(lexical)) {
      const via = abs !== lexical ? ` (${lexical} is, or lies under, a symbolic link resolving to ${abs})` : '';
      out('deny', `ECCode record and memory files are written only by the eccode CLI, wherever they live (${abs})${via}. Use eccode commands (eccode memory …, eccode improve …); never edit them directly.`);
    }
    const fileRoot = findRoot(path.dirname(abs)) || root; // the nearest record above the file decides
    const rel = toPosix(path.relative(fileRoot, abs));
    if (outsideProject(rel)) {
      // Outside the project (e.g. scratch dirs) is nobody's business, except the record of
      // another project or the shared memory under ~/.eccode/: those are the CLI's alone.
      let real = abs;
      try {
        real = fs.realpathSync(abs);
      } catch {
        // not there yet: judge the path as given
      }
      if (recordPath(toPosix(abs)) || recordPath(toPosix(real))) {
        out('deny', `ECCode record and memory files are written only by the eccode CLI, wherever they live (${abs}). Use eccode commands (eccode memory …, eccode improve …); never edit them directly.`);
      }
      return;
    }
    checkEdit(fileRoot, rel, role);
  }
}

if (require.main === module) {
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
} else {
  // Unit-test surface (tests/review-F9-win32-guard.test.js); the hook itself always runs as a script.
  module.exports = { splitCommands, eccodeActors, RECORD_FILES, ECCODE_WORD };
}
