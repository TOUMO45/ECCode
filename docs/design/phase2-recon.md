# Phase 2 reconnaissance: how ECCode is built today

Written before any Phase 2 code, from reading the engine (v0.15.0, commit `e3e8b75`). Every statement names the file it comes from.

## 1. Language, layout, entry points

- **One language, zero dependencies.** The engine is CommonJS Node ≥ 18.17 (`package.json`, `engines`). There is no runtime dependency; the JSON-Schema validator is in-house (`lib/schema.js`). Python appears only as the *subject* of tools (Mealie, the realbugs suite) and in helper scripts the engine runs with the project's interpreter (`scripts/trace/sitecustomize.py`, `bench/pilot/mealie/*.py`).
- **CLI:** `bin/eccode.js`. `main(argv)` parses flags with `lib/cli-args.js`, finds the record root (`--root`, `ECCODE_ROOT`, or the nearest `.eccode/events.jsonl`), reads `--actor` (or `ECCODE_ACTOR`, never `user`), then dispatches by command group. Exit codes: 0 ok, 1 usage or internal error, 2 refused by a rule (`EccodeError` with any code but `USAGE`). Commands that run before a record exists: `init`, `quick`, `debug`, `mcp`, `install`, `export`; the rest call `store.assertInitialized()`.
- **MCP servers:** `lib/mcp.js`. One stdio JSON-RPC server per role (`eccode mcp --actor <role>`), locked to that actor at start; `LOCKABLE` lists the roles. The tool table is one list for every role (`tools()`): role scoping is done by the engine's own rules, not by the tool list. `evidence_run`, `mutate` and `fix_verify` accept only *approved commands* (`approvedCommands`: planned verification commands, the behavior command, detected stack checks). `lib/install.js` registers `eccode_<role>` servers in `.mcp.json` and rewrites each agent's `tools:` line to its own server's tools (`giveRoleTools`).
- **Guard hook:** `scripts/hooks/guard.js`, wired by `hooks/hooks.json` as PreToolUse on `Bash|Edit|Write|MultiEdit|NotebookEdit` (and `mcp__eccode_.*` under enforced profiles). It (1) refuses shell commands that write the record with anything but the CLI, (2) binds `--actor` to the subagent's `agent_type`, (3) enforces file ownership: implementers (`IMPLEMENTERS`) may edit only inside the globs of a task they have claimed; reviewers and designers write only drafts under `.eccode/`. Its ownership check reads `state.tasks[*].claim`. Session start: `scripts/hooks/session-start.js` prints the resume brief.
- **Roles and config:** `lib/config.js` `DEFAULT_CONFIG`: `roles` per gate kind (authors, reviewers), `limits` (review iterations 3, task retries 2, budgets), `lean.level`, `stack.required`. Overridable per project in `.eccode/config.json` (deep-merged). `loadConfig` rejects a non-positive limit.

## 2. The event log

