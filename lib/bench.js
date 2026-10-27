'use strict';
// Paired benchmark: the same agent command runs the same tasks in sandboxes
// WITH the lean-change discipline prepended to the prompt and WITHOUT it, and
// the harness measures what the agent cannot self-report: hidden checks the
// sandbox never contains, lines added, dependencies added, tests written and
// wall time. It reports paired per-task results with sample sizes and never
// invents a saving. The agent command is supplied by the user; this module
// never chooses or bills a model itself.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, execFileSync } = require('child_process');
const { EccodeError, readJson, ensureDir, toPosix, commandEnv } = require('./util');
const lean = require('./lean');

const DEFAULT_SUITE = path.join(__dirname, '..', 'bench', 'tasks');

function git(dir, args) {
  return execFileSync('git', ['-c', 'user.email=bench@eccode', '-c', 'user.name=eccode-bench', ...args], { cwd: dir, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
}

function copyDir(src, dst) {
  fs.cpSync(src, dst, { recursive: true });
}

function listTasks(suite) {
  if (!fs.existsSync(suite)) throw new EccodeError('NOT_FOUND', `No benchmark suite at ${suite}`);
  return fs.readdirSync(suite)
    .filter((d) => fs.existsSync(path.join(suite, d, 'task.json')))
    .map((d) => ({ dir: path.join(suite, d), ...readJson(path.join(suite, d, 'task.json')) }));
}

// Variants that install the toolkit and deliver through one of its tracks:
// "engine" through the quick track, "debug" through the debug track.
const ENGINE_VARIANTS = { engine: 'quick', debug: 'debug' };

/**
 * The engine variants: the toolkit is installed in the sandbox and the agent
 * is asked to deliver the change through a track, so gates, independent
 * review, evidence and the record are all in the loop, not just a prompt.
 * The track is the task's own (task.track) or the variant's: quick for
 * "engine", debug for "debug". quick and debug have one-step playbooks; the
 * other tracks run through start.md (the orchestrate skill), and on a record
 * that already holds a delivered work item they start the next one.
 */
function enginePrompt(variant = 'engine', track = null, { behavior } = {}) {
  track = track || ENGINE_VARIANTS[variant] || 'quick';
  if (track === 'debug') {
    return [
      'This repository has the ECCode toolkit installed under .claude/. Fix the bug below through its debug track:',
      'follow .claude/commands/eccode/debug.md step by step, with `node .claude/eccode/bin/eccode.js` as the CLI and the ECCode',
      'subagents it names. The fix is done when the delivery step succeeds.',
      '',
      'The bug:',
      '',
    ].join('\n');
  }
  if (track === 'quick') {
    return [
      'This repository has the ECCode toolkit installed under .claude/. Deliver the change below through its quick track:',
      'follow .claude/commands/eccode/quick.md step by step, with `node .claude/eccode/bin/eccode.js` as the CLI and the ECCode',
      'subagents it names. The change is done when the delivery step succeeds.',
      '',
      'The change:',
      '',
    ].join('\n');
  }
  const extra = track === 'refactor' && behavior ? ` --behavior "${behavior}"` : '';
  return [
    `This repository has the ECCode toolkit installed under .claude/. Deliver the change below through its ${track} track:`,
    'follow .claude/commands/eccode/start.md (the orchestrate skill) step by step, with `node .claude/eccode/bin/eccode.js` as the',
    'CLI and the ECCode subagents it names. If there is no .eccode/ record yet, initialize it with',
    `\`init --name "<name>" --idea "<the change>" --track ${track}${extra}\`. If the record already holds a delivered work item, start the`,
    `next one with \`work start --track ${track} --title "<a short title>" --actor orchestrator${extra}\`.`,
    'The change is done when the delivery step succeeds.',
    '',
    'The change:',
    '',
  ].join('\n');
}

/** Where fixture repositories are mirrored (bare clones), shared by every run. */
function cacheDir() {
  return process.env.ECCODE_BENCH_CACHE || path.join(os.homedir(), '.cache', 'eccode', 'bench-repos');
}

/**
 * A task whose fixture is a real repository at a pinned commit: the tree of
 * that commit, without its history (the sandbox gets a fresh one-commit git),
 * so the fix that came after it is nowhere in the sandbox. The repository is
 * cloned once into the cache; concurrent batches race safely (clone to a
 * temporary name, then rename).
 */
function mirrorFor(source) {
  if (!source || !source.repo || !/^[0-9a-f]{40}$/.test(String(source.commit || ''))) {
    throw new EccodeError('INVALID_INPUT', 'task.source needs {repo, commit} with a full 40-character commit sha');
  }
  const cache = cacheDir();
  ensureDir(cache);
  const name = String(source.repo).replace(/^[a-z]+:\/\//, '').replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '').replace(/(\.git)?$/, '.git');
  const mirror = path.join(cache, name);
  if (!fs.existsSync(mirror)) {
    const tmp = `${mirror}.tmp-${process.pid}-${Date.now()}`;
    execFileSync('git', ['clone', '-q', '--bare', source.repo, tmp], { stdio: ['ignore', 'ignore', 'pipe'] });
    try {
      fs.renameSync(tmp, mirror);
    } catch {
      fs.rmSync(tmp, { recursive: true, force: true }); // another batch won the race
    }
  }
  const has = () => spawnSync('git', ['--git-dir', mirror, 'cat-file', '-e', `${source.commit}^{commit}`]).status === 0;
  if (!has()) execFileSync('git', ['--git-dir', mirror, 'fetch', '-q', 'origin', source.commit], { stdio: ['ignore', 'ignore', 'pipe'] });
  if (!has()) throw new EccodeError('NOT_FOUND', `Commit ${source.commit} is not in ${source.repo}`);
  return mirror;
}

/** Write the commit's files (all of them, or only `paths`) into dest, through a private index. */
function checkoutFrom(mirror, commit, dest, paths = null) {
  // A private index: concurrent exports from one mirror never share state.
  const index = path.join(os.tmpdir(), `eccode-bench-index-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const env = { ...process.env, GIT_INDEX_FILE: index };
  try {
    execFileSync('git', ['--git-dir', mirror, 'read-tree', commit], { env });
    // The commit's bytes as committed: no line-ending conversion from the
    // machine's settings (autocrlf on Windows would rewrite every file, and
    // the real fix's patch would no longer apply).
    const which = paths ? ['--', ...paths] : ['-a'];
    execFileSync('git', ['-c', 'core.autocrlf=false', '--git-dir', mirror, '--work-tree', dest, 'checkout-index', '-f', ...which], { env });
  } finally {
    fs.rmSync(index, { force: true });
  }
}

function exportSource(source, dest) {
  checkoutFrom(mirrorFor(source), source.commit, dest);
}

/**
 * Only the named files of a source commit, at their own paths under dest:
 * hidden tests taken from the upstream fix at run time, so a suite can name
 * third-party tests without carrying a copy of them.
 */
function exportPaths(source, paths, dest) {
  const mirror = mirrorFor(source);
  const missing = paths.filter((p) => spawnSync('git', ['--git-dir', mirror, 'cat-file', '-e', `${source.commit}:${p}`]).status !== 0);
  if (missing.length) throw new EccodeError('NOT_FOUND', `Not in ${source.repo} at ${source.commit}: ${missing.join(', ')}`);
  checkoutFrom(mirror, source.commit, dest, paths);
  return [...paths];
}

/** The task's environment: ${NAME} in a value is read from the bench's own environment. */
function taskEnv(task) {
  const out = {};
  for (const [k, v] of Object.entries(task.env || {})) {
    out[k] = String(v).replace(/\$\{(\w+)\}/g, (_, name) => {
      if (process.env[name] === undefined) throw new EccodeError('INVALID_INPUT', `Task ${task.id} needs ${name} in the environment (its suite's README says how to set it up)`);
      return process.env[name];
    });
  }
  return out;
}

/** Hidden checks as {id, command}; a bare string gets a positional id. */
function hiddenChecksOf(task) {
  return (task.hiddenChecks || []).map((c, i) => (typeof c === 'string' ? { id: `check${i + 1}`, command: c } : c));
}

/**
 * What the agent run cost, from the agent's own result line when its command
 * prints one (`claude -p --output-format json` or stream-json): total cost,
 * tokens summed over every model the session used (subagents included), turns
 * and subagents. Null when the output has no result object.
 */
function usageOf(stdout) {
  const text = String(stdout || '').trim();
  const candidates = [text, ...text.split('\n').reverse()];
  for (const c of candidates) {
    if (!c.startsWith('{')) continue;
    let r;
    try {
      r = JSON.parse(c);
    } catch {
      continue;
    }
    if (!r || typeof r.total_cost_usd !== 'number') continue;
    const models = Object.values(r.modelUsage || {});
    const sum = (k) => models.reduce((n, m) => n + Number(m[k] || 0), 0);
    const u = r.usage || {};
    const tokens = models.length
      ? sum('inputTokens') + sum('outputTokens') + sum('cacheReadInputTokens') + sum('cacheCreationInputTokens')
      : Number(u.input_tokens || 0) + Number(u.output_tokens || 0) + Number(u.cache_read_input_tokens || 0) + Number(u.cache_creation_input_tokens || 0);
    return {
      // The agent's final answer, kept (cut to 4,000 characters) so a run that
      // stopped early can be explained from the saved records.
      answer: typeof r.result === 'string' ? r.result.slice(0, 4000) : null,
      costUsd: Math.round(r.total_cost_usd * 10000) / 10000,
      tokens,
      outputTokens: models.length ? sum('outputTokens') : Number(u.output_tokens || 0),
      turns: typeof r.num_turns === 'number' ? r.num_turns : null,
      subagents: r.subagent_stats && typeof r.subagent_stats.spawned === 'number' ? r.subagent_stats.spawned : null,
    };
  }
  return null;
}

/** What the record in an engine sandbox shows: delivered, audited, reviewed. */
function engineOutcome(sandbox) {
  const { Store } = require('./store');
  const store = new Store(sandbox);
  if (!store.isInitialized()) return { initialized: false, delivered: false, auditOk: false, reviews: 0, changesRequested: 0, runsRecorded: 0, tokensReported: 0 };
  const state = store.state();
  const work = require('./memory/metrics').costByWork(store.readEvents()).pop() || {};
  let auditOk = false;
  try {
    auditOk = store.audit().ok === true;
  } catch {
    auditOk = false;
  }
  const out = {
    initialized: true,
    delivered: Boolean(state.work && state.work.status === 'delivered'),
    auditOk,
    reviews: work.reviews || 0,
    changesRequested: work.changesRequested || 0,
    runsRecorded: work.runs || 0,
    tokensReported: work.tokens || 0,
  };
  if (state.work && state.work.track === 'debug') {
    // The debug track's own proofs, read before the sandbox is deleted.
    const m = Object.values(state.evidence).filter((e) => e.kind === 'mutation').pop();
    out.fixProven = require('./works').provenFixVerifications(state).length > 0;
    out.mutation = m ? { killed: m.mutation.killed, total: m.mutation.total, survived: m.mutation.survived } : null;
  }
  return out;
}

// Characters of each run's patch kept in its record: enough for a large
// multi-file change whole, so a failed run can be replayed from its record
// (git's 16 MiB buffer bounds the diff itself).
const PATCH_LIMIT = 4000000;

// Paths the harness never counts as the agent's change: the prompt, the
// installed toolkit and the engine's record.
const TOOLING = /^(PROMPT\.md$|\.claude\/|\.eccode\/)/;

// Variants that prepend a skill's text to the prompt (the toolkit is not
// installed): "with" the lean-change discipline, "method" the debugging method.
const SKILL_VARIANTS = { with: 'lean-change', method: 'debug-investigation' };

function leanPrompt(skillName = 'lean-change') {
  const skill = fs.readFileSync(path.join(__dirname, '..', 'skills', skillName, 'SKILL.md'), 'utf8');
  return `Follow this working discipline exactly while solving the task (ignore the eccode CLI commands it mentions; they are not installed here):\n\n${skill.replace(/^---[\s\S]*?---\n/, '')}\n\n---\n\n`;
}

/** Manifest dependency names across the sandbox, for before/after comparison. */
function depsOf(dir) {
  const all = new Set();
  for (const f of lean.listFiles(dir)) {
    if (!/(^|\/)(package\.json|requirements[^/]*\.txt|pyproject\.toml|go\.mod|Cargo\.toml)$/.test(f)) continue;
    const text = lean.readText(dir, f);
    if (text) for (const d of lean.dependencyNames(f, text)) all.add(`${f}:${d}`);
  }
  return all;
}

/** One agent run in a fresh sandbox; returns the measured record. */
/** The task's starting tree in dir: its source commit if it has one, then its fixture/ (an overlay on that tree). */
function materialize(task, dir) {
  if (task.source) exportSource(task.source, dir);
  // A source task's fixture/ holds files the checkout needs to run, such as a
  // generated version module.
  if (fs.existsSync(path.join(task.dir, 'fixture'))) copyDir(path.join(task.dir, 'fixture'), dir);
}

/** Hidden files into <sandbox>/.bench-hidden: a suite's shared ones (<suite>/_hidden), then the task's own. */
function placeHidden(task, sandbox) {
  const sharedHidden = path.join(path.dirname(task.dir), '_hidden');
  if (fs.existsSync(sharedHidden)) copyDir(sharedHidden, path.join(sandbox, '.bench-hidden'));
  const hiddenDir = path.join(task.dir, 'hidden');
  if (fs.existsSync(hiddenDir)) copyDir(hiddenDir, path.join(sandbox, '.bench-hidden'));
  // Hidden files from the source repository, at their own paths: over
  // whatever the agent left there.
  const from = task.hidden && task.hidden.fromSource;
  if (from) exportPaths({ repo: from.repo || task.source.repo, commit: from.commit }, from.paths, sandbox);
}

/**
 * The task's setup command, run in the sandbox after its files are in place
 * and before the starting commit, with the task's environment and
 * ECCODE_BENCH_TASK_DIR (so a setup can call its suite's tools). Null when
 * the task has none.
 */
function runSetup(task, sandbox, env = taskEnv(task)) {
  if (!task.setup) return null;
  const started = Date.now();
  const r = spawnSync(task.setup, { cwd: sandbox, shell: true, encoding: 'utf8', timeout: 1800000, maxBuffer: 16 * 1024 * 1024, env: commandEnv({ ...env, ECCODE_BENCH_TASK_DIR: task.dir }) });
  return { ok: r.status === 0, ms: Date.now() - started, tail: `${r.stdout || ''}${r.stderr || ''}`.split('\n').slice(-12).join('\n') };
}

/** The sandbox's git-ignored files, one by one (files inside an ignored directory too). */
function ignoredFiles(sandbox) {
  const out = execFileSync('git', ['ls-files', '--others', '--ignored', '--exclude-standard', '-z'], { cwd: sandbox, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  return new Set(out.split('\0').filter(Boolean));
}

/**
 * Remove from `dir` (the sandbox or a copy of it) the ignored files the agent
 * left in `sandbox`: those not in `before`, taken as it started. They are no
 * part of the change (git leaves them out of it), and a check that reads them
 * (a test database the agent's own test runs left) grades the sandbox, not
 * the change. The record and the toolkit stay. git names an ignored nested
 * repository as a directory (`a/b/`), removed whole; links are removed, never
 * followed. Returns what could not be removed, so a run is never lost to it.
 */
function removeLeftovers(sandbox, before, dir = sandbox) {
  const kept = [];
  for (const f of ignoredFiles(sandbox)) {
    if (before.has(f) || /^\.(eccode|claude)\//.test(f)) continue;
    try {
      fs.rmSync(path.join(dir, f), { force: true, recursive: f.endsWith('/') });
    } catch (err) {
      kept.push(`${f} (${err.code || err.message})`);
    }
  }
  return kept;
}

/** Run the task's hidden checks in the sandbox. */
function runChecks(task, sandbox, env = taskEnv(task)) {
  return hiddenChecksOf(task).map(({ id, command, timeoutMs }) => {
    // A check may carry its own timeout (a real project's regression suite runs for minutes).
    const r = spawnSync(command, { cwd: sandbox, shell: true, encoding: 'utf8', timeout: timeoutMs || 300000, maxBuffer: 16 * 1024 * 1024, env: commandEnv(env) });
    return { id, command, passed: r.status === 0, tail: `${r.stdout || ''}${r.stderr || ''}`.split('\n').slice(-6).join('\n') };
  });
}

/** The prompt a variant sees, and the track an engine variant delivers through. */
function promptFor(task, variant) {
  const engineVariant = Boolean(ENGINE_VARIANTS[variant]);
  const track = engineVariant ? task.track || ENGINE_VARIANTS[variant] : null;
  const preamble = SKILL_VARIANTS[variant] ? leanPrompt(SKILL_VARIANTS[variant]) : engineVariant ? enginePrompt(variant, track, { behavior: task.behavior }) : '';
  return { prompt: preamble + task.prompt.trim() + '\n', track, engineVariant };
}

/**
 * Install the toolkit and commit it before the agent starts, so the toolkit
 * is the repository's starting point, not part of the change being measured.
 */
function installToolkit(sandbox, { engineProfile = 'guard', engineAgents = 'inherit' } = {}) {
  require('./install').install({ target: sandbox, profile: engineProfile });
  if (engineAgents === 'inherit') {
    // The shipped agents pin their own models (reviewers on a larger one).
    // Inheriting the session's model compares the process, not a model mix.
    const dir = path.join(sandbox, '.claude', 'agents');
    for (const f of fs.readdirSync(dir)) {
      const file = path.join(dir, f);
      fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(/^model: .+$/m, 'model: inherit'));
    }
  }
  git(sandbox, ['add', '-A']);
  git(sandbox, ['commit', '-q', '-m', 'eccode toolkit']);
}

// A Claude Code session that runs the benchmark passes its own identity, IPC
// handles and settings down to every child. An agent inheriting them is not a
// fresh session: the items of a chain (one sandbox) appended to one transcript,
// and every session ran at the launcher's effort with background subagents.
// So an agent keeps only the Claude Code variables that authenticate it and
// pick its model provider; ANTHROPIC_* (API key, base URL) is not touched.
const AGENT_KEEPS = /^CLAUDE_(?:CONFIG_DIR|CODE_(?:OAUTH_TOKEN|USE_(?:BEDROCK|VERTEX|FOUNDRY)|SKIP_(?:BEDROCK|VERTEX|FOUNDRY)_AUTH|CLIENT_(?:CERT|KEY|KEY_PASSPHRASE)|API_KEY_HELPER_TTL_MS))$/;

function agentEnv(extra = {}) {
  const env = commandEnv(extra);
  for (const k of Object.keys(env)) if ((k === 'CLAUDECODE' || k.startsWith('CLAUDE_')) && !AGENT_KEEPS.test(k)) delete env[k];
  return env;
}

function runAgent(sandbox, agentCmd, env, variant, timeoutMs) {
  const started = Date.now();
  // In its own process group (POSIX), so whatever it left running (a test
  // run, a server) is stopped when it exits instead of writing on into the sandbox.
  const group = process.platform !== 'win32';
  const agent = spawnSync(agentCmd, {
    cwd: sandbox,
    shell: true,
    detached: group,
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 32 * 1024 * 1024,
    // Shared lessons stay in the sandbox: runs and chains never read each other's.
    env: agentEnv({ ...env, ECCODE_BENCH_PROMPT: path.join(sandbox, 'PROMPT.md'), ECCODE_BENCH_VARIANT: variant, ECCODE_SHARED_MEMORY: path.join(sandbox, '.eccode', 'shared-memory') }),
  });
  if (group && agent.pid) {
    try { process.kill(-agent.pid, 'SIGKILL'); } catch { /* the group already exited */ }
  }
  return { agent, durationMs: Date.now() - started };
}

/** Remove a sandbox; a failure is reported, never allowed to lose the run's record. */
function removeSandbox(sandbox) {
  try {
    fs.rmSync(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch (err) {
    process.stderr.write(`bench: could not remove ${sandbox}: ${err.code || err.message}\n`);
  }
}

/** The agent's change against HEAD, measured before the hidden checks arrive. */
function measureChange(sandbox, depsBefore) {
  git(sandbox, ['add', '-A']);
  let linesAdded = 0;
  let linesRemoved = 0;
  let testLinesAdded = 0; // the part of linesAdded that is in test files
  const changed = [];
  let toolkitChanged = false;
  for (const row of git(sandbox, ['diff', '--cached', '--numstat']).split('\n').filter(Boolean)) {
    const [a, r, f] = row.split('\t');
    if (f.startsWith('.claude/')) toolkitChanged = true;
    if (TOOLING.test(f)) continue;
    changed.push(f);
    if (a !== '-') {
      linesAdded += Number(a);
      linesRemoved += Number(r);
      if (lean.TEST.test(toPosix(f))) testLinesAdded += Number(a);
    }
  }
  const newDeps = [...depsOf(sandbox)].filter((d) => !depsBefore.has(d)).map((d) => d.split(':').pop());
  // The change itself (text files only, tooling left out, capped), so runs
  // can be compared after their sandboxes are gone.
  const patch = changed.length
    ? git(sandbox, ['diff', '--cached', '--no-color', '--no-ext-diff', '--', ...changed]).slice(0, PATCH_LIMIT)
    : '';
  return { linesAdded, linesRemoved, testLinesAdded, changed, toolkitChanged, newDeps, patch };
}

/** A run whose setup failed: the agent never started, and it counts as a failure. */
function failedSetupRecord(task, variant, setup) {
  return { task: task.id, variant, agentExit: 1, durationMs: 0, hiddenPassed: 0, hiddenTotal: hiddenChecksOf(task).length, linesAdded: 0, linesRemoved: 0, testLinesAdded: 0, filesChanged: 0, testFilesChanged: 0, newDeps: [], patch: '', patchTruncated: false, checks: [], usage: null, setup };
}

/**
 * Token counts from the sandbox's session transcripts (subagents' included)
 * written since sinceMs, each message once: its content blocks repeat its
 * usage. For an agent that never printed its result line, cut by the timeout.
 * The transcripts hold no prices, so there is no cost. Null without any.
 */
function transcriptUsage(sandbox, sinceMs) {
  const dir = transcriptDir(sandbox);
  if (!fs.existsSync(dir)) return null;
  const byMessage = new Map();
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const f = path.join(d, e.name);
      if (e.isDirectory()) walk(f);
      else if (f.endsWith('.jsonl') && fs.statSync(f).mtimeMs >= sinceMs) {
        for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
          if (!line.includes('"usage"')) continue;
          let j;
          try { j = JSON.parse(line); } catch { continue; }
          if (j.type === 'assistant' && j.message && j.message.id && j.message.usage) byMessage.set(j.message.id, j.message.usage);
        }
      }
    }
  };
  walk(dir);
  if (!byMessage.size) return null;
  const sum = (k) => [...byMessage.values()].reduce((n, u) => n + Number(u[k] || 0), 0);
  const u = { inputTokens: sum('input_tokens'), outputTokens: sum('output_tokens'), cacheReadTokens: sum('cache_read_input_tokens'), cacheCreationTokens: sum('cache_creation_input_tokens') };
  return { messages: byMessage.size, tokens: u.inputTokens + u.outputTokens + u.cacheReadTokens + u.cacheCreationTokens, ...u };
}

function resultRecord(task, variant, { agent, durationMs, measured, checks, setup }) {
  return {
    task: task.id,
    variant,
    agentExit: typeof agent.status === 'number' ? agent.status : 1,
    durationMs,
    hiddenPassed: checks.filter((c) => c.passed).length,
    hiddenTotal: checks.length,
    linesAdded: measured.linesAdded,
    linesRemoved: measured.linesRemoved,
    testLinesAdded: measured.testLinesAdded,
    filesChanged: measured.changed.length,
    testFilesChanged: measured.changed.filter((f) => lean.TEST.test(toPosix(f))).length,
    newDeps: measured.newDeps,
    patch: measured.patch,
    patchTruncated: measured.patch.length >= PATCH_LIMIT,
    checks,
    usage: usageOf(agent.stdout),
    // Cut by the harness's timeout: such an agent prints no result line.
    ...(agent.error && agent.error.code === 'ETIMEDOUT' ? { timedOut: true } : {}),
    setup,
  };
}

function runOnce(task, { agentCmd, variant, timeoutMs = 900000, keep = false, engineProfile = 'guard', engineAgents = 'inherit', transcripts = null }) {
  const env = taskEnv(task);
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), `eccode-bench-${task.id}-${variant}-`));
  materialize(task, sandbox);
  const setup = runSetup(task, sandbox, env);
  if (setup && !setup.ok) {
    const record = { ...failedSetupRecord(task, variant, setup), sandbox: keep ? sandbox : null };
    if (!keep) removeSandbox(sandbox);
    return record;
  }
  const { prompt, track, engineVariant } = promptFor(task, variant);
  fs.writeFileSync(path.join(sandbox, 'PROMPT.md'), prompt);
  git(sandbox, ['init', '-q']);
  git(sandbox, ['add', '-A']);
  git(sandbox, ['commit', '-q', '-m', 'fixture']);
  if (engineVariant) installToolkit(sandbox, { engineProfile, engineAgents });
  const depsBefore = depsOf(sandbox);
  const ignoredBefore = ignoredFiles(sandbox);
  const startedAt = Date.now();
  const { agent, durationMs } = runAgent(sandbox, agentCmd, env, variant, timeoutMs);
  const kept = transcripts ? copyTranscripts(sandbox, path.join(transcripts, path.basename(sandbox)), startedAt).length : null;
  const recordKept = transcripts && engineVariant ? copyRecord(sandbox, path.join(transcripts, path.basename(sandbox))) : null;
  const measured = measureChange(sandbox, depsBefore);
  const leftoversKept = removeLeftovers(sandbox, ignoredBefore);
  placeHidden(task, sandbox);
  const checks = runChecks(task, sandbox, env);
  const result = resultRecord(task, variant, { agent, durationMs, measured, checks, setup });
  const record = {
    ...result,
    ...(result.usage ? {} : { transcriptUsage: transcriptUsage(sandbox, startedAt) }),
    ...(leftoversKept.length ? { leftoversKept } : {}),
    ...(engineVariant ? { engine: { ...engineOutcome(sandbox), toolkitChanged: measured.toolkitChanged, agents: engineAgents, track } } : {}),
    ...(kept !== null ? { transcripts: { dir: path.basename(sandbox), files: kept, ...(recordKept !== null ? { record: recordKept } : {}) } } : {}),
    sandbox: keep ? sandbox : null,
  };
  if (!keep) removeSandbox(sandbox);
  return record;
}

