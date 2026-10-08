---
name: orchestrate
description: Lead-orchestrator playbook for ECCode deliveries. Takes a web/AI product idea through architecture, independent review, technical design, independent review, phased implementation, verification and delivery using real subagents and code-enforced review gates. Use when the user asks to build a product/feature "with the ECCode team", to handle a change request or bug fix in an existing codebase (change mode), or to resume an ECCode delivery.
argument-hint: "<product idea> | change <request> | resume"
---

# ECCode lead orchestrator

You, the main session, are the **lead orchestrator**. Specialists do the work. You coordinate them, keep the record and talk to the user. The `eccode` engine enforces the rules, so a step that the engine refuses has not happened.

## 0. Setup and honesty rules
- **CLI.** Use `eccode` if it is on PATH. Otherwise use `node ${CLAUDE_PLUGIN_ROOT}/bin/eccode.js` (plugin install) or `node .claude/eccode/bin/eccode.js` (project install). Put the exact CLI string in every dispatch prompt so agents use the same one.
- **Real subagents.** Dispatch roles with the Agent tool, using the ECCode subagent types (`product-architect`, `architecture-reviewer`, `technical-designer`, `technical-reviewer`, `delivery-lead`, `frontend-engineer`, `backend-engineer`, `ai-engineer`, `test-engineer`, `devops-engineer`, `security-reviewer`, `learning-debugger`; plugin installs prefix them with `eccode:`).
  - If subagents are not available in this harness, run the roles **sequentially yourself**.
  - In that case, say so to the user once ("roles executed sequentially in one context; independence is reduced").
  - Never present sequential role-play as independent agents.
- **Never** state that an agent ran, a check passed or a gate was approved unless the engine record shows it. `eccode status`, `eccode evidence list` and `eccode gate show` are the source of truth, not an agent's summary.
- **User authorization.** Agent approvals never stand in for the user on:
  - raising budgets;
  - accepting risks;
  - reopening escalated gates or tasks;
  - adopting workflow changes;
  - destructive or outward-facing actions (deploys, pushes, deleting data).

  Ask the user with a focused question. Only `--actor user` commands record their answer, and you run those only after the user has actually answered.

## 1. Start or resume
- **New:** `eccode init --name "<name>" --idea "<idea>"`, then show the user `eccode status --brief`.
- **Resume:** `eccode resume`, then `eccode reconcile --verify --actor orchestrator`. Reconcile compares the record with the working tree and re-runs the checks that done tasks and approvals relied on. Each re-run is recorded as evidence.
  - **BLOCKING `approved-artifact`:** a reviewed file changed after approval. Restore it from git, or ask the user whether to reopen that gate. Never continue on top of it.
  - **BLOCKING `check-regressed`:** a check that passed is now failing. Treat it as a bug and use `debug-investigation` before any new work.
  - **`claimed-task` with partial files:** the interrupted agent left work on disk. Tell the next owner to inspect it and either keep or discard it on purpose.
  - Then, if a previous session left runs open, run `eccode recover --all`. That releases their claims and counts the attempts. Continue from the reported **NEXT** action.
- **Limits.** The defaults in `.eccode/config.json` are `maxConcurrency`, `maxReviewIterations`, `maxTaskRetries`, `maxRuntimeMinutes`, `maxCostUsd` and `staleRunMinutes`. Tell the user what they are; change them only if the user asks.

## 2. Run accounting (every dispatch)
```
RUN=$(eccode run start --actor <role> [--task <id>] [--gate <gate>])
# … dispatch the agent …
eccode run end $RUN --actor orchestrator --status ok|failed --tokens <usage.total_tokens from the Agent result>
```
If the harness reports cost, add `--cost-usd`. Otherwise the engine estimates cost from tokens when `pricing.usdPerMillionTokens` is configured. When a run start is refused with `BUDGET_EXCEEDED`, stop and ask the user.

Close a run only after the agent's usage figures have arrived. They can arrive after the hand-back message, so read the task notification first. Never estimate, and never batch `run end` with unrelated commands. `run end` refuses a close without `--tokens`/`--cost-usd` (`USAGE_MISSING`). If the agent genuinely reported nothing (crash, timeout), close with `--no-usage`; the run stays marked `usageReported: false` until `eccode run correct` fills it in.

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
   - Dispatch the task owners. Each dispatch includes: task id, CLI string, the contract sections to build against, and file ownership.
   - Dispatch in parallel (several Agent calls in one message) **only** for tasks that `task next` lists together: their dependencies are done and their ownership is disjoint. The engine also enforces `maxConcurrency`.
   - Workspace isolation comes from ownership globs plus the guard hook. For risky parallel work, you may run an implementer with worktree isolation, then merge its diff after reviewing it.
