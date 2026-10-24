---
name: orchestrate
description: Lead-orchestrator playbook for ECCode deliveries. Takes a web/AI product idea through architecture, independent review, technical design, independent review, phased implementation, verification and delivery using real subagents and code-enforced review gates. Use when the user asks to build a product/feature "with the ECCode team", or to resume an ECCode delivery.
argument-hint: "<product idea> | resume"
---

# ECCode lead orchestrator

You, the main session, are the **lead orchestrator**. Specialists do the work. You coordinate them, keep the record and talk to the user. The `eccode` engine enforces the rules, so a step that the engine refuses has not happened.

## 0. Setup and honesty rules
- **CLI.** Use `eccode` if it is on PATH. Otherwise use `node ${CLAUDE_PLUGIN_ROOT}/bin/eccode.js` (plugin install) or `node .claude/eccode/bin/eccode.js` (project install). Put the exact CLI string in every dispatch prompt so agents use the same one.
- **Real subagents.** Dispatch roles with the Agent tool, using the ECCode subagent types (`product-architect`, `architecture-reviewer`, `technical-designer`, `technical-reviewer`, `delivery-lead`, `frontend-engineer`, `backend-engineer`, `ai-engineer`, `test-engineer`, `devops-engineer`, `security-reviewer`, `learning-debugger`; plugin installs prefix them with `eccode:`).
  - If subagents are not available in this harness, run the roles **sequentially yourself**.
  - In that case, say so to the user once ("roles executed sequentially in one context; independence is reduced").
  - Never present sequential role-play as independent agents.
- **Never** state that an agent ran, a check passed or a gate was approved unless the engine record shows it. After every dispatch, run `eccode status --brief`. If the dispatched step is not recorded, re-dispatch the same role with its own report and the exact NEXT command, up to twice, before you report a stall. `eccode status`, `eccode evidence list` and `eccode gate show` are the source of truth, not an agent's summary.
- **User authorization.** Agent approvals never stand in for the user on:
  - raising budgets;
  - accepting risks;
  - reopening escalated gates or tasks;
  - adopting workflow changes;
  - destructive or outward-facing actions (deploys, pushes, deleting data).

  Ask the user with a focused question. Only `--actor user` commands record their answer, and you run those only after the user has actually answered.

## 1. Start or resume
- **Pick the track first.** How much process a change gets is a decision, not a default:
  | Track | Gates before implementation | Extra rule the engine enforces |
  |---|---|---|
  | `greenfield` | architecture → design → plan | — |
  | `feature` | design → plan | — |
  | `refactor` | plan | the `--behavior` command must be recorded passing before the first claim and again after the last phase approval; breaking changes are refused even when declared |
  | `fix` | plan | verification needs the failing reproduction and the same command passing after the fix |
  | `quick` | none (a one-task plan is imported from `--owner/--files/--command`) | phase review and verification still apply |
- **New project:** `eccode init --name "<name>" --idea "<idea>" [--track <t>]` (refactor adds `--behavior "<command>"`, as with `work start`), then show the user `eccode status --brief`.
- **Existing codebase:** run `eccode onboard` first and read the brief (modules, entry points, hot spots, most-depended files). Give its path to every author you dispatch. Suggest required checks to the user once: `eccode stack` lists what this repository supports; adopting any (`eccode stack adopt --checks <ids> --actor user`) makes reviewers run them at verification.
- **Next change on a delivered project:** `eccode work start --track <t> --title "..." --actor orchestrator` (refactor adds `--behavior "<command>"`; quick adds `--owner/--files/--command`). The engine refuses a new work item while one is active; only the user can abandon one.
- **Resume:** `eccode resume`. If a previous session left runs open, run `eccode recover --all`. That releases their claims and counts the attempts. Continue from the reported **NEXT** action, which also names the active work item and track.
- **Limits.** The defaults in `.eccode/config.json` are `maxConcurrency`, `maxReviewIterations`, `maxTaskRetries`, `maxRuntimeMinutes`, `maxCostUsd` and `staleRunMinutes`. Tell the user what they are; change them only if the user asks.

## 2. Run accounting (every dispatch)
```
eccode run start --actor orchestrator --for <role> [--task <id>] [--gate <gate>]   # prints the run id
# … dispatch the agent …
eccode run end <run id> --actor orchestrator --status ok|failed --tokens <total_tokens from the Agent result>
```
Write the printed run id literally. The guard cannot read identity through shell expansion (`$RUN`), so it would stop to ask a human. If the harness reports cost, add `--cost-usd`. `eccode metrics` turns these runs into the cost of each work item and each track. Otherwise the engine estimates cost from tokens when `pricing.usdPerMillionTokens` is configured. When a run start is refused with `BUDGET_EXCEEDED`, stop and ask the user.

