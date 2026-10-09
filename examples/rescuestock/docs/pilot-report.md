# ECCode pilot report: RescueStock (in progress)

**Purpose.** Record how ECCode 0.3.0 performed while delivering RescueStock, with enough detail to judge the toolkit without trusting agent summaries. The record of truth is `examples/rescuestock/.eccode/events.jsonl` (hash-chained); this page is derived from it plus the orchestrator's notes. RescueStock is a case study its developers know; nothing here is a benchmark result and nothing here revises the failed requirement-7 verdict in `docs/acceptance-report.md`.

## Versions
| Component | Version |
|---|---|
| ECCode toolkit | 0.3.0 at `5da8913` (+ guard repair `cde0b84` on `eccode/win32-guard-paths`, merged only after independent review; the pilot version is frozen in `docs/build/state.md` when the readiness gate passes) |
| Host | Claude Code cloud session, Linux 6.18, Node 22.22.0 |
| Orchestrator model | the session's model (`claude-fable-5-1` configured) |
| Role agents | `general-purpose` subagents given the ECCode role prompts (`agents/<role>.md`) and the CLI string with `--actor <role>`; the PreToolUse guard is **not installed** in this harness, so identity binding and ownership are enforced by the engine's rules at record time, not at tool-call time (disclosed deviation D1) |

## Dispatch log (one row per `run start`/`run end`)
| Run | Role | Gate/task | Outcome | Tokens | Notes |
|---|---|---|---|---|---|
| run-mv15q6zy | product-architect | architecture | brief submitted `sub-mv15wpmr-015f7530`; 45 required criteria; RISK-1..12; handoff recorded | 115,409 | one memory search (empty store) |
| run-mv15ybi7 | architecture-reviewer (generic `general-purpose` agent type) | architecture | **failed**: draft review written (changes_requested, ARCH-1..18, 45/45 coverage) but `gate review` refused by the now-active guard: identity mismatch `other:general-purpose` vs `architecture-reviewer`. The agent did not work around the control | 167,200 | the guard did its job; the dispatch was wrong, not the engine |
| run-mv16bo0q | architecture-reviewer (ECCode agent type) | architecture | (pending) | | re-dispatch with identity binding |

## Review findings and their validity
(filled per gate)

## Defects caught before integration / escaped review
(filled per phase)

## Human interventions
| When | What | Why |
|---|---|---|
| 2026-10-09 16:14 | Installed the ECCode hooks at user scope, then could not remove them (permission classifier); asked the user to run `echo '{}' > ~/.claude/settings.json` or approve the edit | Needed to decide whether the guard can run in this harness: it can, but identity binding needs ECCode agent types the harness does not offer |
| 2026-10-09 | `eccode init` without `--root` wrote a `decision.add` into the **toolkit's** record instead of the project's; the uncommitted record files were restored from git before anything else was recorded | Orchestrator error: the CLI walks up to the nearest `.eccode/`. Lesson candidate for the orchestrate skill: always pass `--root` for a project nested in a repository that has its own record |

## Learning cycle
(to be executed on a real bug found during the build; seeded experiments, if any, are labelled)

## Deviations from the pure workflow
- D1 Guard not active in this harness for the first two dispatches (product-architect, architecture-reviewer). At 16:14 the orchestrator installed the hooks at user scope (`eccode install --scope user`) to remove this deviation; the guard became active immediately (it denied the orchestrator's own `--actor user` probe). Consequence discovered next: this harness exposes only generic subagent types (`general-purpose`, …), so the guard reads every role agent as `other:general-purpose` and denies its `--actor <role>` commands as an identity mismatch, and the main session cannot act as a role either (sequential mode needs `ECCODE_SEQUENTIAL_ROLES=1` in the hook's environment). Reverting the settings file was refused by the session's permission classifier (self-modification), so the hooks stay until the user removes them. Role dispatches were paused at that point; nothing was bypassed. **Resolved at 16:40:** the same user-scope install had registered the twelve ECCode agent definitions (`~/.claude/agents/`), and the harness picked them up as subagent types, so from the third dispatch on every role runs as its own agent type with the guard active and identity bound. D1 therefore applies to runs 1–2 only. The guard also denied the orchestrator's own documentation edit made through an inline Python heredoc whose text mentioned the CLI ("runs a command through a variable or substitution"), a false positive worth a lesson: the guard reads any word containing "eccode" as a possible invocation.
- D2 Reviewers and authors are separate agent contexts, but the same orchestrator wrote every dispatch prompt.
