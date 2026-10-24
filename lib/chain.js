'use strict';
// Chain mode: one sandbox and one ECCode record across a suite's work items,
// in order, the way a team works on one project over months. Before each item
// the tracked tree is replaced by the item's upstream tree, as if teammates'
// commits had landed, keeping the record (.eccode/) and the toolkit
// (.claude/). The agent then works the item as the next work item on the same
// record. Hidden checks run in a throwaway copy, so they never reach the next
// item, and the sandbox's history holds only syncs and the agent's own work:
// no future upstream commit is ever visible.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { EccodeError, commandEnv } = require('./util');
const bench = require('./bench');

const KEEP = /^(\.eccode|\.claude)(\/|$)/;

/**
 * Replace the sandbox's tracked tree (and every untracked or ignored file) by
 * the task's source tree, keeping .eccode/ and .claude/, then commit
 * "upstream: <sha>". Refuses a source tree that has its own .claude/ or
 * .eccode/: syncing it would overwrite the toolkit or the record. A task with
 * no source keeps the tree as it is.
 */
function syncSource(task, sandbox) {
  if (!task.source) {
    // No upstream (a greenfield project): the item builds on the agent's own
    // previous work. Only the item's fixture, if any, is added.
    const fixture = path.join(task.dir, 'fixture');
    if (fs.existsSync(fixture)) fs.cpSync(fixture, sandbox, { recursive: true, force: true });
    bench.git(sandbox, ['add', '-A']);
    bench.git(sandbox, ['commit', '-q', '--allow-empty', '-m', `item fixture: ${task.id}`]);
    return { commit: null, removed: 0, written: 0 };
  }
  const incoming = fs.mkdtempSync(path.join(os.tmpdir(), 'eccode-sync-'));
  try {
    bench.exportSource(task.source, incoming);
    const clash = ['.claude', '.eccode'].filter((d) => fs.existsSync(path.join(incoming, d)));
    if (clash.length) throw new EccodeError('INVALID_INPUT', `The source tree of ${task.id} has its own ${clash.join(' and ')}: syncing it would overwrite the toolkit or the record`);
    const fixture = path.join(task.dir, 'fixture');
    if (fs.existsSync(fixture)) fs.cpSync(fixture, incoming, { recursive: true });
    const tracked = bench.git(sandbox, ['ls-files', '-z']).split('\0').filter((f) => f && !KEEP.test(f));
    for (const f of tracked) fs.rmSync(path.join(sandbox, f), { force: true });
    // Untracked and ignored leftovers too (caches, links made by a setup):
    // the next item starts from upstream's tree and nothing else.
    bench.git(sandbox, ['clean', '-fdxq', '-e', '.eccode/', '-e', '.claude/']);
    fs.cpSync(incoming, sandbox, { recursive: true, force: true });
    bench.git(sandbox, ['add', '-A']);
    bench.git(sandbox, ['commit', '-q', '--allow-empty', '-m', `upstream: ${task.source.commit}`]);
    const now = new Set(bench.git(sandbox, ['ls-files', '-z']).split('\0').filter((f) => f && !KEEP.test(f)));
    return { commit: task.source.commit, removed: tracked.filter((f) => !now.has(f)).length, written: now.size };
  } finally {
    fs.rmSync(incoming, { recursive: true, force: true });
  }
}

/** Run the installed CLI in the sandbox; {status, stdout, ms}. */
function cli(sandbox, args) {
  const started = Date.now();
  const r = spawnSync(process.execPath, [path.join(sandbox, '.claude', 'eccode', 'bin', 'eccode.js'), ...args], { cwd: sandbox, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, env: commandEnv({ ECCODE_ACTOR: '' }) });
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '', ms: Date.now() - started };
}

function recordState(sandbox) {
  const { Store } = require('./store');
  const store = new Store(sandbox);
  return store.isInitialized() ? store.state() : null;
}

/**
 * What a human operator does when an agent left its work item open: release
 * interrupted runs and claims, then abandon the item as the user, saying why.
 * The policy is fixed before any run (it is the pilot's protocol), so the next
 * item can start; the record shows the decision as the user's.
 */
function closeStuckItem(sandbox, task) {
  const state = recordState(sandbox);
  if (!state) return false;
  if (Object.values(state.runs || {}).some((r) => r.status === 'running')) cli(sandbox, ['recover', '--all']);
  if (!state.work || state.work.status !== 'active') return false;
  const r = cli(sandbox, ['work', 'abandon', '--actor', 'user', '--reason', `bench operator: item ${task.id} ended without delivery; abandoned by the pre-registered policy so the next item can start`]);
  if (r.status !== 0) throw new EccodeError('CHAIN_STUCK', `Could not abandon the stuck work item after ${task.id}: ${r.stderr || r.stdout}`);
  return true;
}

