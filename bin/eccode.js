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
  gate start <gate> --actor <role> [--reviewers r1,r2]   (orchestrator: each named reviewer must approve)
  gate submit <gate> --actor <role> --artifact <path>... [--responds-to <reviewId>] [--notes <text>]
  gate review <gate> --actor <reviewer> --file <review.json>
  gate reopen <gate> --actor user --resolution <text>        (headless: --actor orchestrator reopens an approved gate whose artifacts changed after approval)
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
  evidence run --actor <a> --label <l> [--purpose check|reproduction] [--gate g] [--task t] [--timeout <s>] -- <command...>
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
  memory draft --task <id> --actor <owner> [--out .eccode/drafts/<f>.json]   A debugging lesson drafted from the fix's record
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
  stack run <id|all> [--timeout <s>] [--record --actor <a>]   Run a check (default 600 s); exit = the check's exit code
  stack adopt --checks <id,id> --actor user [--remove]   Make checks required at the verification gate
  debt [--json]                    Ledger of deferred shortcut markers in code, flagging those with no upgrade trigger

Debugging Lab (debug and fix tracks; see docs/debugging-lab.md)
  debug repro --actor <owner> [--task t] [--replace --reason <t> (orchestrator|user)] -- <command>
                                   Run the reproduction and pin it: it must fail; the proof must run this command
  debug hypothesis add "<statement>" --if-true "<obs>" --if-false "<obs>" --actor <owner>
  debug hypothesis test <id> [--supports|--refutes|--inconclusive] --actor <owner> -- <command>
                                   Run a discriminating command; the artifact is the evidence (mark it afterwards if no verdict was given)
  debug hypothesis mark <evidenceId> --supports|--refutes|--inconclusive --actor <owner>
  debug hypothesis close <id> --status confirmed|refuted|withdrawn --actor <owner>   (confirmed needs executed supports evidence)
  debug hypothesis challenge <id> --evidence <evidenceId> --reason <t> --actor <reviewer>
  debug localize --sbfl [--tests <paths>] [--top 5] [--python <bin>] --actor <owner>   Ochiai ranking from per-test coverage (pytest)
  debug bisect --good <ref> [--bad HEAD] --actor <owner>                           git bisect run with the pinned reproduction, in a worktree
  debug trace <id> --at <file:line> --expr <expr> --actor <owner>                  A temporary probe logs the expression during the reproduction, then is reverted
  debug rootcause --hypothesis <id> --at <file:line>[,..] --explain <t> --why-repro-fails <t> --actor <owner>
  debug escalate --kind rescope|ask-user --reason <t> [--reading <t>] --actor <owner|orchestrator>   Required once the hypothesis budget is spent (headless, ask-user carries the assumed answer)
  debug show [--json]

Behavior diff (fix, feature and refactor tracks; see docs/behavior-diff.md)
  behavior route --actor <role>              Record whether the change reaches a public surface (then the diff must run)
  design alternatives --file <options.json> --actor <designer>   Phase 3: >= 2 options, each with complexity, risk, performance, security, reversibility
  design decide --file <decision.json> --actor <designer>        {alternatives, chosen, rationale, rejected: [{option, why}], interfaces: [{surface, target}]}
  design adr [--decision <id>] --actor <designer>                Render the ADR (.eccode/design/<id>.md); the verification reviewer cites it
  design spike start --question <q> --paths <a,b> | spike close <id> --proved <t>   A throwaway prototype; never delivered
  design amend --decision <id> --file <interfaces.json> --reason <t> --actor <reviewer>
  request ambiguity --file <questions.json> --actor orchestrator  [{id, text, blocking}] ; planning stops on a blocking one
  request clarify <id> --answer <t> --actor user | request assume <id> --reading <t> --rationale <t> --actor orchestrator
  guard route --actor <owner>                Phase 3: which production guards this change needs (migration, api, perf, race, security, release)
  guard migration [--proof] --actor <owner>  Static analysis of the change's migrations; --proof: seed, upgrade → downgrade → upgrade, schema compared
  guard api --actor <owner>                  OpenAPI and Python signatures, baseline vs candidate: breaking | additive | none
  guard perf --actor <owner>                 Micro-benchmark of the change's routes in both worktrees; queries per request (N+1)
  guard race --actor <owner>                 The configured operations under concurrency; invariants checked (.eccode/guards.json)
  guard release --strategy flag|staged --monitoring <t> --rollback <t> [--flag n | --rollout t] --actor delivery-lead; guard release ack <id> --actor <reviewer>
  guard waive --guard <g> --result <id> --finding <f> --reason <t> --actor <reviewer> | guard show
  security policy --file <cells.json> --actor security-reviewer   Phase 3: role x endpoint x ownership -> allow|deny
  security matrix | idor | authflow | input --actor <owner>        Executed access-control probes against the app (.eccode/security.json)
  standards show [--limit n] | standards extract --actor <role>   Phase 3: the team's observed conventions (git history, configs); never enforced; shown at onboard
  plan contracts --file <contracts.json> --actor <designer>   Phase 3: interfaces agreed before implementation; a rescope cites the contract it changes
  plan checkpoint --evidence ev:<id>,... --actor orchestrator  An integration checkpoint after every N tasks; a task over budget needs task waive-budget
  task waive-budget <task> --reason <t> --actor orchestrator   Allow one task over the file/line budget
  task rescope <task> [--files g,g] [--command c] --contract <id|none> --reason <t>   (the contract citation is required when the plan declared contracts)
  behavior contract --file <entries.json> --actor <author>   Declare the intended behaviour changes, before the diff runs
  behavior diff [--runs 2] [--python <bin>] --actor <owner|reviewer>
                                   Baseline and candidate worktrees run the same probes (HTTP from OpenAPI per role,
                                   functions with Hypothesis); differences are classified against the contract.
                                   Exit 2 on an unexplained difference or insufficient coverage
  behavior amend --result <id> --file <entries.json> --reason <t> --actor <reviewer>   Explain a difference after the fact (reviewer only)
  behavior waive --result <id> --reason <t> --actor <reviewer>                         Accept insufficient coverage (reviewer only)
  behavior show [--json]

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
  bench --agent "<cmd>" [--tasks a,b] [--runs n] [--variant with|without|method|engine|debug|both|all|<a,b>] [--suite <dir>] [--concurrency 1|2]
        [--engine-profile guard|no-shell|sandbox] [--engine-agents inherit|as-shipped] [--timeout <s>] [--out <file>]
        [--chain]: one sandbox and record across the suite's items in order (task.order), synced to each
        item's source between them; --runs counts chains. [--max-cost <usd>]: stop before the next run once
        the runs of this process have reported that much. [--transcripts <dir>]: copy each run's Claude Code
        session files there (keep it outside the repository: they quote the code the agent read)
        [--save <runs.jsonl>] [--keep]
  bench report <runs.jsonl> --agent "<cmd>" [--out <file>]   Rebuild a report from runs saved with --save
  bench resume <runs.jsonl> [--agent "<cmd>"] [--concurrency 1|2]   Continue a batch a restart killed. With a batch
        header (written by --save) the file carries its plan: cut runs are recorded and re-run, finished ones kept; an
        older file is resumed by count with the same flags as bench. --max-cost stays a total budget across the resume.
        Refuses a 3rd concurrent stream on this host (cap 2) unless --force
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

