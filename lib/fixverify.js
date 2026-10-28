'use strict';
// Proof that a regression test catches the bug it was written for: run it
// against the pre-fix code (a temporary git worktree at the base, with the
// current test files copied in) where it must FAIL, then against the fix
// where it must PASS. Both runs are recorded as evidence; a proven pair is a
// failing reproduction and a later pass of the same command, which is what
// the fix track asks for. A pre-fix failure caused by a load error or by API
// the fix adds says nothing about the bug, so it is "inconclusive".
const fs = require('fs');
const os = require('os');
const path = require('path');
const { git, gitChangedFiles } = require('./project');
const lean = require('./lean');
const bugs = require('./bugs');
const evidence = require('./evidence');
const { toPosix, EccodeError } = require('./util');

const DEP_DIRS = ['node_modules', '.venv', 'venv', 'vendor'];

// Failures that come from loading the code, not from running it.
const LOAD_ERRORS = /Cannot find module|ERR_MODULE_NOT_FOUND|does not provide an export named|SyntaxError|ModuleNotFoundError|No module named|IndentationError|cannot find package|no required module provides/;

// Symbols a failure says are missing; checked against the pre-fix sources.
const MISSING = [
  /\b([A-Za-z_$][\w$]*) is not a function/g,
  /\b([A-Za-z_$][\w$]*) is not defined/g,
  /does not provide an export named '([\w$]+)'/g,
  /cannot import name '(\w+)'/g,
  /has no attribute '(\w+)'/g,
  /name '(\w+)' is not defined/g,
  /undefined: (\w+)/g,
];

