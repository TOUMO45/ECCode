---
name: lean-change
description: Reuse-first discipline for writing code, in ECCode tasks and everyday changes - map the reach of a change, then take the smallest option that fully solves it (not needed, already in the codebase, standard library or platform, an installed dependency, then minimal new code) without ever cutting safety, and leave the test, shortcut and dependency evidence the engine checks. Use for any implementation, bug fix or refactor, and when the user asks for the simplest solution or complains about bloat.
---

# Lean change

The best change is usually the smallest one that **completely** solves the problem. Every added line has to be read, tested, secured and maintained by someone later, and every added dependency is code you did not review. Be lazy about the solution, never about the change itself.

## 1. Map the reach before choosing a solution
- Read the task, its acceptance criteria and the code it touches.
- List everything the change has to reach: callers of each function you change (grep them all), tests, fixtures, config, exports, docs. That list is the scope. Features nobody asked for are not.
- Ask what the change could break for users: data destroyed or exposed, callers that stop working, contracts that change shape.
- See what already exists before writing anything: `eccode map --path <area>` lists the top-level functions, classes and exports of each directory; `eccode onboard` gives the whole-repository brief (modules, entry points, hot spots, most-depended files). Then grep for the concept itself (e.g. `slug`, `retry`, `formatMoney`).
- Know the blast radius before you edit a shared file: `eccode impact <file>` lists every dependent and the tests that cover them (`--run --actor <you>` executes and records those tests). The engine records the same impact summary on your completion for the reviewer.

## 2. Take the first rung that fully works
1. **Not needed.** Drop options, flexibility and features that no requirement asks for. Name what you left out in one line (handoff `remainingIssues` or your final reply).
2. **Already in this codebase.** Reuse the helper, component, service or pattern, used the way the surrounding code uses it. The project's own component beats a platform default.
3. **Standard library or platform.** Use the language, runtime or browser feature.
4. **An installed dependency.** Use what the manifest already has. Never add a package to save a few lines.
5. **Minimal new code.** The least code that is correct on edge cases, in the existing structure, naming and style. Clear beats clever: a one-liner the reader has to decode is not short.

While building:
- **Complete the change.** Update every caller, test and fixture the change affects.
- **No speculative structure.** No interface with one implementation, wrapper that only forwards calls, option or config nobody sets, or code "for later".
- **Bug fixes.** Find every caller of the broken function first. Fix the root cause once, in the shared code, not separately in each caller.
- **Moving or merging code.** Keep its validation and error handling.
- **Prefer deleting to adding.** Keep the layers and interfaces the codebase already has.
- **Comments** say only *why*, when the code cannot show it.
- **Between two options of equal size,** pick the one that handles the edge cases.

## 3. Never cut
Validation at trust boundaries · error handling that prevents data loss · authentication and authorization · secrets handling · accessibility · anything in the acceptance criteria. Lean means less unneeded code, never less safety.

## 4. Leave the evidence a reviewer needs
- **A test, or a reason.** New non-trivial logic (a branch, a loop, parsing, money, security, data writes, a bug fix) gets one focused test that fails when the logic breaks. A trivial change needs no test; then say why in `handoff.testsNotNeeded` (for example "rename only" or "covered by contract test X in task Y").
- **Deferred shortcuts.** If you knowingly accept a limit, mark it where it lives, in the file's comment syntax, for example `// shortcut: in-memory cache, move to Redis when we run a second instance`. The text names the limit, then when to upgrade. Declare each one in `handoff.shortcuts` (`file`, `limit`, `upgradeWhen`). `eccode debt` lists every marker, so a deferral cannot quietly become permanent.
- **New dependencies.** Declare each in `handoff.newDependencies` with a `reason` and `alternativesChecked` (what you checked in the codebase, the standard library and the installed dependencies).
- **Breaking changes.** Removing a public export or HTTP route, editing or deleting an existing migration, and destructive SQL in a new migration are detected against the claim-time baseline. Declare each in `handoff.breakingChanges` with the engine-detected `kind` and `name`, a `reason` and the `migration` path for callers — or restore it. On the refactor track they are refused outright.

## What the engine checks at `eccode task complete`
It compares the task's files with a baseline taken when the task was claimed. The project's `lean.level` (in `.eccode/config.json`) sets what happens:

| Level | Behavior |
|---|---|
| `off` | No checks, nothing recorded. |
| `lite` | Measures and records warnings in the task's `lean` record. Refuses nothing. |
| `full` (default) | Refuses: a new dependency that is not declared; a new `shortcut:` marker that is not declared; changed code with no changed test file and no `testsNotNeeded` reason. |
| `strict` | `full`, plus: every new dependency must be pre-approved in the plan (`allowedDependencies`), and every new marker must name an upgrade trigger. |

Every completion also records lines added and removed, new dependencies, shortcuts and test files. The phase reviewer reads this record, and the final handoff reports it.

## Outside a delivery
In a normal session (`/eccode:lean <change>`), follow the same steps. End your reply with one or two lines: what you deliberately did not build, and anything you could not verify.
