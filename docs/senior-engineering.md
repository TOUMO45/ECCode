# Senior-engineering capabilities

What a senior engineer relies on, and where ECCode provides it with engine enforcement rather than prompt hope. Everything here is covered by `tests/` (run `npm run check`).

## 1. Understanding a codebase (`eccode onboard`, `lib/codebase.js`)

`eccode onboard` indexes every source file — definitions, imports resolved against the real file list — and writes a brief: languages, modules, entry points, git hot spots, and the most-depended-on files. Agents read it before proposing or changing anything. The index is cached incrementally under `.eccode/cache/`, so large repositories pay the scan once.

- Languages resolved: JS/TS (relative, index files, tsconfig/jsconfig path aliases), Python (absolute, `src/` layout, dotted-relative, `from X import submodule`), Go (module-path imports to package directories), Rust (`mod`, `use crate::`), Java/Kotlin (package imports by path suffix), Ruby (`require_relative`), PHP (`__DIR__` requires).
- **Dynamic loading is visible, not silent:** files using non-literal `require`/`import(`, `importlib`/`__import__`, `Class.forName` or variable PHP includes are flagged in the index; `eccode impact` and the onboard brief name them as "may also be affected" instead of missing them quietly. Reflection and generated code remain out of reach of a static index, and the brief says so.

## 2. Impact analysis (`eccode impact`)

