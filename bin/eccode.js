#!/usr/bin/env node
'use strict';
// ECCode CLI. Exit codes: 0 success, 1 usage/internal error, 2 refused by a
// workflow rule (gate, ownership, budget, review validation).

const fs = require('fs');
const path = require('path');
const { parseArgs } = require('../lib/cli-args');
const { EccodeError, readJson } = require('../lib/util');

const HELP = `eccode — evidence-gated multi-agent delivery toolkit

Project
  init --name <n> --idea <text> [--track greenfield|feature|refactor|fix|quick]   Create .eccode/
  work start --track <t> --title <text> --actor <orchestrator|user> [--behavior <cmd>]
             [--owner <role> --files <glob,glob> --command <cmd>]     Start the next work item (quick needs owner/files/command)
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

Evidence & records
  evidence run --actor <a> --label <l> [--purpose check|reproduction] [--gate g] [--task t] -- <command...>
  evidence file <path> --actor <a> [--label l] [--note n]
  evidence list [--json] | evidence show <id>
  handoff record --actor <a> --file <handoff.json>
  run start --actor <agent> [--task t] [--gate g]       (prints run id)
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
  impact <file>... | --changed [--base <ref>] [--run --actor <a>]   Who depends on these files, affected tests; --run executes them
  map [--path <dir>] [--chars n]   What already exists (top-level names per directory): reuse before you write
  stack [--json]                   Detected stacks and their checks (project scripts first); * = required
  stack run <id|all> [--record --actor <a>]   Run a check; exit = the check's exit code
  stack adopt --checks <id,id> --actor user [--remove]   Make checks required at the verification gate
  debt [--json]                    Ledger of deferred shortcut markers in code, flagging those with no upgrade trigger

Benchmark
  bench --agent "<cmd>" [--tasks a,b] [--runs n] [--variant with|without|both] [--suite <dir>] [--out <file>] [--keep]
        Paired runs of an agent command (reads PROMPT.md in each sandbox) with and without the lean skill;
        hidden checks, lines, dependencies and tests are measured by the harness, never self-reported

Other
  metrics [--json]                 Rejection rate, repeat bugs, time-to-fix, recurrence, regressions, lean totals
  install --target <dir> [--scope project|user]   Copy agents/skills/commands/hooks into .claude/
  export agents-md [--out AGENTS.md]               Generic AGENTS.md for other harnesses

Global: --root <dir> (or ECCODE_ROOT), --actor <role> (or ECCODE_ACTOR, never for user), --json
`;

function shellQuote(arg) {
  return /^[A-Za-z0-9_\/.,:=@%+-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, "'\\''")}'`;
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
    const store = init(root, { name: need(flags.name, '--name'), idea: need(flags.idea, '--idea'), actor: actor || 'orchestrator', track: flags.track });
    print(flags, `Initialized ECCode project in ${store.dir}`, { root: store.root });
    return 0;
  }
  if (group === 'install') return require('../lib/install').cli(flags, print);
  if (group === 'export') return require('../lib/install').exportCli(sub, flags, print);

  const { store, config } = openProject(root);
  if (group === 'bench') {
    const bench = require('../lib/bench');
    const variants = flags.variant === 'with' ? ['with'] : flags.variant === 'without' ? ['without'] : ['without', 'with'];
    const { records, markdown } = bench.run({
      suite: flags.suite ? path.resolve(flags.suite) : undefined,
      agentCmd: need(flags.agent, '--agent'),
      tasks: flags.tasks ? String(flags.tasks).split(',').map((x) => x.trim()) : null,
      runs: Number(flags.runs || 1),
      variants,
      timeoutMs: flags.timeout ? Number(flags.timeout) * 1000 : undefined,
      keep: Boolean(flags.keep),
      onProgress: (m) => process.stderr.write(`bench: ${m}\n`),
    });
    if (flags.out) {
      require('../lib/util').writeFileAtomic(path.resolve(flags.out), markdown);
      process.stderr.write(`bench: report written to ${flags.out}\n`);
    }
    print(flags, markdown, records);
    return 0;
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
  if (group === 'impact') {
    const { impact } = require('../lib/codebase');
    const { gitChangedFiles } = require('../lib/project');
    const targets = flags.changed ? gitChangedFiles(root, flags.base || 'HEAD') : args._.slice(1);
    if (!targets || !targets.length) throw new EccodeError('USAGE', 'Usage: eccode impact <file>... | eccode impact --changed [--base <ref>]');
    const res = impact(root, targets);
    const max = Number(flags.max || 25);
    const text = [
      `Impact of ${res.targets.length} file(s): ${res.targets.join(', ')}${res.notIndexed.length ? `\n(not in the index, no dependents known: ${res.notIndexed.join(', ')})` : ''}`,
      `Dependents: ${res.dependents.length} file(s) in module(s) ${res.modules.join(', ') || '-'}`,
      ...res.dependents.slice(0, max).map((d) => `  ${'  '.repeat(d.distance - 1)}${d.file} (distance ${d.distance})`),
      res.dependents.length > max ? `  … ${res.dependents.length - max} more (--max ${res.dependents.length})` : null,
      res.tests.length ? `Affected tests (run these): ${res.tests.join(' ')}` : 'WARNING: no affected test file found in the index for this change.',
      res.dynamicCallers.length ? `Note: ${res.dynamicCallers.length} file(s) use dynamic module loading and may also be affected (static analysis cannot tell): ${res.dynamicCallers.slice(0, 8).join(', ')}${res.dynamicCallers.length > 8 ? ', …' : ''}` : null,
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
      const sum = status.summary(store.state(), config);
      if (flags.brief) print({}, status.formatBrief(sum));
      else print(flags, status.formatBrief(sum) + '\n\n' + JSON.stringify(sum.gates, null, 2), sum);
      return 0;
    }
    case 'resume': {
      const state = store.state();
      const sum = status.summary(state, config);
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
      if (sub !== 'record') throw new EccodeError('USAGE', 'Usage: eccode handoff record --file <handoff.json>');
      const id = tasks.recordHandoff(store, need(actor, '--actor'), loadJsonFile(need(flags.file, '--file')));
      print(flags, `Handoff ${id} recorded.`, { id });
      return 0;
    }
    case 'run': {
      if (sub === 'start') {
        const id = runs.startRun(store, config, need(actor, '--actor'), { task: flags.task, gate: flags.gate });
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
