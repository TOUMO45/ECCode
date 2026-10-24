'use strict';
// The one-step path. `eccode quick "<request>"` takes a repository with no
// record (or a delivered one) to a quick work item whose one task is ready to
// claim: the verification command comes from the detected stack, ownership
// from the tracked top-level layout, and the phase gate is started. Every rule
// of the quick track still applies (claim, pinned check, independent review,
// verification, delivery); this module only removes the setup steps, and
// `draftHandoff` fills the handoff fields the record already knows.
// `eccode debug "<bug>"` is the same setup on the debug track: one task, a
// regression test proven by fix verify, a mutation run, one independent
// review, and no verification gate.

const path = require('path');
const { EccodeError, toPosix, matchesAny } = require('./util');
const { init, gitChangedFiles } = require('./project');
const { loadConfig } = require('./config');
const { listFiles } = require('./lean');

const STARTERS = ['orchestrator', 'user', 'delivery-lead'];
const DEPENDENCY_DIRS = new Set(['node_modules', 'vendor', 'venv', 'dist', 'build', 'target', '__pycache__']);

/**
 * The test check for the files a task owns: a sub-project's (frontend/) only
 * when every owned file is inside it, otherwise the root project's, otherwise
 * whichever test check is available.
 */
function pickTestCheck(checks, files = []) {
  const tests = checks.filter((c) => c.kind === 'test' && c.available);
  const inside = (c) => c.dir && files.length > 0 && files.every((f) => toPosix(f).startsWith(`${c.dir}/`));
  return tests.find(inside) || tests.find((c) => !c.dir) || tests[0] || null;
}

// A test path or pytest node id: letters, digits, . / _ - @ + and ::id[params].
const TEST_ENTRY = /^[\w./@+-]+(::[\w[\].,=+-]+)*$/;
// Runners that take test paths as arguments.
const PATH_RUNNERS = /^(python3? -m pytest|pytest|node --test|(npx )?vitest( run)?|(npx )?jest|go test)(\s|$)/;

/**
 * The detected check narrowed to named tests: its runner plus the paths, each
 * an existing file or directory of the project (inside the check's own
 * sub-project). No shell syntax can pass, so MCP stays free of free-form
 * commands; a check whose runner may not take paths is refused.
 */
function narrowCheck(root, check, tests) {
  if (!check) throw new EccodeError('INVALID_INPUT', 'No test check detected to narrow (eccode stack lists what is supported)');
  const list = (Array.isArray(tests) ? tests : [tests]).map((t) => String(t).trim()).filter(Boolean);
  if (!list.length) throw new EccodeError('INVALID_INPUT', 'Name at least one test path');
  const rel = list.map((t) => {
    if (!TEST_ENTRY.test(t)) throw new EccodeError('INVALID_INPUT', `"${t}" is not a test path (letters, digits, . / _ - @ + and pytest ::ids only)`);
    const p = t.split('::')[0].replace(/\/+$/, '');
    if (path.isAbsolute(p) || p.split('/').includes('..')) throw new EccodeError('INVALID_INPUT', `${t} is outside the project`);
    if (check.dir && !(p + '/').startsWith(`${check.dir}/`)) throw new EccodeError('INVALID_INPUT', `${t} is outside ${check.dir}/, where ${check.command} runs`);
    if (!require('fs').existsSync(path.join(root, p))) throw new EccodeError('INVALID_INPUT', `${p} does not exist`);
    return check.dir ? t.slice(check.dir.length + 1) : t;
  });
  const prefix = check.dir ? `cd ${check.dir} && ` : '';
  const body = check.command.startsWith(prefix) ? check.command.slice(prefix.length) : check.command;
  // `node --test <directory>` fails on Node 21 and later: it takes files.
  const nodeTest = /^node --test(\s|$)/.test(body) || (/^(npm|yarn|pnpm) test$/.test(body) && /^node --test(\s|$)/.test(check.script || ''));
  const dir = nodeTest && list.find((t) => require('fs').statSync(path.join(root, t.split('::')[0])).isDirectory());
  if (dir) throw new EccodeError('INVALID_INPUT', `${dir} is a directory; node --test runs test files (Node 21 and later refuse a directory), so name the files`);
  if (PATH_RUNNERS.test(body)) return `${check.command} ${rel.join(' ')}`;
  if (body === 'npm test' && PATH_RUNNERS.test(check.script || '')) return `${check.command} -- ${rel.join(' ')}`;
  if (/^(yarn|pnpm) test$/.test(body) && PATH_RUNNERS.test(check.script || '')) return `${check.command} ${rel.join(' ')}`;
  throw new EccodeError('INVALID_INPUT', `The detected check "${check.command}" may not take test paths; narrow it with the CLI instead (eccode task rescope --command)`);
}