/**
 * Where Claude Code keeps the session transcripts of a working directory. It
 * names the folder from the resolved path (macOS's /var/folders is a link to
 * /private/var/folders), so the sandbox's path is resolved first.
 */
function transcriptDir(sandbox) {
  let dir = sandbox;
  try { dir = fs.realpathSync(sandbox); } catch { /* gone: its path as given */ }
  return path.join(os.homedir(), '.claude', 'projects', dir.replace(/[^a-zA-Z0-9]/g, '-'));
}

/**
 * Copy the sandbox's session transcripts written since `sinceMs` (subagent
 * files included) into dest, keeping their relative paths. They quote the
 * code the agent read, so they belong outside the repository. Returns the
 * copied paths.
 */
function copyTranscripts(sandbox, dest, sinceMs) {
  const dir = transcriptDir(sandbox);
  if (!fs.existsSync(dir)) return [];
  const out = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const src = path.join(d, e.name);
      if (e.isDirectory()) walk(src);
      else if (fs.statSync(src).mtimeMs >= sinceMs) {
        const to = path.join(dest, path.relative(dir, src));
        fs.mkdirSync(path.dirname(to), { recursive: true });
        fs.copyFileSync(src, to);
        out.push(to);
      }
    }
  };
  walk(dir);
  return out;
}

