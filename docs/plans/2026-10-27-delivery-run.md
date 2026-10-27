# Delivery Run Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix what stopped the engine delivering large Mealie changes (register row 138), then measure delivery under row 138's rule in a pre-registered run on all 16 mealie4 items.

**Architecture:**
- **Engine:** a reviewed rescope replaces "only the user changes a reviewed plan's task". The delivery lead proposes; a plan reviewer who is not the proposer approves or rejects; both are recorded as events.
- **Evidence:** the default evidence timeout becomes 30 minutes.
- **Role prompts:** checks sized to the step.
- **Harness, for both variants:** the mealie4 tasks get Mealie's dev environment, a new agent command allows deleting Mealie's test temp directory, and runs get 4 hours.
- **Analysis:** a new `bench/pilot/delivery.js` computes the registered figures.

**Tech Stack:** Node 18+ (no dependencies), `node --test`, the existing bench harness and Mealie suite tools.

**Spec:** docs/specs/2026-10-27-delivery-run-design.md

## Global Constraints

- **Engine version 0.16.0,** bumped with the docs in Task 7.
- **Evidence default timeout:** `eccode evidence run` defaults to 1,800,000 ms (it was 600,000); `--timeout` still overrides it.
- **Run limit:** every measured run uses `--timeout 14400`. The "within 2 hours" figure uses 7,200,000 ms.
- **Mealie dev environment for mealie4:** `PRODUCTION=false` and `PYTHONPATH=.` in each task's `env`. Earlier suites (mealie, mealie2, mealie3) are not rebuilt.
- **Agent command:** `$AGENT_D` = `$AGENT_B` plus `Bash(rm -rf tests/.temp*)`, `Bash(rm -r tests/.temp*)` and `Bash(rm tests/.temp*)`. It is the same for both variants.
- **Runs:**
  - engine, 2 per item on all 16 items = 32 planned runs: e1 takes items 01–06, e2 07–11, e3 12–16;
  - bare, 2 per item = 32 runs, all in process w.
- **Cost ceilings:** `--max-cost` 60 for each engine process and 30 for w.
- **Primary:** delivered with a clean audit in at least 80% of the 32 planned engine runs. A run never started counts as not delivered.
- **Secondary:** at most 1 false refusal per engine run.
- **In-sample items:**
  - `mealie4-01-feature-17398941`
  - `mealie4-05-fix-fb221afa`
  - `mealie4-07-feature-b386e728`
- **Conventions, carried over:**
  - labels before figures;
  - no Mealie file in the repository;
  - no model identifiers in commits or artifacts;
  - the commit trailer from the session's attribution rule;
  - never force-push;
  - PR to `claude/keen-allen-5z33eb`.

## Review Focus

1. **A rescope proposal is left open while its task is claimed.** Approving it then must be refused, because only a pending task changes (Task 1 test).
2. **The user rescopes directly while a proposal is open.** The proposal is superseded and closed, and cannot be approved afterwards (Task 1 test).
3. **A proposal's files overlap an active task by the time it is reviewed.** The approval is refused with the conflict (Task 1 test).
4. **A planned engine run never started** (cost ceiling or a cut process). It counts as not delivered in the primary (Task 4 test).
5. **A delivered run whose agent ended after 7,200 s.** It counts in the 4-hour figure but not in "within 2 hours" (Task 4 test).

---

### Task 1: Reviewed rescope

**Files:**
- Modify:
  - `lib/tasks.js` (`rescope`, new `reviewRescope`);
  - `lib/reducer.js` (two new events, `task.rescoped` closes a proposal);
  - `bin/eccode.js` (`task rescope` output, new `task rescope-review`, help line);
  - `lib/mcp.js` (new `task_rescope_review` tool, updated `task_rescope` description).
- Test: `tests/quick.test.js` (next to `on a reviewed plan only the user changes ownership`), `tests/mcp.test.js`.