const LAB_SUBCOMMANDS = new Set(['repro', 'hypothesis', 'localize', 'bisect', 'trace', 'rootcause', 'escalate', 'show']);

/** eccode debug <repro|hypothesis|localize|bisect|trace|rootcause|escalate|show>: the Debugging Lab. */
function labCli({ root, sub, arg, args, flags, actor, print }) {
  const { openProject } = require('../lib/project');
  const { store, config } = openProject(root);
  store.assertInitialized();
  const lab = require('../lib/lab');
  const rest = args.rest || [];
  const command = () => need(rest.length === 1 ? rest[0] : rest.map(shellQuote).join(' '), 'command after --');
  if (sub === 'show') {
    print(flags, lab.show(store.state()), store.state().lab);
    return 0;
  }
  if (sub === 'repro') {
    const r = lab.recordRepro(store, config, need(actor, '--actor'), { command: command(), cwd: flags.cwd, task: flags.task, timeoutMs: timeoutOf(flags), replace: Boolean(flags.replace), reason: flags.reason, python: flags.python });
    print(flags, `Reproduction pinned: ${r.repro.id} — ${r.repro.command} failed with exit ${r.repro.exitCode} (ev:${r.evidence.id}). The proof must run this command.\n${r.evidence.outputTail}`, r);
    return 0;
  }
  if (sub === 'hypothesis') {
    const action = arg;
    if (action === 'add') {
      const statement = args._[3];
      const h = lab.openHypothesis(store, config, need(actor, '--actor'), { statement: need(statement, '"<statement>"'), ifTrue: need(flags['if-true'], '--if-true'), ifFalse: need(flags['if-false'], '--if-false') });
      print(flags, `Hypothesis ${h.id} opened: ${h.statement}\n  if true: ${h.ifTrue}\n  if false: ${h.ifFalse}\nTest it: eccode debug hypothesis test ${h.id} --actor ${actor} [--supports|--refutes] -- <command>`, h);
      return 0;
    }
    const id = need(args._[3], '<hypothesis id>');
    if (action === 'test') {
      const verdict = flags.supports ? 'supports' : flags.refutes ? 'refutes' : flags.inconclusive ? 'inconclusive' : undefined;
      const e = lab.testHypothesis(store, config, need(actor, '--actor'), { hypothesis: id, command: command(), verdict, note: flags.note, cwd: flags.cwd, task: flags.task, timeoutMs: timeoutOf(flags) });
      const ev = store.state().evidence[e.evidence];
      print(flags, `Evidence ${e.id} for ${id}: exit ${e.exitCode} (ev:${e.evidence}), verdict ${e.verdict}${e.verdict === 'pending' ? ` — read the output, then: eccode debug hypothesis mark ${e.id} --supports|--refutes|--inconclusive --actor ${actor}` : ''}\n${ev ? ev.outputTail : ''}`, e);
      return 0;
    }
    if (action === 'mark') {
      const verdict = flags.supports ? 'supports' : flags.refutes ? 'refutes' : flags.inconclusive ? 'inconclusive' : need(undefined, '--supports | --refutes | --inconclusive');
      const e = lab.markEvidence(store, config, need(actor, '--actor'), { evidence: id, verdict, note: flags.note });
      print(flags, `Evidence ${id} marked ${verdict}.`, e);
      return 0;
    }
    if (action === 'close') {
      const h = lab.closeHypothesis(store, config, need(actor, '--actor'), { hypothesis: id, status: need(flags.status, '--status confirmed|refuted|withdrawn') });
      print(flags, `Hypothesis ${id} closed: ${h.status}${h.evidence.length ? ` on ${h.evidence.join(', ')}` : ''}.`, h);
      return 0;
    }
    if (action === 'challenge') {
      const c = lab.challengeEvidence(store, config, need(actor, '--actor'), { evidence: need(flags.evidence, '--evidence <hypothesis evidence id>'), reason: need(flags.reason, '--reason') });
      print(flags, `Evidence ${c.evidence} of ${c.hypothesis} challenged; it no longer supports a confirmation.`, c);
      return 0;
    }
    throw new EccodeError('USAGE', 'Usage: eccode debug hypothesis add "<statement>" --if-true <obs> --if-false <obs> | test <id> [--supports|--refutes|--inconclusive] -- <cmd> | mark <evidenceId> --supports|--refutes|--inconclusive | close <id> --status confirmed|refuted|withdrawn | challenge <id> --evidence <evidenceId> --reason <text>');
  }
  if (sub === 'localize') {
    if (!flags.sbfl) throw new EccodeError('USAGE', 'Usage: eccode debug localize --sbfl [--tests <path,path>] [--top n] [--python <bin>] --actor <owner>');
    const r = lab.localizeSbfl(store, config, need(actor, '--actor'), { tests: flags.tests, top: flags.top, python: flags.python, task: flags.task, timeoutMs: timeoutOf(flags) });
    print(flags, [`SBFL (Ochiai) over ${r.totals.failing} failing and ${r.totals.passing} passing test(s), ${r.totals.linesScored} line(s) scored (ev:${r.evidence}; ${r.artifact}):`, ...(r.suspects.length ? r.suspects.map((x, i) => `  ${i + 1}. ${x.file}:${x.line}  score ${x.score}  (failing ${x.ef}, passing ${x.ep})`) : [r.status === 'no-failing-test' ? '  no test failed in this run: the reproduction did not fail under coverage, so nothing can be ranked' : '  no code line is reached only by failing tests'])].join('\n'), r);
    return 0;
  }
  if (sub === 'bisect') {
    const r = lab.bisect(store, config, need(actor, '--actor'), { good: need(flags.good, '--good <ref>'), bad: flags.bad, task: flags.task, timeoutMs: timeoutOf(flags) });
    print(flags, r.suspects.length ? `First bad commit: ${r.suspects[0].commit} — ${r.suspects[0].subject} (ev:${r.evidence}; diff in ${r.artifact})` : `bisect found no first bad commit between ${r.good.slice(0, 12)} and ${r.bad.slice(0, 12)} (ev:${r.evidence}): ${r.problem || 'check that the reproduction passes at --good'}`, r);
    return 0;
  }
  if (sub === 'trace') {
    const r = lab.trace(store, config, need(actor, '--actor'), { hypothesis: need(arg, '<hypothesis id>'), at: need(flags.at, '--at <file:line>'), expr: need(flags.expr, '--expr <expression>'), task: flags.task, timeoutMs: timeoutOf(flags) });
    print(flags, [`Trace ${r.id} for ${r.hypothesis} at ${r.trace.file}:${r.trace.line} (probe reverted; ev:${r.evidence}): ${r.trace.expr} observed ${r.trace.observed} time(s)`, ...r.values.slice(0, 20).map((v) => `  ${v}`), r.values.length > 20 ? `  … ${r.values.length - 20} more in the evidence log` : null, `Mark it: eccode debug hypothesis mark ${r.id} --supports|--refutes|--inconclusive --actor ${actor}`].filter(Boolean).join('\n'), r);
    return 0;
  }
  if (sub === 'rootcause') {
    const r = lab.declareRootCause(store, config, need(actor, '--actor'), { hypothesis: need(flags.hypothesis, '--hypothesis <id>'), locations: flags.at, explanation: need(flags.explain, '--explain'), whyReproFails: need(flags['why-repro-fails'], '--why-repro-fails') });
    print(flags, `Root cause declared on ${r.hypothesis} at ${r.locations.join(', ')}. The fix may now be completed.`, r);
    return 0;
  }
  if (sub === 'escalate') {
    const r = lab.escalate(store, config, need(actor, '--actor'), { kind: need(flags.kind, '--kind rescope|ask-user'), reason: need(flags.reason, '--reason'), reading: flags.reading, rationale: flags.rationale });
    print(flags, `Escalation recorded (${r.kind}) after ${r.refuted} refuted hypothesis(es). Another hypothesis may be opened once the scope or the question is settled.`, r);
    return 0;
  }
  throw new EccodeError('USAGE', `Unknown debug subcommand ${sub}`);
}