function defaultCommand(root, config, files = []) {
  const check = pickTestCheck(require('./stack').checks(root, config), files);
  return check ? check.command : null;
}

/**
 * Ownership for the one task: every tracked top-level directory as `dir/**`
 * and every tracked root file, leaving out dot directories (.git, .github,
 * .claude: tooling, not the change) and dependency or build output.
 */
function defaultFiles(root) {
  const dirs = new Set();
  const rootFiles = new Set();
  for (const f of listFiles(root).map(toPosix)) {
    const top = f.split('/')[0];
    if (top.startsWith('.') || DEPENDENCY_DIRS.has(top)) continue;
    if (f.includes('/')) dirs.add(`${top}/**`);
    else rootFiles.add(f);
  }
  return [...[...dirs].sort(), ...[...rootFiles].sort()];
}

function editDistance(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  }
  return d[a.length][b.length];
}

/**
 * Ownership globs that point into a directory that does not exist while a
 * near-identical one does (test/** in a repository with tests/): a typo that
 * would make the guard refuse the engineer's own test file later. A glob into
 * a directory that does not exist and resembles none is accepted: it may be
 * where new code goes.
 */
function ownershipTypos(root, globs) {
  const fs = require('fs');
  const out = [];
  for (const g of globs) {
    const parts = toPosix(g).split('/');
    let dir = '';
    for (let i = 0; i < parts.length - 1 && !/[*?[{]/.test(parts[i]); i++) {
      const next = dir ? `${dir}/${parts[i]}` : parts[i];
      if (fs.existsSync(path.join(root, next))) {
        dir = next;
        continue;
      }
      const siblings = fs.readdirSync(path.join(root, dir || '.'), { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith('.')).map((e) => e.name);
      const near = siblings.find((n) => n.toLowerCase() === parts[i].toLowerCase() || editDistance(n, parts[i]) <= (parts[i].length < 5 ? 1 : 2));
      if (near) out.push(`${g}: there is no ${next}/ here; did you mean ${dir ? `${dir}/` : ''}${near}/?`);
      break;
    }
  }
  return out;
}

function projectName(root) {
  try {
    const pkg = require(path.join(root, 'package.json'));
    if (pkg && typeof pkg.name === 'string' && pkg.name.trim()) return pkg.name.trim();
  } catch { /* no package.json: the directory name is the project name */ }
  return path.basename(path.resolve(root));
}

/**
 * Start the quick change (or, with track 'debug', the bug fix). Returns
 * {workId, task, defaults, created}, where defaults names what was read from
 * the repository rather than passed.
 */
function start(root, actor, { request, owner, files, command, tests, name, track = 'quick' } = {}) {
  const { ONE_TASK } = require('./works');
  if (!ONE_TASK[track]) throw new EccodeError('INVALID_INPUT', `No one-step setup for the ${track} track (quick, debug)`);
  const noun = track === 'debug' ? 'Bug fixes' : 'Quick changes';
  if (!STARTERS.includes(actor)) throw new EccodeError('ROLE_NOT_ALLOWED', `${noun} are started by ${STARTERS.join(', ')}`);
  if (!request || String(request).trim().length < 5) throw new EccodeError('INVALID_INPUT', track === 'debug' ? 'eccode debug needs the bug: eccode debug "<what is wrong>" (>= 5 chars)' : 'eccode quick needs the request: eccode quick "<what to change>" (>= 5 chars)');
  const { Store } = require('./store');
  const existing = new Store(root);
  const initialized = existing.isInitialized();
  const config = initialized ? loadConfig(existing.root) : loadConfig(root);
  const defaults = [];
  if (!command && tests && [].concat(tests).length) {
    const owned = files ? String(files).split(',').map((f) => f.trim()).filter(Boolean) : [];
    command = narrowCheck(root, pickTestCheck(require('./stack').checks(root, config), owned), tests);
    defaults.push(`verification command ${command} (the detected check, narrowed to the named tests)`);
  }
  if (!command) {
    command = defaultCommand(root, config, files ? String(files).split(',').map((f) => f.trim()).filter(Boolean) : []);
    if (!command) throw new EccodeError('INVALID_INPUT', 'No test command detected for this repository (eccode stack lists what is supported). Pass --command "<verification command>".');
    defaults.push(`verification command ${command} (detected)`);
  }
  if (files) {
    const typos = ownershipTypos(root, String(files).split(',').map((f) => f.trim()).filter(Boolean));
    if (typos.length) throw new EccodeError('INVALID_INPUT', `--files names a directory that does not exist:\n- ${typos.join('\n- ')}\nThe guard would refuse the owner's writes there. Fix the glob, or leave --files out to own the tracked layout.`);
  } else {
    files = defaultFiles(root).join(',');
    if (!files) throw new EccodeError('INVALID_INPUT', 'No tracked files to own. Pass --files "<glob,glob>".');
    defaults.push(`ownership ${files} (tracked top-level layout)`);
  }
  if (!owner) {
    owner = 'backend-engineer';
    defaults.push('owner backend-engineer (default; pass --owner)');
  }
  const quick = { title: String(request).trim(), owner, files, command };
  const gates = require('./gates');
  let store;
  let workId;
  if (!initialized) {
    store = init(root, { name: name || projectName(root), idea: quick.title, actor, track, quick });
    workId = store.state().work.id;
  } else {
    store = existing;
    workId = require('./works').startWork(store, config, actor, { track, title: quick.title, quick }).event.data.id;
  }
  const id = ONE_TASK[track].id;
  gates.startGate(store, loadConfig(store.root), `phase:${id}`, actor === 'user' ? 'orchestrator' : actor);
  return { workId, task: store.state().tasks[id], defaults, created: !initialized, root: store.root, track };
}

/** The rest of the path, in order, as commands the roles run. */
function steps(cli, task, track = 'quick') {
  if (track === 'debug') return debugSteps(cli, task);
  const cmd = task.verification.command;
  const o = task.owner;
  return [
    `1. ${o}: ${cli} task claim change --actor ${o}`,
    `   make the change (and its test), then: ${cli} evidence run --actor ${o} --task change --label verify -- ${JSON.stringify(cmd)}`,
    `   ${cli} handoff draft --task change --actor ${o} --out .eccode/drafts/handoff-change.json   (fill in the TODO fields)`,
    `   ${cli} task complete change --actor ${o} --handoff .eccode/drafts/handoff-change.json`,
    `2. ${o}: ${cli} gate submit phase:change --actor ${o}`,
    `3. technical-reviewer: read the diff, run ${cli} evidence run --actor technical-reviewer --gate phase:change --label review -- ${JSON.stringify(cmd)}`,
    `   ${cli} gate review phase:change --actor technical-reviewer --file .eccode/reviews/drafts/phase-change.json   (template: templates/review.json)`,
    `4. orchestrator: ${cli} gate start verification --actor orchestrator`,
    `   delivery-lead: write .eccode/artifacts/verification.md, then ${cli} gate submit verification --actor delivery-lead --artifact .eccode/artifacts/verification.md`,
    `5. security-reviewer (or technical-reviewer): run the check again, then ${cli} gate review verification --actor security-reviewer --file <review.json>`,
    `6. delivery-lead: ${cli} deliver --actor delivery-lead`,
  ];
}

/** The debug track's path: reproduce, fix, prove, review, deliver. */
function debugSteps(cli, task) {
  const cmd = task.verification.command;
  const o = task.owner;
  const id = task.id;
  return [
    `1. ${o}: ${cli} task claim ${id} --actor ${o}`,
    `   reproduce first: write a regression test for the reported symptom, then ${cli} evidence run --actor ${o} --task ${id} --purpose reproduction --label repro -- "<command that runs it>"   (it must fail)`,
    `   find the root cause, fix it, then: ${cli} evidence run --actor ${o} --task ${id} --label verify -- ${JSON.stringify(cmd)}`,
    `   prove the test: ${cli} fix verify --actor ${o} --task ${id} [--test "<command that runs the regression test>"]   (must print PROVEN)`,
    `   ${cli} mutate --actor ${o} --task ${id} --test ${JSON.stringify(cmd)} --record   (a survivor in the fix is behavior no test checks: strengthen the test)`,
    `   ${cli} handoff draft --task ${id} --actor ${o} --out .eccode/drafts/handoff-${id}.json   (fill in the TODO fields: root cause, fix, evidence)`,
    `   ${cli} task complete ${id} --actor ${o} --handoff .eccode/drafts/handoff-${id}.json`,
    `2. ${o}: ${cli} gate submit phase:${id} --actor ${o}`,
    `3. technical-reviewer: read the bug report and the diff; is the root cause fixed, or only the symptom? Run ${cli} evidence run --actor technical-reviewer --gate phase:${id} --label review -- ${JSON.stringify(cmd)}`,
    `   ${cli} gate review phase:${id} --actor technical-reviewer --file .eccode/reviews/drafts/phase-${id}.json   (template: templates/review.json)`,
    `4. orchestrator: ${cli} deliver --actor orchestrator`,
  ];
}

const TODO = 'TODO:';

/**
 * A handoff for a claimed task with every field the record knows filled in:
 * the files git shows changed inside the task's ownership, the latest passing
 * run of the planned command after the claim, the task's criteria. The fields
 * only the author can write start with "TODO:", which task completion refuses.
 */
function draftHandoff(store, taskId, actor) {
  const state = store.state();
  const t = state.tasks[taskId];
  if (!t) throw new EccodeError('UNKNOWN_TASK', `Unknown task ${taskId}`);
  if (t.status !== 'claimed' || !t.claim || t.claim.agent !== actor) throw new EccodeError('OWNERSHIP', `Task ${taskId} is not claimed by ${actor} (status ${t.status})`);
  const owned = (gitChangedFiles(store.root, t.claim.baseCommit) || [])
    .map(toPosix)
    .filter((f) => !f.startsWith('.eccode/') && matchesAny(f, t.files));
  const same = (a, b) => String(a).trim().replace(/\s+/g, ' ') === String(b).trim().replace(/\s+/g, ' ');
  const passed = Object.values(state.evidence)
    .filter((e) => e.kind === 'command' && e.status === 'passed' && e.recordedBy === actor && e.at >= t.claim.at)
    .sort((a, b) => (a.at < b.at ? -1 : 1));
  const pinned = t.verification && t.verification.command;
  const cite = passed.filter((e) => pinned && same(e.command, pinned)).pop() || passed.pop();
  const phase = `phase:${t.phase}`;
  const debug = state.work && state.work.track === 'debug';
  return {
    from: actor,
    to: debug ? 'technical-reviewer' : 'delivery-lead',
    task: taskId,
    objective: `Task ${taskId}: ${t.title}`,
    context: debug ? `${TODO} the root cause: why the code produced the reported symptom, and where` : `${TODO} the decisions, contracts and constraints the reviewer should know`,
    inputs: t.inputs || [],
    dependencies: t.dependencies || [],
    expectedOutput: (t.outputs || []).join('; ') || t.title,
    acceptanceCriteria: t.acceptanceCriteria,
    completedWork: debug ? `${TODO} the fix, the regression test, and what fix verify and the mutation run showed` : `${TODO} what is true now, in your words, and how the evidence shows it`,
    filesChanged: owned,
    evidence: cite ? [`ev:${cite.id}`] : [],
    remainingIssues: [],
    nextAction: debug ? `${actor}: submit ${phase}; technical-reviewer: review it` : `delivery-lead: submit ${phase} for review`,
  };
}

/** Fields of a handoff that still hold a draft's TODO placeholder. */
function placeholders(handoff) {
  const out = [];
  for (const [k, v] of Object.entries(handoff || {})) {
    const values = Array.isArray(v) ? v : [v];
    if (values.some((x) => typeof x === 'string' && x.trim().startsWith(TODO))) out.push(k);
  }
  return out;
}

module.exports = { start, steps, debugSteps, draftHandoff, placeholders, defaultFiles, defaultCommand, pickTestCheck, narrowCheck, ownershipTypos };
