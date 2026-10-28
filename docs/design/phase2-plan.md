# Phase 2 plan: Debugging Lab and Behavior Diff

Status: written after `phase2-recon.md`, before any Phase 2 code. Baseline at the start: `npm test` 383 pass, 0 fail, 12 skipped (3 min 9 s) at commit `e3e8b75`.

## 1. Modules

| File | Purpose |
|---|---|
| `lib/lab.js` (new) | Debugging Lab: repro, hypotheses, executed evidence, closing, localization (SBFL, bisect, trace), root cause, escalation, budget, handoff section, gate checks (`labProblems`) |
| `scripts/lab/sbfl.py` (new) | Runs the test set under `coverage` with per-test dynamic contexts and a JUnit report, prints one JSON (per-test outcome, per-line contexts). Run with the project's interpreter; touches nothing in the project tree (`--data-file`, rcfile and junit under a temp dir) |
| `lib/behavior.js` (new) | Behavior Diff: contract, routing, worktrees, probe corpus, two baseline runs, normalization, nondeterminism exclusion, classification, result event, gate checks (`behaviorProblems`) |
| `scripts/behavior/probe_runner.py` (new) | In one tree: imports the FastAPI app, builds HTTP probes from the OpenAPI schema for impacted routes (per configured role), builds function probes with Hypothesis (fixed seed, bounded, JSON-able inputs) for changed functions, replays a given corpus, prints normalized outputs as JSON |
| `lib/reducer.js` | new event cases, `state.lab` and `state.behavior`, `STATE_VERSION` 5 |
| `lib/works.js` | `checkTrackRules` calls `lab.labProblems` (debug, fix) and `behavior.behaviorProblems` (fix, feature, refactor) |
| `lib/tasks.js` | completion on debug/fix: root cause required when source changed; undeclared edits of pre-existing test files refused; a leftover trace probe refused |
| `lib/gates.js` | phase approval on debug/fix must acknowledge declared test changes (`review.acknowledgedTestChanges`); verification approval on fix/feature/refactor needs the reviewer's own fresh diff result (or routing skip) |
| `lib/delivery.js` | refuses a leftover probe, an unexplained difference, a stale diff; the report gains Lab and Behavior sections |
| `lib/store.js` | `audit()` re-hashes Lab and behavior artifacts and evidence logs |
| `lib/config.js` | `lab: { hypothesisBudget: 5, timeBudgetMinutes: 240 }`, `behavior: { baselineRuns: 2, probeBudget, python }` |
| `lib/mcp.js` | Lab and behavior tools (engine rules scope them by actor) |
| `bin/eccode.js` | `debug repro|hypothesis|localize|bisect|trace|rootcause|escalate|show`, `behavior contract|route|diff|amend|show` |
| `scripts/hooks/guard.js` | `coverage`, `git bisect` subcommands as the engine runs them need no change: the engine spawns them itself; `.eccode/lab/` and `.eccode/behavior/` join `RECORD_FILES` |
| `schemas/*.schema.json` | `handoff.testChanges`, `review.acknowledgedTestChanges`; new `lab-*.schema.json`, `behavior-*.schema.json` for event payloads |
| `tests/lab.test.js`, `tests/behavior.test.js`, `tests/phase2-bypass.test.js`, `tests/phase2-fixtures.test.js` | engine, bypass and fixture tests |
| `tests/fixtures/phase2/` | FastAPI fixture service, seeded bugs, seeded behaviour changes, scorecard builder |
| `docs/debugging-lab.md`, `docs/behavior-diff.md`, `docs/limits.md`, `README.md`, `commands/debug.md`, agents | docs |
| `bench/protocols/2026-10-28-phase2.md`, `lib/bench.js` variant `lab`, ECC installer | Part E and F, prepared, not launched |

## 2. Events

All payloads are validated against a schema before `commit`; every artifact is written under `.eccode/lab/` or `.eccode/behavior/` and content-hashed into the event; `audit` recomputes every hash.