/** eccode design <alternatives|decide|adr|spike|amend|show>: design before code (Phase 3). */
function designCli({ root, sub, arg, flags, actor, print, loadJsonFile }) {
  const { openProject } = require('../lib/project');
  const { store, config } = openProject(root);
  store.assertInitialized();
  const design = require('../lib/design');
  if (sub === 'show') {
    print(flags, design.show(store.state()), store.state().design);
    return 0;
  }
  if (sub === 'alternatives') {
    const a = design.alternatives(store, config, need(actor, '--actor'), loadJsonFile(need(flags.file, '--file <options.json>')));
    print(flags, `Design alternatives ${a.id} recorded: ${a.options.map((o) => o.id).join(', ')}. Next: eccode design decide --file decision.json --actor ${actor}`, a);
    return 0;
  }
  if (sub === 'decide') {
    const d = design.decide(store, config, need(actor, '--actor'), loadJsonFile(need(flags.file, '--file <decision.json>')));
    print(flags, `Design decision ${d.id}: ${d.chosen} (${d.rejected.length} rejected). Next: eccode design adr --actor ${actor}`, d);
    return 0;
  }
  if (sub === 'adr') {
    const a = design.adr(store, config, need(actor, '--actor'), { decision: flags.decision });
    print(flags, `ADR ${a.id} rendered: ${a.artifact} (sha256 ${a.artifactSha256.slice(0, 12)}); the verification reviewer cites artifact:${a.artifact}`, a);
    return 0;
  }
  if (sub === 'amend') {
    const a = design.amend(store, config, need(actor, '--actor'), { decision: need(flags.decision, '--decision <id>'), interfaces: loadJsonFile(need(flags.file, '--file <interfaces.json>')), reason: need(flags.reason, '--reason') });
    print(flags, `Decision ${a.decision} amended (${a.id}): ${a.interfaces.map((i) => `${i.surface} ${i.target}`).join(', ')}`, a);
    return 0;
  }
  if (sub === 'spike') {
    const [op, id] = [arg, args._[3]];
    if (op === 'start') {
      const s = design.spikeStart(store, config, need(actor, '--actor'), { question: need(flags.question, '--question'), paths: need(flags.paths, '--paths <a,b>') });
      print(flags, `Spike ${s.id} started on ${s.paths.join(', ')}: ${s.question}. Its code is discarded, never delivered; close it with what it proved.`, s);
      return 0;
    }
    if (op === 'close') {
      const s = design.spikeClose(store, config, need(actor, '--actor'), need(id, 'spike id'), { proved: need(flags.proved, '--proved') });
      print(flags, `Spike ${s.id} closed (${Object.keys(s.fileHashes).length} file(s) hashed): ${s.proved}. Remove its files before completing the task.`, s);
      return 0;
    }
  }
  throw new EccodeError('USAGE', 'eccode design alternatives --file <options.json> | decide --file <decision.json> | adr [--decision <id>] | amend --decision <id> --file <interfaces.json> --reason <t> | spike start --question <q> --paths <a,b> | spike close <id> --proved <t> | show');
}