// A pre-fix failure counts only when a test assertion failed or an error was
// raised inside the code the fix changed: an allowlist, not a guess at what
// went wrong.
const ASSERTION = /ERR_ASSERTION|AssertionError|AssertionFailedError|\bassert(?:ion)? failed\b|^E\s+assert\b|expect\(received\)|^\s*--- FAIL:/m;
// Files a failure says are missing (Node ENOENT, Python FileNotFoundError).
const MISSING_FILE = [/ENOENT: no such file or directory, \w+ '([^']+)'/g, /No such file or directory: '([^']+)'/g];

/**
 * A path from a pre-fix failure, relative to the project root, or null. Found
 * by the worktree's own "pre-fix" directory segment, not by comparing
 * prefixes: on Windows the temp directory has an 8.3 short spelling
 * (RUNNER~1) while errors report the long one.
 */
function relToProject(p, prefix) {
  const norm = p.replace(/\\/g, '/');
  const k = norm.lastIndexOf('/pre-fix/');
  if (k >= 0) {
    const r = norm.slice(k + '/pre-fix/'.length);
    const pre = toPosix(prefix || '');
    return pre && r.startsWith(pre) ? r.slice(pre.length) : r;
  }
  return /^([A-Za-z]:)?\//.test(norm) ? null : norm;
}

/**
 * Each failing test's report. pytest prints them in its FAILURES section, each
 * under a "____ test_name ____" line (one underscore a side for a long name),
 * and ends the section with a "====" line: errors at setup, passed tests'
 * output and the summary are other sections. A line of spaced underscores
 * separates frames inside one report.
 */
function failureBlocks(output) {
  const lines = String(output).split('\n');
  const start = lines.findIndex((l) => /^=+ FAILURES =+$/.test(l));
  if (start < 0) return [];
  const blocks = [];
  for (const line of lines.slice(start + 1)) {
    if (/^=+( |$)/.test(line)) break;
    const header = /^_+ (.*\S) _+$/.exec(line);
    if (header && /[^_ ]/.test(header[1])) blocks.push([]);
    else if (blocks.length) blocks[blocks.length - 1].push(line);
  }
  return blocks.map((b) => b.join('\n'));
}

function throughSource(output, sources) {
  // A frame names a fixed file as an absolute path (/x/pre-fix/src/a.js), a
  // quoted one ("src/a.js"), or relative at the start of a line, as pytest
  // prints it (src/a.py:57: in f): the path must start and end on a boundary.
  const esc = (p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return sources.some((f) => [f, f.replace(/\//g, '\\')].some((p) => new RegExp(`(^|[\\s"'(/\\\\])${esc(p)}(?=$|[\\s"'),:])`, 'm').test(output)));
}

/**
 * Whether an error line of the output names a definition of the fixed files
 * (a class or function, before or after the fix): a library that raises the
 * bug's error about the fixed code (pydantic: "validation error for
 * IngredientFood") leaves no frame in it. Names shorter than 6 characters
 * are too common to count.
 */
function namesFixedDefinition(output, root, base, sources) {
  const names = new Set();
  for (const f of sources) {
    for (const text of [git(root, ['show', `${base}:${f}`]), lean.readText(root, f)]) {
      if (text) for (const n of lean.definedNames(f, text)) if (n.length >= 6) names.add(n);
    }
  }
  const errorLines = output.split('\n').filter((l) => /Error|Exception/.test(l));
  return [...names].some((n) => errorLines.some((l) => new RegExp(`\\b${n.replace(/\$/g, '\\$')}\\b`).test(l)));
}

/**
 * Why a pre-fix failure proves nothing, or null when it is a real test
 * failure. Inconclusive: a load error; a missing file that exists in the
 * working tree (the pre-fix checkout lacks an untracked or generated file);
 * a missing name the fix adds (the test calls new API), unless another test
 * failed an assertion without calling it; or no assertion
 * failed and no error came from the fixed code (a crash elsewhere, a timeout,
 * a setup error).
 */
function inconclusiveReason(output, root, base, sources, prefix) {
  const load = LOAD_ERRORS.exec(output);
  if (load) return `the tests fail to load on the pre-fix code (${load[0]}), which says nothing about the bug`;
  for (const re of MISSING_FILE) {
    for (const m of output.matchAll(re)) {
      const rel = relToProject(m[1], prefix);
      if (rel && fs.existsSync(path.join(root, rel))) return `the pre-fix run is missing ${rel}, which exists in the working tree (untracked, ignored or generated): the environments differ, so the failure says nothing about the bug`;
    }
  }
  const names = new Set();
  for (const re of MISSING) for (const m of output.matchAll(re)) names.add(m[1].split('.').pop());
  const word = (name) => new RegExp(`\\b${name.replace(/\$/g, '\\$')}\\b`);
  const added = [...names].filter((name) => !sources.some((f) => word(name).test(git(root, ['show', `${base}:${f}`]) || ''))
    && sources.some((f) => word(name).test(lean.readText(root, f) || '')));
  // A test that failed an assertion without calling the new API still shows the bug.
  const shown = failureBlocks(output).some((b) => ASSERTION.test(b) && !added.some((name) => word(name).test(b)));
  if (added.length && !shown) return `the tests call ${added[0]}, which the fix adds; a failure on missing API says nothing about the bug. Test the behavior the bug broke through API that existed before the fix`;
  if (!ASSERTION.test(output) && !throughSource(output, sources) && !namesFixedDefinition(output, root, base, sources)) {
    return 'no test assertion failed and no error was raised in the fixed code (a crash elsewhere, a timeout or a setup error). Assert the expected behavior explicitly';
  }
  return null;
}

/**
 * Run the proof. `test` is the command; `base` defaults to the task's claim
 * base. Returns {verdict, reason, base, tests, sources, pre, post}, where
 * verdict is proven | tests-pass-without-fix | fix-fails-tests | inconclusive.
 */
function verify(store, actor, { test, task, base, timeoutMs } = {}) {
  const root = store.root;
  const state = store.state();
  const t = task ? state.tasks[task] : null;
  if (task && !t) throw new EccodeError('NOT_FOUND', `Unknown task ${task}`);
  base = base || require('./tasks').taskBase(t);
  if (!base) throw new EccodeError('USAGE', 'fix verify needs --task <a claimed or completed task> or --base <ref>: the commit before the fix');
  // The Debugging Lab pins the reproduction: the proof runs that command, so
  // the test that failed before the fix is the test that passes after it.
  const pinned = state.lab && state.lab.repro && state.work && ['debug', 'fix'].includes(state.work.track) ? state.lab.repro.command : null;
  const norm = (c) => String(c == null ? '' : c).trim().replace(/\s+/g, ' ');
  if (pinned && test && norm(test) !== norm(pinned)) {
    throw new EccodeError('REPRO_PINNED', `The reproduction is pinned to ${JSON.stringify(pinned)}; the proof must run it (eccode fix verify --test ${JSON.stringify(pinned)}). To change the reproduction, the orchestrator or the user records eccode debug repro --replace --reason "<why>".`);
  }
  test = test || pinned || (t && t.verification && t.verification.command);
  if (!test) throw new EccodeError('USAGE', 'fix verify needs --test "<command that runs the regression test>"');
  const sha = git(root, ['rev-parse', '--verify', `${base}^{commit}`]);
  if (!sha) throw new EccodeError('NOT_FOUND', `Unknown base ${base}`);

  const changed = (gitChangedFiles(root, sha) || []).map(toPosix).filter((f) => !f.startsWith('.eccode/') && fs.existsSync(path.join(root, f)));
  const tests = changed.filter((f) => lean.TEST.test(f));
  const sources = changed.filter((f) => bugs.isCode(f) && !lean.TEST.test(f));
  if (!tests.length) throw new EccodeError('NO_REGRESSION_TEST', `No test file changed since ${base}: a fix needs the regression test that reproduces the bug.`);
  if (!sources.length) throw new EccodeError('NO_FIX', `No source file changed since ${base}: there is no fix to verify.`);

  const top = git(root, ['rev-parse', '--show-toplevel']);
  const prefix = git(root, ['rev-parse', '--show-prefix']) || '';
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'eccode-fixverify-'));
  const wt = path.join(tmp, 'pre-fix');
  if (git(top, ['worktree', 'add', '--detach', '--quiet', wt, sha]) === null) {
    fs.rmSync(tmp, { recursive: true, force: true });
    throw new EccodeError('GIT_FAILED', `Could not create a worktree at ${base}`);
  }
  const label = `pre-fix@${sha.slice(0, 12)}`;
  let pre;
  let post;
  try {
    const preRoot = path.join(wt, prefix);
    for (const f of tests) {
      fs.mkdirSync(path.dirname(path.join(preRoot, f)), { recursive: true });
      fs.copyFileSync(path.join(root, f), path.join(preRoot, f));
    }
    for (const d of DEP_DIRS) {
      if (fs.existsSync(path.join(root, d)) && !fs.existsSync(path.join(preRoot, d))) {
        fs.symlinkSync(path.join(root, d), path.join(preRoot, d), process.platform === 'win32' ? 'junction' : 'dir');
      }
    }
    let why = null;
    pre = evidence.runCommand(store, actor, {
      label: 'fix-verify: pre-fix',
      command: test,
      task,
      timeoutMs,
      externalCwd: preRoot,
      cwdLabel: label,
      purposeFor: (exitCode, output) => {
        if (exitCode === 0) return 'check';
        why = inconclusiveReason(output, root, sha, sources, prefix);
        return why ? 'check' : 'reproduction';
      },
      extra: { fixVerify: { phase: 'pre-fix', base: sha, tests } },
    });
    pre.inconclusive = why;
  } finally {
    git(top, ['worktree', 'remove', '--force', wt]);
    git(top, ['worktree', 'prune']);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  post = evidence.runCommand(store, actor, { label: 'fix-verify: post-fix', command: test, task, timeoutMs, extra: { fixVerify: { phase: 'post-fix', base: sha, preFix: pre.id } } });

  let verdict;
  let reason;
  if (pre.status === 'passed') {
    verdict = 'tests-pass-without-fix';
    reason = `The changed tests pass on the pre-fix code (${label}), so they do not catch the bug. Write a test that fails for the reported symptom before the fix.`;
  } else if (pre.inconclusive) {
    verdict = 'inconclusive';
    reason = `The pre-fix run failed, but ${pre.inconclusive}.`;
  } else if (post.status !== 'passed') {
    verdict = 'fix-fails-tests';
    reason = 'The tests fail on the pre-fix code (good), but they also fail with the fix: the fix is incomplete or wrong.';
  } else {
    verdict = 'proven';
    reason = `The regression test fails on the pre-fix code and passes with the fix: it catches this bug and will catch its return.`;
  }
  return { verdict, reason, base: sha, tests, sources, pre: { id: pre.id, exitCode: pre.exitCode, purpose: pre.purpose, tail: pre.outputTail }, post: { id: post.id, exitCode: post.exitCode } };
}

function format(r) {
  return [
    `Fix verification against ${r.base.slice(0, 12)}: tests ${r.tests.join(', ')}; fix in ${r.sources.join(', ')}`,
    `  pre-fix  (worktree at the base, new tests copied in): exit ${r.pre.exitCode}  ev:${r.pre.id}${r.pre.purpose === 'reproduction' ? ' (reproduction)' : ''}`,
    `  post-fix (working tree): exit ${r.post.exitCode}  ev:${r.post.id}`,
    `${r.verdict === 'proven' ? 'PROVEN' : `NOT PROVEN (${r.verdict})`}: ${r.reason}`,
  ].join('\n');
}

module.exports = { verify, format, inconclusiveReason };
