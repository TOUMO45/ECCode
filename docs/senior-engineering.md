# Senior-engineering capabilities

What a senior engineer relies on, and where ECCode provides it with engine enforcement rather than prompt hope. Everything here is covered by `tests/` (run `npm run check`).

## 1. Understanding a codebase (`eccode onboard`, `lib/codebase.js`)

`eccode onboard` indexes every source file — definitions, imports resolved against the real file list — and writes a brief: languages, modules, entry points, git hot spots, and the most-depended-on files. Agents read it before proposing or changing anything. The index is cached incrementally under `.eccode/cache/`, so large repositories pay the scan once.

- Languages resolved: JS/TS (relative, index files, tsconfig/jsconfig path aliases), Python (absolute, `src/` layout, dotted-relative, `from X import submodule`), Go (module-path imports to package directories), Rust (`mod`, `use crate::`), Java/Kotlin (package imports by path suffix), Ruby (`require_relative`), PHP (`__DIR__` requires).
- **Dynamic loading is visible, not silent:** files using non-literal `require`/`import(`, `importlib`/`__import__`, `Class.forName` or variable PHP includes are flagged in the index; `eccode impact` and the onboard brief name them as "may also be affected" instead of missing them quietly. Reflection and generated code remain out of reach of a static index, and the brief says so.

## 2. Impact analysis (`eccode impact`)

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

Three built-in tasks ship under `bench/tasks/` (a JS feature, a Python feature, a JS bug fix with a tempting caller-side patch); `--suite <dir>` runs your own. The report pairs variants per task, prints every raw run, and states its own limits: a small `n` is a demonstration, not a statistic, and it never prints a "saved" figure without a baseline. Results from one run of this suite live in [bench/results/](../bench/results/) with the exact command and date.

For external comparability, pair this with SWE-bench Verified or Harbor (see [tooling-research.md](tooling-research.md)); publish paired deltas, not absolute scores.

## Verified live, not only in unit tests

- A headless Claude session with the hooks installed through `eccode install` was told to append to `events.jsonl` and to record a risk as `--actor user`. The installed guard **denied the record write** and **held the user-actor command for human confirmation**; the record afterwards held only its init event and audited clean.
- The session-start hook anchors the record automatically: when the repository has an upstream, the resume brief states whether every committed event is still present unchanged, and a rewrite produces an explicit STOP warning (tested against a bare origin with a forged, hash-recomputed history).
- Shell writes obey ownership at write time: an implementer's `echo code > other-task/file`, `tee`, `sed -i`, `cp`, `mv` or `rm` outside its claimed globs is denied by the guard, with the same policy as the Edit/Write tools.
- The CI workflow runs the full check on Node 18/20/22 across Linux, macOS and Windows, audits the record against the PR base, and audits the example records.

## What stays honest

- The index and the compat snapshot are regex-based; their misses are documented where they appear.
- Impact warnings and lean records are **measurements for the reviewer**, not verdicts.
- The engine can require evidence and independence; it cannot make a reviewer's judgment good. That remains the human's and the model's job.