/**
 * Copy the sandbox's ECCode record (.eccode/, without the index cache) to
 * <dest>/record: the gates, reviews, evidence and declarations the run left,
 * read after the sandbox is gone. Like transcripts, it can quote the code, so
 * it belongs outside the repository. False when the sandbox has no record.
 */
function copyRecord(sandbox, dest) {
  const src = path.join(sandbox, '.eccode');
  if (!fs.existsSync(path.join(src, 'events.jsonl'))) return false;
  fs.cpSync(src, path.join(dest, 'record'), { recursive: true, filter: (p) => path.relative(src, p).split(path.sep)[0] !== 'cache' });
  return true;
}

/** Run records from a --save file: one JSON per line; typed lines (chain summaries, stops) are not runs. */
function loadRuns(text) {
  return String(text).split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l)).filter((r) => !r.type);
}

/** Spent so far by these records, from the agents' own result lines. */
function spentUsd(records) {
  return Math.round(records.reduce((sum, r) => sum + ((r.usage && r.usage.costUsd) || 0), 0) * 10000) / 10000;
}

/**
 * Exact two-sided permutation test on the difference of MEANS between the two
 * variants' per-run lines-added (the mean is the standard, sensitive choice;
 * the summary table still shows medians). Every C(n, k) relabeling is
 * enumerated (guarded by a cap), so the p-value is exact, not asymptotic:
 * with 5 runs a side, the smallest attainable p is 2/252 ~= 0.008.
 */