- **Store** (`lib/store.js`): `events.jsonl` is append-only and hash-chained; `state.json` is a rebuildable snapshot. `commit(type, actor, data, check)` takes the O_EXCL lock (`util.withLock`), rebuilds state, runs `check(state)` (which throws to refuse and may return extra fields merged into the event), then appends `{seq, ts, type, actor, data, prevHash, hash}` with `hash = sha256(prevHash + JSON.stringify(body))`, reduces the persisted line and writes the snapshot.
- **Reducer** (`lib/reducer.js`): pure `(state, event) -> state`, one `case` per event type; unknown types are kept in the log but change nothing. `STATE_VERSION` (4) is bumped when the shape of reducing an existing type changes, so an older snapshot is replayed rather than reported as tampered. State holds `project`, `work` (id, track, baseCommit, dirtyAtInit, behaviorCommand), `pastWorks`, `gateOrder`, `gates`, `plan`, `tasks`, `evidence`, `reviews`, `handoffs`, `runs`, `risks`, `decisions`, `citations`, `lessons`, `totals`, `delivery`.
- **Event types today:** `project.initialized`, `work.started`, `work.abandoned`, `gate.started`, `gate.submitted`, `review.recorded`, `review.rejected`, `gate.escalated`, `gate.reopened`, `plan.imported`, `task.claimed`, `task.completed`, `task.failed`, `task.rescoped`, `task.reset`, `evidence.recorded`, `handoff.recorded`, `run.started`, `run.ended`, `run.corrected`, `risk.recorded`, `decision.recorded`, `memory.cited`, `memory.recorded`, `delivery.completed`.
- **Artifacts and evidence** (`lib/evidence.js`): `runCommand` executes a shell command in its own process group with a watchdog (`util.spawnGrouped`), inside an *integrity window* (`recordWindow`: the record is locked, any change the command makes to record files is reverted and named; changes to tracked files outside the actor's claim fail the run with exit 99). The redacted output is written to `.eccode/evidence/<id>.log` and the event carries `logSha256`, `exitCode`, `status`, `purpose` (`check` or `reproduction`), `outputTail`, `durationMs`, plus any `extra` fields (fix verify adds `fixVerify`). `recordFile` pins a file's hash as evidence of kind `file`. `resolveRef` resolves `ev:<id>` and `artifact:<path>` references.
- **Audit** (`store.audit()`, CLI `audit`): checks seq continuity, `prevHash` linkage, content hash, and snapshot == replay; `--against <ref>` checks that every event committed at `<ref>` is still present with the same hash. The CLI also lists approved artifacts that changed (`delivery.unreviewedChanges`). **Evidence logs are not re-hashed by `audit`** today: `logSha256` is recorded but never recomputed against the file. Phase 2 extends audit to verify every artifact hash it adds (and, as a free improvement, evidence logs).

## 3. The gate and rule engine

- **Where rules live:** inside the `check(state)` callback of each `store.commit`, in the module that owns the transition: `lib/gates.js` (`startGate`, `submit`, `checkReview`/`recordReview`, `reopenGate`), `lib/tasks.js` (`claim`, `complete`, `fail`, `reset`, `rescope`), `lib/works.js` (`startWork`, `abandonWork`, `checkTrackRules`, `refactorBaselineProblem`), `lib/delivery.js` (`preconditions`, `deliver`), `lib/lean.js`, `lib/compat.js`, `lib/bugs.js` (`checkCompletion`, called from `tasks.complete`).
- **How a rule reads state:** the callback receives the state rebuilt under the lock, so a rule only ever sees committed events. Checks that scan the tree (lean, compat, impact) run before the lock and are re-validated inside it (the claim they saw must still be the claim).
- **How a refusal is reported:** `throw new EccodeError(CODE, message, details)`. The CLI prints `eccode: [CODE] message` and exits 2; MCP returns `isError` content with `[CODE] message`. Review refusals are also *recorded* (`review.rejected` events) and escalate the gate after `maxReviewIterations`.
- **Track rules at the last gate:** `gates.submit` calls `works.checkTrackRules(state)` when the submitted gate is the last in `gateOrder` (verification, or the debug track's one phase): fix needs a reproduction pair, debug a proven `fix verify` and a mutation run, fix/debug a debugging lesson, refactor the behavior command green before the first claim and after the last phase approval. Review approval of a phase or verification gate needs a passing check the reviewer ran after the submission (`checkReview`), cited in the review.
- **Only reviewed code ships:** `delivery.coverage` compares the tree with `work.baseCommit`; the last gate's submission and `deliver` refuse uncovered files.
- **How rules are tested:** `node --test tests/*.test.js`. `tests/helpers.js` builds throwaway git repositories (`tmpProject`), drives gates (`approveThroughPlan`, `approval`, `rejection`, `passCheck`, `handoffFor`) and asserts refusals by code (`expectCode`). Track and one-step tests drive the real CLI with `spawnSync` (`tests/debug.test.js`, `tests/quick.test.js`). `tests/limits.test.js` parses `docs/limits.md` and checks each row's disposition, the open-row count in the header, and figures quoted in the docs.

## 4. Tracks

`lib/reducer.js` `TRACKS`: `greenfield` (architecture → design → plan → phases → verification), `feature` (design → plan → …), `refactor` and `fix` (plan → …), `quick` (phases → verification), `debug` (one phase, no verification). `works.ONE_TASK` holds the auto-imported one-task plans of `quick` (task `change`) and `debug` (task `fix`), built by `lib/quick.js` `start` from the detected stack (`lib/stack.js`) and the tracked layout. The one-step playbooks are `commands/quick.md` and `commands/debug.md`; `quick.steps`/`debugSteps` print the remaining path.

## 5. Tools to reuse

| Tool | Module | Reused for |
|---|---|---|
| `impact` | `lib/codebase.js` `impact(root, targets)` → dependents, tests, moduleCounts, dynamicCallers | risk routing; which tests SBFL runs; which routes/functions the behavior diff probes |
| `compat.routesIn`, `snapshot` | `lib/compat.js` | public-surface detection (routes, exports, migrations) for risk routing and HTTP probe targets |
| `fix verify` | `lib/fixverify.js` | the fail-before/pass-after proof; its pre-fix worktree pattern (detach worktree, copy new tests in, symlink `DEP_DIRS`, remove in `finally`) is the template for bisect and the behavior-diff worktrees |
| `mutate` | `lib/mutate.js` | file restore pattern (`recoveryFile`, restore in `finally`) reused by trace probes |
| `evidence.runCommand` | `lib/evidence.js` | every executed command of the Lab and the diff goes through it, so the integrity window, redaction, timeout and the artifact log apply |
| `stack` | `lib/stack.js` | detected test checks (pytest), `testRunCommands` |
| worktrees, run limits | `fixverify.js`, `config.limits`, `project.assertBudget` | isolation; the hypothesis budget joins `config.limits` |
| `lean.TEST`, `bugs.isCode` | `lib/lean.js`, `lib/bugs.js` | test-file and code-file classification for the test-edit gate and the function probes |
| `memory/draft.js` | lessons shown at work start and claim | the Lab handoff feeds the lesson draft |

## 6. Identity and ownership

`--actor` is self-asserted on the CLI and bound by the guard to the subagent's `agent_type`; `user` from a subagent is refused, from the main session it makes Claude Code ask the human. MCP servers lock the actor per process. Ownership is enforced at completion (`tasks.complete`: changed files must be inside the task's globs and shown changed by git) and at tool-call time (guard). `.eccode/drafts/**` is shared scratch. A reviewer never edits project code.

## 7. Tests

`npm test` = `node --test tests/*.test.js` (31 files); `npm run check` adds `scripts/validate-toolkit.js` (frontmatter, roles, schemas, templates, hooks). CI (`.github/workflows/check.yml`) runs it on Linux Node 18/20/22, macOS and Windows; the Linux/22 job installs pytest, ruff, TypeScript, codebase-memory-mcp and the realbugs environments so no check is skipped there (`ECCODE_REQUIRE_TRACERS=1`). Tests that need an optional tool skip with a message elsewhere.

## 8. Python toolchain in this container

Python 3.13.17, `uv` 0.11.x, `ruff`; pytest, coverage, hypothesis, fastapi and httpx were absent system-wide and are installed in a venv at `/root/.cache/eccode-py` (pytest 9.2.0, coverage 7.17.0, hypothesis 6.170.13, fastapi 0.162.0, httpx 0.28.1) for the fixtures. The engine will take the interpreter from `ECCODE_PYTHON`, the project's `.venv`, or `python3`, in that order.

## 9. What this recon changes in the Phase 2 prompt (deviations)

- **"fix.submitted" is not an event.** The moment a fix is handed to review is the owner's `task complete` (handoff) and the owner's `gate submit phase:<p>`. The Lab gates are enforced at both, and again by `checkTrackRules` at the last gate.
- **The repro already exists on the debug track** as `evidence run --purpose reproduction`. `eccode debug repro` runs through the same `evidence.runCommand` (purpose `reproduction`) and then commits `repro.recorded` pointing at that evidence, so there is one executed artifact and no parallel run.
- **MCP tool scoping per role** is done by the engine's rules, not by per-role tool lists (`lib/mcp.js` serves one table). Phase 2 keeps that model: Lab tools refuse non-owner actors inside the engine, and the reviewer's challenge tool is refused for non-reviewer actors.
- **Audit does not re-hash evidence logs today.** Phase 2 adds artifact re-hashing for its own artifacts and for evidence logs, since the prompt requires audit coverage of content-hashed artifacts.
- **The benchmark harness** (`lib/bench.js`) has engine variants keyed by track (`ENGINE_VARIANTS`). A Phase 2 arm is a new variant (`lab`), and an ECC arm needs an installer for a pinned ECC commit; both are prepared, not run.
