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

**Sized to the task.** One record carries many deliveries: after `deliver`, `eccode work start --track feature|refactor|fix|quick|greenfield` opens the next work item with gates sized to its risk. On an existing codebase, `eccode onboard` briefs agents first (modules, entry points, hot spots, most-depended files) and `eccode impact` names what a change reaches before it is made. See [docs/senior-engineering.md](docs/senior-engineering.md).

**Lean by default.** Implementers reuse before they write: not needed → already in the codebase → standard library → installed dependency → minimal new code. They never cut validation, security or accessibility. The engine refuses a task completion that adds an **undeclared dependency** or an **undeclared `shortcut:`**, or that changes code with **neither a test nor a stated reason**. It records lines added and removed for every task. The idea is adapted from [Ponytail](https://github.com/DietrichGebert/ponytail); ECCode makes it checkable. See [docs/lean.md](docs/lean.md).

## Components

| | |
|---|---|
| **12 agents** | product-architect · architecture-reviewer · technical-designer · technical-reviewer · delivery-lead · learning-debugger · frontend / backend / ai / test / devops engineers · security-reviewer |
| **9 skills** | `orchestrate` (lead orchestrator playbook) · review-gate · handoff-protocol · verification-evidence · debug-investigation · engineering-memory · self-improvement · **lean-change** · **senior-review** |
| **11 commands** | `/eccode:start` · `/eccode:resume` · `/eccode:status` · `/eccode:investigate` · `/eccode:deliver` · `/eccode:improve` · `/eccode:lean` · `/eccode:review` · `/eccode:audit` · `/eccode:debt` · `/eccode:onboard` |
| **2 hooks** | SessionStart injects a resume brief. PreToolUse is a guard that ties `--actor` to the subagent actually running, enforces file ownership and protects the record. |
| **Engine + CLI + MCP** | Zero-dependency Node ≥18: gates, tasks, evidence, runs and budgets, recovery, delivery, memory, self-improvement, metrics, lean and breaking-change checks, work items and tracks, codebase index (`onboard`, `impact`, `map`, `debt`), stack packs (`stack`), bug detection and problem solving (`bugs`, `mutate`, `fix verify`), paired benchmark (`bench`), and `eccode mcp` (the engine as typed tools, one actor-locked server per role, for no-Bash agents) |
| **Bugs and problem solving** | `eccode bugs` flags slips in the lines a change adds (calibrated on 4.6M lines of real code) and runs ruff, go vet, eslint or semgrep when they are installed; completion refuses undeclared errors. `eccode mutate` measures whether the tests would notice a broken change. `eccode fix verify` proves a regression test fails on the pre-fix code and passes on the fix. |
| **Memory** | Four layers (project, debugging, knowledge, workflow). A lesson is verified only when **the same check failed before the fix and passed after it**, a reviewer who is not the author signs off, and it carries applicability conditions checked against the current environment. Lessons can be promoted to shared memory after a privacy scan. |

## Quick start

```bash
# Claude Code plugin
/plugin marketplace add TOUMO45/ECCode
/plugin install eccode@eccode
/eccode:start "A small web app where support agents paste a ticket and get an AI triage…"

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