// Deterministic PRNG shared by the Monte Carlo fallbacks, so published
// p-values reproduce exactly from the same data.
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function permutationTest(a, b, cap = 200000) {
  if (!a.length || !b.length) return null;
  const all = [...a, ...b];
  const mean = (xs) => xs.reduce((n, x) => n + x, 0) / xs.length;
  const observed = Math.abs(mean(a) - mean(b));
  // When the exact enumeration would exceed the cap (C(|a|+|b|, |a|) splits),
  // fall back to a seeded Monte Carlo permutation test instead of silence.
  let exactSplits = 1;
  for (let i = 1; i <= Math.min(a.length, b.length); i++) exactSplits = (exactSplits * (all.length - Math.min(a.length, b.length) + i)) / i;
  if (exactSplits > cap) {
    const resamples = 100000;
    const rand = mulberry32(42);
    let extreme = 0;
    for (let r = 0; r < resamples; r++) {
      const arr = all.slice();
      for (let j = arr.length - 1; j > 0; j--) {
        const k = Math.floor(rand() * (j + 1));
        [arr[j], arr[k]] = [arr[k], arr[j]];
      }
      if (Math.abs(mean(arr.slice(0, a.length)) - mean(arr.slice(a.length))) >= observed - 1e-9) extreme += 1;
    }
    return { p: (extreme + 1) / (resamples + 1), splits: resamples, monteCarlo: true, atFloor: extreme === 0 }; // atFloor: no resample was as extreme, so p is an upper bound
  }
  const idx = [];
  let count = 0;
  let extreme = 0;
  const choose = (start, need) => {
    if (count > cap) return;
    if (!need) {
      count += 1;
      const inA = new Set(idx);
      const xa = [];
      const xb = [];
      all.forEach((v, i) => (inA.has(i) ? xa : xb).push(v));
      if (Math.abs(mean(xa) - mean(xb)) >= observed - 1e-9) extreme += 1;
      return;
    }
    for (let i = start; i <= all.length - need; i++) {
      idx.push(i);
      choose(i + 1, need - 1);
      idx.pop();
    }
  };
  choose(0, a.length);
  return count > cap ? null : { p: extreme / count, splits: count };
}

