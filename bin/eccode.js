#!/usr/bin/env node
'use strict';
// ECCode CLI. Exit codes: 0 success, 1 usage/internal error, 2 refused by a
// workflow rule (gate, ownership, budget, review validation).

const fs = require('fs');
const path = require('path');
const { parseArgs } = require('../lib/cli-args');
const { EccodeError, readJson, own } = require('../lib/util');

const HELP = `eccode — evidence-gated multi-agent delivery toolkit

Project
  init --name <n> --idea <text> [--profile delivery|change]
                                         Create .eccode/ (change: plan -> phases for a change request)
  status [--json|--brief]                Gates, tasks, budget and the next action
  resume                                 Resume brief for a new session, with read-only reconciliation
  reconcile --actor <a> [--verify] [--max-checks n]
                                         Check the record against files (and re-run recorded checks); exit 3 on blocking issues
  recover [--all] --actor orchestrator|user   Close interrupted runs, release their claims
  audit                                  Verify the hash chain, snapshot==replay, and approved artifacts
  rebuild [--force --actor user]         Rewrite state.json by replaying events.jsonl
                                         (--force: the user accepts a rolled-back log, LOG_ROLLBACK)
  deliver --actor delivery-lead          Produce the verified final handoff

Templates
  template review|plan|handoff|lesson   Print a valid JSON skeleton to start from (it validates as printed)

Gates (architecture, design, plan, phase:<id>, verification)
  gate start <gate> --actor <role>
  gate submit <gate> --actor <role> --artifact <path>... [--responds-to <reviewId>] [--notes <text>]
  gate review <gate> --actor <reviewer> --file <review.json>
  gate reopen <gate> --actor user --resolution <text> [--waive all|F1,F2]
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
  rework open --actor orchestrator|user --reason <text> --files <glob>... --owner <role> [--evidence ev:<id>]...
                                         A defect found after approval or delivery: opens phase:rework-N with one scoped task
  run start --actor <role|orchestrator> [--agent <role>] [--task t] [--gate g]   (prints run id; the orchestrator opens runs for the role it dispatches)
  run end <runId> --actor orchestrator --status ok|failed (--tokens n [--cost-usd x] | --no-usage) [--note n]
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
  memory assess <id> --actor <a> --verdict applies|does-not-apply --reason <text> --evidence ev:<id> [...]
                                             Does a retrieved lesson fit THIS problem's cause? (needs an experiment)
  memory cite <id> --actor <a> --context <text>
  memory env                                  Show the detected environment
  memory status                               Learning on/off and record counts (ECCODE_LEARNING=on|off)

Self-improvement
  improve propose --file <proposal.json> --actor <a>
  improve evaluate <id> --actor <a> --variant baseline|candidate -- <command...>
  improve review <id> --actor <reviewer> --decision approve|reject --notes <text>
  improve adopt <id> --actor user|orchestrator
  improve rollback <id> --actor user|orchestrator --reason <text> [--regression]
  improve list

Other
  metrics [--json]                 Rejection rate, repeat bugs, time-to-fix, recurrence, regressions
  install --target <dir> [--scope project|user]   Copy agents/skills/commands/hooks into .claude/
  export agents-md [--out AGENTS.md]               Generic AGENTS.md for other harnesses

Global: --root <dir> (or ECCODE_ROOT), --actor <role> (or ECCODE_ACTOR), --json
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
  if (value === undefined || value === true || value === '') throw new EccodeError('USAGE', `Missing required ${name}`);
  return value;
}

/** A numeric flag (undefined when absent); malformed values are a usage error, not a crash or a silent NaN. */
function numberFlag(flags, name, { min = 0, integer = false } = {}) {
  const v = flags[name];
  if (v === undefined) return undefined;
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  if (!Number.isFinite(n) || n < min || (integer && !Number.isInteger(n))) {
    throw new EccodeError('USAGE', `--${name} expects ${integer ? 'a whole number' : 'a number'} >= ${min} (got ${JSON.stringify(v)})`);
  }
  return n;
}

// Positional arguments (group, subcommand, argument) each command takes.
// Extra ones are refused rather than dropped: `--artifact a.md b/*.md` must
// not silently submit only a.md.
const POSITIONALS = {
  init: 1, install: 1, template: 2, status: 1, resume: 1, reconcile: 1, recover: 1, rebuild: 1, audit: 1, deliver: 1, metrics: 1,
  export: 2, handoff: 2, risk: 2, decision: 2,
  gate: 3, plan: 3, task: 3, rework: 2, evidence: 3, run: 3, memory: 3, improve: 3,
  'task list': 2, 'task next': 2, 'evidence run': 2, 'evidence list': 2, 'run start': 2,
  'memory status': 2, 'memory add': 2, 'memory list': 2, 'memory duplicates': 2, 'memory env': 2, 'improve propose': 2, 'improve list': 2,
};

function checkPositionals(positionals) {
  const [group, sub] = positionals;
  const max = POSITIONALS[`${group} ${sub}`] || POSITIONALS[group];
  if (max && positionals.length > max) {
    throw new EccodeError('USAGE', `Unexpected argument(s): ${positionals.slice(max).join(' ')} (repeat a flag for each value, e.g. --artifact a.md --artifact b.md; quote multi-word values)`);
  }
}

function print(flags, human, json) {
  if (flags.json) process.stdout.write(JSON.stringify(json === undefined ? human : json, null, 2) + '\n');
  else process.stdout.write((typeof human === 'string' ? human : JSON.stringify(human, null, 2)) + '\n');
}

let projectRoot = null;

/** JSON input: resolved from the current directory, then from the project root; missing is a clean refusal. */
function loadJsonFile(file) {
  const candidates = [path.resolve(file)];
  if (projectRoot && !path.isAbsolute(file)) candidates.push(path.resolve(projectRoot, file));
  const found = candidates.find((c) => fs.existsSync(c));
  if (!found) throw new EccodeError('NOT_FOUND', `File not found: ${file}`);
  return readJson(found);
}