**Interfaces:**
- **Produces:**
  - `tasks.rescope(store, config, taskId, actor, { files, command, reason })`.
    - On a reviewed plan, an actor in `config.roles.plan.authors` gets back `{ proposed: true, proposal: '<rsc-id>' }`, and the task does not change. The user still applies directly.
    - Any other actor is refused with `ROLE_NOT_ALLOWED`.
  - `tasks.reviewRescope(store, config, taskId, actor, { decision: 'approve'|'reject', reason })`.
    - The actor must be in `config.roles.plan.reviewers`, and must not be the proposer.
  - **Events:**
    - `task.rescope_proposed {task, proposal, files, command, reason}`;
    - `task.rescope_reviewed {task, proposal, decision: 'reject', reason}`;
    - an approval commits `task.rescoped {task, files, command, reason, proposal, approvedBy, review}`.
  - **State:** `state.tasks[id].rescopeProposal = {id, by, at, files, command, reason}` or `null`.
  - **CLI:** `eccode task rescope-review <task> --decision approve|reject --reason <text> --actor <reviewer>`.
  - **MCP:** `task_rescope_review {task, decision, reason}`.

- [ ] **Step 1: Write the failing tests** in `tests/quick.test.js`:

```js
test('on a reviewed plan the delivery lead proposes a rescope and a plan reviewer applies it', () => {
  const ctx = require('./helpers').tmpProject();
  require('./helpers').approveThroughPlan(ctx);
  const tasks = require('../lib/tasks');
  const p = tasks.rescope(ctx.store, ctx.config, 'api', 'delivery-lead', { files: 'src/server/**,src/shared/**', reason: 'the api task needs the shared types' });
  assert.strictEqual(p.proposed, true);
  assert.deepStrictEqual(ctx.store.state().tasks.api.files, ['src/server/**'], 'a proposal changes nothing');
  expectCode(() => tasks.reviewRescope(ctx.store, ctx.config, 'api', 'delivery-lead', { decision: 'approve', reason: 'I approve my own proposal' }), 'ROLE_NOT_ALLOWED');
  tasks.reviewRescope(ctx.store, ctx.config, 'api', 'technical-reviewer', { decision: 'approve', reason: 'shared types are the api contract' });
  const t = ctx.store.state().tasks.api;
  assert.deepStrictEqual(t.files, ['src/server/**', 'src/shared/**']);
  assert.strictEqual(t.rescopeProposal, null);
  assert.strictEqual(t.history.find((h) => h.event === 'rescoped').approvedBy, 'technical-reviewer');
  assert.strictEqual(ctx.store.audit().ok, true);
});

test('a rescope proposal: engineers cannot propose, one at a time, a rejection or a user rescope closes it, and only a pending, unconflicted task changes', () => {
  // backend-engineer proposes → ROLE_NOT_ALLOWED
  // second proposal while one is open → INVALID_TRANSITION
  // reject → rescopeProposal null, files unchanged; approving after → INVALID_TRANSITION
  // propose, then the user rescopes directly → rescopeProposal null (superseded)
  // propose, claim the task, approve → INVALID_TRANSITION
  // propose files overlapping another claimed task, approve → OWNERSHIP_CONFLICT
});
```

  Write the second test's six cases as code, with the codes shown. A CLI case goes in `tests/quick.test.js` too:
  - `task rescope … --actor delivery-lead` prints `rescope-review`;
  - `task rescope-review … --decision approve --actor technical-reviewer` prints the new files.

  In `tests/mcp.test.js`, a case where the `task_rescope_review` tool exists and applies an approved proposal.

- [ ] **Step 2: Run them to verify they fail.**
  - Run: `node --test --test-name-pattern="rescope" tests/quick.test.js tests/mcp.test.js`
  - Expected: FAIL, `ROLE_NOT_ALLOWED` on the delivery lead's proposal, and `tasks.reviewRescope is not a function`.