| Event | Payload | Written by |
|---|---|---|
| `repro.recorded` | `{id, evidence: ev id, command, cwd, fingerprint: {platform, node, python, gitHead, envHash}, exitCode, logSha256, failing: true, replaces?, reason?}` | `debug repro` (owner); `--replace --reason` by orchestrator/user only |
| `hypothesis.opened` | `{id, statement, ifTrue, ifFalse}` | owner, learning-debugger |
| `hypothesis.evidence` | `{id, hypothesis, evidence: ev id, command, logSha256, verdict: supports|refutes|inconclusive, note?, trace?: {file, line, expr, values}}` | `debug hypothesis test` (runs the command), `debug trace`; verdict set by the runner (`--supports|--refutes`) |
| `hypothesis.challenged` | `{hypothesis, evidence, reason}` | reviewer roles only: marks an evidence verdict disputed; a challenged `supports` no longer counts |
| `hypothesis.closed` | `{hypothesis, status: confirmed|refuted, evidence: [ids]}` | owner; `confirmed` needs ≥ 1 unchallenged `supports` evidence of kind `command` |
| `localization.result` | `{id, method: sbfl|bisect|trace, suspects: [{file, line, score} | {commit, subject}], artifact, artifactSha256, command, tests?}` | `debug localize`, `debug bisect` |
| `rootcause.declared` | `{hypothesis, locations: [file:line], explanation, whyReproFails}` | owner |
| `lab.escalated` | `{kind: rescope|ask-user, reason, refuted, elapsedMinutes}` | owner or orchestrator; required before a hypothesis past the budget |
| `behavior.contract` | `{id, entries: [{surface: http|function|cli, target, inputClass, expected}]}` | design/plan authors, task owner; refused once a diff result exists in the work item |
| `behavior.contract.amended` | `{id, entries, reason, amends: result id}` | reviewer roles only |
| `behavior.routing` | `{decision: run|skip, reasons, surfaces: [...], changedFiles}` | `behavior route` (engine computes) |
| `behavior.diff.result` | `{id, base, treeFingerprint, probes, executed, dropped, nondeterministic: [...], differences: [{probe, surface, target, input, baseline, candidate, sha256, classification: expected|unexplained, contract?}], unexplained, coverage: ok|insufficient-coverage, artifact, artifactSha256}` | `behavior diff` |
| `behavior.waiver` | `{result, reason}` | reviewer roles only, for `insufficient-coverage` |

## 3. Gates (each with a positive and a negative test)

Debugging Lab (tracks `debug`, `fix`):
1. **Root cause before a fix.** `task complete` of a task whose changed files include non-test code, and `gate submit` of the last gate, refuse unless a `rootcause.declared` in this work item names a hypothesis closed `confirmed`, and that closure cites a `hypothesis.evidence` with verdict `supports`, not challenged, whose evidence record is kind `command` with its log present and hash-matching.
2. **No confirmation from prose.** `hypothesis.closed` with `confirmed` refuses without such evidence; `hypothesis.evidence` cannot be created without executing (no CLI path takes an output; a payload naming a `file` evidence or an unknown id is refused).
3. **One repro command.** `fix verify --test` must equal the active repro command (normalized whitespace) when a `repro.recorded` exists; the fix track's reproduction pair must be on that command; a second `repro.recorded` needs `--replace --reason` by orchestrator/user and is recorded with what it replaces.
4. **Tests are not the fix.** Completion refuses a modified pre-existing test file (existed at the claim base, matched by `lean.TEST`) unless `handoff.testChanges[{file, reason}]` declares it; the phase review approval refuses unless `review.acknowledgedTestChanges` names each declared file. New test files are free.
5. **Budget.** `hypothesis.opened` refuses when refuted hypotheses ≥ `lab.hypothesisBudget` (default 5) or minutes since the repro ≥ `lab.timeBudgetMinutes` (default 240), until a `lab.escalated` is recorded after the last refutation.
6. **Refuted hypotheses stay.** They are in state and in the handoff table; nothing deletes them.
7. **No probe ships.** Completion, last-gate submission and `deliver` refuse any file containing an `eccode-trace-probe` marker.

Behavior Diff (tracks `fix`, `feature`, `refactor`; `quick` and `debug` unaffected):
8. **Routing recorded.** The last gate's submission needs a `behavior.routing` event for this work item; `skip` is accepted only when the engine found no public surface among the changed files and their dependents (routes, non-test definitions imported elsewhere, CLI entry, migration).
9. **No unexplained difference.** With routing `run`, the latest `behavior.diff.result` must have `unexplained` 0 after contract matching, or every unexplained difference covered by a `behavior.contract.amended` by a reviewer. On `refactor` every difference is unexplained (contract entries are refused on refactor).
10. **Reviewer re-run, not stale.** Verification approval needs a `behavior.diff.result` recorded by the approving reviewer after the submission, whose `treeFingerprint` equals the current tree; `deliver` re-checks the fingerprint.
11. **Coverage.** A result with `coverage: insufficient-coverage` blocks until a later result covers the surface or a reviewer `behavior.waiver` names it.
12. **No whitewash.** A `behavior.contract` committed after a result exists is refused (`CONTRACT_AFTER_DIFF`); only `behavior.contract.amended` by a reviewer may add entries then.

## 4. Commands

