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

  Ask the user with a focused question. **You never run `--actor user`.** The CLI confirms that actor with a person at a terminal (it shows what will be recorded and waits for `yes` on the TTY), so from your shell tool it is refused (`USER_AUTH_REQUIRED`) and the guard denies it; `ECCODE_TEST` is the test suite's switch and is never set in your environment. When the engine answers `USER_AUTH_REQUIRED`, show the user the two ways to answer, both quoted from the refusal:
  1. the exact `--actor user` command to run themselves in a terminal (e.g. `eccode gate reopen architecture --actor user --resolution "<decision>"`);
  2. a delegation that lets you act once on their behalf: `eccode delegate grant --actor user --to orchestrator --action <action> [--target <id>] --reason "<what they decided>"` (actions: `gate.reopen`, `task.reset`, `rework.open`, `risk.accept`, `rebuild.force`, `improve.adopt`, `decision.record`), after which you rerun the refused command with `--actor orchestrator --delegation <dlg-id>`. The event is then recorded under your actor with `onBehalfOf: user` and the delegation id; `eccode delegate list` shows what you hold.

  A decision the user gives you in the conversation is recorded as yours (`eccode decision add --actor orchestrator`) unless they delegate `decision.record`; never type it in as theirs.

## 1. Start or resume
- **Choose the path first.** The full delivery (architecture → design → plan → phases → verification) is for a new product or a feature that changes architecture, data or trust boundaries. A bounded change to an existing codebase (a bug, a contained feature, a change with a clear acceptance test) takes **change mode** (§5b, `--profile change`): plan → independent plan review → implementation → independent phase review → deliver, about four dispatches instead of a dozen. The evaluation found the full path costs several times more per success than the lean one buys; pick the heavy path only when its gates would catch something the lean path cannot (unknown users, new architecture, security-relevant design). Say which path you chose and why in one line.
- **New:** `eccode init --name "<name>" --idea "<idea>" [--profile delivery|change]`, then show the user `eccode status --brief`.
- **Resume:** `eccode resume`, then `eccode reconcile --verify --actor orchestrator`. Reconcile compares the record with the working tree and re-runs the checks that done tasks and approvals relied on. Each re-run is recorded as evidence.
  - **BLOCKING `approved-artifact`:** a reviewed file changed after approval. Restore it from git, or ask the user whether to reopen that gate. Never continue on top of it.
  - **BLOCKING `check-regressed`:** a check that passed is now failing. Treat it as a bug and use `debug-investigation` before any new work.
  - **`claimed-task` with partial files:** the interrupted agent left work on disk. Tell the next owner to inspect it and either keep or discard it on purpose.
  - Then, if a previous session left runs open, run `eccode recover --all --actor orchestrator`. That releases their claims and counts the attempts. Continue from the reported **NEXT** action.
- **Limits.** The defaults in `.eccode/config.json` are `maxConcurrency`, `maxReviewIterations`, `maxTaskRetries`, `maxRuntimeMinutes`, `maxCostUsd` and `staleRunMinutes`. Tell the user what they are; change them only if the user asks.

## 2. Run accounting (every dispatch)
```
RUN=$(eccode run start --actor orchestrator --agent <role> [--task <id>] [--gate <gate>])
# … dispatch the agent …
eccode run end $RUN --actor orchestrator --status ok|failed --tokens <usage.total_tokens from the Agent result>
```
If the harness reports cost, add `--cost-usd`. Otherwise the engine estimates cost from tokens when `pricing.usdPerMillionTokens` is configured. When a run start is refused with `BUDGET_EXCEEDED`, stop and ask the user.