/** One item of a chain, on the shared sandbox. Same record shape as bench.runOnce, plus `chain`. */
function runChainItem(task, sandbox, { agentCmd, variant, timeoutMs = 900000, engineProfile = 'guard', engineAgents = 'inherit', first = false, index = 0, transcripts = null } = {}) {
  const env = bench.taskEnv(task);
  const sync = syncSource(task, sandbox);
  const setup = bench.runSetup(task, sandbox, env);
  const { prompt, track, engineVariant } = bench.promptFor(task, variant);
  if (first && engineVariant) bench.installToolkit(sandbox, { engineProfile, engineAgents });
  const chain = { index, sync, indexMs: null, abandoned: false };
  if (setup && !setup.ok) {
    bench.git(sandbox, ['add', '-A']);
    bench.git(sandbox, ['commit', '-q', '--allow-empty', '-m', `work item: ${task.id} (setup failed)`]);
    return { ...bench.failedSetupRecord(task, variant, setup), chain };
  }
  fs.writeFileSync(path.join(sandbox, 'PROMPT.md'), prompt);
  bench.git(sandbox, ['add', '-A']);
  bench.git(sandbox, ['commit', '-q', '--allow-empty', '-m', `item: ${task.id}`]);
  if (engineVariant && recordState(sandbox)) {
    // The index after teammates' commits landed: what an agent waits for when
    // it asks for the codebase brief at the start of the item.
    chain.indexMs = cli(sandbox, ['onboard', '--json']).ms;
  }
  const depsBefore = bench.depsOf(sandbox);
  const startedAt = Date.now();
  const { agent, durationMs } = bench.runAgent(sandbox, agentCmd, env, variant, timeoutMs);
  // One directory per item: the chain's sandbox, hence its transcript folder, is shared.
  if (transcripts) chain.transcripts = { dir: `${path.basename(sandbox)}-${index + 1}-${task.id}`, files: bench.copyTranscripts(sandbox, path.join(transcripts, `${path.basename(sandbox)}-${index + 1}-${task.id}`), startedAt) };
  const measured = bench.measureChange(sandbox, depsBefore);
  // Hidden checks in a throwaway copy: they never reach the next item.
  const copy = fs.mkdtempSync(path.join(os.tmpdir(), `eccode-chain-check-${task.id}-`));
  let checks;
  try {
    fs.cpSync(sandbox, copy, { recursive: true, filter: (src) => path.basename(src) !== '.git' || path.dirname(src) !== sandbox });
    bench.placeHidden(task, copy);
    checks = bench.runChecks(task, copy, env);
  } finally {
    fs.rmSync(copy, { recursive: true, force: true });
  }
  const engine = engineVariant ? { ...bench.engineOutcome(sandbox), toolkitChanged: measured.toolkitChanged, agents: engineAgents, track } : null;
  if (engineVariant) chain.abandoned = closeStuckItem(sandbox, task);
  // The record as the item left it (after any operator abandon), next to the item's transcripts.
  if (transcripts && engineVariant) chain.transcripts.record = bench.copyRecord(sandbox, path.join(transcripts, chain.transcripts.dir));
  bench.git(sandbox, ['add', '-A']);
  bench.git(sandbox, ['commit', '-q', '--allow-empty', '-m', `work item: ${task.id}`]);
  return { ...bench.resultRecord(task, variant, { agent, durationMs, measured, checks, setup }), ...(engine ? { engine } : {}), chain };
}

/** The long-lived record after the chain: integrity, size, command latency, cost per track, lessons. */
function chainSummary(sandbox) {
  if (!recordState(sandbox)) return { auditOk: null, events: 0, recordBytes: 0, latencyMs: null, metrics: null, lessons: [] };
  const status = cli(sandbox, ['status', '--json']);
  const metrics = cli(sandbox, ['metrics', '--json']);
  const audit = cli(sandbox, ['audit', '--json']);
  const lessons = cli(sandbox, ['memory', 'list', '--json']);
  const parse = (r) => {
    try {
      return JSON.parse(r.stdout);
    } catch {
      return null;
    }
  };
  const events = path.join(sandbox, '.eccode', 'events.jsonl');
  const lessonRows = parse(lessons);
  return {
    auditOk: audit.status === 0 && Boolean(parse(audit) && parse(audit).ok),
    events: fs.existsSync(events) ? fs.readFileSync(events, 'utf8').split('\n').filter(Boolean).length : 0,
    recordBytes: fs.existsSync(events) ? fs.statSync(events).size : 0,
    latencyMs: { status: status.ms, metrics: metrics.ms, audit: audit.ms },
    metrics: parse(metrics),
    lessons: Array.isArray(lessonRows) ? lessonRows.map((l) => l.id || l.title || JSON.stringify(l)) : [],
  };
}

/** One chain: the tasks in order on one sandbox. {records, summary, stopped?} */
function runChain(tasks, { agentCmd, variant = 'engine', timeoutMs, keep = false, engineProfile, engineAgents, maxCostUsd = null, spentBefore = 0, transcripts = null, onProgress, onRecord } = {}) {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), `eccode-chain-${variant}-`));
  bench.git(sandbox, ['init', '-q']);
  const records = [];
  let stopped = null;
  try {
    for (const [index, task] of tasks.entries()) {
      const spent = Math.round((spentBefore + bench.spentUsd(records)) * 10000) / 10000;
      if (maxCostUsd !== null && spent >= maxCostUsd) {
        stopped = { reason: 'max-cost', spentUsd: spent };
        if (onProgress) onProgress(`stopped: $${spent} spent, cap $${maxCostUsd}`);
        break;
      }
      if (onProgress) onProgress(`chain ${variant}: item ${index + 1}/${tasks.length} ${task.id}`);
      const record = runChainItem(task, sandbox, { agentCmd, variant, timeoutMs, engineProfile, engineAgents, first: index === 0, index, transcripts });
      records.push(record);
      if (onRecord) onRecord(record);
    }
    return { records, summary: chainSummary(sandbox), ...(stopped ? { stopped } : {}), sandbox: keep ? sandbox : null };
  } finally {
    if (!keep) fs.rmSync(sandbox, { recursive: true, force: true });
  }
}

/** Suite order for a chain: task.order, then the directory name. */
function chainOrder(tasks) {
  return [...tasks].sort((a, b) => (a.order ?? Infinity) - (b.order ?? Infinity) || path.basename(a.dir).localeCompare(path.basename(b.dir)));
}

module.exports = { syncSource, runChainItem, runChain, chainSummary, chainOrder, closeStuckItem };