```
eccode debug repro [--replace --reason <t>] --actor <owner> -- <cmd>
eccode debug hypothesis add "<statement>" --if-true "<obs>" --if-false "<obs>" --actor <owner>
eccode debug hypothesis test <id> (--supports|--refutes|--inconclusive) [--note <t>] --actor <owner> -- <cmd>
eccode debug hypothesis close <id> --status confirmed|refuted --actor <owner>
eccode debug hypothesis challenge <id> --evidence <evId> --reason <t> --actor <reviewer>
eccode debug localize --sbfl [--tests <path>...] [--top 5] [--python <bin>] --actor <owner>
eccode debug bisect --good <ref> [--bad <ref>] --actor <owner>
eccode debug trace <hypothesis> --at <file:line> --expr <expr> --actor <owner>
eccode debug rootcause --hypothesis <id> --at <file:line>[,...] --explain "<text>" --why-repro-fails "<text>" --actor <owner>
eccode debug escalate --kind rescope|ask-user --reason <t> --actor <owner|orchestrator>
eccode debug show [--json]
eccode behavior contract --file <entries.json> --actor <author>
eccode behavior route --actor <any role>
eccode behavior diff [--probes <dir>] [--runs 2] [--python <bin>] --actor <owner|reviewer>
eccode behavior amend --result <id> --file <entries.json> --reason <t> --actor <reviewer>
eccode behavior waive --result <id> --reason <t> --actor <reviewer>
eccode behavior show [--json]
```

MCP: `lab_repro`, `lab_hypothesis_add`, `lab_hypothesis_test`, `lab_hypothesis_close`, `lab_hypothesis_challenge`, `lab_localize`, `lab_bisect`, `lab_trace`, `lab_rootcause`, `lab_escalate`, `behavior_contract`, `behavior_route`, `behavior_diff`, `behavior_amend`, `behavior_waive`. Commands executed over MCP go through the same approved-command rule as `evidence_run`: the repro command is approved once recorded; `lab_hypothesis_test` takes a command from the approved list or the repro command, never free text.

## 5. Fixtures (`tests/fixtures/phase2/`)

`shop/`: a FastAPI service (items, users with roles `admin`/`user`, orders, pricing with rounding, pagination) on sqlite (stdlib), with a pytest suite. `bugs.json` lists seeded bugs as unified diffs against the correct code: off-by-one (pagination), wrong condition (discount), state leak between requests (module-level cache), wrong default (page size), regression in a specific commit (bisect: five commits, the third breaks tax), missing authorization on one path. `changes.json` lists behaviour changes whose suite stays green: sort order, error code 404→400, dropped response field, rounding, a field leaked to `user` role, default pagination, plus 3 declared intended changes and 1 pure refactor. The builder `build.js` materializes any of them into a temp git repository; `tests/phase2-fixtures.test.js` runs SBFL, bisect and the diff on each and prints the scorecard (also written to `tests/fixtures/phase2/scorecard.md` by the test when `ECCODE_WRITE_SCORECARD=1`). Needs pytest, coverage, hypothesis, fastapi, httpx in `ECCODE_PYTHON`; without them the fixture tests skip with the exact reason, and CI installs them in the Linux/22 job.

## 6. Deviations from the prompt, and why

Found while building (each with the test that pins it):
- **A verdict after the artifact.** `hypothesis.evidence` is recorded `pending` when no verdict is given at run time; the agent marks it (`hypothesis.marked`) after reading the output, as the prompt's flow describes, and evidence is marked once.
- **Appended tests are free.** The first test-edit rule refused every regression test appended to an existing test file. It now applies to changed or removed lines of a pre-existing test (register row 144).
- **Bisect validates both ends** before trusting `git bisect run` (row 141), after the fixtures caught it blaming the first commit when the command was not runnable.
- **Probe order** is reads first, deletions last (row 146), after a deletion probe hid a change in another endpoint.
- **SBFL ties** go to the line more failing tests reach, then fewer passing tests: with two failing tests, the wrong boundary line had tied with the failing API test's own path.
- **The ECC arm** installs ECC's agents, skills and commands only (its hooks need a plugin root); the protocol names it.
- The whole suite's existing fix- and debug-track flows gained the Lab and routing steps (tests/helpers.js `labRootCause`, tests/works.test.js `routeBehavior`): the gates they test are unchanged and still pass.

- "`fix.submitted`" → enforced at task completion and at the last gate (see recon §9).
- `repro.recorded` references the executed `evidence.recorded` run instead of carrying a second artifact: one artifact, two events, consistent with how `fixVerify` extends evidence.
- Tool scoping over MCP stays engine-side (the one tool table), consistent with `lib/mcp.js`.
- Test-observed outputs (probe source 3) are not built: capturing return values inside the project's own tests needs a pytest plugin injected into the project's run, which the integrity window and the ownership rules exist to forbid. Recorded in `limits.md`.
- `impact` reaches "a public surface" on nearly every change (every non-test definition imported elsewhere is one), so risk routing skips only changes confined to tests, docs and private helpers nothing imports. That is the honest reading of the rule; `quick` is the lever for small changes.
