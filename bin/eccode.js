#!/usr/bin/env node
'use strict';
// ECCode CLI. Exit codes: 0 success, 1 usage/internal error, 2 refused by a
// workflow rule (gate, ownership, budget, review validation).

const fs = require('fs');
const path = require('path');
const { parseArgs } = require('../lib/cli-args');
const { EccodeError, readJson, toPosix, ensureDir } = require('../lib/util');

const HELP = `eccode — evidence-gated multi-agent delivery toolkit

Start here
  quick "<change>" --actor orchestrator [--owner <role>] [--files <globs>] [--command <cmd>]
                                         One small, reviewed change: creates the record if needed, a one-task
                                         quick work item with its check and ownership read from the repository,
                                         starts its gate, and prints every remaining step (Claude Code: /eccode:quick)
  debug "<bug>" --actor orchestrator [--owner <role>] [--files <globs>] [--command <cmd>]
                                         One bug, fixed at its root: the same setup on the debug track. The owner
                                         reproduces it with a test, fixes it, proves the test (fix verify) and
                                         records a mutation run; one independent review; no verification gate
                                         (Claude Code: /eccode:debug)
  status --brief                         Where the work stands and the next action
  onboard                                Brief on an unfamiliar codebase before changing it
  impact --changed | bugs                What a change affects; slips in the lines it added
  The full reference follows.

Project
  init --name <n> --idea <text> [--track greenfield|feature|refactor|fix] [--behavior <cmd>]   Create .eccode/ (refactor needs --behavior; a quick change: eccode quick)
  work start --track <t> --title <text> --actor <orchestrator|user> [--behavior <cmd>]
             [--owner <role> --files <glob,glob> --command <cmd>]     Start the next work item (quick and debug need owner/files/command)
  work abandon --actor user --reason <text>   Abandon the active work item (user decision)
  work list [--json]                     Current and archived work items
  status [--json|--brief]                Gates, tasks, budget and the next action
  resume                                 Resume brief for a new session (read-only)
  recover [--all]                        Close interrupted runs, release their claims
  audit [--against <git-ref>]            Verify the hash chain, snapshot==replay, approved artifacts; with
                                         --against, that history committed at <ref> was not rewritten
  rebuild                                Rewrite state.json by replaying events.jsonl
  deliver --actor delivery-lead          Produce the verified final handoff

Gates (architecture, design, plan, phase:<id>, verification)
  gate start <gate> --actor <role>
  gate submit <gate> --actor <role> --artifact <path>... [--responds-to <reviewId>] [--notes <text>]
  gate review <gate> --actor <reviewer> --file <review.json>
  gate reopen <gate> --actor user --resolution <text>
  gate show <gate> [--json]

Plan & tasks
  plan validate <plan.json>
  task list [--json] | task next
  task claim <id> --actor <owner> [--run <runId>]
  task complete <id> --actor <owner> --handoff <handoff.json>
  task fail <id> --actor <owner> --reason <text>
  task reset <id> --actor <orchestrator|delivery-lead|user> --reason <text>
  task rescope <id> [--files <glob,glob>] [--command "<cmd>"] --actor <orchestrator (quick, debug tracks)|user> --reason <text>
                                         Correct a pending task's ownership (release a claimed one with task fail)

Evidence & records
  evidence run --actor <a> --label <l> [--purpose check|reproduction] [--gate g] [--task t] -- <command...>
  evidence file <path> --actor <a> [--label l] [--note n]
  evidence list [--json] | evidence show <id>
  handoff record --actor <a> --file <handoff.json>
  handoff draft --task <id> --actor <owner> [--out .eccode/drafts/<f>.json]
                                         The handoff for your claimed task with what the record knows filled in
                                         (changed files, the passing planned check, criteria); fill the TODO fields
  run start --actor <agent> [--task t] [--gate g]       (prints run id; the orchestrator opens a dispatched
            role's run with --actor orchestrator --for <role>)
  run end <runId> --actor orchestrator --status ok|failed [--tokens n] [--cost-usd x] [--note n]
  run correct <runId> --actor orchestrator [--tokens n] [--cost-usd x] --reason <text>   (append-only)
  risk add --id R1 --title t --severity low|medium|high|critical [--mitigation m] [--owner o] --actor a
  risk update --id R1 --status open|mitigated|accepted|closed --actor a
  decision add --title t --decision d --rationale r [--alternatives a] [--lesson <memId>]... --actor a

Memory (layers: project, debugging, knowledge, workflow)
  memory add --file <record.json> --actor <a> [--scope project|shared]
  memory search <query> [--layer l] [--scope project|shared|all] [--check-env] [--limit n] [--json]
  memory show <id> [--history] | memory list [--layer l] [--status s]
  memory review <id> --actor <reviewer> --decision verify|reject --notes <text>
  memory revise <id> --file <patch.json> --actor <a> --reason <text>
  memory check <id> [--env key=value]...     Applicability against this environment
  memory supersede <oldId> --by <newId> --actor <a> --reason <text>
  memory duplicates [--threshold 0.8]
  memory promote <id> --actor <a>             Sanitize + copy a verified lesson to shared memory
  memory cite <id> --actor <a> --context <text>
  memory env                                  Show the detected environment

Self-improvement
  improve propose --file <proposal.json> --actor <a>
  improve evaluate <id> --actor <a> --variant baseline|candidate -- <command...>
  improve review <id> --actor <reviewer> --decision approve|reject --notes <text>
  improve adopt <id> --actor user|orchestrator
  improve rollback <id> --actor <a> --reason <text>
  improve list

Codebase (work in any repository; see docs/lean.md and docs/senior-engineering.md)
  onboard [--refresh] [--json]     Index the codebase; brief: modules, entry points, hot spots, most-depended files
  impact <file>... | --changed [--base <ref>] [--run --actor <a>] [--trace -- <command...>] [--calls]
                                   Who depends on these files, affected tests; --run executes them; --trace
                                   runs a command under runtime load tracers, so dynamic requires and
                                   reflective imports are resolved by observation, not parsing
  map [--path <dir>] [--chars n]   What already exists (top-level names per directory): reuse before you write
  stack [--json]                   Detected stacks and their checks (project scripts first); * = required
  stack run <id|all> [--record --actor <a>]   Run a check; exit = the check's exit code
  stack adopt --checks <id,id> --actor user [--remove]   Make checks required at the verification gate
  debt [--json]                    Ledger of deferred shortcut markers in code, flagging those with no upgrade trigger

Bugs and problem solving (see docs/bugs.md)
  bugs [--task <id> | --base <ref>] [--all] [--files a,b] [--no-external] [--json]
                                   Bug patterns on the lines a change added (whole files with --all), plus the
                                   findings of installed analyzers (ruff, go vet, eslint, semgrep) on the same
                                   lines; exit 1 on any error. Task completion refuses undeclared errors
  mutate --test "<cmd>" [--task <id> | --base <ref>] [--files a,b] [--max 25] [--timeout <s>]
         [--min-score <0-100>] [--record --actor <a>]
                                   Mutation testing on the changed code lines: one boundary, equality, logical,
                                   boolean, +/- or negation change at a time; a survivor is behavior no test
                                   checks. Files are always restored (also after a killed run)
  fix verify --actor <a> (--task <id> | --base <ref>) [--test "<cmd>"]
                                   Proof the regression test catches the bug: it must FAIL on the pre-fix code
                                   (a temporary worktree at the base with the new tests) and PASS on the fix.
                                   Exit 0 only when proven; the pair counts as the fix track's reproduction

Benchmark
  bench --agent "<cmd>" [--tasks a,b] [--runs n] [--variant with|without|method|engine|debug|both|all|<a,b>] [--suite <dir>]
        [--engine-profile guard|no-shell|sandbox] [--engine-agents inherit|as-shipped] [--timeout <s>] [--out <file>]
        [--chain]: one sandbox and record across the suite's items in order (task.order), synced to each
        item's source between them; --runs counts chains. [--max-cost <usd>]: stop before the next run once
        the runs of this process have reported that much. [--transcripts <dir>]: copy each run's Claude Code
        session files there (keep it outside the repository: they quote the code the agent read)
        [--save <runs.jsonl>] [--keep]
  bench report <runs.jsonl> --agent "<cmd>" [--out <file>]   Rebuild a report from runs saved with --save
  bench tally [--dir bench/results]       Recompute run totals and the stratified test, pooled and per model, from recorded reports
        Paired runs of an agent command (reads PROMPT.md in each sandbox) with and without the lean skill;
        "engine" installs the toolkit and asks for delivery through the quick track (bench/suites/engine:
        multi-file tasks with regression traps); "debug" asks for the fix through the debug track
        (bench/suites/realbugs: real bugs at their pre-fix commits); "method" prepends the debugging
        method's text with nothing installed. Hidden checks, lines, dependencies, tests, and the tokens and
        cost the agent reports (claude -p --output-format json) are measured by the harness, never self-reported

MCP (the engine as typed tool calls; see docs/mcp.md)
  mcp --actor <role>               Serve gates/tasks/evidence/impact as MCP tools over stdio, locked to one role.
                                   One server per role + no Bash for the agent = no shell to obfuscate.

Other
  metrics [--json]                 Rejection rate, repeat bugs, time-to-fix, recurrence, regressions, lean totals
  install --target <dir> [--scope project|user] [--profile sandbox|no-shell|guard] [--with-codebase-memory]
        Copy agents/skills/commands/hooks into .claude/. Default profile: sandbox where Claude Code
        supports it (macOS; Linux/WSL2 with bubblewrap+socat), otherwise no-shell. guard = text guard only.
  export agents-md [--out AGENTS.md]               Generic AGENTS.md for other harnesses

Global: --root <dir> (or ECCODE_ROOT), --actor <role> (or ECCODE_ACTOR, never for user), --json
`;