- [ ] **Step 3: Implement.**
  - **`lib/tasks.js`:** split the role check of `rescope`:
    - one-task tracks keep the orchestrator or the user;
    - on a reviewed plan, the user applies, a plan author proposes, and anyone else is refused.

    Shared validation (files or command present, a reason of at least 10 characters, a pending task) runs for proposals and approvals alike.
  - **`reviewRescope`:** needs an open proposal, a plan reviewer who is not the proposer, a pending task, and no overlap with a claimed task's files. The reason is at least 10 characters.
  - **Reducer:** `task.rescope_proposed` sets `rescopeProposal`. `task.rescope_reviewed` clears it and adds a `rescope-rejected` history entry. `task.rescoped` clears it and records `approvedBy` and `proposal` in its history entry when present.
  - **The usage message** names both paths: the user, or a plan author's proposal for a plan reviewer.

- [ ] **Step 4: Run them to verify they pass,** then the files they touch.
  - Run: `node --test tests/quick.test.js tests/mcp.test.js tests/debug.test.js`
  - Expected: all pass, including `on a reviewed plan only the user changes ownership` (the orchestrator is still refused).

- [ ] **Step 5: Commit.** `Engine: a reviewed plan's task can be rescoped by a reviewed proposal, not only by the user`

### Task 2: A 30-minute evidence default, and role guidance

**Files:**
- Modify: `lib/evidence.js` (`DEFAULT_TIMEOUT_MS`, exported), `bin/eccode.js` (help line for `evidence run`).
- Modify:
  - `agents/delivery-lead.md`;
  - `agents/technical-reviewer.md`;
  - `agents/backend-engineer.md`, `agents/frontend-engineer.md`, `agents/test-engineer.md`;
  - `skills/orchestrate/SKILL.md`.
- Test: `tests/integrity.test.js` (evidence default), `tests/quick.test.js` (guidance strings).

- [ ] **Step 1: Write the failing tests.**
  - `evidence run waits 30 minutes by default`: `assert.strictEqual(require('../lib/evidence').DEFAULT_TIMEOUT_MS, 1800000)`, and the CLI help for `evidence run` says `default 1800 s`.
  - `the shipped guidance routes a reviewed plan's change through a reviewed rescope`:
    - `agents/delivery-lead.md` contains `task rescope` and no longer says `only the user can change an approved plan`;
    - `agents/technical-reviewer.md` contains `task rescope-review`;
    - `skills/orchestrate/SKILL.md` contains `rescope-review`.
  - `engineers run their task's planned check, not whole test directories`: each of the three engineer files contains `planned check`.
- [ ] **Step 2: Run them to verify they fail.**
  - Run: `node --test --test-name-pattern="30 minutes|reviewed rescope|planned check" tests/integrity.test.js tests/quick.test.js`
  - Expected: FAIL.
- [ ] **Step 3: Implement.**
  - Export `DEFAULT_TIMEOUT_MS = 1800000` and use it as `runCommand`'s default.
  - Update the help line.
  - Edit the agent and skill texts as in spec 3.1 and 3.3:
    - the delivery lead proposes a rescope when a planned check cannot run or a file belongs to no task, and writes needed variables inside the check (`env NAME=value …`);
    - the reviewer reviews proposals and runs the narrowest check covering the submission;
    - engineers run their planned check and touched tests;
    - the orchestrator dispatches propose-then-review instead of asking the user.
- [ ] **Step 4: Run** `npm test`. Expected: `# fail 0`.
- [ ] **Step 5: Commit.** `Engine: 30-minute evidence default; guidance for reviewed rescopes and checks sized to the step`

### Task 3: Harness — Mealie's dev environment and the agent command