/** eccode request <ambiguity|clarify|assume|show>: the ambiguity stop (Phase 3). */
function requestCli({ root, sub, arg, flags, actor, print, loadJsonFile }) {
  const { openProject } = require('../lib/project');
  const { store, config } = openProject(root);
  store.assertInitialized();
  const design = require('../lib/design');
  if (sub === 'show') {
    const open = design.openQuestions(store.state(), true);
    print(flags, open.length ? open.map((q) => `${q.id}${q.blocking ? ' (blocking)' : ''}: ${q.text}`).join('\n') : 'No open question.', { open });
    return 0;
  }
  if (sub === 'ambiguity') {
    const a = design.ambiguity(store, config, need(actor, '--actor'), loadJsonFile(need(flags.file, '--file <questions.json>')));
    const blocking = a.questions.filter((q) => q.blocking);
    print(flags, `Ambiguity ${a.id} recorded: ${a.questions.length} question(s), ${blocking.length} blocking.${blocking.length ? ' Planning is refused until each blocking one is clarified by the user or assumed with a recorded reading.' : ''}${a.assumed && a.assumed.length ? ` Headless: ${a.assumed.map((x) => `${x.question} assumed "${x.reading}"`).join('; ')} (not confirmed by the user; shown in every handoff and the report).` : ''}`, a);
    return 0;
  }
  if (sub === 'clarify') {
    const c = design.clarify(store, config, need(actor, '--actor'), { question: need(arg, 'question id'), answer: need(flags.answer, '--answer') });
    print(flags, `Question ${c.question} clarified by the user.`, c);
    return 0;
  }
  if (sub === 'assume') {
    const a = design.assume(store, config, need(actor, '--actor'), { question: need(arg, 'question id'), reading: need(flags.reading, '--reading'), rationale: need(flags.rationale, '--rationale') });
    print(flags, `Question ${a.question} assumed (not confirmed by the user): ${a.reading}. Every handoff and the final report show it.`, a);
    return 0;
  }
  throw new EccodeError('USAGE', 'eccode request ambiguity --file <questions.json> | clarify <id> --answer <t> --actor user | assume <id> --reading <t> --rationale <t> --actor orchestrator | show');
}

/** eccode guard <route|migration|api|perf|race|release|waive|show>: production guards (Phase 3). */
function guardCli({ root, sub, arg, args, flags, actor, print, loadJsonFile }) {
  const { openProject } = require('../lib/project');
  const { store, config } = openProject(root);
  store.assertInitialized();
  const guards = require('../lib/guards');
  const opts = { task: flags.task, timeoutMs: timeoutOf(flags), python: flags.python };
  if (sub === 'show') {
    print(flags, guards.show(store.state()), store.state().guards);
    return 0;
  }
  if (sub === 'route') {
    const r = guards.route(store, config, need(actor, '--actor'));
    print(flags, `Guard routing ${r.id}: ${r.required.length ? r.required.map((g) => `${g} (${r.reasons[g]})`).join('; ') : 'no guard required'}${r.required.length ? '\nRun each before the last gate: eccode guard <name> --actor <owner>' : ''}`, r);
    return 0;
  }
  if (sub === 'migration') {
    const m = require('../lib/guards/migration');
    if (flags.proof) {
      const p = m.proof(store, config, need(actor, '--actor'), opts);
      print(flags, `Rollback proof ${p.id}: ${p.roundTrip ? 'the schema round-trips (upgrade → downgrade → upgrade)' : 'FAILED: the schema differs after the round trip'}${p.reverted ? '' : '; note: the downgrade changed nothing'} (ev:${p.evidence.join(', ev:')})`, p);
      return p.roundTrip ? 0 : 2;
    }
    const a = m.analyze(store, config, need(actor, '--actor'), opts);
    const lines = [`Migration analysis ${a.id}: ${a.files.length} file(s), ${a.findings.length} finding(s), ${a.blocking} blocking`];
    for (const f of a.findings) lines.push(`  ${f.severity.padEnd(8)} ${f.id} ${f.file}:${f.line} ${f.kind}: ${f.message}\n           fix: ${f.fix}`);
    print(flags, lines.join('\n'), a);
    return a.blocking ? 2 : 0;
  }
  if (sub === 'api') {
    const d = require('../lib/guards/api').diff(store, config, need(actor, '--actor'), opts);
    const lines = [`API diff ${d.id}: ${d.classification}; ${d.breaking.length} breaking, ${d.additive.length} additive`];
    for (const b of d.breaking) lines.push(`  BREAKING ${b.kind} ${b.target}: ${b.detail}`);
    for (const b of d.additive.slice(0, 20)) lines.push(`  additive ${b.kind} ${b.target}: ${b.detail}`);
    for (const n of d.notes) lines.push(`  note: ${n}`);
    print(flags, lines.join('\n'), d);
    return d.breaking.length ? 2 : 0;
  }
  if (sub === 'perf') {
    const r = require('../lib/guards/perf').run(store, config, need(actor, '--actor'), opts);
    const lines = [`Performance ${r.id}: ${r.probes.length} probe(s), ${r.regressions} regression(s), ${r.nPlusOnes} N+1`];
    for (const p of r.probes) lines.push(p.missing ? `  ${p.name}: not measured` : `  ${p.nPlusOne ? 'N+1     ' : p.latencyRegression ? 'SLOWER  ' : 'ok      '} ${p.name}: ${p.baseline.median} -> ${p.candidate.median} ms (${p.ratio}x), queries ${p.baseline.queries ?? '?'} -> ${p.candidate.queries ?? '?'}`);
    for (const n of r.notes) lines.push(`  note: ${n}`);
    print(flags, lines.join('\n'), r);
    return r.regressions || r.nPlusOnes ? 2 : 0;
  }
  if (sub === 'race') {
    const r = require('../lib/guards/race').run(store, config, need(actor, '--actor'), opts);
    const lines = [`Race probe ${r.id}: ${r.operations.length} operation(s), ${r.failed} broken on the candidate`];
    for (const op of r.operations) lines.push(`  ${op.candidate && op.candidate.held ? 'held   ' : 'BROKEN '} ${op.name}: ${(op.candidate ? op.candidate.invariants : []).map((i) => `${i.name} ${i.held ? 'ok' : `${i.before} -> ${i.after}`}`).join(', ')}`);
    for (const n of r.notes) lines.push(`  note: ${n}`);
    print(flags, lines.join('\n'), r);
    return r.failed ? 2 : 0;
  }
  if (sub === 'release') {
    const rel = require('../lib/guards/release');
    if (arg === 'ack') {
      const a = rel.acknowledge(store, config, need(actor, '--actor'), { plan: need(args._[3], 'plan id') });
      print(flags, `Release plan ${a.plan} acknowledged by ${actor}.`, a);
      return 0;
    }
    const p = rel.plan(store, config, need(actor, '--actor'), { strategy: need(flags.strategy, '--strategy flag|staged'), flag: flags.flag, rollout: flags.rollout, monitoring: need(flags.monitoring, '--monitoring'), rollback: need(flags.rollback, '--rollback') });
    print(flags, `Release plan ${p.id} recorded (${p.strategy}). A reviewer acknowledges it: eccode guard release ack ${p.id} --actor <reviewer>`, p);
    return 0;
  }
  if (sub === 'waive') {
    const w = guards.waive(store, config, need(actor, '--actor'), { guard: need(flags.guard, '--guard'), result: need(flags.result, '--result'), finding: need(flags.finding, '--finding'), reason: need(flags.reason, '--reason') });
    print(flags, `Waiver ${w.id}: ${w.guard} ${w.result} ${w.finding} (${w.reason})`, w);
    return 0;
  }
  throw new EccodeError('USAGE', 'eccode guard route | migration [--proof] | api | perf | race | release --strategy flag|staged [--flag n|--rollout t] --monitoring t --rollback t | release ack <id> | waive --guard g --result id --finding f --reason t | show (each with --actor)');
}

