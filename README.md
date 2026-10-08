# ECCode: evidence-gated multi-agent engineering for Claude Code

ECCode is a toolkit that lets a team of specialised AI agents take a web or AI product from idea to delivery: architecture, independent review, technical design, independent review, phased implementation, verification and a verified handoff. The quality rules are **enforced in code**, not just written into prompts.

> Inspired by [ECC](https://github.com/affaan-m/ECC) and built as an independent implementation. Read [docs/ecc-assessment.md](docs/ecc-assessment.md) for the comparison and the reasons for that choice, and [NOTICE](NOTICE) for attribution.

## What's different

In most agent frameworks, "the reviewer must approve before merging" is a sentence in a prompt. In ECCode it is a state transition that the `eccode` engine **refuses** in these cases:

- **Self-approval:** the reviewer authored, or claimed a task in, the work being reviewed.
- **No evidence:** an approval cites evidence that doesn't exist, or cites a check that failed.
- **Stale artifact:** the reviewed file changed after it was submitted (detected by SHA-256).
- **Implementation without re-execution:** an implementation or verification approval doesn't cite a check that **the reviewer** ran after the submission.
- **Unresolved findings:** blocking findings from the previous round are not explicitly resolved, with evidence.
- **Out of order:** a stage starts before its predecessor is approved. After N rejections, the stage escalates to **you**.

Everything is recorded in an append-only, hash-chained event log, so work can resume after any interruption and the final handoff is generated from evidence rather than from agent summaries. **Resume does not trust the record blindly:** `eccode reconcile --verify` compares it with the working tree (approved artifacts, partial work of interrupted claims) and re-runs the checks that earlier work relied on.

## Components

| | |
|---|---|
| **12 agents** | product-architect · architecture-reviewer · technical-designer · technical-reviewer · delivery-lead · learning-debugger · frontend / backend / ai / test / devops engineers · security-reviewer |
| **7 skills** | `orchestrate` (lead orchestrator playbook) · review-gate · handoff-protocol · verification-evidence · debug-investigation · engineering-memory · self-improvement |
| **7 commands** | `/eccode:start` · `/eccode:change` · `/eccode:resume` · `/eccode:status` · `/eccode:investigate` · `/eccode:deliver` · `/eccode:improve` |
| **3 hooks** | SessionStart injects a resume brief with a reconciliation of the record against the working tree. PreToolUse is a guard that ties `--actor` to the subagent actually running, enforces file ownership and protects the record. Stop is a completion gate for unattended runs (`ECCODE_UNATTENDED=1`): a session started with `/eccode:start`, `/eccode:change` or `/eccode:resume` cannot end before the delivery is complete or a user decision is pending. |
| **Engine + CLI** | Zero-dependency Node ≥18: gates, tasks, evidence, runs and budgets, recovery, delivery, memory, self-improvement, metrics |
| **Learning switch** | `ECCODE_LEARNING=off` (or `memory.learning:false`) disables lesson retrieval, recording and self-improvement, so the effect of learning can be measured against a baseline (see `eval/`). |
| **Memory** | Four layers (project, debugging, knowledge, workflow). A lesson is verified only when **the same check failed before the fix and passed after it**, a reviewer who is not the author signs off, and it carries applicability conditions checked against the current environment. Lessons can be promoted to shared memory after a privacy scan. |

## Quick start

```bash
# Claude Code plugin
/plugin marketplace add TOUMO45/ECCode
/plugin install eccode@eccode
/eccode:start "A small web app where support agents paste a ticket and get an AI triage…"
/eccode:change "Invoice totals are wrong when a shipping fee is present"    # a bug fix or bounded change in existing code

# …or copy into a project without the plugin system
node ECCode/bin/eccode.js install --target ./my-project

# verify the toolkit itself
cd ECCode && npm run check
node scripts/verify-install.js --live     # follows docs/usage.md in a throwaway config dir and starts a project
```

See [docs/usage.md](docs/usage.md) for installation, configuration, usage and troubleshooting, [docs/architecture.md](docs/architecture.md) for the design, and [docs/memory.md](docs/memory.md) for the learning system.

## Demonstration

[`examples/triage-desk/`](examples/triage-desk) contains a complete delivery of **TriageDesk**, a small web app with an AI ticket-triage feature, run by real Claude Code subagents through every gate. Its `.eccode/` directory is the unedited record: reviews, rejections, evidence logs, handoffs, lessons and the final handoff. [`examples/learning-cycle/`](examples/learning-cycle) shows a lesson being reused in a different project. [docs/final-report.md](docs/final-report.md) lists what was verified, what wasn't, and what remains.

## License

MIT. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