/** Two-sided Fisher exact test on [[a, n1 - a], [b, n2 - b]]: P of tables no likelier than the observed one. */
function fisherExact(a, n1, b, n2) {
  const lf = [0];
  for (let i = 1; i <= n1 + n2; i++) lf[i] = lf[i - 1] + Math.log(i);
  const k = a + b;
  const logP = (x) => lf[n1] - lf[x] - lf[n1 - x] + lf[n2] - lf[k - x] - lf[n2 - k + x] - (lf[n1 + n2] - lf[k] - lf[n1 + n2 - k]);
  const observed = logP(a);
  let p = 0;
  for (let x = Math.max(0, k - n2); x <= Math.min(k, n1); x++) if (logP(x) <= observed + 1e-9) p += Math.exp(logP(x));
  return Math.min(1, p);
}

const allPassed = (r) => r.hiddenTotal > 0 && r.hiddenPassed === r.hiddenTotal;

/**
 * An engine variant (engine: the quick track; debug: the debug track) vs
 * without, per task and pooled: runs passing every hidden check (Fisher exact
 * per task; a permutation test stratified by task when pooled), which checks
 * failed, tokens and cost as the agent reported them, wall time, and what the
 * engine's own record says (delivered, audit, reviews).
 */
function engineSection(records, variant = 'engine', baseline = 'without') {
  const tasks = [...new Set(records.filter((r) => r.variant === variant).map((r) => r.task))];
  if (!tasks.length || !records.some((r) => r.variant === baseline)) return [];
  const med = (xs) => (xs.length ? median(xs) : null);
  const fmt = (x, d = 0) => (x === null ? '—' : d ? x.toFixed(d) : String(Math.round(x)));
  const failed = (rs) => {
    const c = {};
    for (const r of rs) for (const ch of r.checks.filter((x) => !x.passed)) c[ch.id || ch.command] = (c[ch.id || ch.command] || 0) + 1;
    return Object.entries(c).map(([id, n]) => `${id} ${n}`).join(', ') || 'none';
  };
  const agents = records.some((r) => r.engine && r.engine.agents === 'as-shipped') ? '; subagents use the models their definitions pin' : '; every subagent inherits the session\'s model';
  const what = variant === 'method'
    ? '"method" prepends the debug-investigation skill text (reproduce first, isolate, root cause, prove the fix) to the prompt; nothing is installed, so there is no record.'
    : variant === 'debug'
    ? `"debug" installs the toolkit in the sandbox and asks for the fix through the debug track: claim, a regression test reproduced before the fix, fix verify proving it fails on the pre-fix code and passes with the fix, a mutation run on the changed lines, one independent review and a hash-chained record, with no verification gate${agents}.`
    : `"engine" installs the toolkit in the sandbox and asks for delivery through the quick track: claim, pinned check, independent review, verification and a hash-chained record${agents}.`;
  const out = [
    '',
    baseline === 'without' ? ({ debug: '## Debug track vs without', method: '## Method text vs without' }[variant] || '## Engine vs without') : `## ${variant === 'debug' ? 'Debug track' : variant} vs ${baseline === 'engine' ? 'engine (quick track)' : baseline}`,
    '',
    `${what} A run passes when it passes every hidden check. Tokens and cost are what the agent command reported for the whole session, subagents included ("—" when it reported none).`,
    '',
    `| Task | Passing every hidden check (${baseline} → ${variant}) | p | Failed checks (${baseline}; ${variant}) | Median tokens (${baseline} → ${variant}) | Median cost $ | Median seconds | Engine record (${variant}): delivered / audit OK / median reviews |`,
    '|---|---|---|---|---|---|---|---|',
  ];
  const row = (label, a, e, p) => {
    const tok = (rs) => med(rs.filter((r) => r.usage).map((r) => r.usage.tokens));
    const cost = (rs) => med(rs.filter((r) => r.usage).map((r) => r.usage.costUsd));
    const secs = (rs) => med(rs.map((r) => r.durationMs / 1000));
    const eng = e.map((r) => r.engine || {});
    const record = ENGINE_VARIANTS[variant] ? `${eng.filter((x) => x.delivered).length}/${e.length} / ${eng.filter((x) => x.auditOk).length}/${e.length} / ${fmt(med(eng.map((x) => x.reviews || 0)))}` : '—';
    out.push(`| ${label} | ${a.filter(allPassed).length}/${a.length} → ${e.filter(allPassed).length}/${e.length} | ${p} | ${failed(a)}; ${failed(e)} | ${fmt(tok(a))} → ${fmt(tok(e))} | ${fmt(cost(a), 2)} → ${fmt(cost(e), 2)} | ${fmt(secs(a))} → ${fmt(secs(e))} | ${record} |`);
  };
  for (const t of tasks) {
    const a = records.filter((r) => r.task === t && r.variant === baseline);
    const e = records.filter((r) => r.task === t && r.variant === variant);
    const p = a.length && e.length ? `Fisher ${fisherExact(e.filter(allPassed).length, e.length, a.filter(allPassed).length, a.length).toFixed(3)}` : '—';
    row(t, a, e, p);
  }
  if (tasks.length > 1) {
    const a = records.filter((r) => tasks.includes(r.task) && r.variant === baseline);
    const e = records.filter((r) => tasks.includes(r.task) && r.variant === variant);
    const strat = stratifiedTest([...a, ...e].map((r) => ({ stratum: r.task, variant: r.variant === variant ? 'with' : 'without', lines: allPassed(r) ? 1 : 0 })));
    row('**all tasks**', a, e, strat ? `stratified ${strat.atFloor ? '≤' : '='}${strat.p < 0.001 ? strat.p.toExponential(2) : strat.p.toFixed(3)}` : '—');
  }
  return out;
}

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : null;
};