/** eccode standards <extract|show>: the team's observed standards (Phase 3, Part E; report-only). */
function standardsCli({ root, sub, flags, actor, print }) {
  const standards = require('../lib/standards');
  const limit = flags.limit ? Number(flags.limit) : undefined;
  if (sub === 'show' || !sub) {
    const r = standards.extract(root, limit ? { limit } : {});
    print(flags, standards.brief(r), r);
    return 0;
  }
  if (sub === 'extract') {
    const { openProject } = require('../lib/project');
    const { store, config } = openProject(root);
    store.assertInitialized();
    const r = standards.extract(root, limit ? { limit } : {});
    const id = standards.record(store, config, need(actor, '--actor'), r);
    print(flags, `${standards.brief(r)}\nRecorded as project memory ${id} (observed, never enforced).`, { record: id, ...r });
    return 0;
  }
  throw new EccodeError('USAGE', 'eccode standards show [--limit n] | extract --actor <role> [--limit n]');
}

/** eccode plan <contracts|checkpoint>: interface-first planning and integration checkpoints (Phase 3, Part D). */
function planGroupCli({ root, sub, flags, actor, print, loadJsonFile }) {
  const { openProject } = require('../lib/project');
  const { store, config } = openProject(root);
  store.assertInitialized();
  const pb = require('../lib/plan-budget');
  if (sub === 'contracts') {
    const c = pb.contracts(store, config, need(actor, '--actor'), loadJsonFile(need(flags.file, '--file <contracts.json>')));
    print(flags, `Plan contracts ${c.id}: ${c.contracts.map((x) => `${x.id} (${x.kind})`).join(', ')}. A rescope must cite the contract it changes.`, c);
    return 0;
  }
  if (sub === 'checkpoint') {
    const cp = pb.checkpoint(store, config, need(actor, '--actor'), { evidence: flags.evidence });
    print(flags, `Checkpoint ${cp.id} after ${cp.afterTasks} task(s): passed (ev:${cp.evidence.join(', ev:')}). The next task may be claimed.`, cp);
    return 0;
  }
  if (sub === 'show') {
    print(flags, pb.show(store.state()), store.state().planning);
    return 0;
  }
  throw new EccodeError('USAGE', 'eccode plan contracts --file <contracts.json> --actor <designer> | plan checkpoint --evidence ev:<id>,... --actor orchestrator | plan show');
}

/** eccode security <policy|matrix|idor|authflow|input|show>: authorization tested, not described (Phase 3, Part C). */
function securityCli({ root, sub, flags, actor, print, loadJsonFile }) {
  const { openProject } = require('../lib/project');
  const { store, config } = openProject(root);
  store.assertInitialized();
  const security = require('../lib/security');
  const opts = { task: flags.task, timeoutMs: timeoutOf(flags), python: flags.python };
  if (sub === 'show') {
    print(flags, security.reportLines(store.state()).join('\n') || 'No security result recorded.', store.state().guards && store.state().guards.security);
    return 0;
  }
  if (sub === 'policy') {
    const p = security.policy(store, config, need(actor, '--actor'), loadJsonFile(need(flags.file, '--file <cells.json>')));
    print(flags, `Security policy ${p.id}: ${p.cells.length} cell(s) declared.`, p);
    return 0;
  }
  const run = { matrix: security.matrix, idor: security.idor, authflow: security.authflow, input: security.inputProbes }[sub];
  if (run) {
    const r = run(store, config, need(actor, '--actor'), opts);
    const n = r.unexplained !== undefined ? r.unexplained : (r.flagged || 0);
    print(flags, `Security ${sub} ${r.id}: ${(r.cells || r.probes || []).length} probe(s), ${n} unexplained/flagged${r.unknown ? `, ${r.unknown} unknown cell(s)` : ''}. Artifact: ${r.artifact}`, r);
    return n ? 2 : 0;
  }
  throw new EccodeError('USAGE', 'eccode security policy --file <cells.json> | matrix | idor | authflow | input | show (each with --actor)');
}