function main(argv) {
  const args = parseArgs(argv);
  const { flags } = args;
  const [group, sub, arg] = args._;
  if (!group || flags.help || group === 'help') {
    process.stdout.write(HELP);
    return 0;
  }
  checkPositionals(args._);
  const root = findRoot(flags);
  projectRoot = root;
  const actor = flags.actor || process.env.ECCODE_ACTOR;
  const { openProject, init } = require('../lib/project');

  if (group === 'init') {
    const store = init(root, { name: need(flags.name, '--name'), idea: need(flags.idea, '--idea'), actor: actor || 'orchestrator', profile: flags.profile || 'delivery' });
    print(flags, `Initialized ECCode project in ${store.dir}`, { root: store.root });
    return 0;
  }
  if (group === 'template') {
    process.stdout.write(JSON.stringify(require('../lib/templates').template(need(sub, '<review|plan|handoff|lesson>')), null, 2) + '\n');
    return 0;
  }
  if (group === 'install') return require('../lib/install').cli(flags, print);
  if (group === 'export') return require('../lib/install').exportCli(sub, flags, print);

  const { store, config } = openProject(root);
  const memoryGroups = { memory: '../lib/memory/cli', improve: '../lib/memory/improve-cli' };
  if (memoryGroups[group]) return require(memoryGroups[group]).run({ store, config, sub, arg, flags, rest: args.rest, actor, print, need, numberFlag, loadJsonFile, root });
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
      const { inspect, formatIssues } = require('../lib/reconcile');
      const issues = inspect(store, state); // read-only: resume never writes to the record
      const text = [status.formatBrief(sum), formatIssues(issues), lastHandoffs.length ? 'Recent handoffs:\n' + lastHandoffs.join('\n') : ''].filter(Boolean).join('\n');
      print(flags, text, { ...sum, reconcile: issues, recentHandoffs: lastHandoffs });
      return 0;
    }
    case 'reconcile': {
      const { reconcile, formatIssues } = require('../lib/reconcile');
      const rep = reconcile(store, config, need(actor, '--actor'), { verify: Boolean(flags.verify), maxChecks: numberFlag(flags, 'max-checks', { min: 1, integer: true }) });
      const checks = rep.checks.map((c) => `- re-ran ev:${c.previous} → ev:${c.rerun} ${c.status.toUpperCase()}: ${c.command}`);
      print(flags, [formatIssues(rep.issues), checks.length ? `Checks re-run:\n${checks.join('\n')}` : rep.verified ? 'Checks re-run: none recorded' : 'Checks not re-run (add --verify).'].join('\n'), rep);
      return rep.ok ? 0 : 3;
    }
    case 'recover': {
      const rec = runs.recover(store, config, { all: Boolean(flags.all), actor: need(actor, '--actor') });
      print(flags, rec.length ? rec.map((r) => `recovered run ${r.run || '-'} (${r.agent}) task=${r.task || '-'} released=${r.released}${r.escalated ? ' ESCALATED' : ''}`).join('\n') : 'Nothing to recover.', rec);
      return 0;
    }
    case 'rebuild': {
      const st = store.rebuildSnapshot({ force: Boolean(flags.force), actor });
      print(flags, `Snapshot rebuilt from ${st.seq} events.`, { seq: st.seq });
      return 0;
    }
    case 'audit': {
      const res = store.audit();
      // Replay, not the snapshot: audit must work (and report) on a rolled-back log.
      const all = require('../lib/delivery').unreviewedChanges(store.rebuild(), store.root);
      // A change already submitted for review in a later gate is normal flow (a warning); an edit no
      // gate has seen is an audit failure. Delivery stays strict about both.
      const changes = all.filter((c) => !c.pending);
      const pending = all.filter((c) => c.pending);
      const ok = res.ok && !changes.length;
      const warn = pending.length ? `\nPending re-review (not failures):\n- ${pending.map((c) => `${c.path} ${c.problem} (approved at ${c.gate})`).join('\n- ')}` : '';
      print(flags, ok ? `Audit OK: ${res.events} events, chain intact, approved artifacts unchanged.${warn}` : `Audit FAILED:\n- ${[...res.errors, ...changes.map((c) => `${c.path} ${c.problem} (${c.gate})`)].join('\n- ')}${warn}`, { ...res, unreviewedChanges: changes, pendingReview: pending, ok });
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
        gates.reopenGate(store, gateId, need(actor, '--actor'), need(flags.resolution, '--resolution'), { waive: flags.waive });
        const left = store.state().gates[gateId].openFindings;
        print(flags, `Gate ${gateId} reopened by user decision.${left.length ? ` Still open (the next approval must resolve them with evidence): ${left.map((f) => f.id).join(', ')}.` : ''}`);
      } else if (sub === 'show') {
        const g = own(store.state().gates, gateId);
        if (!g) throw new EccodeError('UNKNOWN_GATE', `Unknown gate ${gateId}`);
        const toJudge = require('../lib/lessons').decisionsToJudge(store.state(), gateId);
        print(flags, toJudge.length ? { ...g, lessonDecisionsToJudge: toJudge } : g);
      } else throw new EccodeError('USAGE', `Unknown gate subcommand ${sub}`);
      return 0;
    }
    case 'plan': {
      if (sub !== 'validate') throw new EccodeError('USAGE', 'Usage: eccode plan validate <plan.json>');
      const plan = loadJsonFile(need(arg, '<plan.json>'));
      const errors = tasks.validatePlan(plan, config);
      const warnings = errors.length
        ? []
        : [
            ...tasks.ownershipConflicts(plan.tasks).map(([a, b]) => `${a} and ${b} may run in parallel but share file ownership (they will be serialized)`),
            ...tasks.recordGlobWarnings(plan.tasks),
          ];
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
        const lessons = require('../lib/lessons').renderForClaim(store, config, event.data.lessons || []);
        print(flags, `Claimed ${arg} (base ${event.data.baseCommit || 'no git'}).${lessons}`, event.data);
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
          timeoutMs: flags.timeout === undefined ? undefined : Math.round(numberFlag(flags, 'timeout', { min: 1 }) * 1000),
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
        const ev = own(state.evidence, need(arg, '<id>').replace(/^ev:/, ''));
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
        const id = runs.startRun(store, config, need(actor, '--actor'), { task: flags.task, gate: flags.gate, agent: flags.agent });
        print(flags, id, { id });
      } else if (sub === 'end') {
        const { state } = runs.endRun(store, config, need(arg, '<runId>'), need(actor, '--actor'), {
          status: flags.status || 'ok',
          costUsd: flags['cost-usd'],
          tokens: flags.tokens,
          note: flags.note,
          noUsage: Boolean(flags['no-usage']),
        });
        print(flags, `Run ${arg} closed. Totals: $${state.totals.costUsd}, ${state.totals.runtimeMinutes} min, ${state.totals.tokens} tokens.`, state.totals);
      } else if (sub === 'correct') {
        const { state } = runs.correctRun(store, need(arg, '<runId>'), need(actor, '--actor'), { tokens: flags.tokens, costUsd: flags['cost-usd'], reason: need(flags.reason, '--reason') });
        print(flags, `Run ${arg} corrected. Totals: $${state.totals.costUsd}, ${state.totals.tokens} tokens.`, state.totals);
      } else throw new EccodeError('USAGE', `Unknown run subcommand ${sub}`);
      return 0;
    }
    case 'rework': {
      if (sub !== 'open') throw new EccodeError('USAGE', 'Usage: eccode rework open --actor orchestrator --reason <text> --files <glob>... --owner <role> [--evidence ev:<id>]... [--title <text>]');
      const rw = require('../lib/rework').openRework(store, config, need(actor, '--actor'), { reason: flags.reason, files: [].concat(flags.files || []), owner: flags.owner, evidence: [].concat(flags.evidence || []), title: flags.title });
      const { id, gate } = rw;
      print(flags, `Rework ${id} opened: gate ${gate} is in progress with task ${id} owned by ${flags.owner}. Dispatch the owner (claim the task, add a failing regression test, fix, complete), then submit and independently review ${gate}, then eccode deliver again.`, { id, gate, task: id });
      return 0;
    }
    case 'risk': {
      const fields = { id: need(flags.id, '--id'), title: flags.title, severity: flags.severity, mitigation: flags.mitigation, owner: flags.owner, status: flags.status || (sub === 'add' ? 'open' : undefined) };
      if (sub === 'update' && !fields.status) fields.status = own(store.state().risks, fields.id) ? own(store.state().risks, fields.id).status : 'open';
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