function summarize(records) {
  const cell = {};
  for (const r of records) {
    const k = `${r.task}|${r.variant}`;
    (cell[k] = cell[k] || []).push(r);
  }
  const rows = [];
  for (const [k, rs] of Object.entries(cell)) {
    const [task, variant] = k.split('|');
    rows.push({
      task,
      variant,
      n: rs.length,
      hidden: `${rs.reduce((n, r) => n + r.hiddenPassed, 0)}/${rs.reduce((n, r) => n + r.hiddenTotal, 0)}`,
      medianLines: median(rs.map((r) => r.linesAdded)),
      medianCodeLines: rs.every((r) => typeof r.testLinesAdded === 'number') ? median(rs.map(codeLines)) : null,
      medianSeconds: Math.round(median(rs.map((r) => r.durationMs)) / 1000),
      runsWithNewDeps: rs.filter((r) => r.newDeps.length).length,
      runsWithTests: rs.filter((r) => r.testFilesChanged > 0).length,
    });
  }
  for (const task of new Set(records.map((r) => r.task))) {
    const lines = (v) => records.filter((r) => r.task === task && r.variant === v).map((r) => r.linesAdded);
    const test = permutationTest(lines('with'), lines('without'));
    const code = (v) => records.filter((r) => r.task === task && r.variant === v).map(codeLines);
    const known = records.filter((r) => r.task === task).every((r) => typeof r.testLinesAdded === 'number');
    const codeTest = known ? permutationTest(code('with'), code('without')) : null;
    for (const row of rows.filter((x) => x.task === task)) Object.assign(row, { permutation: test, codePermutation: codeTest });
  }
  return rows;
}

// Lines added outside test files: separates "wrote more code" from "wrote the
// test the bare prompt skipped", which total lines added cannot tell apart.
function codeLines(r) {
  return r.linesAdded - r.testLinesAdded;
}

function pText(perm) {
  return perm.monteCarlo
    ? `Monte Carlo permutation p${perm.atFloor ? '≤' : '='}${perm.p < 0.001 ? perm.p.toExponential(2) : perm.p.toFixed(4)} over ${perm.splits} seeded resamples`
    : `exact permutation p=${perm.p.toFixed(3)} over ${perm.splits} splits`;
}

function report(records, { agentCmd }) {
  const rows = summarize(records);
  const tasks = [...new Set(rows.map((r) => r.task))];
  const minN = Math.min(...rows.filter((r) => r.variant !== 'paired Δ').map((r) => r.n));
  const anyMonteCarlo = rows.some((r) => r.permutation && r.permutation.monteCarlo);
  const nNote = minN >= 10
    ? `Each variant ran n >= ${minN} times per task. ${anyMonteCarlo
      ? 'Where every split can be enumerated the permutation test is exact; above that it is a seeded Monte Carlo permutation test (each row says which), and "p≤" marks a p-value at the resampling floor.'
      : 'The exact permutation test enumerates every split, so the p-values are exact, not asymptotic.'} Read the raw rows alongside the medians.`
    : 'Small n means a demonstration, not a statistic — read the raw rows, not just the medians.';
  const lines = [
    '# ECCode paired benchmark',
    '',
    `Agent command: \`${agentCmd}\`. "with" prepends the lean-change skill text to the prompt; "without" is the bare prompt${records.some((r) => r.variant === 'engine') ? '; "engine" installs the toolkit and asks for delivery through the quick track' : ''}${records.some((r) => r.variant === 'debug') ? '; "debug" installs the toolkit and asks for the fix through the debug track' : ''}${records.some((r) => r.variant === 'method') ? '; "method" prepends the debug-investigation skill text (no toolkit installed)' : ''}. Hidden checks never exist in the sandbox while the agent works. ${nNote}`,
    '',
    '| Task | Variant | n | Hidden checks | Median lines added | Median code lines added (tests excluded) | Runs adding a dependency | Runs changing a test | Median seconds |',
    '|---|---|---|---|---|---|---|---|---|',
  ];
  const signed = (d) => `${d >= 0 ? '+' : ''}${d}`;
  for (const t of tasks) {
    for (const v of ['without', 'with', 'method', 'engine', 'debug']) {
      const r = rows.find((x) => x.task === t && x.variant === v);
      if (r) lines.push(`| ${t} | ${v} | ${r.n} | ${r.hidden} | ${r.medianLines} | ${r.medianCodeLines === null ? '—' : r.medianCodeLines} | ${r.runsWithNewDeps}/${r.n} | ${r.runsWithTests}/${r.n} | ${r.medianSeconds} |`);
    }
    const a = rows.find((x) => x.task === t && x.variant === 'without');
    const b = rows.find((x) => x.task === t && x.variant === 'with');
    if (a && b && a.medianLines !== null && b.medianLines !== null) {
      const perm = b.permutation ? ` (${pText(b.permutation)})` : '';
      const code = a.medianCodeLines !== null && b.medianCodeLines !== null
        ? `${signed(b.medianCodeLines - a.medianCodeLines)}${b.codePermutation ? ` (${pText(b.codePermutation)})` : ''}`
        : '—';
      lines.push(`| ${t} | **paired Δ** |  |  | ${signed(b.medianLines - a.medianLines)}${perm} | ${code} |  |  |  |`);
    }
  }
  const pairedWins = tasks.map((t) => {
    const a = rows.find((x) => x.task === t && x.variant === 'without');
    const b = rows.find((x) => x.task === t && x.variant === 'with');
    return a && b && a.medianLines !== null && b.medianLines !== null ? Math.sign(a.medianLines - b.medianLines) : 0;
  });
  const wins = pairedWins.filter((x) => x > 0).length;
  const losses = pairedWins.filter((x) => x < 0).length;
  if (records.some((r) => r.variant === 'with') && records.some((r) => r.variant === 'without')) {
    lines.push('', `Paired medians across ${tasks.length} task(s): the "with" variant produced the smaller diff on ${wins}, the larger on ${losses}, equal on ${tasks.length - wins - losses}. Sign counts, not significance.`);
  }
  lines.push(...engineSection(records, 'engine'), ...engineSection(records, 'debug'), ...engineSection(records, 'method'), ...engineSection(records, 'debug', 'engine'));
  lines.push('', '## Raw runs', '', '| Task | Variant | Hidden | Lines +/− | New deps | Test files | Seconds | Agent exit | Lines added in tests | Failed checks | Tokens | Cost $ | Engine record |', '|---|---|---|---|---|---|---|---|---|---|---|---|---|');
  for (const r of records) {
    const failedIds = r.checks.filter((c) => !c.passed).map((c) => c.id || c.command).join(', ') || '—';
    const e = r.engine;
    const proof = e && 'fixProven' in e ? `, fix ${e.fixProven ? 'proven' : 'not proven'}, mutants ${e.mutation ? `${e.mutation.killed}/${e.mutation.total} killed` : 'not run'}` : '';
    const eng = e ? `${e.delivered ? 'delivered' : e.initialized ? 'not delivered' : 'no record'}, audit ${e.auditOk ? 'ok' : 'FAILED'}, ${e.reviews} reviews${proof}${e.toolkitChanged ? ', toolkit modified' : ''}` : '—';
    lines.push(`| ${r.task} | ${r.variant} | ${r.hiddenPassed}/${r.hiddenTotal} | +${r.linesAdded}/−${r.linesRemoved} | ${r.newDeps.join(', ') || '—'} | ${r.testFilesChanged} | ${Math.round(r.durationMs / 1000)} | ${r.agentExit} | ${typeof r.testLinesAdded === 'number' ? r.testLinesAdded : '—'} | ${failedIds} | ${r.usage ? r.usage.tokens : '—'} | ${r.usage ? r.usage.costUsd.toFixed(4) : '—'} | ${eng} |`);
  }
  const failed = records.flatMap((r) => r.checks.filter((c) => !c.passed).map((c) => `- ${r.task} (${r.variant}): \`${c.command}\`\n  \`\`\`\n${c.tail.trim()}\n  \`\`\``));
  if (failed.length) lines.push('', '## Failed hidden checks', '', ...failed);
  return lines.join('\n') + '\n';
}

