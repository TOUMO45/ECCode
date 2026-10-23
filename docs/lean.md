# Lean changes: reuse first, enforced and measured

Agents overbuild. Asked for a date field, an agent installs a date-picker library or writes a calendar, when the project already has an input component and the browser has a native date input. Senior engineers do the opposite. They check what already exists, write the smallest change that fully solves the problem, and never cut safety to get there.

[Ponytail](https://github.com/DietrichGebert/ponytail) (MIT) popularized this as a prompt-level "lazy senior dev" skill. ECCode adopts the idea in its own words (see [NOTICE](../NOTICE)) and adds what ECCode adds everywhere: **the parts that can be checked are checked by the engine, and the results are recorded.**

| | Prompt-level skill | ECCode |
|---|---|---|
| Reuse-first decision steps | ✅ | ✅ `lean-change` skill, built into every implementer's task protocol |
| Map of what already exists | Injected at session start | ✅ `eccode map [--path]`, run before writing |
| Senior review / repository audit | ✅ | ✅ `senior-review` skill: phase gates and `/eccode:review`, `/eccode:audit` |
| Deferred-shortcut ledger | ✅ | ✅ `eccode debt`, also in the final handoff |
| New dependency must be justified | Asked | **Refused** at task completion unless declared with a reason and the alternatives checked |
| Deferred shortcut must be visible | Asked | **Refused** unless every new `shortcut:` marker is declared in the handoff |
| Risky logic ships with a test | Asked | **Refused** when code changed with no changed test file and no stated reason |
| Measured outcome | Benchmark averages | Per-task lines added and removed, dependencies, shortcuts and tests, in `eccode metrics` and the final handoff |

## How it works

1. **At the task's first `eccode task claim`**, the engine takes a baseline of the task's ownership globs: the direct dependencies of every manifest (`package.json`, `requirements*.txt`, `pyproject.toml`, `go.mod`, `Cargo.toml`) and every deferral marker in code. It reads this before taking the record lock, so scanning a large area never blocks other agents. The baseline is kept across retries and rework. A failed attempt therefore cannot launder a dependency or marker into the baseline, and a rework handoff re-declares the task's dependencies and markers.
2. **The implementer follows the `lean-change` skill.** It maps the reach of the change and runs `eccode map`. Then it takes the first option that fully works: *not needed* → *already in the codebase* → *standard library or platform* → *an installed dependency* → *minimal new code*. It never cuts validation, error handling, security or accessibility.
3. **At `eccode task complete`**, the engine compares the task's area with the baseline:
   - every **new dependency** must be in `handoff.newDependencies`, with a `reason` and `alternativesChecked`;
   - every **new marker** must be declared in `handoff.shortcuts` (`file`, `limit`, `upgradeWhen`);
   - **changed code** (by file type, excluding test files) needs a changed test file or a `handoff.testsNotNeeded` reason of at least 10 characters.

   Markers and dependencies that existed at claim time never count against the task.
4. **The result is recorded on the task** (`lean`): lines added and removed since the claim's base commit, new dependencies, shortcuts, code and test file counts, the no-test reason, and warnings.
5. **The phase reviewer** applies the `senior-review` skill and reads that record. They challenge each dependency and each no-test reason. Declared shortcuts count as decisions, unless the expected load already exceeds them. The security reviewer checks the supply-chain side of every new dependency.
6. **`eccode deliver`** writes a lean table and the deferred-shortcut ledger into the final handoff.

## Levels (`lean.level` in `.eccode/config.json`)

| Level | Behavior |
|---|---|
| `off` | No baseline, no checks, nothing recorded. |
| `lite` | Measures and records `warnings`; refuses nothing. Good for adopting ECCode on an existing project. |
| `full` (default) | Refuses undeclared new dependencies, undeclared new markers, and code changed with neither a test nor a reason. |
| `strict` | `full`, plus: every new dependency must be pre-approved in the plan (`task.allowedDependencies`), and every new marker must name an upgrade trigger. |

Refusals use the existing `INVALID_HANDOFF` code. Each reason starts with `lean:`, and the CLI exits with `2`, as for every workflow rule. A task claimed before lean checks existed has no baseline. For such a task, dependencies and markers are not compared, and the record says so.

## Shortcut markers

A deliberate shortcut is marked where it lives, in the file's comment syntax. The text names the limit first, then when to upgrade:

```js
const sessions = new Map(); // shortcut: in-memory sessions, move to Redis when we run a second instance
```

- Any comment style is recognized: `//`, `#`, `/* */`, `--`, `<!-- -->`.
- Markers in prose files (`.md`, `.txt`, …) are ignored.
- Ponytail's older `ponytail:` keyword is accepted too, so repositories that already use Ponytail keep their ledger.
- `eccode debt` lists every marker and tags the ones with no upgrade trigger as `[no-trigger]`, because those are the ones that silently become permanent.

## Commands

| Command | What it does |
|---|---|
| `eccode map [--path <dir>] [--chars n]` | One line per directory with its files' top-level functions, classes and exports. Shared code (`lib`, `utils`, `components`, `services`, …) comes first. Tests, vendored and generated files are skipped. Supports JS/TS, Python, Go, Rust, Java/C#, Kotlin, Ruby and PHP. Detection is regex-based: nested and dynamically created definitions are missed. |
| `eccode debt [--json]` | Ledger of deferred shortcuts in code. |
| `eccode metrics` | Now includes a `lean` summary: tasks measured, lines added and removed, new dependencies, shortcuts declared, code tasks with tests, warnings. |
| `/eccode:lean <change>` | One change made the lean way in a normal session, outside a delivery. |
| `/eccode:review [target]` | One-shot senior review of a diff, commit, branch, PR or files. Reports only. |
| `/eccode:audit [path]` | One-shot senior audit of a repository or path. At most 20 ranked findings, each with a concrete failing case. |
| `/eccode:debt` | Shows the ledger and offers to add missing triggers. |

`map` and `debt` work in any repository, including one with no ECCode project.

## Honesty boundary

ECCode reports what it measured: lines a task added and removed, and the dependencies, markers and tests it found. It never prints "lines saved". The larger version that was not written has no baseline to subtract from. A with-and-without comparison needs a controlled benchmark; see [tooling-research.md](tooling-research.md).

That benchmark (`eccode bench`, results in [bench/results/](../bench/results/)) finds the effect of this skill depends on the model. On Haiku, which already writes tests, the skill gives 5.37 fewer lines per change on Haiku (p ≤ 5.0e-5). On Sonnet, a pre-registered batch gives +3.00 lines per change in the pre-registered Sonnet batch (p = 1.0e-4), while runs writing tests rose from 45/80 to 80/80. On both models the hidden checks pass and no run adds a dependency. Read the skill as test-and-reuse discipline first; smaller diffs follow where the model already writes tests ([limits.md](limits.md), row 36).

## Limits

- **Test detection** uses paths and names (`test/`, `tests/`, `__tests__/`, `spec/`, `e2e/`, `*.test.*`, `*.spec.*`, `*_test.*`, `test_*.py`). A changed test file shows a test was touched, not that it is meaningful. Judging that is the reviewer's job, and mutation testing is the planned upgrade.
- **Manifest parsing** is line-based for TOML. It is marked with a `shortcut:` comment in `lib/lean.js`, so it appears in ECCode's own `eccode debt`.
- **The baseline covers the task's ownership globs.** A manifest outside them belongs to another task. The scope check refuses it when the handoff lists it. A change the handoff does *not* list is caught later: the verification submission and `deliver` refuse any changed file that no approved review covered (see [architecture.md](architecture.md#security-model)).