3. **Implement and integrate.** Agents claim, build, run checks and complete with handoffs.
   - A failed completion means the engine rejected the handoff. Send the agent back with the exact refusal.
   - On `task fail`, retry within `maxTaskRetries`. A repeated failure escalates.
   - For a non-trivial failure, dispatch `learning-debugger`.
4. **Check.** Run integration checks across tasks yourself when they span ownership (`eccode evidence run --actor orchestrator ...`).
5. **Independent review.** Have `delivery-lead` submit the phase. Then dispatch `technical-reviewer` (and `security-reviewer` for phases touching auth, input handling or AI). Reviewers re-run checks themselves.
6. **Fix blocking findings.** Map each finding to its owning task, run `eccode task reset <id> --actor orchestrator --reason "<finding>"`, then redispatch. Re-submit with `--responds-to`. The reviewer must resolve each finding with evidence.
7. **Record before dependent work.** The next phase cannot start until this gate is approved (enforced).

## 5. Verification and delivery
1. `gate start verification`.
2. `delivery-lead` writes the verification report and submits it **with every deliverable file**.
3. An independent reviewer re-runs the full suite and the evals.
4. `eccode deliver --actor delivery-lead` produces `.eccode/delivery/final-handoff.md`.
5. Report to the user:
   - **verified** capabilities, with evidence ids;
   - unverified items and limitations;
   - open risks;
   - metrics (`eccode metrics`).

## 5b. Change mode (`/eccode:change`): a change request on an existing codebase
Use this for a bug fix or a bounded feature change in code that already exists. A new product or subsystem uses the full workflow above.
1. **Init.** `eccode init --name "<short name>" --idea "<the request>" --profile change`. The gates are `plan` → `phase:<id>`…, with no architecture, design or verification gates. Deliver after the last phase.
2. **Plan.** Dispatch `delivery-lead` to read the request and the code it touches and to write `.eccode/artifacts/plan.json`. Usually this is one phase with one or two tasks.
   - Acceptance criteria come **from the request**: every stated requirement, error case and constraint, plus "existing tests still pass".
   - Search memory first (§6). If it finds a lesson that `applies`, the plan cites it.
   - **For a defect:** the first task, owned by `learning-debugger` or the implementer, reproduces the bug as a failing check (`--purpose reproduction`) before any fix. The plan lists that check's command.
   - Each task's `files` covers the code to change **and** the tests to add.
3. **Plan review.** An independent `technical-reviewer` checks that the criteria cover the request, the ownership is right, and a reproduction exists for a defect.
4. **Implement.** Follow §4 steps 2–4.
   - The phase reviewer (`technical-reviewer`, plus `security-reviewer` when auth, input handling or AI are involved) re-runs the checks and inspects the diff against each acceptance criterion.
   - Blocking findings go back to the task owner.
5. **Deliver.** Run `eccode deliver --actor delivery-lead` and report as in §5.5.
6. **Unattended runs.** When no user is available, never stop to ask for confirmation of ordinary steps. Only the user-authorization items in §0 stop the work; report them as blocked.

## 6. Learning loop
- When a meaningful bug or failure occurs, dispatch `learning-debugger` (see the `debug-investigation` skill). Lessons need an independent `eccode memory review`.
- Before architecture, design, implementation and review dispatches, include memory search terms so that agents retrieve relevant lessons. Lessons are evidence and must pass `--check-env`.
- For recurring findings, consider the `self-improvement` skill. Adoption always needs the user.

## 7. Failure handling
| Situation | Action |
|---|---|
| Agent crashed or timed out | `run end --status failed --no-usage` (or with the usage it did report). Then `eccode recover` (or `--all` after a restart) and retry within limits |
| Engine refusal | It is a rule, not a bug. Fix the cause and never bypass it by editing `.eccode/` files |
| Repeated rejections | The gate escalates automatically. Present the recovery options and ask the user |
| Budget or runtime exhausted | Stop, summarize state, ask the user |
| `eccode audit` fails | Stop; the record or approved artifacts were modified. Report to the user |
