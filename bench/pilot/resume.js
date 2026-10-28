'use strict';
// Rerun amendment 1 (bench/protocols/2026-10-25-mealie-rerun.md): a container
// restart killed every batch process in the middle of an item. A run it cut
// off has no result line, so it counts as a failure (the pilot's "one batch"
// rule), and no run gets a second sample. Two readings are written:
// - the registered one (--registered): a chain that dies is not restarted and
//   its remaining items count as not delivered, with the cause; a run that
//   never started counts as a failure;
// - the continued one (--save, the batch's own file): each chain continues on
//   its surviving sandbox and record from the next item, after the harness's
//   registered operator abandon of the cut item, and each run that never
//   started runs once.
// A cut run whose agent had already finished (the harness had copied its
// transcripts) can be graded afterwards from a copy of its sandbox
// (--posthoc): a note for the report, outside both readings.
// usage (from the worktree pinned at the protocol commit):
//   node bench/pilot/resume.js chain --suite <dir> --sandbox <dir> --save <file> --registered <file>
//     --chain-run <k> --interrupted <task id> --cause <text> --agent <cmd> --variant engine
//     [--engine-profile guard] [--engine-agents inherit] [--timeout <s>] [--max-cost <usd>]
//     [--transcripts <dir>] [--posthoc <file>] [--keep]
//   node bench/pilot/resume.js runs --suite <dir> --sandbox <dir> --save <file> --registered <file>
//     --interrupted <task id> --variant <v> --then <id:n,...> --cause <text> --agent <cmd>
//     [--timeout <s>] [--max-cost <usd>] [--transcripts <dir>] [--posthoc <file>]
//     [--amendment <n>]   (a later restart: n > 1, and no --registered)
const fs = require('fs');
const os = require('os');
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const bench = require(path.join(ROOT, 'lib', 'bench'));
const chainLib = require(path.join(ROOT, 'lib', 'chain'));

const AMENDMENT = 1;

const readLines = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l)) : []);
const append = (f, r) => fs.appendFileSync(f, JSON.stringify(r) + '\n');
const spent = (f) => bench.spentUsd(readLines(f).filter((l) => !l.type));

/** The registered reading starts as the batch's own file stood at the restart. */
function startRegistered(save, registered) {
  fs.mkdirSync(path.dirname(registered), { recursive: true });
  if (!fs.existsSync(registered)) fs.copyFileSync(save, registered);
}

/** A run the restart cut off: no result line, so a failure, with its cause and what the record showed. */
function interruptedRecord(task, variant, { cause, agentFinished = null, engine = null, chain = null, transcripts = null, amendment = AMENDMENT }) {
  return {
    ...bench.failedSetupRecord(task, variant, null),
    ...(engine ? { engine: { ...engine, delivered: false } } : {}),
    ...(transcripts ? { transcripts } : {}),
    ...(chain ? { chain } : {}),
    infrastructure: { cause, agentFinished, neverStarted: false, ...(engine ? { recordDelivered: engine.delivered } : {}) },
    amendment,
  };
}

/** A run the restart left unstarted, as the registered reading counts it. */
function neverStartedRecord(task, variant, { cause, chain = null }) {
  const { engineVariant, track } = bench.promptFor(task, variant);
  return {
    ...bench.failedSetupRecord(task, variant, null),
    ...(engineVariant ? { engine: { initialized: false, delivered: false, auditOk: false, reviews: 0, changesRequested: 0, runsRecorded: 0, tokensReported: 0, track } } : {}),
    ...(chain ? { chain } : {}),
    infrastructure: { cause, agentFinished: false, neverStarted: true },
    amendment: AMENDMENT,
  };
}

/** The hidden checks on a copy of a cut run's sandbox, as the harness would have run them. */
function gradeCopy(task, sandbox, { withGit }) {
  const copy = fs.mkdtempSync(path.join(os.tmpdir(), `eccode-posthoc-${task.id}-`));
  try {
    fs.cpSync(sandbox, copy, { recursive: true, filter: (src) => withGit || path.basename(src) !== '.git' || path.dirname(src) !== sandbox });
    bench.placeHidden(task, copy);
    const checks = bench.runChecks(task, copy, bench.taskEnv(task));
    return { hiddenPassed: checks.filter((c) => c.passed).length, hiddenTotal: checks.length, checks };
  } finally {
    fs.rmSync(copy, { recursive: true, force: true });
  }
}