**Files:**
- Modify:
  - `bench/suites/mealie/_tools/build.js` (export `DEV_ENV = { PRODUCTION: 'false', PYTHONPATH: '.' }`, merged into each task's `env`);
  - `bench/suites/mealie4/*/task.json` (rebuilt by `build.js --suite bench/suites/mealie4`).
- Create: `bench/pilot/agents-delivery.sh` (`$AGENT_D`, with a header saying what changed from `$AGENT_B` and why).
- Test: `tests/mealie.test.js`.

- [ ] **Step 1: Write the failing test.** `mealie4 tasks run in Mealie's dev environment`:
  - `build.js`'s `DEV_ENV` equals `{ PRODUCTION: 'false', PYTHONPATH: '.' }`;
  - every mealie4 `task.json` `env` contains both;
  - `agents-delivery.sh`'s `AGENT_D` equals `AGENT_B` plus exactly the three `rm` patterns. Parse both files' `--allowedTools` lists.
- [ ] **Step 2: Run it to verify it fails.**
  - Run: `node --test --test-name-pattern="dev environment" tests/mealie.test.js`
  - Expected: FAIL.
- [ ] **Step 3: Implement,** then rebuild:
  - Run: `node bench/suites/mealie/_tools/build.js --suite bench/suites/mealie4`
  - Expected: 16 lines, the same ids and tracks as before. `git diff --stat bench/suites/mealie4` shows only `task.json` env changes.
- [ ] **Step 4: Run** `node --test tests/mealie.test.js`. Expected: pass.
- [ ] **Step 5: Commit.** `Mealie suites: tasks run in Mealie's dev environment; the delivery run's agent command`

### Task 4: The analysis, `bench/pilot/delivery.js`

**Files:**
- Create: `bench/pilot/delivery.js`.
- Test: `tests/pilot.test.js`.

**Interfaces:**
- Consumes from `bench/pilot/proof.js`: `readRuns`, `passed`, `runKeys`, `friction`. Consumes `stratifiedTest` from `lib/bench.js`.
- Produces `report({ engine, bare, labels, friction, rescopes, planned, inSample, withinMs = 7200000 }) -> string` (markdown), with these lines:
  - **Delivery (primary):** `delivered/planned`, met when at least 0.8 × planned;
  - **Within 2 hours:** delivered runs with `durationMs <= withinMs`;
  - **In-sample / out-of-sample:** delivered over planned for each;
  - **Friction (secondary):** as in `multifile.js`;
  - **Correctness:** engine against bare passed (a run marked or measured as timed out fails), with the stratified test over items that have both;
  - **Rescopes:** proposed, approved, rejected;
  - median cost and run time.
- Also produces `rescopes(dir, rows) -> { proposed, approved, rejected }`, read from each engine run's copied record (`tr-<process>/<transcripts.dir>/record/events.jsonl`).
- CLI: `node bench/pilot/delivery.js --runs <dir> --labels <failures.json> --refusals <refusals.json> --planned 32 [--out <md>]`.
  - Engine processes are `e1`–`e3` and the bare process is `w`.
  - Typed lines are skipped, and runs of at least 14,400,000 ms are marked timed out.
  - It refuses to run while any failed run has no label.

- [ ] **Step 1: Write the failing tests** (`multifile run`-style fixtures):
  - `delivery run: planned runs never started count as not delivered`: 30 rows, planned 32, met when `delivered >= 0.8 * planned` (25.6).
    - 25 delivered: expect `25/32` and `missed`.
    - 26 delivered: expect `26/32` and `met`.
  - `delivery run: within 2 hours counts only runs that ended by 7,200 s`: a delivered run with `durationMs: 9000000` counts in the 4-hour figure and not in "within 2 hours".
  - `delivery run: in-sample and out-of-sample are reported apart, and an unlabelled failure stops the analysis`.
  - `delivery run: rescopes are counted from the copied records`: a temporary `tr-e1/<dir>/record/events.jsonl` holding one proposed-and-approved rescope and one rejected one. Expect `{ proposed: 2, approved: 1, rejected: 1 }`.
- [ ] **Step 2: Run them to verify they fail.**
  - Run: `node --test --test-name-pattern="delivery run" tests/pilot.test.js`
  - Expected: FAIL (module not found).
- [ ] **Step 3: Implement** `bench/pilot/delivery.js` to the interface above. Reuse `proof.js` and the timeout marking from `multifile.js`; export it there rather than copying it.
- [ ] **Step 4: Run** `node --test tests/pilot.test.js`. Expected: pass.
- [ ] **Step 5: Commit.** `Delivery run analysis: delivery over planned runs, within 2 hours, in and out of sample`

### Task 5: Validate, smoke, register

**Files:**
- Create: `bench/protocols/<registration date>-mealie-delivery.md`.
- Modify: `bench/suites/mealie4/README.md`, with a line on the dev environment and the re-validation.

- [ ] **Step 1: Live validation of the rebuilt mealie4.** Run `ECCODE_MEALIE_VALIDATE=1` "mealie4 live" in three shards, as for the multi-file run (scratch `validate-live.js`). Expected: every target fails at its source commit and passes at its fix, and every regression check passes at both. A failure is a ruling: fix the environment or exclude the item, and record it in the protocol.
- [ ] **Step 2: Smoke run.** One engine run on item 08 from the working tree with `$AGENT_D` and `--timeout 14400`. It is not counted. Expected: it runs to the end with a result line. Record its outcome for the protocol.
- [ ] **Step 3: Write the protocol** from the spec. It records:
  - the commands for e1–e3 and w, with `$AGENT_D`, `--timeout 14400`, `--runs 2` and the ceilings from Global Constraints;
  - the save and transcript paths under `<scratch>/delivery/`;
  - the label rules;
  - the criteria with exact thresholds;
  - the restart procedure (the multi-file run's amendment 1);
  - the validation and smoke results;
  - the risks from spec section 10.
- [ ] **Step 4: Register.** Commit and push the protocol, then pin a worktree at that commit (`/tmp/mp/wt5`).
- [ ] **Step 5: Ledger** the registration commit and time.

### Task 6: The batch and its labels

- [ ] **Step 1: Clear old scratch** if free disk is under 4 GB: old sandboxes under `/tmp/mp`, never the saved runs.
- [ ] **Step 2: Launch** e1, e2, e3 and w detached from `/tmp/mp/wt5`, writing to `<scratch>/delivery`, with a timeline file. Arm a watcher and a safety-net check-in.
- [ ] **Step 3: Label as runs finish.**
  - Replay every failed run of either variant on a clean tree (`proof-replay.js`, both checks), and label it with a reason.
  - Label every engine refusal with the refusal tools (copied to scratch from the multi-file run's).
- [ ] **Step 4: Commit the labels** to `bench/pilot/mealie/labels-delivery/` before computing any figure.
- [ ] **On a restart:** commit an amendment first, then follow the multi-file run's amendment-1 procedure.

### Task 7: Analyse, report, fix, ship

**Files:**
- Create:
  - `bench/pilot-results/<registration date>-mealie-delivery.md`;
  - `.runs.jsonl` beside it.
- Modify:
  - `docs/limits.md` (row 138, row 59, new rows);
  - `README.md`, `docs/final-report.md`, `docs/senior-engineering.md`;
  - `package.json`, `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json` (0.16.0).

- [ ] **Step 1: Analyse.**
  - Run: `node bench/pilot/delivery.js --runs <scratch>/delivery --labels … --refusals … --planned 32`
  - Expected: a Delivery line saying met or missed, then Friction and Correctness.
- [ ] **Step 2: Write the report,** labels before figures, disclosing every deviation and cut run.
- [ ] **Step 3: Fix each defect the run exposes,** test-first, with a register row each.
- [ ] **Step 4: Update the register.** Row 138 closes if the primary is met and stays open otherwise. Row 59 gains the correctness figures.
- [ ] **Step 5: Get a final whole-branch review** from a fresh reviewer, then do the fix pass. Then run `npm test` (expected `# fail 0`), commit and push.
- [ ] **Step 6: Ship.** Open the PR to `claude/keen-allen-5z33eb` and drive CI to green, then merge as with PR #24. Update the evaluation doc.