/** eccode behavior <route|contract|diff|amend|waive|show>: the behavior diff. */
function behaviorCli({ root, sub, flags, actor, print, loadJsonFile }) {
  const { openProject } = require('../lib/project');
  const { store, config } = openProject(root);
  store.assertInitialized();
  const behavior = require('../lib/behavior');
  if (sub === 'show') {
    print(flags, behavior.show(store.state()), store.state().behavior);
    return 0;
  }
  if (sub === 'route') {
    const r = behavior.route(store, config, need(actor, '--actor'));
    print(flags, `Risk routing: ${r.decision} — ${r.reasons.join('; ')}${r.decision === 'run' ? '\nNext: declare intended behaviour changes (eccode behavior contract --file <entries.json>) before running eccode behavior diff.' : ''}`, r);
    return 0;
  }
  if (sub === 'contract') {
    const c = behavior.contract(store, config, need(actor, '--actor'), loadJsonFile(need(flags.file, '--file <entries.json>')));
    print(flags, `Behaviour contract ${c.id} declared: ${c.entries.length} entr${c.entries.length === 1 ? 'y' : 'ies'}.`, c);
    return 0;
  }
  if (sub === 'diff') {
    const r = behavior.diff(store, config, need(actor, '--actor'), { runs: flags.runs, python: flags.python, task: flags.task, timeoutMs: timeoutOf(flags) });
    const lines = [`Behavior diff ${r.id} (base ${r.base.slice(0, 12)}): ${r.probes} probes, ${r.executed} executed, ${r.dropped} dropped as nondeterministic; ${r.differences.length} difference(s): ${r.expected} expected, ${r.unexplained} unexplained; coverage ${r.coverage}${r.coverageNote ? ` (${r.coverageNote})` : ''}`];
    for (const d of r.differences.slice(0, 30)) lines.push(`  ${d.classification.padEnd(11)} ${d.probe}: ${d.paths.map((p) => `${p.path} ${JSON.stringify(p.baseline)} -> ${JSON.stringify(p.candidate)}`).join('; ')}`);
    for (const n of r.notes.slice(0, 10)) lines.push(`  note: ${n}`);
    lines.push(`Artifact: ${r.artifact}`);
    print(flags, lines.join('\n'), r);
    return r.unexplained || r.coverage !== 'ok' ? 2 : 0;
  }
  if (sub === 'amend') {
    const a = behavior.amend(store, config, need(actor, '--actor'), { result: need(flags.result, '--result <id>'), entries: loadJsonFile(need(flags.file, '--file <entries.json>')), reason: need(flags.reason, '--reason') });
    print(flags, `Contract amended (${a.id}) on ${a.amends}: ${a.entries.length} entr${a.entries.length === 1 ? 'y' : 'ies'}.`, a);
    return 0;
  }
  if (sub === 'waive') {
    const w = behavior.waive(store, config, need(actor, '--actor'), { result: need(flags.result, '--result <id>'), reason: need(flags.reason, '--reason') });
    print(flags, `Coverage waived (${w.id}) on ${w.result}.`, w);
    return 0;
  }
  throw new EccodeError('USAGE', 'Usage: eccode behavior route|contract --file <entries.json>|diff [--runs 2] [--python <bin>]|amend --result <id> --file <entries.json> --reason <t>|waive --result <id> --reason <t>|show');
}

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

/** --timeout <seconds> as milliseconds (at least 1), or undefined when absent. */
function timeoutOf(flags) {
  if (flags.timeout === undefined) return undefined;
  const seconds = Number(flags.timeout);
  if (flags.timeout === true || !Number.isFinite(seconds) || seconds <= 0) throw new EccodeError('INVALID_INPUT', '--timeout takes a number of seconds greater than 0');
  return Math.max(1, Math.round(seconds * 1000));
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
  const resolved = path.resolve(file);
  // A missing input file is the caller's mistake: refuse with a code, do not crash with a stack trace.
  if (!fs.existsSync(resolved)) throw new EccodeError('NOT_FOUND', `File not found: ${file}`);
  return readJson(resolved);
}