const startedAtOf = (sandbox) => Number(bench.git(sandbox, ['log', '-1', '--format=%ct']).trim()) * 1000;

function resumeChain({ suite, sandbox, save, registered, chainRun, interrupted, cause, agentCmd, variant = 'engine', engineProfile = 'guard', engineAgents = 'inherit', timeoutMs = 3600000, maxCostUsd = null, transcripts = null, posthoc = null, keep = false, onProgress = () => {} }) {
  if (readLines(save).some((l) => l.amendment === AMENDMENT && (l.chainRun === chainRun || l.chain === chainRun))) throw new Error(`chain ${chainRun} in ${save} was already resumed`);
  const tasks = chainLib.chainOrder(bench.listTasks(suite));
  const i = tasks.findIndex((t) => t.id === interrupted);
  if (i < 0) throw new Error(`no task ${interrupted} in ${suite}`);
  const head = bench.git(sandbox, ['log', '-1', '--format=%s']).trim();
  if (head !== `item: ${interrupted}`) throw new Error(`the sandbox is not on item ${interrupted}: its last commit is "${head}"`);
  const task = tasks[i];
  const { engineVariant, track } = bench.promptFor(task, variant);
  const dir = `${path.basename(sandbox)}-${i + 1}-${task.id}`;
  // The harness copies an item's transcripts only once its agent has exited.
  const agentFinished = transcripts ? fs.existsSync(path.join(transcripts, dir)) : null;
  if (posthoc && agentFinished) append(posthoc, { task: task.id, variant, chainRun, posthoc: true, ...gradeCopy(task, sandbox, { withGit: false }) });
  const chain = { index: i, sync: null, indexMs: null, abandoned: false };
  if (transcripts) chain.transcripts = { dir, files: bench.copyTranscripts(sandbox, path.join(transcripts, dir), startedAtOf(sandbox)) };
  const engine = engineVariant ? { ...bench.engineOutcome(sandbox), toolkitChanged: null, agents: engineAgents, track } : null;
  if (engineVariant) chain.abandoned = chainLib.closeStuckItem(sandbox, task);
  if (transcripts && engineVariant) chain.transcripts.record = bench.copyRecord(sandbox, path.join(transcripts, dir));
  bench.git(sandbox, ['add', '-A']);
  bench.git(sandbox, ['commit', '-q', '--allow-empty', '-m', `work item: ${task.id} (cut off: ${cause})`]);
  const cut = { ...interruptedRecord(task, variant, { cause, agentFinished, engine, chain }), chainRun };
  startRegistered(save, registered);
  append(save, cut);
  append(registered, cut);
  for (const [j, t] of tasks.entries()) {
    if (j > i) append(registered, { ...neverStartedRecord(t, variant, { cause, chain: { index: j, sync: null, indexMs: null, abandoned: false } }), chainRun });
  }
  append(registered, { type: 'chain-summary', chain: chainRun, variant, ...chainLib.chainSummary(sandbox), at: 'restart', amendment: AMENDMENT });
  try {
    for (const [j, t] of tasks.entries()) {
      if (j <= i) continue;
      const so = spent(save);
      if (maxCostUsd !== null && so >= maxCostUsd) {
        append(save, { type: 'stopped', reason: 'max-cost', spentUsd: so, chain: chainRun, amendment: AMENDMENT });
        break;
      }
      onProgress(`chain ${variant} ${chainRun}: item ${j + 1}/${tasks.length} ${t.id} (amendment ${AMENDMENT})`);
      const r = chainLib.runChainItem(t, sandbox, { agentCmd, variant, timeoutMs, engineProfile, engineAgents, first: false, index: j, transcripts });
      append(save, { ...r, chainRun, amendment: AMENDMENT });
    }
    append(save, { type: 'chain-summary', chain: chainRun, variant, ...chainLib.chainSummary(sandbox), amendment: AMENDMENT });
  } finally {
    if (!keep) bench.removeSandbox(sandbox);
  }
}

/**
 * A later restart (amendment > 1) resumes the same file again. The registered
 * reading is the batch as the first restart left it, so only amendment 1 writes it.
 */