// A Unix socket path may hold about 104-108 bytes. Tests that bind one in
// the temporary directory (tornado's do) fail when the sandbox and its temp
// directory live under a long path, whatever the agent did.
const SOCKET_SAFE_TMPDIR = 60;

/** A warning when the temporary directory is long enough to break Unix-socket tests, else null. */
function tmpdirWarning(dir = os.tmpdir()) {
  const out = [];
  if (dir.length > SOCKET_SAFE_TMPDIR) out.push(`the temporary directory is ${dir.length} characters long (${dir}): tests that bind a Unix socket in it fail with "AF_UNIX path too long" whatever the agent did. Set TMPDIR to a short directory (under ${SOCKET_SAFE_TMPDIR} characters).`);
  // Sandboxes under a Claude Code session's scratchpad put that path in every
  // agent's working directory; agents then treat it as their scratchpad and
  // write (and could read) files shared across runs.
  if (/(^|[\\/])scratchpad([\\/]|$)/.test(dir)) out.push(`the temporary directory is inside a session scratchpad (${dir}): agents see it in their working directory and write files there that other runs can read. Use a temporary directory outside it.`);
  return out.length ? out.join(' ') : null;
}

function run({ suite = DEFAULT_SUITE, agentCmd, tasks: only, runs = 1, variants = ['without', 'with'], timeoutMs, keep, engineProfile, engineAgents, maxCostUsd = null, transcripts = null, onProgress, onRecord }) {
  if (!agentCmd) throw new EccodeError('INVALID_INPUT', 'bench requires --agent "<command run inside each sandbox>" (it must read PROMPT.md, e.g. claude -p "$(cat PROMPT.md)")');
  const warning = tmpdirWarning();
  if (warning && onProgress) onProgress(`WARNING: ${warning}`);
  const tasks = listTasks(suite).filter((t) => !only || only.includes(t.id));
  if (!tasks.length) throw new EccodeError('NOT_FOUND', 'No matching benchmark tasks');
  const records = [];
  for (const task of tasks) {
    for (const variant of variants) {
      for (let i = 0; i < runs; i++) {
        if (maxCostUsd !== null && spentUsd(records) >= maxCostUsd) {
          // The budget cap: stop before the next run, never in the middle of one.
          const stopped = { reason: 'max-cost', spentUsd: spentUsd(records) };
          if (onProgress) onProgress(`stopped: $${stopped.spentUsd} spent, cap $${maxCostUsd}`);
          return { records, markdown: report(records, { agentCmd }), stopped };
        }
        if (onProgress) onProgress(`${task.id} ${variant} run ${i + 1}/${runs}`);
        const record = runOnce(task, { agentCmd, variant, timeoutMs, keep, engineProfile, engineAgents, transcripts });
        records.push(record);
        if (onRecord) onRecord(record); // persisted as it lands: a killed batch keeps its finished runs
      }
    }
  }
  return { records, markdown: report(records, { agentCmd }) };
}

// Stratified permutation test over every recorded raw run: variant labels are
// shuffled only WITHIN each task-batch (one report file x one task), so batch
// and task effects cancel and batches are never treated as independent samples
// of one another. Statistic: the unweighted mean over strata of
// (mean lines added with) - (mean lines added without). Seeded Monte Carlo.
function stratifiedTest(rows, { resamples = 20000, seed = 42 } = {}) {
  const strata = new Map();
  for (const r of rows) {
    if (!strata.has(r.stratum)) strata.set(r.stratum, { with: [], without: [] });
    const s = strata.get(r.stratum);
    if (s[r.variant]) s[r.variant].push(r.lines);
  }
  const usable = [...strata.values()].filter((s) => s.with.length && s.without.length);
  if (!usable.length) return null;
  const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
  const stat = (groups) => mean(groups.map((g) => mean(g.with) - mean(g.without)));
  const observed = stat(usable);
  const rand = mulberry32(seed); // deterministic, so a reported p reproduces exactly
  const pools = usable.map((s) => ({ all: s.with.concat(s.without), nWith: s.with.length }));
  let extreme = 0;
  for (let i = 0; i < resamples; i++) {
    const groups = pools.map(({ all, nWith }) => {
      const a = all.slice();
      for (let j = a.length - 1; j > 0; j--) {
        const k = Math.floor(rand() * (j + 1));
        [a[j], a[k]] = [a[k], a[j]];
      }
      return { with: a.slice(0, nWith), without: a.slice(nWith) };
    });
    if (Math.abs(stat(groups)) >= Math.abs(observed) - 1e-12) extreme += 1;
  }
  return { delta: observed, p: (extreme + 1) / (resamples + 1), atFloor: extreme === 0, resamples, strata: usable.length, runs: usable.reduce((n, s) => n + s.with.length + s.without.length, 0) };
}