**Persistent codebase memory over MCP.** The index is saved in `.eccode/cache/` and rebuilt incrementally; `eccode mcp` serves it as the `onboard`, `map` and `impact` tools, so agents query the codebase without re-reading it. **Function-level callers through codebase-memory-mcp.** When [codebase-memory-mcp](https://github.com/DeusData/codebase-memory-mcp) (MIT, local) is installed, `eccode impact <files> --calls` asks its resolved call graph which functions call each function in the target files, and prints them next to ECCode's file-level dependents (`src/util.js#clamp <- src/cart.js#lineTotal`). ECCode drives it over MCP stdio (`lib/cbm.js`): an incremental `index_repository`, then `get_file_outline` and `trace_path` in batched sessions. `eccode install --with-codebase-memory` also registers it as the `codebase_memory` MCP server for agents. It is found through `$ECCODE_CBM` or `PATH`; without it, ECCode stays zero-dependency. CI installs v0.12.1, pinned by SHA-256, and requires the integration tests.

**Runtime tracing closes the static gap by observation.** `eccode impact <files> --trace -- "<command>"` runs the command under load tracers (a Node `require` hook, an ESM loader registered through `module.register`, a Python `sys.meta_path` finder, a Ruby `TracePoint`, a PHP `file://` stream wrapper, and a JVM agent for Java and Kotlin, compiled on first use and cached): dynamic requires built from variables, static and dynamic ESM `import`, and `importlib`/reflective imports resolve because they are *observed*, not parsed. The output reports which targets the command actually loaded, which runtime-only dependents appeared, and which flagged dynamic loaders were seen in action — and says plainly when a trace observed nothing. Tested against a string-concatenated `require`, a variable-built ESM `import()`, and an `importlib.import_module` call that no static parser can see — each traced through a symlinked root, the macOS tmpdir shape. On a Node older than 18.18 the ESM loader is skipped rather than risked (an unknown flag in `NODE_OPTIONS` would abort the traced command); CJS and Python tracing still run.

`eccode impact <files>` (or `--changed [--base <ref>]`) walks the reverse import graph: every dependent with its distance, the affected test files, and the modules touched. `--run --actor <role>` executes exactly those tests and records them as evidence (`node --test` / `pytest` / `go test`, grouped by language).

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

Every track ends in implementation phases plus verification, with all existing rules (independent review, evidence, lean, coverage) intact. A one-line fix no longer pays for an architecture gate, and a rewrite no longer sneaks through as a "quick change": the track is chosen explicitly, and recorded.

## 5. Safe fixes, refactors and breaking changes

- **Fix track:** the verification gate refuses submission until the record holds the failing reproduction (`--purpose reproduction`) and the **same command** passing later. The rule that already governed memory lessons now governs deliveries.
- **Refactor track:** `work start --behavior "<command>"` names the behavior suite. Verification refuses submission unless that command was recorded passing **before the first task claim** and again **after the last phase approval**. Any detected breaking change on a refactor is refused, even if declared.
- **Breaking changes (all tracks):** at the first claim the engine snapshots the task area's public surface — exported definitions, HTTP routes (express-style calls, Python decorators, Go handlers), and migration files. At completion it refuses (at the default `lean.level: full`):
  - a removed export or route not declared in `handoff.breakingChanges` (engine-detected kind and name, a reason, and the callers' migration path);
  - an **edited or deleted existing migration** (applied migrations are history);
  - **destructive SQL** in a new migration (`DROP`, `TRUNCATE`, `DELETE` without `WHERE`, `ALTER … DROP`) left undeclared.
  `strict` additionally requires the plan to pre-approve each breaking change (`task.allowedBreaking`).

## 6. Stack packs (`eccode stack`)

`eccode stack` detects the stacks from their manifests and lists runnable checks — the project's own scripts first (`npm test`, `npm run lint`), then standard tools that are actually installed (tsc, pytest, ruff, mypy, go test/vet/gofmt, cargo test/clippy/fmt, maven/gradle, rspec, composer), plus universal ones: a built-in dependency-free secrets scan (`eccode stack run eccode-secrets`; high-confidence token patterns, test-fixture hits downgraded to warnings, `eccode-allow-secret` suppresses a line) and gitleaks/OSV-Scanner when installed.

`eccode stack adopt --checks <ids> --actor user` makes checks **required**: a verification approval is refused until the reviewer has recorded each one passing after the submission. Adoption is policy, so it needs the user (the guard turns `--actor user` into a confirmation prompt).

## 7. Proof: the paired benchmark (`eccode bench`)

```bash
eccode bench --agent 'cat PROMPT.md | claude -p --model haiku --allowedTools "Read Grep Glob Edit Write Bash(npm test) Bash(node --test*) Bash(pytest*)"' --runs 5
```

The same agent command solves the same tasks in fresh sandboxes, once with the lean-change skill prepended to the prompt and once without. The harness — never the agent — measures:

- **hidden checks** copied into the sandbox only after the agent finishes (functional tests, "no new dependency", "fixed at the root cause, not in the caller");
- lines added/removed, files changed, dependencies added, test files changed, wall time.

Eight built-in tasks ship under `bench/tasks/` spanning JavaScript, Python, and Go: features, a bug fix with a tempting caller-side patch, a dependency temptation, and reuse temptations in two languages; `--suite <dir>` runs your own. The report pairs variants per task, prints every raw run with an exact permutation test, and grades its own sample size: below n=10 it calls itself a demonstration, and it never prints a "saved" figure without a baseline.

What the recorded runs show (every number recomputable with `eccode bench tally`): across 382 live agent runs, 764/764 hidden checks passed, 0 added a dependency, 0 agent failures. Every task has an n>=10-per-variant batch, and the two largest effects were confirmed by a **fixed-protocol n=25 replication** (protocol stated before the run in the working session, not committed in advance; reported verbatim): relative-time −11 median lines (p = 6.0e-5), slugify-reuse −4 (p ≤ 1.0e-5, the resampling floor), each over 100,000 seeded Monte Carlo resamples — the fallback the permutation test now takes, labelled as such, where exact enumeration is infeasible. At n=10 the with-skill variant produced the smaller median diff on 8 of 8 tasks, individually significant on dedupe-objects (−29.5 median lines, p=0.000), fix-last-page (p=0.003) and csv-sum (p=0.029). The global test is a **stratified permutation test** over every recorded raw run — variant labels are shuffled only within each task-batch, so batch and task effects cancel and repeated batches of the same task are never treated as independent samples: the with-skill variant adds on average **4.57 fewer lines per change** (26 strata, 382 runs, two-sided p ≤ 5.0e-5, the floor of 20,000 seeded resamples — reproducible, the seed is fixed). Sonnet ran only in small batches, so its model-specific conclusions are marked unsettled. The records keep every case including the non-significant small-task batches and the recorded null. Alongside the diff-size effect, the invariant result is discipline — tests present, no dependency creep, helpers reused — which is what the skill promises. Results from runs of this suite live in [bench/results/](../bench/results/) with the exact command and date, and `eccode bench tally` recomputes the headline totals (runs, hidden-check passes, dependency additions, agent failures) from those files, so any claim about past runs is derived from the records rather than remembered.

Every limit stated during this upgrade is dispositioned in [docs/limits.md](limits.md) — eliminated with evidence, or closed by design with the rationale recorded. Nothing is open.

For external comparability, pair this with SWE-bench Verified or Harbor (see [tooling-research.md](tooling-research.md)); publish paired deltas, not absolute scores.

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
  | Stack packs | `stack`, `stack run node-test`, `stack run eccode-secrets` | Node stack detected; both checks run and pass; adopt-to-require legend shown |
  | Benchmark proof | `bench tally` + a real `bench --agent` run | Record totals read correctly; the mini run passed both hidden checks; hidden checks absent while the agent works |
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
