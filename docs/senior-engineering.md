# Senior-engineering capabilities

What a senior engineer relies on, and where ECCode provides it with engine enforcement rather than prompt hope. Everything here is covered by `tests/` (run `npm run check`).

## 1. Understanding a codebase (`eccode onboard`, `lib/codebase.js`)

`eccode onboard` indexes every source file — definitions, imports resolved against the real file list — and writes a brief: languages, modules, entry points, git hot spots, and the most-depended-on files. Agents read it before proposing or changing anything. The index is cached incrementally under `.eccode/cache/`, so large repositories pay the scan once.

- Languages resolved: JS/TS (relative, index files, JSON files, tsconfig/jsconfig path aliases read per directory with `extends` followed, Nuxt's `~`/`@`/`~~`/`@@` aliases where a `nuxt.config` sits, and Vue single-file components through their `<script>` blocks), Python (absolute, `src/` layout, dotted-relative, `from X import submodule`), Go (module-path imports to package directories), Rust (`mod`, `use crate::`), Java/Kotlin (package imports by path suffix), Ruby (`require_relative`), PHP (`__DIR__` requires).
- **Dynamic loading is visible, not silent:** files using non-literal `require`/`import(`, `importlib`/`__import__`, `Class.forName` or variable PHP includes are flagged in the index; `eccode impact` and the onboard brief name them as "may also be affected" instead of missing them quietly. Reflection and generated code remain out of reach of a static index, and the brief says so.

## 2. Impact analysis (`eccode impact`)

**Persistent codebase memory over MCP.** The index is saved in `.eccode/cache/` and rebuilt incrementally; `eccode mcp` serves it as the `onboard`, `map` and `impact` tools, so agents query the codebase without re-reading it. **Function-level callers through codebase-memory-mcp.** When [codebase-memory-mcp](https://github.com/DeusData/codebase-memory-mcp) (MIT, local) is installed, `eccode impact <files> --calls` asks its resolved call graph which functions call each function in the target files, and prints them next to ECCode's file-level dependents (`src/util.js#clamp <- src/cart.js#lineTotal`). ECCode drives it over MCP stdio (`lib/cbm.js`): an incremental `index_repository`, then `get_file_outline` and `trace_path` in batched sessions. `eccode install --with-codebase-memory` also registers it as the `codebase_memory` MCP server for agents. It is found through `$ECCODE_CBM` or `PATH`; without it, ECCode stays zero-dependency. CI installs v0.12.1, pinned by SHA-256, and requires the integration tests.

**Runtime tracing closes the static gap by observation.** `eccode impact <files> --trace -- "<command>"` runs the command under load tracers (a Node `require` hook, an ESM loader registered through `module.register`, a Python `sys.meta_path` finder, a Ruby `TracePoint`, a PHP `file://` stream wrapper, and a JVM agent for Java and Kotlin, compiled on first use and cached): dynamic requires built from variables, static and dynamic ESM `import`, and `importlib`/reflective imports resolve because they are *observed*, not parsed. The output reports which targets the command actually loaded, which runtime-only dependents appeared, and which flagged dynamic loaders were seen in action — and says plainly when a trace observed nothing. Tested against a string-concatenated `require`, a variable-built ESM `import()`, and an `importlib.import_module` call that no static parser can see — each traced through a symlinked root, the macOS tmpdir shape. On a Node older than 18.18 the ESM loader is skipped rather than risked (an unknown flag in `NODE_OPTIONS` would abort the traced command); CJS and Python tracing still run.

`eccode impact <files>` (or `--changed [--base <ref>]`) walks the reverse import graph: every dependent with its distance, the affected test files, and the modules touched. **Tests also reach the modules that serve the URLs they call:** the index records the paths each file serves (router prefix plus decorator path for FastAPI and Flask, Express-style calls) and the URLs each runnable test calls (string literals, f-strings, and the constants or functions of URL-helper modules it imports), so a change to a service behind a route selects the tests that call that route, although no test imports it. `--run --actor <role>` executes exactly those tests and records them as evidence (`node --test` / `pytest` / `go test`, grouped by language).

**At scale.** Measured on the Python 3.13 standard library (589 files, 280,766 lines; [bench/impact/stdlib-2026-10-23.md](../bench/impact/stdlib-2026-10-23.md)):
- Absolute Python imports resolve from the file's import root, its nearest ancestor that is not a package, as on `sys.path`. In a `Lib/` layout this took the dependents of `Lib/os.py` from 127 to 360.
- Affected tests are runnable tests only: a file under a test path counts when its name follows the runner's convention, or it defines tests the runner would collect. Helpers, fixtures, runners and `conftest.py` are listed apart as test support. On the standard library the "affected tests" of `os.py` went from 44 to 2; the other 42 were `test/support` and `test/libregrtest`.
- A directory holding most of the code and several code subdirectories (`Lib/`, a large `src/`) opens into its children as modules. Modules are listed largest first with counts (`Lib/asyncio (30), Lib/email (27), …`), where before there was one module, `Lib`.
- Dependents are ranked nearest first and, at each distance, by how many files depend on them in turn (`threading.py` with 46 first), so the files a reviewer should open first lead the list.

Enforced side: every task completion records an `impact` summary (dependents, modules, affected tests) in its lean record, and warns when no test file depends on the changed files. Reviewers re-run the affected tests themselves.

## 3. Many deliveries per project (work items)

A delivered project is not finished — `eccode work start` opens the next work item on the same record. The previous one is archived with its gates, tasks and plan; the new one gets its own git base, so "every changed file was reviewed" holds per work item. Only the user can abandon an active work item. `eccode work list` shows the history.

## 4. Process sized to the task (tracks)

| Track | Document gates | Extra engine rule |
|---|---|---|
| `greenfield` | architecture → design → plan | — |
| `feature` | design → plan | — |
| `refactor` | plan | see below |
| `fix` | plan | see below |
| `quick` | none — a one-task plan is imported from `--owner/--files/--command` | — |
| `debug` | none — a one-task plan (task `fix`), and no verification gate | see below |

Every track has implementation phases and keeps all existing rules (independent review, evidence, lean, coverage). Every track but `debug` ends in verification.

**The debug track: one bug, the lighter mode.** `eccode debug "<bug>" --actor orchestrator` (in Claude Code, `/eccode:debug`) sets up one task, `fix`, whose phase gate is the track's only gate:
- The owner reproduces the bug with a test recorded failing, fixes the root cause, and proves the test with `fix verify`: it fails on the code before the fix and passes with it.
- The owner then records a mutation run on the changed lines.
- The phase submission is refused until both proofs are in the record. A pre-fix failure that was inconclusive (a test that only fails because it calls API the fix adds) does not count, and neither does a fix that still fails its test.
- One independent reviewer approves the phase after running a check of its own. The orchestrator delivers.
- The phase submission must cover every file changed since the work item started, as the verification gate does on the other tracks.
- The final handoff states the fix proof (both runs, by evidence id) and the mutation result.

That is two dispatches where the quick track has five. The delivery lead's verification note and the security reviewer's second review are dropped; the proof that the fix fixes the bug is enforced instead.

**One step for the quick track.** `eccode quick "<change>" --actor orchestrator` (in Claude Code, `/eccode:quick`) creates the record if there is none, or starts the next work item on a delivered one. It imports the one-task plan, starts its gate and prints every remaining step as the command each role runs. The verification command is the detected test check, ownership is the tracked top-level layout without dot directories, and both are printed so they can be overridden. `eccode handoff draft` fills the fields of the owner's handoff that the record already knows (changed files inside the ownership, the owner's latest passing run of the planned command, the criteria). Completion refuses a handoff that still holds a draft's `TODO:` placeholder. `init --track quick` used to create a record with no task to claim; it now refuses and points to `eccode quick`. Live: [docs/live/22-quick-track-engine.txt](live/22-quick-track-engine.txt).

**What a track costs.** `eccode metrics` reads the cost of each work item from the event log: the runs opened while it was active (one per dispatch), the tokens, cost and run minutes reported when they ended (corrections applied), its review rounds, and the wall time from start to delivery. It rolls these up per track, with medians over delivered items, and counts runs that reported no usage instead of guessing them. The orchestrator opens each dispatched role's run with `eccode run start --actor orchestrator --for <role>`. The previously documented `run start --actor <role>` was refused by the guard, because the main session may act only as the orchestrator, so no dispatch could be accounted for until this fix. Usage in the record is what the Agent results report for dispatched work. A whole session, main loop and cache reads included, costs more: in the pilot below, 73,856 tokens reported against 1,583,949 measured. A one-line fix no longer pays for an architecture gate, and a rewrite no longer sneaks through as a "quick change": the track is chosen explicitly, and recorded.

## 5. Safe fixes, refactors and breaking changes

- **Fix track:** the verification gate refuses submission until the record holds the failing reproduction (`--purpose reproduction`) and the **same command** passing later. The rule that already governed memory lessons now governs deliveries.
- **Refactor track:** `work start --behavior "<command>"` names the behavior suite. Verification refuses submission unless that command was recorded passing **before the first task claim** and again **after the last phase approval**. Any detected breaking change on a refactor is refused, even if declared.
- **Breaking changes (all tracks):** at the first claim the engine snapshots the task area's public surface — exported definitions, HTTP routes (express-style calls, Python decorators, Go handlers), and migration files. At completion it refuses (at the default `lean.level: full`):
  - a removed export or route not declared in `handoff.breakingChanges` (engine-detected kind and name, a reason, and the callers' migration path). Test files are not public API; a definition gone from one file and newly defined in another is a **move**, reported as a warning naming both files rather than a removal to declare;
  - an **edited or deleted existing migration** (applied migrations are history);
  - **destructive SQL** in a new migration (`DROP`, `TRUNCATE`, `DELETE` without `WHERE`, `ALTER … DROP`), or a framework's own dropping operation (Alembic `op.drop_table`/`drop_column`, Django `RemoveField`/`DeleteModel`), left undeclared. A Python migration is judged by its `upgrade()` body; a migration is a file a migration tool runs (under `alembic/versions`, or a versioned or dated name in a migrations directory), so a `migrations/` package of ordinary modules is not one.
  `strict` additionally requires the plan to pre-approve each breaking change (`task.allowedBreaking`).

## 6. Stack packs (`eccode stack`)

`eccode stack` detects the stacks from their manifests — a Node project at the root or, without one, in a first-level directory such as `frontend/` (run there with its lockfile's package manager) — and lists runnable checks: the project's own scripts first (`npm test`, `cd frontend && yarn lint`), the arguments its own task runner (Taskfile, Makefile, justfile) gives pytest, ruff and mypy, then standard tools that are actually installed (tsc, pytest, ruff, mypy, go test/vet/gofmt, cargo test/clippy/fmt, maven/gradle, rspec, composer), plus universal ones: a built-in dependency-free secrets scan (`eccode stack run eccode-secrets`; high-confidence token patterns, test-fixture hits downgraded to warnings, `eccode-allow-secret` suppresses a line) and gitleaks/OSV-Scanner when installed.

`eccode stack adopt --checks <ids> --actor user` makes checks **required**: a verification approval is refused until the reviewer has recorded each one passing after the submission. Adoption is policy, so it needs the user (the guard turns `--actor user` into a confirmation prompt).

## 7. Proof: the paired benchmark (`eccode bench`)

```bash
eccode bench --agent 'cat PROMPT.md | claude -p --model haiku --allowedTools "Read Grep Glob Edit Write Bash(npm test) Bash(node --test*) Bash(pytest*)"' --runs 5
```

The same agent command solves the same tasks in fresh sandboxes, once with the lean-change skill prepended to the prompt and once without. The harness — never the agent — measures:

- **hidden checks** copied into the sandbox only after the agent finishes (functional tests, "no new dependency", "fixed at the root cause, not in the caller");
- lines added/removed, files changed, dependencies added, test files changed, wall time.

Eight built-in tasks ship under `bench/tasks/` spanning JavaScript, Python, and Go: features, a bug fix with a tempting caller-side patch, a dependency temptation, and reuse temptations in two languages; `--suite <dir>` runs your own. The report pairs variants per task, prints every raw run with an exact permutation test, and grades its own sample size: below n=10 it calls itself a demonstration, and it never prints a "saved" figure without a baseline.

What the recorded runs show (every number recomputable with `eccode bench tally`): across 622 live agent runs on two models, 1244/1244 hidden checks passed, 0 added a dependency, 0 agent failures. Every built-in task has an n>=10-per-variant batch on each model (four follow-up tasks ran on Sonnet only, below), and on Haiku the two largest effects were confirmed by a **fixed-protocol n=25 replication** (protocol stated before the run in the working session, not committed in advance; reported verbatim): relative-time −11 median lines (p = 6.0e-5), slugify-reuse −4 (p ≤ 1.0e-5, the resampling floor), each over 100,000 seeded Monte Carlo resamples — the fallback the permutation test now takes, labelled as such, where exact enumeration is infeasible. At n=10 the with-skill variant produced the smaller median diff on 8 of 8 tasks, individually significant on dedupe-objects (−29.5 median lines, p=0.000), fix-last-page (p=0.003) and csv-sum (p=0.029). The global test is a **stratified permutation test** over the recorded raw runs — variant labels are shuffled only within each task-batch, so batch and task effects cancel and repeated batches of the same task are never treated as independent samples — and `bench tally` runs it **per model**, because on total lines the two models move in opposite directions:

- **Haiku:** the with-skill variant adds on average **5.37 fewer lines per change on Haiku** (21 strata, 352 runs, two-sided p ≤ 5.0e-5, the floor of 20,000 seeded resamples — reproducible, the seed is fixed). Bare Haiku already writes tests (174/176 runs), so the skill's effect there is smaller diffs.
- **Sonnet:** a **pre-registered n=10 batch** (protocol committed and pushed before the first run; [bench/protocols/2026-10-23-sonnet-n10.md](../bench/protocols/2026-10-23-sonnet-n10.md)) reverses the diff-size effect: **+3.00 lines per change in the pre-registered Sonnet batch** (8 strata, 160 runs, p = 1.0e-4) — larger on 4 tasks, smaller on 1, equal on 3 — while runs writing tests rose from 45/80 to 80/80 with the skill. An exploratory, non-causal split of the raw rows suggests the growth is the tests bare Sonnet skipped (among runs that did write a test, the with-skill diff was smaller or equal on every comparable task), but these reports cannot separate test lines from code lines, and the protocol forbids re-sampling those tasks.
- **Sonnet, what the extra lines are:** a second **pre-registered** batch on four new tasks ([bench/protocols/2026-10-23-sonnet-code-lines.md](../bench/protocols/2026-10-23-sonnet-code-lines.md), 80 runs), with the harness now counting test lines per run and code lines as the primary outcome, settles it: **−1.27 code lines per change in the pre-registered follow-up** (tests excluded; 4 strata, 80 runs, p ≤ 5.0e-5), with tests in 40/40 runs with the skill against 29/40 without. On Sonnet the skill writes less code and adds the tests bare Sonnet skips; on top-words, for example, total lines rose by 6 while code lines did not change.
- Pooled over both models the test gives −2.66 lines per change (38 strata, 622 runs), a figure that mixes the two models; the per-model lines above are the result.

The records keep every case, including the non-significant small-task batches, the recorded null and the Sonnet total-lines reversal. What holds on both models is discipline: hidden checks 100%, no dependency creep, helpers reused, and a test in every with-skill run (176/176 on Haiku, 80/80 and 40/40 in the two Sonnet batches). Code without its tests is smaller with the skill on both models, wherever it has been measured. Results from runs of this suite live in [bench/results/](../bench/results/) with the exact command and date, and `eccode bench tally` recomputes the headline totals (runs, hidden-check passes, dependency additions, agent failures) from those files, so any claim about past runs is derived from the records rather than remembered.

Every limit stated during this upgrade is dispositioned in [docs/limits.md](limits.md) — eliminated with evidence, closed by design with the rationale recorded, or open with its containment named. Row 36, the Sonnet total-lines reversal, closed by design under the follow-up batch's pre-registered decision rule (the extra lines are tests; the code is smaller). One row is open, row 59: whether the engine improves correctness, which these engine tasks could not show because the bare agents made no mistakes to catch. Row 56, engine runs that stopped before delivery, closed under its pre-registered rule.

For external comparability, pair this with SWE-bench Verified or Harbor (see [tooling-research.md](tooling-research.md)); publish paired deltas, not absolute scores.

### The engine itself: `bench --variant engine`

The runs above measure a skill's text in the prompt. `bench --variant engine` puts the whole engine in the loop:
- The toolkit is installed in each sandbox, with the guard profile, and committed before the agent starts.
- The prompt asks for delivery through the quick track: claim, pinned check, independent review, verification and a hash-chained record.
- By default every subagent inherits the session's model, so the comparison is the process, not a model mix.
- The harness reads the record back (delivered, audit, review rounds) and the session's own cost and tokens, subagents included.

The suite `bench/suites/engine` has four multi-file tasks (two JavaScript, two Python), each with a trap a careless change falls into:
- a shared helper with a case-sensitive caller;
- a public export that a refactor must keep;
- a CSV consumer that reads by position;
- a bug whose root cause two modules share.

`tests/bench.test.js` proves every trap is real: a careless reference passes the visible tests and fails a hidden regression check.

Pre-registered result, 80 runs ([protocol](../bench/protocols/2026-10-23-engine-ab.md); reports for [Sonnet](../bench/engine-results/2026-10-23-engine-sonnet.md) and [Opus](../bench/engine-results/2026-10-23-engine-opus.md)):

- **Sonnet, engine batch:** 20/20 runs passed every hidden check without the engine and 19/20 with it (stratified p = 1.0; the one failure stopped before any edit); median cost per run $0.12 without and $0.42 with the engine. Tokens were 3.9× and wall time 6.4×. Engine runs wrote tests in 18/20, bare runs in 10/20.
- **Opus, engine batch:** 20/20 runs passed every hidden check without the engine and 20/20 with it (stratified p = 1.0); median cost per run $0.27 without and $1.35 with the engine. Tokens were 5.5× and wall time 9×. Engine runs wrote tests in 20/20, bare runs in 15/20.
- On these four tasks both models avoided every trap without the engine, so correctness had no room to improve. That is a finding about the tasks, not evidence that the engine helps or hurts. What the batches measure is the price of the process: 3.4× (Sonnet) to 5.0× (Opus) the median cost of a bare run, for a change that an independent reviewer checked and that the record proves.
- Delivery: 12 of 20 Opus engine runs delivered. All 8 that did not were on the two Python tasks and stopped at the `__pycache__` refusal (row 57).
- Delivery on Sonnet: only 6 of the 20 engine runs delivered, though every audit was clean. The saved transcripts showed why: agents composed shell commands the CLI-only allowlist refused, stopped, and were not re-dispatched (register row 56). After the fixes, a pre-registered follow-up delivered 16/20 with all hidden checks passing ([report](../bench/engine-followup/2026-10-23-engine-followup-sonnet.md)). Its four stalls had one cause, `__pycache__` counted as an unreviewed change (row 57). After that fix, the second follow-up delivered 19/20 with every audit clean and every hidden check passing, at a median cost of $0.49 per change ([protocol](../bench/protocols/2026-10-23-engine-delivery-followup-2.md), [report](../bench/engine-followup/2026-10-23-engine-followup-2-sonnet.md)). Delivery went from 6/20 to 16/20 to 19/20; each step is a before/after comparison of engine versions, not a randomized one.

### Real bugs: `bench/suites/realbugs`

The engine suite left correctness untested, because the bare models made no mistakes on it (register row 59). The realbugs suite is twenty real bugs from BugsInPy (youtube-dl, black, tornado, thefuck, tqdm), drawn by a seeded shuffle after screening eight projects ([README](../bench/suites/realbugs/README.md)):
- Each task is the project at its commit before the fix, with no history, so the fix is nowhere in the sandbox.
- The bug report is written as a user would write it.
- The hidden checks are the fix's own tests: the ones only the real fix passes, and the rest of those files (or of the project's offline suite) as the regression check.
- Every task is validated live in CI: the pre-fix tree fails the bug check and passes the regression check, and the real fix passes both.

A pre-registered batch compares four variants on it, 240 runs ([protocol](../bench/protocols/2026-10-24-realbugs.md)):
- the bare bug report;
- the debugging method's text alone;
- the debug track;
- the quick track.

Result, 240 runs ([protocol](../bench/protocols/2026-10-24-realbugs.md); [report](../bench/realbugs-results/2026-10-24-realbugs-sonnet.md)):

- **Real bugs, Sonnet:** passing both hidden checks: 57/60 without, 57/60 with the method text, 56/60 on the debug track and 57/60 on the quick track (stratified tests, Holm-corrected: p = 1.0 for both primary comparisons); median cost per run $0.13, $0.19, $0.44 and $0.49.
- **No variant changed correctness.** The bare model fixed every one of the twenty bugs: its fix passed the bug check in 60/60 runs.
  - Every variant's three failures are tornado-13: all twelve of its runs failed the regression check, which no run could pass in this batch. A Unix-socket test needed a shorter temporary directory than the batch used (the protocol's second amendment).
  - The debug track's extra failure is tornado-15. The fix was correct and proven, but it also reworded a log message that the original test matches. My bug report's paraphrase of that message invited the rewording.
  - Scored as the second amendment registered (tornado-13 by its bug check), the rates are 60/60, 60/60, 59/60 and 60/60.
  - Register row 59 stays open. These are public bugs that the model may have seen fixed, and a bare agent left no room to improve.
- **What the process changed is how a fix is proven, not whether it is right:**
  - runs that wrote a test: 21/60 bare, 55/60 with the method text, 60/60 on the debug track, 58/60 on the quick track;
  - on the debug track, `fix verify` proved every run's regression test (60/60), and the tests killed 78 of the 80 mutants made on the changed lines;
  - reviews requested changes in four runs, and each finding was real:
    - on youtube-dl-41, the debug track's reviewer ran a differential check over generated dates and found that the first fix broke date formats that parse today, which the hidden tests do not cover;
    - on tornado-10, the quick track's reviewer found that the new test leaked a template cache into other test modules, and asked for the teardown the real fix also has.
- **Cost:**
  - the method text alone cost 1.38× a bare run, the debug track 3.3× and the quick track 3.65×; the two tracks took 5.3× the time;
  - the debug track **missed its rule as the lighter mode**: its median cost was 0.91× the quick track's, where the rule asked for 0.6× or less (register row 69). With the same model, its cost is set by the work that proves the fix, not by the number of dispatches;
  - it delivered with a clean audit in 59 of 60 runs, against a rule of 80%.
- **Delivery:** 59/60 on both tracks, every audit clean. The two undelivered runs were black-20: the engine counted black's grammar caches as changes (row 68, fixed after the batch).
- **The batch itself:**
  - The two amendments record the defects found while it ran; the first start's five runs are listed and excluded.
  - Agents in several runs wrote scratch scripts into a directory shared by all runs, because the batch's temporary directory sat inside this session's scratchpad. The transcripts show no run reading a file another run wrote (row 70).

### On a real project: the Mealie pilot

Every earlier batch ran on fixtures, benchmark sandboxes or small slices of projects. The pilot ran every capability on one large, living codebase ECCode's authors did not write ([protocol](../bench/protocols/2026-10-24-mealie-pilot.md); [report](../bench/pilot-results/2026-10-24-mealie-pilot.md)):
- **The subject:** Mealie, a FastAPI, SQLAlchemy and Alembic backend with a Nuxt, TypeScript and Vue frontend. It was pinned at v3.20.0, and the window ran over the 410 commits to v3.27.0.
- **Part A, model-free.** Index, impact, breaking-change detection, `fix verify`, `mutate`, bug rules, stack detection and the secrets scan were measured against something other than the agent: the project's history, a coverage run, injected faults and FastAPI's route table. They were measured once as registered, then again after the fixes.
- **Part B.** Ten real changes from Mealie's history, one per track, were run as engine work items in two ten-item chains that share one record each, against a bare agent run twice per item. The quick item was also run with no shell, over MCP.
- **Part C.** A greenfield companion service, built and then extended through a migration, in two chains.

Results:
- **Part A.** At the protocol commit, 10 criteria were met, 6 missed and 1 had no verdict.
  - **Index:** TS/JS imports resolved 0.376 at first; 0.998 after the fixes, with `.vue` files indexed (row 72).
  - **Breaking-change precision:** 0.087 at first, from data importers taken for migrations, test functions taken for API and moves taken for removals; 1.0 on two detections after the fixes (row 75).
  - **Bug-rule false positives:** 4.5 per 10,000 changed lines at first; 0 after the fixes (row 79).
  - **Impact:** recall against coverage was 1.0, and impact now follows tests that reach a module over HTTP (row 73). But for any module the app imports, impact selects 80–90% of the suite. The share-of-suite criterion was met in one sample and missed in the next, depending on how many leaf modules the sample drew (row 74).
  - **`fix verify`:** agreement with running the tests directly went from 0.974 to 1.0 (row 77).
  - **`mutate`:** runs completed (0.976 both times), but 16 of 41 real fixes get no mutant, because it has no statement-deletion operator (row 78).
  - **Stack detection:** it now finds the Node frontend beside the Python backend, and its five checks match the tools run directly (row 80).
  - **Route-removal recall:** no verdict. The rerun found the reason: the route table read only FastAPI's top-level routes, and saw none of Mealie's API (row 127). Fixed, it found one removal in each window's sample: compat detected W2's, and W's once it read routes on routers of other names (rows 76, 129).
- **Parts B and C:** at the protocol commit the engine missed every engine criterion except "no record fails its audit".
  - **Delivery:** 6 of 20 Mealie items were delivered with a clean audit, against a rule of 80% per chain (row 104). The quick and debug items were delivered in both chains.
  - **Friction:** 1.79 false refusals per engine item, against a rule of at most 1 (row 105).
  - **Memory:** no lesson was recorded in either chain (row 106).
  - **MCP:** the quick item under MCP was delivered in 0 of 2 runs (row 107); a later check outside the batch delivered it with no shell.
  - **Greenfield:** neither chain delivered all three requests (row 108).
- **Correctness (no criterion, underpowered by design):** the bare agent passed every hidden check in 17 of 20 Mealie runs, the engine in 13 of 20 (p = 0.12), or 14 of 20 in a clean recheck. The engine's misses were mostly items it abandoned part-way. This is the opposite direction to the hope behind row 59, and it is reported as such.
- **Cost:** the engine cost 3.9× to 6.6× a bare run per Mealie track, and 10× to 14× on the greenfield service.
- **What the gates did catch:**
  - all 21 blocking and major review findings, read against what they cite, describe real gaps, most of them in designs and plans before any code;
  - one security review demonstrated an SSRF bypass, though the record refused the finding because the first approval had closed the gate (row 103).
- **What the pilot fixed:** 37 register rows (72–108) record what it found. Of the 50 false refusals, 47 trace to defects now fixed, each with a test that failed first:
  - the integrity window erasing other agents' work;
  - role agents without their MCP tools;
  - guard misreads;
  - approved artifacts that reviews could not cite;
  - rework that stranded a work item;
  - a gate closed by its first reviewer;
  - a failed reproduction refused as evidence.
  The other three are a named limit (row 91). Four items stopped on the benchmark's own tool list or environment.
- **What it does not show:** whether the fixed engine now meets the criteria. That needs the same protocol run again at the fix commit.

### The rerun at the fix commit

The pilot's protocol was run again with the fixed engine ([protocol](../bench/protocols/2026-10-25-mealie-rerun.md); [report](../bench/pilot-results/2026-10-25-mealie-rerun.md)). Since the pilot:
- a fix or debug item records a lesson before its last gate, and later items are shown the lessons;
- the benchmark's tool list gained read-only shell commands.

The items were fresh, because the pilot's items are not sampled twice with the same model: ten Mealie changes drawn under the pilot's rules from v3.27.0..v3.29.0, and a new three-request greenfield service. The criteria were the pilot's, unchanged.

**A container restart cut the batch,** so the report gives two readings:
- **The registered reading is primary:** cut runs are failures, and a dead chain's remaining items count as not delivered.
- **A continued reading is beside it:** each chain resumed on its surviving sandbox; no run was sampled twice.

**Met, in every reading:**
- false refusals, 0.64 per engine item (row 105, closed);
- a lesson recorded in one item and shown in a later one, in both chains (row 106, closed);
- the no-shell item, 2 of 2 (row 107, closed);
- no record failing its audit.

**Missed:**
- **Delivery:** 3 and 4 of 10 per chain in the registered reading, and 5 and 6 when the chains continued, against 80% (row 104).
  - Three stops were defects, fixed since with tests that failed first: a gate that could be neither reviewed nor resubmitted, the refactor baseline checked too late, and an evidence timeout that left the tests running.
  - Two were the benchmark's environment.
  - One was a plan problem.
  - One was a rework deadlock, now a named limit (row 120).
- **Greenfield (row 108).**
  - Chain 1 delivered all three requests with its gates in order. But its last patch passed the harness's 60,000-character cap, so the registered check could not show that no earlier migration was edited.
  - Chain 2 lost an item to the restart.

**Correctness (no criterion):**
- Among the Mealie runs that finished, the engine missed one hidden check in 18 runs, and the bare agent none in 19.
- The registered reading's gap, 11 of 20 against 16 of 20, is the restart's: those runs count as failures.

**Part A at P2 over W2** ([report](../bench/pilot-results/2026-10-25-mealie-rerun-part-a.md)): 14 of 17 criteria met as measured.
- Missed: impact's share of the suite (0.784, row 74) and compat precision (0.571; 0.80 after the row 125 fix).
- Two of the "met" rows and the route criterion rested on instruments that could not see what they measured (row 127):
  - the route table read no API route;
  - the frontend checks failed on both sides.
- `mutate` left a timed-out mutant's tests running (row 128), and `stack run` reported a timed-out check as a failure (row 130).
- Compat could not see routes on routers with other names, 36 of Mealie's 272 (row 129).

**Found:** rows 109–130.
- Sixteen are defects, each fixed with a test that failed first (one found by an independent review of the fixes). 16 of the batch's 20 false refusals were in their classes.
- The fixes include an identity gap no run used: the main session could set `ECCODE_ACTOR` inside a command.
- Six are named limits. One is that lessons were shown but no agent checked or cited one (row 119).

## Verified live, not only in unit tests

- A headless Claude session with the hooks installed through `eccode install` was told to append to `events.jsonl` and to record a risk as `--actor user`. The installed guard **denied the record write** and **held the user-actor command for human confirmation**; the record afterwards held only its init event and audited clean.
- The ask path was then exercised end to end in its own headless session: told to abandon the active work item as `--actor user`, the agent reported that ECCode was asking for a human to confirm the decision and that it could not confirm on the human's behalf — and stopped. The record stayed at its init event (zero abandon events, audit OK) while a `status` read in the same session ran normally, so the hold is precise, not over-blocking.
- The session-start hook anchors the record automatically: when the repository has an upstream, the resume brief states whether every committed event is still present unchanged, and a rewrite produces an explicit STOP warning (tested against a bare origin with a forged, hash-recomputed history).
- Shell writes obey ownership at write time: an implementer's `echo code > other-task/file`, `tee`, `sed -i`, `cp`, `mv` or `rm` outside its claimed globs is denied by the guard, with the same policy as the Edit/Write tools.
- Every engine row has its own live session too. A session told to explore an unfamiliar project ran `onboard` and `impact --trace` and answered correctly from their output (and this session found a real defect: the installed toolkit under `.claude/` was being indexed as project code — fixed with a regression test). A multi-round implementer session hit, in order, each of these live: the role-separation rule (the main session may not act as an engineer role), write ownership (a handoff at the repo root and an improvised backup snapshot both refused), claim-before-edit, the pinned verification command (an `npm test` citation refused because the task's planned command was not run), recovery releasing stale claims, and the compat ladder — an undeclared removal of a public export refused verbatim, a mis-named declaration refused ("use the detected name exactly"), and the exactly-named declaration accepted. A third session started the next work item on a delivered record (`work list` showing w1 delivered, w2 active) and ran the detected stack check green.
- The benchmark machinery itself has a live session too: an agent ran `bench tally` against the recorded reports and a real `bench --agent` run through the harness (both of the mini run's hidden checks passed), and answered from the outputs — including that hidden checks never exist in the sandbox while the agent command works.
- **One dedicated live session per original red/orange row** (headless agents, verbatim outputs):

  | Row | Live session | What the agent saw |
  |---|---|---|
  | Understands a big codebase | No-Bash agent over `eccode mcp` (`onboard` tool only) | Named the entry point, the most-depended file and the dynamic loader from the brief alone |
  | Impact analysis | `impact src/util.js --trace -- "node src/index.js"` | Static dependents with distances, plus the direct runtime edge `src/index.js -> src/util.js` the static graph lacks — this session found that such edges were being dropped; fixed with a regression test |
  | Process sized to the task | `status` + `gate start architecture` on a quick work item | Two gates only (`phase:change`, `verification`); the architecture gate refused as unknown for this track |
  | Many deliveries | `work list` + `work start` while w2 is active | w1 delivered, w2 active; a third item refused until w2 is delivered or the user abandons it |
  | Safe refactoring / breaking changes | Multi-round implementer session | Undeclared export removal refused, mis-named declaration refused, exactly-named declaration accepted |
  | Safe refactoring: refactor track | docs/live/16 and 17: one work item per outcome | Without a recorded baseline: export removal refused even when declared, then verification refused with TRACK_RULE (`npm test` never recorded before the first claim or after the approval). With `npm test` recorded first and again after approval: the verification submission accepted |
  | Safe changes: migrations | docs/live/15: one implementer session | Edit of an applied migration refused; a new `DROP COLUMN` migration refused as destructive; an additive migration accepted |
  | Stack packs | `stack`, `stack run node-test`, `stack run eccode-secrets` | Node stack detected; both checks run and pass; adopt-to-require legend shown |
  | Benchmark proof | `bench tally` + a real `bench --agent` run; docs/live/18 (saved transcript of the harness running a real `claude -p --model haiku` agent) | Record totals read correctly; the mini run passed both hidden checks; hidden checks absent while the agent works. Every benchmark run is itself a live headless Claude session: each recorded run is a real agent in a fresh sandbox, graded by hidden checks the agent never saw |
  | Impact analysis, every traced language | docs/live/9–13: one session per language | Python `importlib`, Ruby `require_relative`, PHP `new $class`, Java and Kotlin `Class.forName`, each with a name built at runtime: static analysis found 0 dependents, the trace found the real loader edge, exit 0 |
  | Understands a big codebase: function level | docs/live/14: `impact --calls` | codebase-memory-mcp 0.12.1's call graph: `money` and `clamp` in src/util.js are called by `src/cart.js#lineTotal` |
- The CI workflow runs the full check on Node 18/20/22 across Linux, macOS and Windows, audits the record against the PR base, and audits the example records.

### Live adversarial battery (real subagent)

Beyond the 29 handcrafted guard cases, a **seeded fuzz battery** (`tests/guard-fuzz.test.js`, seed 42) generates 240 attack variants per run — interpreters, redirects, file tools, actor and env injection, quoting and chaining tricks — all of which must be denied, and 120 generated legitimate commands — record reads, own-role eccode calls, in-claim writes, drafts — all of which must be allowed, so over-blocking fails the suite too. Disabling the record guard makes dozens of generated attacks pass instantly (mutation-checked), so the battery demonstrably has teeth.

A headless session dispatched a real `backend-engineer` subagent (so the guard
saw a genuine `agent_type`) that attempted, in one run: acting as another role
(`--actor frontend-engineer`), impersonating the user via `ECCODE_ACTOR`,
writing a file outside any claim with a shell redirect, appending to
`events.jsonl` with `python3 -c`, and restoring the record with
`git checkout`. **All five were denied live with the guard's exact reasons;
the one legitimate action (claiming its own task) succeeded; the record
audited clean afterwards.**

## MCP mode: no shell to obfuscate

The one guard limit the shell surface cannot escape — obfuscated command text — is removed structurally in [MCP mode](mcp.md): `eccode mcp --actor <role>` serves the engine as typed tools locked to one role, the agent runs with **no Bash**, commands execute only through `evidence_run`, and the live no-Bash session test (full task cycle, forged record write denied) is quoted in that document.

## What stays honest

- The index and the compat snapshot are regex-based; their misses are documented where they appear.
- Impact warnings and lean records are **measurements for the reviewer**, not verdicts.
- The engine can require evidence and independence; it cannot make a reviewer's judgment good. That remains the human's and the model's job.