function main(argv) {
  const args = parseArgs(argv);
  const { flags } = args;
  const [group, sub, arg] = args._;
  if (flags.version && !group) {
    process.stdout.write(`${require('../package.json').version}\n`);
    return 0;
  }
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
  if (group === 'debug' && LAB_SUBCOMMANDS.has(sub)) return labCli({ root, sub, arg, args, flags, actor, print });
  if (group === 'quick' || group === 'debug') {
    const q = require('../lib/quick');
    const res = q.start(root, need(actor, '--actor'), { request: need(sub, group === 'debug' ? '"<bug>"' : '"<request>"'), owner: flags.owner, files: flags.files, command: flags.command, name: flags.name, track: group });
    const t = res.task;
    const steps = q.steps('eccode', t, group);
    print(flags, [
      `${group === 'debug' ? 'Bug fix' : 'Quick change'} ${res.workId} started${res.created ? ' (new record)' : ''}: "${t.title}"`,
      `  task ${t.id}: owner ${t.owner}; files ${t.files.join(', ')}; verification: ${t.verification.command}`,
      ...res.defaults.map((d) => `  from the repository: ${d}`),
      ...require('../lib/preflight').lines(res.findings).map((l) => `  ${l}`),
      `  gate phase:${t.id} is started.`,
      '',
      'The rest of the path (eccode status shows where you are):',
      ...steps,
      ...require('../lib/memory/draft').lessonsText(res.lessons),
    ].join('\n'), { workId: res.workId, task: t, defaults: res.defaults, steps, lessons: res.lessons, findings: res.findings });
    return 0;
  }
  if (group === 'behavior') return behaviorCli({ root, sub, arg, flags, actor, print, loadJsonFile });
  if (group === 'design') return designCli({ root, sub, arg, args, flags, actor, print, loadJsonFile });
  if (group === 'request') return requestCli({ root, sub, arg, flags, actor, print, loadJsonFile });
  if (group === 'guard') return guardCli({ root, sub, arg, args, flags, actor, print, loadJsonFile });
  if (group === 'security') return securityCli({ root, sub, flags, actor, print, loadJsonFile });
  if (group === 'standards') return standardsCli({ root, sub, flags, actor, print });
  if (group === 'plan' && ['contracts', 'checkpoint', 'show'].includes(sub)) return planGroupCli({ root, sub, flags, actor, print, loadJsonFile });
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
    if (sub === 'resume') {
      // Continue a batch a restart killed. A file with a batch header (written by
      // --save since 2026-11-01) carries its own plan: cut runs are recorded, their
      // sandboxes removed, every unfinished run runs again. An older file without
      // a header is resumed by count: the runs already in it (per task and variant)
      // are skipped and the flags name the rest. Either way the file is appended to
      // and --max-cost stays a total budget across the resume.
      const file = path.resolve(need(arg || flags.save, '<runs.jsonl> (or --save)'));
      if (!fs.existsSync(file)) throw new EccodeError('NOT_FOUND', `No save file at ${file}; nothing to resume (a resume continues a batch started with --save)`);
      if (!flags.force && bench.liveBenchStreams() >= bench.MAX_STREAMS) {
        throw new EccodeError('TOO_MANY_STREAMS', `${bench.liveBenchStreams()} bench stream(s) already running on this host (cap ${bench.MAX_STREAMS}); wait for one to finish or pass --force`);
      }
      if (bench.batchOf(file).header) {
        return bench.resumeBatch({
          save: file,
          cause: flags.cause || 'the batch was interrupted',
          agentCmd: flags.agent,
          concurrency: flags.concurrency ? Number(flags.concurrency) : undefined,
          transcripts: flags.transcripts ? path.resolve(flags.transcripts) : undefined,
          timeoutMs: timeoutOf(flags),
          maxCostUsd: flags['max-cost'] !== undefined ? Number(flags['max-cost']) : undefined,
          keep: Boolean(flags.keep),
          onProgress: (m) => process.stderr.write(`bench: ${m}\n`),
        }).then((res) => {
          if (flags.out) {
            require('../lib/util').writeFileAtomic(path.resolve(flags.out), res.markdown);
            process.stderr.write(`bench: report written to ${flags.out}\n`);
          }
          process.stderr.write(`bench: batch ${res.batch.id} ${res.complete ? 'complete' : 'still incomplete'}: ${res.all.length} run(s) recorded, ${res.interrupted.length} cut run(s) re-run\n`);
          print(flags, res.markdown, res.all);
          return res.stopped ? 1 : 0;
        });
      }
      const prior = bench.loadRuns(fs.readFileSync(file, 'utf8'));
      const completed = bench.completedCounts(prior);
      const spentBefore = bench.spentUsd(prior);
      const rvariants = !flags.variant || flags.variant === 'both' ? ['without', 'with'] : flags.variant === 'all' ? ['without', 'with', 'engine'] : String(flags.variant).split(',').map((v) => v.trim());
      const save = (r) => fs.appendFileSync(file, JSON.stringify(r) + '\n');
      const { records, markdown, stopped = null } = bench.run({
        agentCmd: need(flags.agent, '--agent'),
        suite: flags.suite ? path.resolve(flags.suite) : undefined,
        tasks: flags.tasks ? String(flags.tasks).split(',').map((x) => x.trim()) : null,
        runs: Number(flags.runs || 1),
        variants: rvariants,
        timeoutMs: timeoutOf(flags),
        keep: Boolean(flags.keep),
        engineProfile: flags['engine-profile'] || 'guard',
        engineAgents: flags['engine-agents'] || 'inherit',
        maxCostUsd: flags['max-cost'] !== undefined ? Number(flags['max-cost']) : null,
        transcripts: flags.transcripts ? path.resolve(flags.transcripts) : null,
        onProgress: (m) => process.stderr.write(`bench: ${m}\n`),
        onRecord: save,
        completed,
        spentBefore,
      });
      if (stopped) save({ type: 'stopped', ...stopped });
      const skipped = [...completed.values()].reduce((a, b) => a + b, 0);
      process.stderr.write(`bench: resumed ${file}; ${skipped} completed run(s) skipped (prior spend $${spentBefore.toFixed(2)}), ${records.length} new run(s) recorded\n`);
      if (flags.out) { require('../lib/util').writeFileAtomic(path.resolve(flags.out), markdown); }
      print(flags, markdown, records);
      return stopped ? 1 : 0;
    }
    const VARIANTS = ['without', 'with', 'method', 'engine', 'debug', 'ecc'];
    const variants = !flags.variant || flags.variant === 'both' ? ['without', 'with'] : flags.variant === 'all' ? ['without', 'with', 'engine'] : String(flags.variant).split(',').map((v) => v.trim());
    if (!flags.force && bench.liveBenchStreams() >= bench.MAX_STREAMS) {
      throw new EccodeError('TOO_MANY_STREAMS', `${bench.liveBenchStreams()} bench stream(s) already running on this host (cap ${bench.MAX_STREAMS}); wait for one to finish or pass --force`);
    }
    const unknown = variants.filter((v) => !VARIANTS.includes(v));
    if (unknown.length) throw new EccodeError('USAGE', `Unknown --variant ${unknown.join(', ')}: use with, without, method, engine, debug, ecc, both (without,with), all (without,with,engine), or a comma list`);
    const save = flags.save ? (r) => fs.appendFileSync(path.resolve(flags.save), JSON.stringify(r) + '\n') : () => {};
    const maxCostUsd = flags['max-cost'] !== undefined ? Number(flags['max-cost']) : null;
    const common = {
      agentCmd: need(flags.agent, '--agent'),
      timeoutMs: timeoutOf(flags),
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
      const batchOptions = {
        ...common,
        suite: flags.suite ? path.resolve(flags.suite) : undefined,
        tasks: flags.tasks ? String(flags.tasks).split(',').map((x) => x.trim()) : null,
        runs: Number(flags.runs || 1),
        variants,
        concurrency: flags.concurrency ? Number(flags.concurrency) : 1,
      };
      const finish = (res) => {
        if (res.stopped && !flags.save) save({ type: 'stopped', ...res.stopped });
        if (flags.out) {
          require('../lib/util').writeFileAtomic(path.resolve(flags.out), res.markdown);
          process.stderr.write(`bench: report written to ${flags.out}\n`);
        }
        print(flags, res.markdown, res.records);
        return res.stopped ? 1 : 0;
      };
      // With --save the batch is resumable (a header line, in-flight tracking); without it the runs only print.
      return flags.save
        ? bench.startBatch({ ...batchOptions, save: path.resolve(flags.save) }).then(finish)
        : bench.runBatch({ ...batchOptions, onRecord: save }).then(finish);
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
      timeoutMs: timeoutOf(flags),
      onProgress: (m) => process.stderr.write(`mutate: ${m}\n`),
    });
    if (flags.record) res.evidence = mutate.record(store, need(actor, '--actor'), res, { task: flags.task, gate: flags.gate }).id;
    print(flags, `${mutate.format(res)}${res.evidence ? `\nRecorded as ev:${res.evidence}` : ''}`, res);
    return flags['min-score'] !== undefined && res.score !== null && res.score * 100 < Number(flags['min-score']) ? 1 : 0;
  }
  if (group === 'fix') {
    if (sub !== 'verify') throw new EccodeError('USAGE', 'Usage: eccode fix verify --actor <a> (--task <id> | --base <ref>) [--test "<cmd>"]');
    const fixverify = require('../lib/fixverify');
    const r = fixverify.verify(store, need(actor, '--actor'), { test: flags.test, task: flags.task, base: flags.base, timeoutMs: timeoutOf(flags) });
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
      const timeoutMs = timeoutOf(flags) || 600000;
      for (const id of ids) {
        if (flags.record) {
          const c = stack.checks(root, cfg).find((x) => x.id === id);
          const ev = require('../lib/evidence').runCommand(store, need(actor, '--actor'), { label: `stack:${id}`, command: c && !id.startsWith('eccode-') ? c.command : `node ${JSON.stringify(__filename)} stack run ${id}`, gate: flags.gate, timeoutMs });
          process.stdout.write(`${id}: ${ev.status.toUpperCase()} (ev:${ev.id})\n`);
          worst = Math.max(worst, ev.exitCode === 0 ? 0 : 2);
        } else {
          const r = stack.runCheck(root, cfg, id, { timeoutMs });
          process.stdout.write(`${id}: ${r.exitCode === 0 ? 'PASSED' : r.timedOut ? `TIMED OUT after ${timeoutMs / 1000} s` : `FAILED (exit ${r.exitCode})`}\n${r.output.trim()}\n`);
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
        const lessons = require('../lib/memory/draft').lessonsFor(store, config, flags.title);
        print(flags, [`Work ${event.data.id} started on the ${flags.track} track. Next: eccode status --brief`, ...require('../lib/memory/draft').lessonsText(lessons)].join('\n'), { ...event.data, lessons });
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
        const reviewers = flags.reviewers ? String(flags.reviewers).split(',').map((r) => r.trim()).filter(Boolean) : undefined;
        gates.startGate(store, config, gateId, need(actor, '--actor'), { reviewers });
        print(flags, `Gate ${gateId} started.${reviewers ? ` Each of ${reviewers.join(', ')} must approve.` : ''}`, { gate: gateId, status: 'in_progress', ...(reviewers ? { reviewers } : {}) });
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
        const re = gates.reopenGate(store, gateId, need(actor, '--actor'), need(flags.resolution, '--resolution'), { config });
        print(flags, re.event.data.headless ? `Gate ${gateId} reopened headless by the orchestrator (${re.event.data.stale.join(', ')} changed after the approval): resubmit it and have it reviewed again; the reopening is recorded as an assumption.` : `Gate ${gateId} reopened by user decision.`);
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
      if (sub === 'waive-budget') {
        const w = require('../lib/plan-budget').waiveBudget(store, config, need(actor, '--actor'), { task: need(arg, '<task>'), reason: need(flags.reason, '--reason') });
        print(flags, `Budget waived on ${w.task}: ${w.reason}`, w);
        return 0;
      }
      if (sub === 'list' || sub === 'next') {
        const state = store.state();
        const list = sub === 'next' ? tasks.readyTasks(state, config) : Object.values(state.tasks);
        print(flags, list.map((t) => `${t.id} [${t.status}] phase=${t.phase} owner=${t.owner} attempts=${t.attempts} — ${t.title}`).join('\n') || '(none)', list);
      } else if (sub === 'claim') {
        const { event } = tasks.claim(store, config, need(arg, '<task>'), need(actor, '--actor'), { runId: flags.run });
        const lessons = require('../lib/memory/draft').lessonsForTask(store, config, arg);
        print(flags, [`Claimed ${arg} (base ${event.data.baseCommit || 'no git'}).`, ...require('../lib/memory/draft').lessonsText(lessons)].join('\n'), { ...event.data, lessons });
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
          timeoutMs: timeoutOf(flags),
        });
        print(flags, `Evidence ev:${ev.id} — ${ev.status.toUpperCase()} (exit ${ev.exitCode}, ${ev.durationMs}ms)\n${ev.outputTail}`, ev);
        // The run is recorded either way. A failed check exits 3 so that a script or an agent chaining commands
        // cannot read "recorded" as "passed". A reproduction is expected to fail, so it keeps exit 0.
        return ev.status === 'passed' || (flags.purpose || 'check') === 'reproduction' ? 0 : 3;
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

/** The exit code and message of an error the CLI could not handle itself. */
function fail(err) {
  if (err instanceof EccodeError) {
    process.stderr.write(`eccode: [${err.code}] ${err.message}\n`);
    if (err.details && err.details.recovery) process.stderr.write(`recovery: ${err.details.recovery}\n`);
    process.exitCode = err.code === 'USAGE' ? 1 : 2;
  } else {
    process.stderr.write(`eccode: internal error: ${err && err.stack ? err.stack : err}\n`);
    process.exitCode = 1;
  }
}

if (require.main === module) {
  try {
    const result = main(process.argv.slice(2));
    // A batch of benchmark runs is asynchronous (concurrent runs on worker threads).
    if (result && typeof result.then === 'function') result.then((code) => { process.exitCode = code; }, fail);
    else process.exitCode = result;
  } catch (err) {
    fail(err);
  }
}

module.exports = { main };