// Recompute the headline numbers from recorded report files, so claims about
// past runs are derived from the records on disk rather than remembered.
// Raw-run rows are | Task | Variant | Hidden | Lines | New deps | Test files | Seconds | Agent exit |,
// plus | Lines added in tests | in reports written since that column was added.
function tally(dir) {
  const rows = [];
  const engineRows = [];
  const perFile = [];
  const total = { files: 0, runs: 0, hiddenPassed: 0, hiddenTotal: 0, depRuns: 0, agentFailures: 0, pairedSmaller: 0, pairedLarger: 0, pairedEqual: 0 };
  for (const name of fs.readdirSync(dir).filter((f) => f.endsWith('.md')).sort()) {
    const text = fs.readFileSync(path.join(dir, name), 'utf8').replace(/\r\n/g, '\n');
    const raw = text.split(/^## Raw runs$/m)[1];
    if (!raw) continue;
    // The model is the one the report's agent command names; effects are
    // reported per model, because pooling models can hide opposite effects.
    const model = (text.match(/--model\s+([\w.-]+)/) || [])[1] || 'unknown';
    const f = { file: name, model, runs: 0, hiddenPassed: 0, hiddenTotal: 0, depRuns: 0, agentFailures: 0 };
    const engineFile = /\| (engine|debug|method) \|/.test(raw);
    for (const line of raw.split(/\n## /)[0].split('\n')) {
      const cells = line.split('|').map((c) => c.trim());
      if (cells.length < 10 || !/^\d+\/\d+$/.test(cells[3])) continue; // header, separator and summary rows fall out here
      const [passed, ran] = cells[3].split('/').map(Number);
      f.runs += 1;
      f.hiddenPassed += passed;
      f.hiddenTotal += ran;
      if (cells[5] && cells[5] !== '—' && cells[5] !== '-') f.depRuns += 1;
      if (cells[8] !== '0') f.agentFailures += 1;
      const lines = (cells[4].match(/\+(\d+)/) || [])[1];
      if (engineFile && ['engine', 'debug', 'method', 'without'].includes(cells[2])) {
        const tokens = /^\d+$/.test(cells[11] || '') ? Number(cells[11]) : null;
        const costUsd = /^\d+(\.\d+)?$/.test(cells[12] || '') ? Number(cells[12]) : null;
        engineRows.push({ stratum: `${name}|${cells[1]}`, model, variant: cells[2], allPass: passed === ran && ran > 0, tokens, costUsd, seconds: Number(cells[7]), delivered: /^delivered/.test(cells[13] || ''), auditOk: /audit ok/.test(cells[13] || '') });
        continue; // engine batches are their own comparison, never pooled with the lean-skill strata
      }
      if ((cells[2] === 'with' || cells[2] === 'without') && lines !== undefined) {
        const inTests = /^\d+$/.test(cells[9] || '') ? Number(cells[9]) : null;
        rows.push({ stratum: `${name}|${cells[1]}`, model, variant: cells[2], lines: Number(lines), codeLines: inTests === null ? null : Number(lines) - inTests, wroteTests: Number(cells[6]) > 0 });
      }
    }
    perFile.push(f);
    total.files += 1;
    for (const k of ['runs', 'hiddenPassed', 'hiddenTotal', 'depRuns', 'agentFailures']) total[k] += f[k];
  }
  // Paired-median signs per task-batch, derived from the raw runs (never from
  // a report's own summary cells): negative = with-variant smaller diff.
  const byStratum = new Map();
  for (const r of rows) {
    if (!byStratum.has(r.stratum)) byStratum.set(r.stratum, { with: [], without: [] });
    byStratum.get(r.stratum)[r.variant].push(r.lines);
  }
  for (const g of byStratum.values()) {
    if (!g.with.length || !g.without.length) continue;
    const d = median(g.with) - median(g.without);
    total[d < 0 ? 'pairedSmaller' : d > 0 ? 'pairedLarger' : 'pairedEqual'] += 1;
  }
  const byModel = {};
  for (const m of [...new Set(rows.map((r) => r.model))].sort()) {
    const mine = rows.filter((r) => r.model === m);
    const tests = (v) => { const vr = mine.filter((r) => r.variant === v); return { wrote: vr.filter((r) => r.wroteTests).length, runs: vr.length }; };
    // Tests excluded, over the runs whose reports record test lines.
    const code = mine.filter((r) => r.codeLines !== null).map((r) => ({ ...r, lines: r.codeLines }));
    byModel[m] = { runs: mine.length, stratified: stratifiedTest(mine), codeStratified: stratifiedTest(code), testsWith: tests('with'), testsWithout: tests('without') };
  }
  // Engine batches, per model: pass rates and tokens, engine vs without in the same files.
  const engine = {};
  for (const m of [...new Set(engineRows.map((r) => r.model))].sort()) {
    const mine = engineRows.filter((r) => r.model === m);
    const side = (v) => {
      const vr = mine.filter((r) => r.variant === v);
      const tok = vr.filter((r) => r.tokens !== null).map((r) => r.tokens);
      const cost = vr.filter((r) => r.costUsd !== null).map((r) => r.costUsd);
      return { runs: vr.length, allPass: vr.filter((r) => r.allPass).length, medianTokens: tok.length ? median(tok) : null, medianCostUsd: cost.length ? median(cost) : null, medianSeconds: vr.length ? median(vr.map((r) => r.seconds)) : null, delivered: vr.filter((r) => r.delivered).length, auditOk: vr.filter((r) => r.auditOk).length };
    };
    const versus = (v) => stratifiedTest(mine.filter((r) => r.variant === v || r.variant === 'without').map((r) => ({ stratum: r.stratum, variant: r.variant === v ? 'with' : 'without', lines: r.allPass ? 1 : 0 })));
    engine[m] = { without: side('without'), engine: side('engine'), passRate: versus('engine') };
    if (mine.some((r) => r.variant === 'debug')) Object.assign(engine[m], { debug: side('debug'), debugPassRate: versus('debug') });
    if (mine.some((r) => r.variant === 'method')) Object.assign(engine[m], { method: side('method'), methodPassRate: versus('method') });
  }
  return { perFile, total, stratified: stratifiedTest(rows), byModel, engine };
}

module.exports = { cacheDir, ignoredFiles, removeLeftovers, transcriptUsage, mulberry32, transcriptDir, copyTranscripts, copyRecord, loadRuns, exportPaths, runSetup, promptFor, installToolkit, runAgent, agentEnv, removeSandbox, measureChange, failedSetupRecord, resultRecord, spentUsd, engineOutcome, depsOf, git, hiddenChecksOf, ENGINE_VARIANTS, SKILL_VARIANTS, tmpdirWarning, run, tally, stratifiedTest, runOnce, listTasks, summarize, report, leanPrompt, enginePrompt, exportSource, taskEnv, materialize, placeHidden, runChecks, permutationTest, fisherExact, usageOf, hiddenChecksOf, ENGINE_VARIANTS, DEFAULT_SUITE };