function shellQuote(arg) {
  if (/^[A-Za-z0-9_\/.,:=@%+-]+$/.test(arg)) return arg;
  // Evidence commands run through the platform shell (sh, or cmd.exe on
  // Windows, which has no single quotes: CRT parsing reads "" as a literal ").
  if (process.platform === 'win32') return `"${arg.replace(/"/g, '""')}"`;
  return `'${arg.replace(/'/g, "'\\''")}'`;
}

function findRoot(flags) {
  if (flags.root) return path.resolve(flags.root);
  if (process.env.ECCODE_ROOT) return path.resolve(process.env.ECCODE_ROOT);
  let dir = process.cwd();
  for (;;) {
    if (fs.existsSync(path.join(dir, '.eccode', 'events.jsonl'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return process.cwd();
    dir = parent;
  }
}

function need(value, name) {
  if (value === undefined || value === true || value === '') {
    const hint = name === '--actor' && process.env.ECCODE_ACTOR === 'user' ? ' (ECCODE_ACTOR=user is ignored: pass --actor user explicitly)' : '';
    throw new EccodeError('USAGE', `Missing required ${name}${hint}`);
  }
  return value;
}

function print(flags, human, json) {
  if (flags.json) process.stdout.write(JSON.stringify(json === undefined ? human : json, null, 2) + '\n');
  else process.stdout.write((typeof human === 'string' ? human : JSON.stringify(human, null, 2)) + '\n');
}

function loadJsonFile(file) {
  return readJson(path.resolve(file));
}

function main(argv) {
  const args = parseArgs(argv);
  const { flags } = args;
  const [group, sub, arg] = args._;
  if (!group || flags.help || group === 'help') {
    process.stdout.write(HELP);
    return 0;
  }
  const root = findRoot(flags);
  // User authority must be visible in the command itself, where the guard hook
  // can ask the human to confirm it, so ECCODE_ACTOR never supplies "user".
  const actor = flags.actor || (process.env.ECCODE_ACTOR === 'user' ? undefined : process.env.ECCODE_ACTOR);
  const { openProject, init } = require('../lib/project');

  if (group === 'init') {
    const quick = ['quick', 'debug'].includes(flags.track) ? { owner: flags.owner, files: flags.files, command: flags.command } : undefined;
    const store = init(root, { name: need(flags.name, '--name'), idea: need(flags.idea, '--idea'), actor: actor || 'orchestrator', track: flags.track, quick, behavior: flags.behavior });
    print(flags, `Initialized ECCode project in ${store.dir}`, { root: store.root });
    return 0;
  }
  if (group === 'quick' || group === 'debug') {
    const q = require('../lib/quick');
    const res = q.start(root, need(actor, '--actor'), { request: need(sub, group === 'debug' ? '"<bug>"' : '"<request>"'), owner: flags.owner, files: flags.files, command: flags.command, name: flags.name, track: group });
    const t = res.task;
    const steps = q.steps('eccode', t, group);
    print(flags, [
      `${group === 'debug' ? 'Bug fix' : 'Quick change'} ${res.workId} started${res.created ? ' (new record)' : ''}: "${t.title}"`,
      `  task ${t.id}: owner ${t.owner}; files ${t.files.join(', ')}; verification: ${t.verification.command}`,
      ...res.defaults.map((d) => `  from the repository: ${d}`),
      `  gate phase:${t.id} is started.`,
      '',
      'The rest of the path (eccode status shows where you are):',
      ...steps,
    ].join('\n'), { workId: res.workId, task: t, defaults: res.defaults, steps });
    return 0;
  }
  if (group === 'mcp') {
    // Long-running: serves the engine as MCP tools, locked to one actor.
    require('../lib/mcp').serve({ root, actor: need(actor, '--actor') });
    return undefined; // the stdin listener keeps the process alive until the client closes it
  }
  if (group === 'install') return require('../lib/install').cli(flags, print);
  if (group === 'export') return require('../lib/install').exportCli(sub, flags, print);

  const { store, config } = openProject(root);
  if (group === 'bench') {
    const bench = require('../lib/bench');
    if (sub === 'tally') {
      const t = bench.tally(path.resolve(root, flags.dir || 'bench/results'));
      const pv = (st) => `p ${st.atFloor ? '≤' : '='} ${st.p < 0.001 ? st.p.toExponential(2) : st.p.toFixed(4)}`;
      const perModel = Object.entries(t.byModel).map(([m, b]) => `  ${m}: ${b.runs} paired-variant runs; ${b.stratified ? `mean with-without = ${b.stratified.delta.toFixed(2)} lines (${b.stratified.strata} strata), two-sided ${pv(b.stratified)}` : 'not enough paired rows'}; runs changing a test file: with ${b.testsWith.wrote}/${b.testsWith.runs}, without ${b.testsWithout.wrote}/${b.testsWithout.runs}${b.codeStratified ? `; tests excluded (${b.codeStratified.runs} runs that record test lines): ${b.codeStratified.delta.toFixed(2)} lines, ${pv(b.codeStratified)}` : ''}`);
      const text = t.perFile
        .map((f) => `${f.file}: ${f.runs} runs, hidden ${f.hiddenPassed}/${f.hiddenTotal}, dep-adding ${f.depRuns}, agent failures ${f.agentFailures}`)
        .concat(`TOTAL: ${t.total.runs} runs across ${t.total.files} report files, hidden ${t.total.hiddenPassed}/${t.total.hiddenTotal}, dep-adding ${t.total.depRuns}, agent failures ${t.total.agentFailures}`, `Paired medians per task-batch: with-variant smaller ${t.total.pairedSmaller}, larger ${t.total.pairedLarger}, equal ${t.total.pairedEqual}`, t.stratified ? `Stratified permutation (labels shuffled within each task-batch, ${t.stratified.strata} strata, ${t.stratified.runs} runs): mean with-without = ${t.stratified.delta.toFixed(2)} lines, two-sided p ${t.stratified.atFloor ? '≤' : '='} ${t.stratified.p < 0.001 ? t.stratified.p.toExponential(2) : t.stratified.p.toFixed(4)} over ${t.stratified.resamples} seeded resamples (pools every model; read the per-model lines)` : 'Stratified permutation: not enough paired raw rows', 'Per model (the same test within each model):', ...perModel)
        .concat(Object.entries(t.engine).length ? ['Engine batches (engine and debug vs without, same files; pass = every hidden check):'] : [], Object.entries(t.engine).map(([m, e]) => {
          const side = (name, x, rate) => `${name} ${x.allPass}/${x.runs} pass, median ${x.medianTokens === null ? '—' : x.medianTokens} tokens, $${x.medianCostUsd === null ? '—' : x.medianCostUsd}, ${x.medianSeconds} s${name === 'without' || name === 'method' ? '' : `, delivered ${x.delivered}/${x.runs}, audit ok ${x.auditOk}/${x.runs}`}${rate ? `; pass-rate difference ${rate.delta >= 0 ? '+' : ''}${(rate.delta * 100).toFixed(1)} points, stratified p ${rate.atFloor ? '≤' : '='} ${rate.p.toFixed(4)}` : ''}`;
          return `  ${m}: ${[side('without', e.without), e.engine.runs ? side('engine', e.engine, e.passRate) : null, e.debug ? side('debug', e.debug, e.debugPassRate) : null, e.method ? side('method', e.method, e.methodPassRate) : null].filter(Boolean).join('; ')}`;
        }))
        .join('\n');
      print(flags, text, t);
      return 0;
    }
    if (sub === 'report') {
      // Rebuild a report from runs saved with --save (one JSON record per line).
      const file = path.resolve(need(arg, '<runs.jsonl>'));
      const records = bench.loadRuns(fs.readFileSync(file, 'utf8'));
      const markdown = bench.report(records, { agentCmd: need(flags.agent, '--agent') });
      if (flags.out) {
        require('../lib/util').writeFileAtomic(path.resolve(flags.out), markdown);
        process.stderr.write(`bench: report of ${records.length} saved runs written to ${flags.out}\n`);
      }
      print(flags, markdown, records);
      return 0;
    }
    const VARIANTS = ['without', 'with', 'method', 'engine', 'debug'];
    const variants = !flags.variant || flags.variant === 'both' ? ['without', 'with'] : flags.variant === 'all' ? ['without', 'with', 'engine'] : String(flags.variant).split(',').map((v) => v.trim());
    const unknown = variants.filter((v) => !VARIANTS.includes(v));
    if (unknown.length) throw new EccodeError('USAGE', `Unknown --variant ${unknown.join(', ')}: use with, without, method, engine, debug, both (without,with), all (without,with,engine), or a comma list`);
    const save = flags.save ? (r) => fs.appendFileSync(path.resolve(flags.save), JSON.stringify(r) + '\n') : () => {};
    const maxCostUsd = flags['max-cost'] !== undefined ? Number(flags['max-cost']) : null;
    const common = {
      agentCmd: need(flags.agent, '--agent'),
      timeoutMs: flags.timeout ? Number(flags.timeout) * 1000 : undefined,
      keep: Boolean(flags.keep),
      engineProfile: flags['engine-profile'] || 'guard',
      engineAgents: flags['engine-agents'] || 'inherit',
      maxCostUsd,
      transcripts: flags.transcripts ? path.resolve(flags.transcripts) : null,
      onProgress: (m) => process.stderr.write(`bench: ${m}\n`),
    };
    let records;
    let markdown;
    let stopped = null;
    if (flags.chain) {
      // One sandbox and record per chain; --runs counts chains.
      const chain = require('../lib/chain');
      if (variants.length !== 1) throw new EccodeError('USAGE', '--chain runs one --variant per process');
      const only = flags.tasks ? String(flags.tasks).split(',').map((x) => x.trim()) : null;
      const tasks = chain.chainOrder(bench.listTasks(flags.suite ? path.resolve(flags.suite) : path.join(__dirname, '..', 'bench', 'tasks')).filter((t) => !only || only.includes(t.id)));
      const warning = bench.tmpdirWarning();
      if (warning) common.onProgress(`WARNING: ${warning}`);
      records = [];
      for (let k = 1; k <= Number(flags.runs || 1) && !stopped; k++) {
        const res = chain.runChain(tasks, { ...common, variant: variants[0], spentBefore: bench.spentUsd(records), onRecord: (r) => save({ ...r, chainRun: k }) });
        records.push(...res.records.map((r) => ({ ...r, chainRun: k })));
        save({ type: 'chain-summary', chain: k, variant: variants[0], ...res.summary });
        stopped = res.stopped || null;
      }
      markdown = bench.report(records, { agentCmd: common.agentCmd });
    } else {
      ({ records, markdown, stopped = null } = bench.run({
        ...common,
        suite: flags.suite ? path.resolve(flags.suite) : undefined,
        tasks: flags.tasks ? String(flags.tasks).split(',').map((x) => x.trim()) : null,
        runs: Number(flags.runs || 1),
        variants,
        onRecord: save,
      }));
    }
    if (stopped) save({ type: 'stopped', ...stopped });
    if (flags.out) {
      require('../lib/util').writeFileAtomic(path.resolve(flags.out), markdown);
      process.stderr.write(`bench: report written to ${flags.out}\n`);
    }
    print(flags, markdown, records);
    return stopped ? 1 : 0;
  }
  if (group === 'onboard') {
    const { onboardBrief } = require('../lib/codebase');
    const b = onboardBrief(root, { refresh: Boolean(flags.refresh) });
    if (fs.existsSync(path.join(root, '.eccode'))) {
      require('../lib/util').writeFileAtomic(path.join(root, '.eccode', 'cache', 'onboard.md'), b.text + '\n');
    }
    print(flags, b.text, { modules: b.modules, files: Object.keys(b.index.files).length, builtAt: b.index.builtAt });
    return 0;
  }
  if (group === 'bugs') {
    const bugs = require('../lib/bugs');
    let base = flags.base || 'HEAD';
    if (flags.task) {
      const t = store.state().tasks[flags.task];
      if (!t) throw new EccodeError('NOT_FOUND', `Unknown task ${flags.task}`);
      const claimBase = require('../lib/tasks').taskBase(t);
      if (claimBase) base = claimBase;
    }
    const res = bugs.scan(root, { base, all: Boolean(flags.all), files: flags.files ? String(flags.files).split(',').map((x) => x.trim()).filter(Boolean) : null, external: !flags['no-external'] });
    print(flags, bugs.format(res), res);
    return res.findings.some((f) => f.severity === 'error') ? 1 : 0;
  }
  if (group === 'mutate') {
    const mutate = require('../lib/mutate');
    let base = flags.base || 'HEAD';
    let test = flags.test;
    if (flags.task) {
      const t = store.state().tasks[flags.task];
      if (!t) throw new EccodeError('NOT_FOUND', `Unknown task ${flags.task}`);
      base = require('../lib/tasks').taskBase(t) || base;
      if (!test && t.verification && t.verification.command) test = t.verification.command;
    }
    const res = mutate.run(root, {
      test: need(test, '--test'),
      base,
      files: flags.files ? String(flags.files).split(',').map((x) => x.trim()).filter(Boolean) : null,
      max: flags.max ? Number(flags.max) : 25,
      timeoutMs: flags.timeout ? Number(flags.timeout) * 1000 : undefined,
      onProgress: (m) => process.stderr.write(`mutate: ${m}\n`),
    });
    if (flags.record) res.evidence = mutate.record(store, need(actor, '--actor'), res, { task: flags.task, gate: flags.gate }).id;
    print(flags, `${mutate.format(res)}${res.evidence ? `\nRecorded as ev:${res.evidence}` : ''}`, res);
    return flags['min-score'] !== undefined && res.score !== null && res.score * 100 < Number(flags['min-score']) ? 1 : 0;
  }
  if (group === 'fix') {
    if (sub !== 'verify') throw new EccodeError('USAGE', 'Usage: eccode fix verify --actor <a> (--task <id> | --base <ref>) [--test "<cmd>"]');
    const fixverify = require('../lib/fixverify');
    const r = fixverify.verify(store, need(actor, '--actor'), { test: flags.test, task: flags.task, base: flags.base, timeoutMs: flags.timeout ? Number(flags.timeout) * 1000 : undefined });
    print(flags, fixverify.format(r), r);
    return r.verdict === 'proven' ? 0 : 1;
  }
  if (group === 'impact') {
    const { impact } = require('../lib/codebase');
    const { gitChangedFiles } = require('../lib/project');
    const targets = flags.changed ? gitChangedFiles(root, flags.base || 'HEAD') : args._.slice(1);
    if (!targets || !targets.length) throw new EccodeError('USAGE', 'Usage: eccode impact <file>... | eccode impact --changed [--base <ref>]');
    let res = impact(root, targets);
    if (flags.trace) {
      const { traceRun, mergeTrace } = require('../lib/codebase');
      const command = (args.rest || []).length === 1 ? args.rest[0] : (args.rest || []).map((x) => x).join(' ');
      if (!command) throw new EccodeError('USAGE', 'impact --trace needs the command after --, e.g. eccode impact src/x.js --trace -- "npm test"');
      res = mergeTrace(res, traceRun(root, command));
    }
    if (flags.calls) {
      const cbm = require('../lib/cbm');
      if (!cbm.binary()) throw new EccodeError('NOT_FOUND', 'impact --calls needs codebase-memory-mcp (https://github.com/DeusData/codebase-memory-mcp): install it on PATH, or set ECCODE_CBM to its binary.');
      res.calls = cbm.functionCallers(root, res.targets);
    }
    const max = Number(flags.max || 25);
    const text = [
      `Impact of ${res.targets.length} file(s): ${res.targets.join(', ')}${res.notIndexed.length ? `\n(not in the index, no dependents known: ${res.notIndexed.join(', ')})` : ''}`,
      `Dependents: ${res.dependents.length} file(s) in ${res.moduleCounts.length} module(s)${res.moduleCounts.length ? `: ${res.moduleCounts.slice(0, 10).map((m) => `${m.module} (${m.files})`).join(', ')}${res.moduleCounts.length > 10 ? `, … ${res.moduleCounts.length - 10} more` : ''}` : ''}`,
      res.dependents.length ? '  nearest first; at each distance, the files most depended on first' : null,
      ...res.dependents.slice(0, max).map((d) => `  ${'  '.repeat(d.distance - 1)}${d.file} (distance ${d.distance}${d.reach ? `; ${d.reach} file(s) depend on it` : ''})`),
      res.dependents.length > max ? `  … ${res.dependents.length - max} more (--max ${res.dependents.length})` : null,
      res.tests.length ? `Affected tests (run these): ${res.tests.slice(0, 40).join(' ')}${res.tests.length > 40 ? ` … ${res.tests.length - 40} more (--json lists all; --run runs all)` : ''}` : 'WARNING: no affected test file found in the index for this change.',
      res.testSupport.length ? `Test support reached (helpers, fixtures, runners; not tests to run): ${res.testSupport.length} file(s): ${res.testSupport.slice(0, 6).join(', ')}${res.testSupport.length > 6 ? ', …' : ''}` : null,
      res.dynamicCallers.length ? `Note: ${res.dynamicCallers.length} file(s) use dynamic module loading and may also be affected (static analysis cannot tell): ${res.dynamicCallers.slice(0, 8).join(', ')}${res.dynamicCallers.length > 8 ? ', …' : ''}` : null,
      res.notCovered && (res.notCovered.generated || res.notCovered.unreadable) ? `Note: ${res.notCovered.generated} generated and ${res.notCovered.unreadable} unreadable file(s) are outside the index; their dependents are not tracked (eccode onboard lists them).` : null,
      res.runtime ? `Runtime trace (exit ${res.runtime.exitCode}): ${res.runtime.loadsObserved} in-project loads observed; targets loaded by the command: ${res.runtime.targetsLoaded.join(', ') || 'none'}; runtime-only dependents found: ${res.runtime.runtimeDependents.join(', ') || 'none'}; direct edges the static graph lacks: ${res.runtime.runtimeOnlyEdges.join(', ') || 'none'}; dynamic loaders observed in action: ${res.runtime.dynamicCallersObserved.join(', ') || 'none'}${res.runtime.loadsObserved === 0 ? ' (nothing observed: the command may not run this project\'s Node or Python code)' : ''}${res.runtime.loadsObserved > 0 && res.runtime.targetsNotLoaded.length ? ` (the command never loaded ${res.runtime.targetsNotLoaded.join(', ')}, so this trace says nothing about the runtime callers of ${res.runtime.targetsNotLoaded.length === 1 ? 'that target' : 'those targets'}: trace a command that exercises it)` : ''}${res.runtime.esmTraced ? '' : ' (ESM imports were not traced: this Node lacks module.register, needs >= 18.19 / 20.6)'}${!res.runtime.jvmTraced && res.targets.some((t) => /\.(java|kt)$/.test(t)) ? ' (JVM classes were not traced: no JDK javac/jar found to build the tracing agent)' : ''}` : null,
      ...(res.calls ? (res.calls.error ? [`Function-level callers (${res.calls.tool}): ${res.calls.error}`] : [
        `Function-level callers (${res.calls.tool}, resolved call graph):`,
        ...res.calls.functions.map((f) => `  ${f.file}#${f.name} <- ${f.callers.length ? f.callers.map((c) => `${c.file}#${c.name}${c.hop > 1 ? ` (hop ${c.hop})` : ''}`).join(', ') : 'no callers found'}`),
        res.calls.truncated ? `  … ${res.calls.truncated} more function(s) not traced` : null,
      ]) : []),
    ].filter(Boolean).join('\n');
    print(flags, text, res);
    if (flags.run) {
      if (!res.tests.length) return 2;
      const cmds = require('../lib/stack').testRunCommands(root, res.tests);
      let worst = 0;
      for (const command of cmds) {
        const ev = require('../lib/evidence').runCommand(store, need(actor, '--actor'), { label: 'impact: affected tests', command });
        process.stdout.write(`ev:${ev.id} ${ev.status.toUpperCase()} — ${command}\n`);
        if (ev.exitCode !== 0) worst = 2;
      }
      return worst;
    }
    return 0;
  }
  if (group === 'stack') {
    const stack = require('../lib/stack');
    const cfg = config || require('../lib/config').DEFAULT_CONFIG;
    if (sub === 'run') {
      const ids = need(arg, '<check id|all>') === 'all'
        ? stack.checks(root, cfg).filter((c) => c.available).map((c) => c.id)
        : [arg];
      let worst = 0;
      for (const id of ids) {
        if (flags.record) {
          const c = stack.checks(root, cfg).find((x) => x.id === id);
          const ev = require('../lib/evidence').runCommand(store, need(actor, '--actor'), { label: `stack:${id}`, command: c && !id.startsWith('eccode-') ? c.command : `node ${JSON.stringify(__filename)} stack run ${id}`, gate: flags.gate });
          process.stdout.write(`${id}: ${ev.status.toUpperCase()} (ev:${ev.id})\n`);
          worst = Math.max(worst, ev.exitCode === 0 ? 0 : 2);
        } else {
          const r = stack.runCheck(root, cfg, id);
          process.stdout.write(`${id}: ${r.exitCode === 0 ? 'PASSED' : `FAILED (exit ${r.exitCode})`}\n${r.output.trim()}\n`);
          worst = Math.max(worst, r.exitCode === 0 ? 0 : 2);
        }
      }
      return worst;
    }
    if (sub === 'adopt') {
      if (need(actor, '--actor') !== 'user') throw new EccodeError('USER_AUTH_REQUIRED', 'Required checks are policy: eccode stack adopt needs --actor user');
      store.assertInitialized();
      const required = stack.adopt(root, String(need(flags.checks, '--checks')).split(',').map((x) => x.trim()).filter(Boolean), { remove: Boolean(flags.remove) });
      print(flags, `Required stack checks: ${required.join(', ') || '(none)'}`, { required });
      return 0;
    }
    const list = stack.checks(root, cfg);
    const text = [
      `Stacks: ${stack.detect(root).map((s) => `${s.id} (${s.evidence})`).join(' · ') || '(none detected)'}`,
      ...list.map((c) => `${c.required ? '*' : ' '} ${c.id.padEnd(16)} [${c.kind}] ${c.available ? '' : '(tool missing) '}${c.command}${c.networked ? '  (uses the network)' : ''}`),
      'Legend: * required at verification (eccode stack adopt --actor user). Project scripts beat standard tools.',
    ].join('\n');
    print(flags, text, list);
    return 0;
  }
  if (group === 'map' || group === 'debt') {
    const lean = require('../lib/lean');
    if (group === 'debt') {
      const ledger = lean.debtLedger(root);
      print(flags, lean.formatLedger(ledger), ledger);
      return 0;
    }
    const chars = Number(flags.chars || (config ? config.lean.mapChars : require('../lib/config').DEFAULT_CONFIG.lean.mapChars));
    const map = lean.reuseMap(root, { under: flags.path, chars });
    print(flags, map.text || '(no source files with top-level definitions found)', map);
    return 0;
  }
  const memoryGroups = { memory: '../lib/memory/cli', improve: '../lib/memory/improve-cli' };
  if (memoryGroups[group]) return require(memoryGroups[group]).run({ store, config, sub, arg, flags, rest: args.rest, actor, print, need, loadJsonFile, root });
  store.assertInitialized();
  const gates = require('../lib/gates');
  const tasks = require('../lib/tasks');
  const evidence = require('../lib/evidence');
  const runs = require('../lib/runs');
  const status = require('../lib/status');

  switch (group) {
    case 'status': {
      const sum = status.summary(store.state(), config, { root: store.root });
      if (flags.brief) print({}, status.formatBrief(sum));
      else print(flags, status.formatBrief(sum) + '\n\n' + JSON.stringify(sum.gates, null, 2), sum);
      return 0;
    }
    case 'resume': {
      const state = store.state();
      const sum = status.summary(state, config, { root: store.root });
      const lastHandoffs = Object.values(state.handoffs).slice(-3).map((h) => `- ${h.at} ${h.from}→${h.to}: ${h.nextAction}`);
      const text = [status.formatBrief(sum), lastHandoffs.length ? 'Recent handoffs:\n' + lastHandoffs.join('\n') : ''].filter(Boolean).join('\n');
      print(flags, text, { ...sum, recentHandoffs: lastHandoffs });
      return 0;
    }
    case 'recover': {
      const rec = runs.recover(store, config, { all: Boolean(flags.all) });
      print(flags, rec.length ? rec.map((r) => `recovered run ${r.run || '-'} (${r.agent}) task=${r.task || '-'} released=${r.released}${r.escalated ? ' ESCALATED' : ''}`).join('\n') : 'Nothing to recover.', rec);
      return 0;
    }
    case 'rebuild': {
      const st = store.rebuildSnapshot();
      print(flags, `Snapshot rebuilt from ${st.seq} events.`, { seq: st.seq });
      return 0;
    }
    case 'audit': {
      const res = store.audit();
      let against = '';
      if (flags.against) {
        const { git } = require('../lib/project');
        const ref = flags.against;
        if (git(root, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]) === null) res.errors.push(`--against: unknown git ref ${ref}`);
        else {
          const committed = git(root, ['show', `${ref}:./.eccode/events.jsonl`]);
          res.errors.push(...(committed === null ? [] : store.divergenceFrom(committed)));
          against = committed === null ? ` (no record at ${ref} to compare)` : `, history matches ${ref}`;
        }
      }
      const changes = require('../lib/delivery').unreviewedChanges(store.state(), store.root);
      const ok = res.errors.length === 0 && !changes.length;
      print(flags, ok ? `Audit OK: ${res.events} events, chain intact, approved artifacts unchanged${against}.` : `Audit FAILED:\n- ${[...res.errors, ...changes.map((c) => `${c.path} ${c.problem} (${c.gate})`)].join('\n- ')}`, { ...res, unreviewedChanges: changes, ok });
      return ok ? 0 : 2;
    }
    case 'deliver': {
      let metrics;
      try {
        metrics = require('../lib/memory/metrics').compute(store, config).summary;
      } catch {
        metrics = undefined;
      }
      const res = require('../lib/delivery').deliver(store, need(actor, '--actor'), { metrics });
      print(flags, `Delivered. Final handoff: ${res.report}`, res);
      return 0;
    }
    case 'work': {
      const works = require('../lib/works');
      if (sub === 'start') {
        const { event } = works.startWork(store, config, need(actor, '--actor'), {
          track: need(flags.track, '--track'),
          title: need(flags.title, '--title'),
          behavior: flags.behavior,
          quick: { title: flags.title, owner: flags.owner, files: flags.files, command: flags.command },
        });
        print(flags, `Work ${event.data.id} started on the ${flags.track} track. Next: eccode status --brief`, event.data);
      } else if (sub === 'abandon') {
        works.abandonWork(store, need(actor, '--actor'), need(flags.reason, '--reason'));
        print(flags, 'Work item abandoned by user decision. Start the next one with eccode work start.');
      } else if (sub === 'list') {
        const st = store.state();
        const rows = [...Object.values(st.pastWorks).map((p) => p.work), ...(st.work ? [st.work] : [])];
        print(flags, rows.map((w) => `${w.id} [${w.track}] ${w.status}${w.delivery ? ` delivered ${w.delivery.at}` : ''} — ${w.title}`).join('\n') || '(none)', rows);
      } else throw new EccodeError('USAGE', `Unknown work subcommand ${sub}`);
      return 0;
    }
    case 'gate': {
      const gateId = need(arg, '<gate>');
      if (sub === 'start') {
        gates.startGate(store, config, gateId, need(actor, '--actor'));
        print(flags, `Gate ${gateId} started.`, { gate: gateId, status: 'in_progress' });
      } else if (sub === 'submit') {
        const { event } = gates.submit(store, config, gateId, need(actor, '--actor'), {
          artifacts: flags.artifact || [],
          respondsTo: flags['responds-to'],
          notes: flags.notes,
        });
        print(flags, `Submitted ${gateId} as ${event.data.submissionId} (${event.data.artifacts.length} artifact(s)). Next: independent review.`, event.data);
      } else if (sub === 'review') {
        const review = loadJsonFile(need(flags.file, '--file'));
        const { event, state } = gates.recordReview(store, config, gateId, need(actor, '--actor'), review);
        gates.archiveReview(store, event.data.reviewId, review);
        const g = store.state().gates[gateId];
        print(flags, `Review ${event.data.reviewId} recorded: ${review.decision}. Gate ${gateId} is now ${g.status}.${g.status === 'escalated' ? `\nESCALATED: ${g.escalation.recovery}` : ''}`, { reviewId: event.data.reviewId, gateStatus: g.status, escalation: g.escalation, iterations: state.gates[gateId].iterations });
      } else if (sub === 'reopen') {
        gates.reopenGate(store, gateId, need(actor, '--actor'), need(flags.resolution, '--resolution'));
        print(flags, `Gate ${gateId} reopened by user decision.`);
      } else if (sub === 'show') {
        const g = store.state().gates[gateId];
        if (!g) throw new EccodeError('UNKNOWN_GATE', `Unknown gate ${gateId}`);
        print(flags, g);
      } else throw new EccodeError('USAGE', `Unknown gate subcommand ${sub}`);
      return 0;
    }
    case 'plan': {
      if (sub !== 'validate') throw new EccodeError('USAGE', 'Usage: eccode plan validate <plan.json>');
      const plan = loadJsonFile(need(arg, '<plan.json>'));
      const errors = tasks.validatePlan(plan, config);
      const warnings = errors.length ? [] : tasks.ownershipConflicts(plan.tasks).map(([a, b]) => `${a} and ${b} may run in parallel but share file ownership (they will be serialized)`);
      print(flags, errors.length ? `Plan INVALID:\n- ${errors.join('\n- ')}` : `Plan valid: ${plan.phases.length} phase(s), ${plan.tasks.length} task(s).${warnings.length ? `\nWarnings:\n- ${warnings.join('\n- ')}` : ''}`, { errors, warnings });
      return errors.length ? 2 : 0;
    }
    case 'task': {
      if (sub === 'list' || sub === 'next') {
        const state = store.state();
        const list = sub === 'next' ? tasks.readyTasks(state, config) : Object.values(state.tasks);
        print(flags, list.map((t) => `${t.id} [${t.status}] phase=${t.phase} owner=${t.owner} attempts=${t.attempts} — ${t.title}`).join('\n') || '(none)', list);
      } else if (sub === 'claim') {
        const { event } = tasks.claim(store, config, need(arg, '<task>'), need(actor, '--actor'), { runId: flags.run });
        print(flags, `Claimed ${arg} (base ${event.data.baseCommit || 'no git'}).`, event.data);
      } else if (sub === 'complete') {
        tasks.complete(store, config, need(arg, '<task>'), need(actor, '--actor'), loadJsonFile(need(flags.handoff, '--handoff')));
        print(flags, `Task ${arg} completed with validated handoff.`);
      } else if (sub === 'fail') {
        const { state } = tasks.fail(store, config, need(arg, '<task>'), need(actor, '--actor'), need(flags.reason, '--reason'));
        const t = state.tasks[arg];
        print(flags, t.status === 'escalated' ? `Task ${arg} ESCALATED: ${t.escalation.recovery}` : `Task ${arg} failed (attempt ${t.attempts}); it may be retried.`, t);
      } else if (sub === 'reset') {
        tasks.reset(store, need(arg, '<task>'), need(actor, '--actor'), need(flags.reason, '--reason'));
        print(flags, `Task ${arg} reset to pending.`);
      } else if (sub === 'rescope') {
        tasks.rescope(store, config, need(arg, '<task>'), need(actor, '--actor'), { files: flags.files, command: flags.command, reason: need(flags.reason, '--reason') });
        print(flags, [flags.files ? `Task ${arg} now owns ${flags.files}.` : null, flags.command ? `Task ${arg} now verifies with: ${flags.command}` : null].filter(Boolean).join('\n'));
      } else throw new EccodeError('USAGE', `Unknown task subcommand ${sub}`);
      return 0;
    }
    case 'evidence': {
      if (sub === 'run') {
        // One argument is a shell command string; several arguments are an
        // argv vector whose quoting must survive (e.g. sh -c '<a && b>').
        const rest = args.rest || [];
        const command = need(rest.length === 1 ? rest[0] : rest.map(shellQuote).join(' '), 'command after --');
        const ev = evidence.runCommand(store, need(actor, '--actor'), {
          label: need(flags.label, '--label'),
          command,
          cwd: flags.cwd,
          gate: flags.gate,
          task: flags.task,
          purpose: flags.purpose || 'check',
          timeoutMs: flags.timeout ? Number(flags.timeout) * 1000 : undefined,
        });
        print(flags, `Evidence ev:${ev.id} — ${ev.status.toUpperCase()} (exit ${ev.exitCode}, ${ev.durationMs}ms)\n${ev.outputTail}`, ev);
        return 0;
      }
      if (sub === 'file') {
        const ev = evidence.recordFile(store, need(actor, '--actor'), { file: need(arg, '<path>'), label: flags.label, note: flags.note, gate: flags.gate, task: flags.task });
        print(flags, `Evidence ev:${ev.id} — ${ev.path} sha256=${ev.sha256.slice(0, 12)}…`, ev);
        return 0;
      }
      const state = store.state();
      if (sub === 'show') {
        const ev = state.evidence[need(arg, '<id>').replace(/^ev:/, '')];
        if (!ev) throw new EccodeError('NOT_FOUND', `No evidence ${arg}`);
        print(flags, ev);
        return 0;
      }
      if (sub === 'list') {
        const list = Object.values(state.evidence);
        print(flags, list.map((e) => `ev:${e.id} [${e.status}] ${e.kind} by ${e.recordedBy}: ${e.label}`).join('\n') || '(none)', list);
        return 0;
      }
      throw new EccodeError('USAGE', `Unknown evidence subcommand ${sub}`);
    }
    case 'handoff': {
      if (sub === 'draft') {
        const draft = require('../lib/quick').draftHandoff(store, need(flags.task, '--task'), need(actor, '--actor'));
        const text = JSON.stringify(draft, null, 2) + '\n';
        if (flags.out) {
          const out = path.resolve(root, flags.out);
          const rel = toPosix(path.relative(store.root, out));
          if (!/^\.eccode\/drafts\//.test(rel)) throw new EccodeError('USAGE', '--out must be under .eccode/drafts/ (the shared draft area)');
          ensureDir(path.dirname(out));
          fs.writeFileSync(out, text);
          process.stdout.write(`Draft written to ${rel}: fill in the TODO fields, then eccode task complete ${flags.task} --actor ${actor} --handoff ${rel}\n`);
        } else process.stdout.write(text);
        return 0;
      }
      if (sub !== 'record') throw new EccodeError('USAGE', 'Usage: eccode handoff record --file <handoff.json> | handoff draft --task <id> --actor <owner> [--out .eccode/drafts/<f>.json]');
      const id = tasks.recordHandoff(store, need(actor, '--actor'), loadJsonFile(need(flags.file, '--file')));
      print(flags, `Handoff ${id} recorded.`, { id });
      return 0;
    }
    case 'run': {
      if (sub === 'start') {
        const id = runs.startRun(store, config, need(actor, '--actor'), { task: flags.task, gate: flags.gate, agent: flags.for });
        print(flags, id, { id });
      } else if (sub === 'end') {
        const { state } = runs.endRun(store, config, need(arg, '<runId>'), need(actor, '--actor'), {
          status: flags.status || 'ok',
          costUsd: flags['cost-usd'],
          tokens: flags.tokens,
          note: flags.note,
        });
        print(flags, `Run ${arg} closed. Totals: $${state.totals.costUsd}, ${state.totals.runtimeMinutes} min, ${state.totals.tokens} tokens.`, state.totals);
      } else if (sub === 'correct') {
        const { state } = runs.correctRun(store, need(arg, '<runId>'), need(actor, '--actor'), { tokens: flags.tokens, costUsd: flags['cost-usd'], reason: need(flags.reason, '--reason') });
        print(flags, `Run ${arg} corrected. Totals: $${state.totals.costUsd}, ${state.totals.tokens} tokens.`, state.totals);
      } else throw new EccodeError('USAGE', `Unknown run subcommand ${sub}`);
      return 0;
    }
    case 'risk': {
      const fields = { id: need(flags.id, '--id'), title: flags.title, severity: flags.severity, mitigation: flags.mitigation, owner: flags.owner, status: flags.status || (sub === 'add' ? 'open' : undefined) };
      if (sub === 'update' && !fields.status) fields.status = store.state().risks[fields.id] ? store.state().risks[fields.id].status : 'open';
      runs.recordRisk(store, need(actor, '--actor'), fields);
      print(flags, `Risk ${fields.id} recorded (${fields.status}).`);
      return 0;
    }
    case 'decision': {
      const id = runs.recordDecision(store, need(actor, '--actor'), {
        title: flags.title,
        decision: flags.decision,
        rationale: flags.rationale,
        alternatives: flags.alternatives,
        lessons: flags.lesson || [],
      });
      print(flags, `Decision ${id} recorded.`, { id });
      return 0;
    }
    case 'metrics': {
      const m = require('../lib/memory/metrics').compute(store, config);
      print(flags, require('../lib/memory/metrics').format(m), m);
      return 0;
    }
    default:
      throw new EccodeError('USAGE', `Unknown command "${group}". Run eccode help.`);
  }
}

if (require.main === module) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (err) {
    if (err instanceof EccodeError) {
      process.stderr.write(`eccode: [${err.code}] ${err.message}\n`);
      if (err.details && err.details.recovery) process.stderr.write(`recovery: ${err.details.recovery}\n`);
      process.exitCode = err.code === 'USAGE' ? 1 : 2;
    } else {
      process.stderr.write(`eccode: internal error: ${err.stack || err}\n`);
      process.exitCode = 1;
    }
  }
}

module.exports = { main };
