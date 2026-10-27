# ECCode: evidence-gated multi-agent engineering for Claude Code

ECCode is a toolkit that lets a team of specialised AI agents build and maintain software like a senior engineering team: from a product idea to a verified delivery, and then on through the features, fixes and refactors that follow, on new projects and existing codebases. The quality rules are **enforced in code**, not just written into prompts.

> Inspired by [ECC](https://github.com/affaan-m/ECC) and built as an independent implementation. Read [docs/ecc-assessment.md](docs/ecc-assessment.md) for the comparison and the reasons for that choice, and [NOTICE](NOTICE) for attribution.

## What's different

In most agent frameworks, "the reviewer must approve before merging" is a sentence in a prompt. In ECCode it is a state transition that the `eccode` engine **refuses** in these cases:

- **Self-approval:** the reviewer authored, or claimed a task in, the work being reviewed.
- **No evidence:** an approval cites evidence that doesn't exist, or cites a check that failed.
- **Stale artifact:** the reviewed file changed after it was submitted (detected by SHA-256).
- **Implementation without re-execution:** an implementation or verification approval doesn't cite a check that **the reviewer** ran after the submission.
- **Unresolved findings:** blocking findings from the previous round are not explicitly resolved, with evidence.
- **Out of order:** a stage starts before its predecessor is approved. After N rejections, the stage escalates to **you**.
- **Unreviewed code:** a file changed since the project started that no approved review covered. The verification submission and `deliver` both refuse it.
- **A substitute check:** a task cites `true` or any other command instead of the verification command its approved plan pinned.
- **A decision made for you:** an agent records `--actor user`. Subagents are blocked, and the main session triggers a Claude Code confirmation prompt.
- **An undeclared breaking change:** a removed public export or HTTP route, an edited or deleted applied migration, or destructive SQL, missing from the handoff's `breakingChanges`. Refactor work items refuse breaking changes outright.
- **A fix that was never reproduced:** on the fix track, verification requires the failing reproduction and the same command passing after the fix.
- **A refactor that changed behavior:** the declared behavior command must be recorded green before the first change and after the last approval.
- **Skipped required checks:** once the user adopts stack checks (`eccode stack adopt`), verification approval requires the reviewer's own passing run of each.

Everything is recorded in an append-only, hash-chained event log, so work can resume after any interruption and the final handoff is generated from evidence rather than from agent summaries. `eccode audit --against origin/main` proves that history already committed was not rewritten. Run it in CI with branch protection to anchor the record outside the agents' reach.

**One step for a small change.** `/eccode:quick "<change>"` (or `eccode quick "<change>" --actor orchestrator`) creates the record if needed, imports a one-task plan whose verification command and ownership are read from the repository, starts its gate and prints every remaining step. The owning engineer implements and tests the change, `handoff draft` fills the handoff fields the record already knows, an independent reviewer re-runs the check, and `deliver` closes it. `eccode metrics` reports what each work item and each track cost: runs, tokens, review rounds and wall time.

**One step for one bug.** `/eccode:debug "<bug report>"` (or `eccode debug "<bug>" --actor orchestrator`) is the lighter debug track: the owner reproduces the bug with a failing test, fixes the root cause, proves the test with `fix verify` (it fails on the code before the fix and passes with it) and records a mutation run; the engine refuses the phase until both are recorded; one independent reviewer approves; the orchestrator delivers. Two dispatches instead of five.

**Measured, including the engine itself.** `eccode bench --variant engine` installs the toolkit in each sandbox and asks for delivery through the quick track. In a pre-registered batch of 80 runs on four multi-file tasks with regression traps, both models tested passed every hidden check with or without the engine; the traps did not catch either. The reviewed, recorded path cost 3.4× (Sonnet) to 5.0× (Opus) the median cost of a bare run, and engine runs wrote tests more often (18/20 vs 10/20 on Sonnet). The batches also found engine defects that kept runs from delivering; each is fixed and registered. A second pre-registered batch ran on twenty real bugs from five open-source projects: 240 runs, comparing a bare agent, the debugging method as text, the debug track and the quick track. The bare agent already fixed every bug, so again no variant changed correctness. What the engine changed is the proof. Every debug-track run proved its regression test fails before the fix and passes after, and reviews caught regressions the projects' own tests miss. The debug track cost 3.3× a bare run, and the quick track 3.65×. Whether the engine improves correctness where bare agents do fail is still open. See [docs/senior-engineering.md](docs/senior-engineering.md) and [docs/limits.md](docs/limits.md).

**Tested on a real project, then tested again.** A pre-registered pilot ran every capability on Mealie, a FastAPI and Nuxt app ECCode's authors did not write, at v3.20.0 and over the 410 commits to v3.27.0.
- **The model-free tools mostly held up at that scale.**
  - Indexing took under a second.
  - Impact analysis's recall against coverage was 1.0, and against injected faults 0.94, then 1.0 after a fix. But it selects most of the suite for any module the app imports.
  - Six of the seventeen criteria missed at first: TS/JS resolution, breaking-change precision, `fix verify` agreement, bug-rule false positives, and stack detection and its checks. Each was fixed, and all six were met when measured again.
- **The engine at the protocol commit** delivered 6 of 20 real work items with a clean audit, where the rule was 80%, and refused correct steps 1.8 times per item.
- **Correctness:** the bare agent passed every hidden check in 17 of 20 runs, the engine in 13 of 20.
- **Every stop is on the register,** and most causes are fixed with tests. See [the pilot report](bench/pilot-results/2026-10-24-mealie-pilot.md).
- **The rerun at the fix commit,** on ten fresh Mealie changes and a new greenfield service, met six of the nine engine criteria, against one in the pilot:
  - false refusals fell to 0.64 per item (rule ≤ 1);
  - lessons were recorded and shown to later items;
  - the no-shell item was delivered in 2 of 2 runs;
  - no record failed its audit.
- **Delivery is still short** of the 80% rule. 7 of 20 items were delivered in the registered reading, where a container restart cut the last four items of each chain. 11 of 20 were delivered when the chains continued.
- **The bare agent was right almost every time.** Among the Mealie runs that finished, it missed no hidden check, and the engine missed one. On the greenfield service, the bare agent missed one and the engine none.
- **The model-free half met 14 of its 17 criteria on fresh history.** Checking the instruments found two of them blind:
  - the route table saw none of Mealie's API routes, in the pilot as well;
  - the frontend checks failed on both sides for environment reasons.

  Those are fixed with tests, along with four engine defects the checks turned up:
  - timeouts in `mutate` and `stack run` that left tests running;
  - compat reading a dev script as API;
  - compat missing routes on routers with other names.

  Afterwards compat precision was 0.80 on fresh history, and route recall 1 of 1 in each window.

  See [the rerun report](bench/pilot-results/2026-10-25-mealie-rerun.md) and [its Part A](bench/pilot-results/2026-10-25-mealie-rerun-part-a.md).
- **The proof run** was registered to find the bare agent's mistakes and measure whether the engine catches them. It took every eligible change of fresh Mealie history, 19 items, each run twice bare and twice through the engine.
  - **No verdict on correctness.** The bare agent passed every hidden check in 36 of 38 runs, the engine in 36 of 38. All four failures were one test whose DOM event the request did not name, so no item was hard.
  - **Delivery met:** 38 of 38 engine runs delivered with a clean audit (rule 80%), with 0.08 false refusals per run.
  - **What the engine added:** tests in every run (bare: 13 of 38), and a proven regression test and a lesson in every fix. Checked after the fact, 37 of 38 engine patches passed Mealie's lint gate, against 30 of 38 bare. It cost a median 10.8× a bare run.
  - Three defects found and fixed (rows 131–133). See [the proof run report](bench/pilot-results/2026-10-26-mealie-proof.md).
- **The multi-file run** asked again on the 16 largest eligible changes of Mealie's recent history (121 to 1,355 lines in 6 to 30 files), screening each with three bare runs.
  - **The bare agent did get large changes wrong:** its own mistakes on three items, which made them hard.
  - **Primary missed:** on those items, 6 fresh runs of each variant gave the engine 12 of 18 and the bare agent 9 of 18 (p = 0.50, rule p < 0.05). The engine fixed the bare agent's mistakes on two items (6/6 against 3/6, and 4/6 against 1/6), but four of its six runs on the third reached the 7,200 s timeout. Graded on a clean tree with the timeout set aside, 17 of 18 engine patches pass (post hoc).
  - **Delivery missed:** 9 of 18 engine runs delivered (rule 80%; row 138). Four timed out, and five stopped to ask a user, four of them after the benchmark's tool list refused a command they needed. Friction met: 0.17 false refusals per run.
  - It cost a median 7.7× a bare run and took 48.5 minutes against 6.3.
  - Defects found: two engine defects fixed (rows 134–135), two harness limits mitigated (rows 136–137), the run's own analysis corrected, and `ps` added to the guard's read-only list (row 91). See [the multi-file run report](bench/pilot-results/2026-10-27-mealie-multifile.md).

**Sized to the task.** One record carries many deliveries: after `deliver`, `eccode work start --track feature|refactor|fix|quick|greenfield` opens the next work item with gates sized to its risk. On an existing codebase, `eccode onboard` briefs agents first (modules, entry points, hot spots, most-depended files) and `eccode impact` names what a change reaches before it is made. See [docs/senior-engineering.md](docs/senior-engineering.md).

**Lean by default.** Implementers reuse before they write: not needed → already in the codebase → standard library → installed dependency → minimal new code. They never cut validation, security or accessibility. The engine refuses a task completion that adds an **undeclared dependency** or an **undeclared `shortcut:`**, or that changes code with **neither a test nor a stated reason**. It records lines added and removed for every task. The idea is adapted from [Ponytail](https://github.com/DietrichGebert/ponytail); ECCode makes it checkable. See [docs/lean.md](docs/lean.md).

## Components

| | |
|---|---|
| **12 agents** | product-architect · architecture-reviewer · technical-designer · technical-reviewer · delivery-lead · learning-debugger · frontend / backend / ai / test / devops engineers · security-reviewer |
| **9 skills** | `orchestrate` (lead orchestrator playbook) · review-gate · handoff-protocol · verification-evidence · debug-investigation · engineering-memory · self-improvement · **lean-change** · **senior-review** |
| **13 commands** | `/eccode:quick` · `/eccode:debug` · `/eccode:start` · `/eccode:resume` · `/eccode:status` · `/eccode:investigate` · `/eccode:deliver` · `/eccode:improve` · `/eccode:lean` · `/eccode:review` · `/eccode:audit` · `/eccode:debt` · `/eccode:onboard` |
| **2 hooks** | SessionStart injects a resume brief. PreToolUse is a guard that ties `--actor` to the subagent actually running, enforces file ownership and protects the record. |
| **Engine + CLI + MCP** | Zero-dependency Node ≥18: gates, tasks, evidence, runs and budgets, recovery, delivery, memory, self-improvement, metrics, lean and breaking-change checks, work items and tracks, codebase index (`onboard`, `impact`, `map`, `debt`), stack packs (`stack`), bug detection and problem solving (`bugs`, `mutate`, `fix verify`), the one-step paths (`quick`, `debug`, `handoff draft`), cost per track (`metrics`), paired benchmark (`bench`, with `engine` and `debug` variants that put the whole engine in the loop, and a real-bug suite), and `eccode mcp` (the engine as typed tools, one actor-locked server per role, for no-Bash agents) |
| **Bugs and problem solving** | `eccode bugs` flags slips in the lines a change adds (calibrated on 4.6M lines of real code) and runs ruff, go vet, eslint or semgrep when they are installed; completion refuses undeclared errors. `eccode mutate` measures whether the tests would notice a broken change. `eccode fix verify` proves a regression test fails on the pre-fix code and passes on the fix. |
| **Memory** | Four layers (project, debugging, knowledge, workflow). A lesson is verified only when **the same check failed before the fix and passed after it**, a reviewer who is not the author signs off, and it carries applicability conditions checked against the current environment. Lessons can be promoted to shared memory after a privacy scan. |

## Quick start

```bash
# Claude Code plugin
/plugin marketplace add TOUMO45/ECCode
/plugin install eccode@eccode
/eccode:start "A small web app where support agents paste a ticket and get an AI triage…"
/eccode:quick "Search should ignore case"          # one small, reviewed change on an existing codebase
/eccode:debug "Ten items get no bulk discount"     # one bug: reproduced, fixed at the root, proven, reviewed

# …or copy into a project without the plugin system
node ECCode/bin/eccode.js install --target ./my-project   # enforced record protection by default: OS sandbox, or no shell where there is none

# verify the toolkit itself
cd ECCode && npm run check
```

See [docs/usage.md](docs/usage.md) for installation, configuration, usage and troubleshooting, [docs/architecture.md](docs/architecture.md) for the design, [docs/memory.md](docs/memory.md) for the learning system, [docs/lean.md](docs/lean.md) for lean changes, [docs/bugs.md](docs/bugs.md) for bug detection, mutation testing and proving fixes, [docs/senior-engineering.md](docs/senior-engineering.md) for onboarding, impact, tracks, breaking-change rules, stack packs and the benchmark, and [docs/tooling-research.md](docs/tooling-research.md) for the open-source tools on the roadmap.

## Demonstration

[`examples/triage-desk/`](examples/triage-desk) contains a complete delivery of **TriageDesk**, a small web app with an AI ticket-triage feature, run by real Claude Code subagents through every gate. Its `.eccode/` directory is the unedited record: reviews, rejections, evidence logs, handoffs, lessons and the final handoff. [`examples/learning-cycle/`](examples/learning-cycle) shows a lesson being reused in a different project. [docs/final-report.md](docs/final-report.md) lists what was verified, what wasn't, and what remains.

## License

MIT. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