function resumeRuns({ suite, sandbox, save, registered = null, interrupted, variant, then = [], cause, agentCmd, engineProfile = 'guard', engineAgents = 'inherit', timeoutMs = 3600000, maxCostUsd = null, transcripts = null, posthoc = null, amendment = AMENDMENT, onProgress = () => {} }) {
  if (readLines(save).some((l) => l.amendment === amendment)) throw new Error(`${save} was already resumed`);
  if (amendment === AMENDMENT && !registered) throw new Error('the first restart writes the registered reading: --registered is required');
  if (amendment !== AMENDMENT && registered) throw new Error(`amendment ${amendment} leaves the registered reading as the first restart left it: omit --registered`);
  const tasks = bench.listTasks(suite);
  const byId = (id) => tasks.find((t) => t.id === id) || (() => { throw new Error(`no task ${id} in ${suite}`); })();
  const task = byId(interrupted);
  if (!path.basename(sandbox).startsWith(`eccode-bench-${task.id}-${variant}-`)) throw new Error(`the sandbox is not on item ${interrupted} (${variant}): ${sandbox}`);
  const { engineVariant, track } = bench.promptFor(task, variant);
  const dir = path.basename(sandbox);
  const agentFinished = transcripts ? fs.existsSync(path.join(transcripts, dir)) : null;
  if (posthoc && agentFinished) append(posthoc, { task: task.id, variant, posthoc: true, ...gradeCopy(task, sandbox, { withGit: true }) });
  const files = transcripts ? bench.copyTranscripts(sandbox, path.join(transcripts, dir), startedAtOf(sandbox)) : null;
  const engine = engineVariant ? { ...bench.engineOutcome(sandbox), toolkitChanged: null, agents: engineAgents, track } : null;
  const cut = interruptedRecord(task, variant, { cause, agentFinished, engine, transcripts: files ? { dir, files } : null, amendment });
  if (registered) startRegistered(save, registered);
  append(save, cut);
  if (registered) append(registered, cut);
  bench.removeSandbox(sandbox);
  const queue = then.flatMap(([id, n]) => Array.from({ length: n }, () => byId(id)));
  if (registered) for (const t of queue) append(registered, neverStartedRecord(t, variant, { cause }));
  for (const [k, t] of queue.entries()) {
    const so = spent(save);
    if (maxCostUsd !== null && so >= maxCostUsd) {
      append(save, { type: 'stopped', reason: 'max-cost', spentUsd: so, amendment });
      break;
    }
    onProgress(`${t.id} ${variant} run ${k + 1}/${queue.length} (amendment ${amendment})`);
    append(save, { ...bench.runOnce(t, { agentCmd, variant, timeoutMs, engineProfile, engineAgents, transcripts }), amendment });
  }
}

function main(argv) {
  const [mode, ...rest] = argv;
  const flags = {};
  for (let i = 0; i < rest.length; i++) {
    if (!rest[i].startsWith('--')) throw new Error(`unexpected argument ${rest[i]}`);
    const key = rest[i].slice(2);
    if (key === 'keep') flags.keep = true;
    else flags[key] = rest[++i];
  }
  const need = (k) => {
    if (flags[k] === undefined) throw new Error(`--${k} is required`);
    return flags[k];
  };
  const resolved = (k) => (flags[k] ? path.resolve(flags[k]) : null);
  const common = {
    suite: path.resolve(need('suite')),
    sandbox: path.resolve(need('sandbox')),
    save: path.resolve(need('save')),
    registered: resolved('registered'),
    interrupted: need('interrupted'),
    cause: need('cause'),
    agentCmd: need('agent'),
    variant: need('variant'),
    engineProfile: flags['engine-profile'] || 'guard',
    engineAgents: flags['engine-agents'] || 'inherit',
    timeoutMs: Number(flags.timeout || 3600) * 1000,
    maxCostUsd: flags['max-cost'] === undefined ? null : Number(flags['max-cost']),
    transcripts: resolved('transcripts'),
    posthoc: resolved('posthoc'),
    onProgress: (m) => process.stderr.write(`resume: ${m}\n`),
  };
  if (mode === 'chain') return resumeChain({ ...common, registered: path.resolve(need('registered')), chainRun: Number(need('chain-run')), keep: Boolean(flags.keep) });
  if (mode === 'runs') return resumeRuns({ ...common, amendment: Number(flags.amendment || AMENDMENT), then: need('then').split(',').map((x) => x.split(':')).map(([id, n]) => [id, Number(n)]) });
  throw new Error('usage: resume.js chain|runs --suite <dir> --sandbox <dir> --save <file> --registered <file> --interrupted <id> --cause <text> --agent <cmd> --variant <v> ...');
}

if (require.main === module) {
  try {
    main(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`resume: ${err.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = { interruptedRecord, neverStartedRecord, resumeChain, resumeRuns, AMENDMENT };