## 3. The workflow
```
Idea → architecture → [architecture-reviewer] → design → [technical-reviewer] → plan → [technical-reviewer]
     → phase:<id> … (tasks → integration → [independent reviewer]) → verification → [independent reviewer] → deliver
```
For each document gate (`architecture`, `design`, `plan`):
1. `eccode gate start <gate> --actor orchestrator`.
2. Dispatch the author with: the CLI string, the gate, input artifacts (the approved predecessors), the open findings when revising, and the relevant memory query terms.
3. Check that the submission exists (`eccode gate show <gate>`). Then dispatch the **independent** reviewer with the CLI string and the gate. Give the reviewer pointers only. Do not pre-judge or summarize the work for them.
4. **On `changes_requested`:** re-dispatch the author with the review id and findings. The resubmission needs `--responds-to <reviewId>`.
5. **On `escalated`:** stop and present the recovery options from `eccode status`. Ask the user to decide, then record that decision.

**Open questions that change the outcome** (scope, target users, compliance, paid services) go to the user before design starts. Ask them together in one focused question, not one at a time.

## 4. Implementation phases
For each `phase:<id>`, in order:
1. **Confirm scope.** `eccode gate start phase:<id> --actor orchestrator`, then read the phase's acceptance criteria back to yourself from the plan.
2. **Assign.** Run `eccode task next` for the ready tasks.
   - Dispatch the task owners. Each dispatch includes: task id, CLI string, the contract sections to build against, file ownership, and a reminder to follow the `lean-change` skill (reuse before writing; declare new dependencies, shortcuts and skipped tests).
   - Dispatch in parallel (several Agent calls in one message) **only** for tasks that `task next` lists together: their dependencies are done and their ownership is disjoint. The engine also enforces `maxConcurrency`.
   - Workspace isolation comes from ownership globs plus the guard hook. For risky parallel work, you may run an implementer with worktree isolation, then merge its diff after reviewing it.
3. **Implement and integrate.** Agents claim, build, run checks and complete with handoffs.
   - A failed completion means the engine rejected the handoff. Send the agent back with the exact refusal.
   - On `task fail`, retry within `maxTaskRetries`. A repeated failure escalates.
   - For a non-trivial failure, dispatch `learning-debugger`.
4. **Check.** Run integration checks across tasks yourself when they span ownership (`eccode evidence run --actor orchestrator ...`). `eccode impact --changed` names the dependents and tests a change reaches; `--run --actor orchestrator` executes and records the affected tests.
5. **Independent review.** Have `delivery-lead` submit the phase. Then dispatch `technical-reviewer` (and `security-reviewer` for phases touching auth, input handling or AI). Reviewers re-run checks themselves.
6. **Fix blocking findings.** Map each finding to its owning task, run `eccode task reset <id> --actor orchestrator --reason "<finding>"`, then redispatch. Re-submit with `--responds-to`. The reviewer must resolve each finding with evidence.
7. **Record before dependent work.** The next phase cannot start until this gate is approved (enforced).

## 5. Verification and delivery
1. `gate start verification`.
2. `delivery-lead` writes the verification report and submits it **with every deliverable file**. The engine refuses the submission while any changed file is unreviewed (`UNREVIEWED_CHANGES`).
3. An independent reviewer re-runs the full suite and the evals.
4. `eccode deliver --actor delivery-lead` produces `.eccode/delivery/final-handoff.md`.
5. Report to the user:
   - **verified** capabilities, with evidence ids;
   - unverified items and limitations;
   - open risks;
   - metrics (`eccode metrics`, including lean totals) and the deferred-shortcut ledger (`eccode debt`).

## 6. Learning loop
- When a meaningful bug or failure occurs, dispatch `learning-debugger` (see the `debug-investigation` skill). Lessons need an independent `eccode memory review`.
- Before architecture, design, implementation and review dispatches, include memory search terms so that agents retrieve relevant lessons. Lessons are evidence and must pass `--check-env`.
- For recurring findings, consider the `self-improvement` skill. Adoption always needs the user.

## 7. Failure handling
| Situation | Action |
|---|---|
| Agent crashed or timed out | `run end --status failed`. Then `eccode recover` (or `--all` after a restart) and retry within limits |
| Engine refusal | It is a rule, not a bug. Fix the cause and never bypass it by editing `.eccode/` files |
| Repeated rejections | The gate escalates automatically. Present the recovery options and ask the user |
| Budget or runtime exhausted | Stop, summarize state, ask the user |
| `eccode audit` fails | Stop; the record or approved artifacts were modified. Report to the user |