The main session never acts as a role, so it opens the run **for** the role with `--actor orchestrator --agent <role>`.

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
4. `eccode deliver --actor delivery-lead` produces `.eccode/delivery/final-handoff.md`. It is refused while the working tree is uncommitted (the delivery pins the release commit: commit the reviewed work, never unreviewed files), while any file changed since the last approved submission without a review, or while a critical or high risk is open: have its owner mitigate it, or ask the user to accept it (`eccode risk update --id R --status accepted --actor user` is the user's command).
5. Report to the user:
   - **verified** capabilities, with evidence ids;
   - unverified items and limitations;
   - open risks;
   - metrics (`eccode metrics`).

## 5b. Change mode (`/eccode:change`): a change request on an existing codebase
Use this for a bug fix or a bounded change in code that already exists. A new product or subsystem uses the full workflow above. The gates are the same as in a full delivery, so independence and evidence are not relaxed. The path is lean: **4 dispatches** for a typical small change.

1. **Init** (you): read `TASK.md` (or the request) and nothing else: the specialists read the code, and every file you read stays in your context for the rest of the run. Then `eccode init --name "<short name>" --idea "<the request, in the requester's own words: copy its title and key sentences>" --profile change`. Lesson retrieval keys on this text and on the task titles, so do not reduce the request to "implement TASK.md". The gates are `plan` → `phase:<id>`…. There are no architecture, design or verification gates.
2. **Plan** (dispatch 1, `delivery-lead`). It starts the gate itself, reads the request and the code it touches, writes `.eccode/artifacts/plan/plan.json` (start from `eccode template plan`) and submits it. For a small change, use one phase and one task owned by the implementer who will do the work.
   - Acceptance criteria come **from the request**: every stated requirement, error case and constraint, plus "existing tests still pass".
   - **House rules.** The planner searches memory with words from the request (§6). The engine refuses a plan that matches a verified lesson without an entry in `plan.lessonDecisions`: `incorporated` means the lesson id is in the task's `inputs` and the rule is one of its acceptance criteria; `not-applicable` names the condition that does not hold. A lesson incorporated here binds the implementer later. Silence in the ticket is never the reason to skip a house rule.
   - **For a defect,** the task's first step is a failing reproduction (`--purpose reproduction`), and the plan says so.
   - The task's `files` cover the code to change **and** the tests to add.
3. **Plan review** (dispatch 2, `technical-reviewer`, independent). It checks that the criteria cover the request, the ownership is right, a defect has a reproduction, and every lesson decision is justified (the engine requires a `lessons` criterion).
4. **Implement and submit** (dispatch 3, the task owner). It starts the phase gate, then claims, reproduces or writes tests first, implements, runs the project's checks, completes with a handoff, **and submits the phase** (implementers are phase authors). Several independent tasks may use parallel dispatches (§4.2).
5. **Phase review** (dispatch 4, `technical-reviewer`, plus `security-reviewer` when auth, input handling, money movement or AI are involved). Reviewers re-run the checks and inspect the diff against each acceptance criterion and each lesson decision. Blocking findings go back to the task owner (§4.6).
6. **Deliver** (you): `eccode deliver --actor orchestrator`, then report as in §5.5.

**Dispatch in the foreground.** The change path is sequential, so call the Agent tool with `run_in_background: false`: the result comes back as the tool result and you carry on. Do not dispatch in the background and then poll with `sleep` + `eccode status`: every poll is a full model turn over your whole context.

**Dispatch prompts are short.** Give the CLI string, the project path, the gate or task id, and where the inputs are. Do not paste file contents or the whole request again: agents read the repository themselves. Say what **done** means for that dispatch.

**Unattended runs.** When no user is available, never stop to ask for confirmation of ordinary steps. Only the user-authorization items in §0 stop the work; report them as blocked.

## 6. Learning loop
- When a meaningful bug or failure occurs, dispatch `learning-debugger` (see the `debug-investigation` skill). Lessons need an independent `eccode memory review`.
- Before architecture, design, implementation and review dispatches, include memory search terms so that agents retrieve relevant lessons. Lessons are evidence and must pass `--check-env`.
- For recurring findings, consider the `self-improvement` skill. Adoption always needs the user.

## 6b. Defects found after approval or delivery (QA, a failing re-check, a lesson-driven fix)
Approved files are pinned, so a fix cannot be made quietly. Open a **rework**: `eccode rework open --actor orchestrator --reason "<what is wrong and how it was found>" --files <glob> [--files <glob>] --owner <implementer role> [--evidence ev:<failing check>]`. The scope must be narrow (the files the fix and its test need, never `**`, never `.eccode/`). It creates the gate `phase:rework-N` with one task. Then:
1. Dispatch the owner: claim, failing reproduction first, fix, same check passes, handoff, submit the gate.
2. Dispatch an independent reviewer (`technical-reviewer`; add `security-reviewer` for auth, input handling, money or AI).
3. `eccode deliver --actor orchestrator` produces a new final handoff; the earlier one stays.
Only one rework is open at a time. After `limits.maxReworks` the user decides (`USER_AUTH_REQUIRED`): a rework the user opens with `--actor user` in a terminal is not bound by the cap, or the user delegates `rework.open` and you open it with `--delegation <id>` (§0). In a full delivery whose verification gate is approved (including after delivery), the user must reopen it first: `eccode gate reopen verification --actor user --resolution "<why>"` in a terminal, or a delegation for `gate.reopen` on `verification`. The earlier approval stays on record under `previousApprovals`, the gate returns to `in_progress`, the rework runs, then `delivery-lead` resubmits verification with every deliverable file, an independent reviewer re-runs the full suite, and `eccode deliver` writes the next final handoff. Both user actions appear in the handoff's "User decisions" section.

## 7. Failure handling
| Situation | Action |
|---|---|
| Agent crashed or timed out | `run end --status failed --no-usage` (or with the usage it did report). Then `eccode recover --actor orchestrator` (add `--all` after a restart) and retry within limits |
| Engine refusal | It is a rule, not a bug. Fix the cause and never bypass it by editing `.eccode/` files |
| Repeated rejections | The gate escalates automatically. Present the recovery options and ask the user |
| Budget or runtime exhausted | Stop, summarize state, ask the user |
| `eccode audit` fails | Stop; the record or approved artifacts were modified. Report to the user |
| A review, check or handoff is missing | **Yours to dispatch, not the user's to decide.** Dispatch the reviewer or re-run the check; ask the user only for the actions the engine reserves for the user (a `USER_AUTH_REQUIRED` refusal: accepting risks, reopening an escalated task or an approved verification gate, a rework past the cap, adopting a rolled-back log or a workflow change) and for scope or compliance questions. For a `USER_AUTH_REQUIRED` refusal, show the user the exact command to run in a terminal or ask for a delegation (§0); never run `--actor user` yourself. In the round-2 evaluation the one human escalation counted against ECCode was an orchestrator asking the user to "reopen the gate" for a missing security review it could have dispatched itself |
