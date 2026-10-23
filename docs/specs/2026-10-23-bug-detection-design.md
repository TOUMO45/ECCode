# Design: professional problem solving and bug detection

Approved scope (2026-10-23): all four parts below, with honest measurement.

## Goal

Make ECCode catch bugs in the code an agent writes, and make bug fixing provable, using checks the engine runs itself rather than the agent's word. Success means:
- the new checks run with zero dependencies;
- every claim about them is measured (precision on real code, detection on seeded bugs, live agent sessions);
- each limit found gets a row in docs/limits.md.

## 1. `eccode bugs`: bug detection on the lines a change adds

**What it does.** It scans the lines a change adds (or whole files with `--all`) for bug patterns that are almost always wrong. It reports findings with an id, severity, file:line, the reason and a fix hint.

**Scope of a scan.**
- `--task <id>` uses the task's claim base.
- `--base <ref>` takes any git ref.
- The default is HEAD, which covers working-tree and untracked files.
- Only code files are scanned. Vendored, generated and build directories are skipped, using the same rules as lean.

**Built-in rules.** They run on a masked copy of each line: string contents and comments are blanked, but delimiters are kept. A rule marked *raw* needs the literal text.
- JS/TS:
  - focused test (`it.only`, `fit`): error, tests only;
  - `debugger`: error;
  - comparison with NaN: error;
  - `typeof x === "<not a typeof result>"`: error, raw;
  - `forEach(async …)`, whose promises nobody awaits: error;
  - assignment inside an `if` condition: error;
  - `new Promise(async …)`: warning;
  - empty `catch {}`: warning;
  - `parseInt` without a radix: warning;
  - skipped test (`it.skip`, `xit`): warning, tests only.
- Python:
  - `breakpoint()` and `pdb`/`ipdb.set_trace()`: error;
  - mutable default argument: error;
  - `is` / `is not` with a literal: error;
  - `assert (x, y)`, which is always true: error;
  - bare `except:`: warning;
  - `except …:` whose body is only `pass`: warning (looks at the next line);
  - skip decorators on tests: warning.
- Go: `t.Skip`: warning, tests only.
- All code: merge-conflict markers: error, raw.

**External analyzers.** They run when installed, never downloaded, and only their findings on the scanned lines are kept:
- `ruff check` (Python). Pyflakes-class codes F821, F811, F841 and F632 count as errors; everything else is a warning.
- `go vet` (Go modules): every report is an error.
- `eslint`, when the project has an eslint config: its own severities.
- `semgrep`, when the project has `.semgrep.yml`.

`--no-external` turns them off.

**Gate at completion.** Task completion runs the built-in rules on the task's added lines; external tools are excluded so the gate is deterministic.
- At lean level `full`, each error finding must be fixed or declared in `handoff.acceptedFindings: [{rule, file, reason}]`.
- At `strict`, warnings must be declared too.
- At `lite`, findings are recorded only. At `off`, nothing runs.

Findings go into the task's lean record for the phase reviewer.

## 2. `eccode mutate`: mutation testing on the changed lines

**What it does.**
1. Runs `--test "<cmd>"` once on the unmodified code; if it fails, mutation testing stops.
2. For each mutant, applies one small change to one changed, non-test code line: relational boundaries (`<` and `<=`, `>` and `>=`), equality flips, `&&`/`||` (Python `and`/`or`), boolean literals, `+`/`-`, and dropping a `!`.
3. Runs the test command again, then restores the file.

A mutant that fails the tests is *killed*. One that passes is a *survivor*: behavior no test checks.

**Safety.**
- Mutants are applied to masked text, so strings and comments are never changed.
- A mutant that does not parse (`node --check`, `py_compile`, `gofmt -e`) is counted as *invalid*, never as killed.
- Original content is kept in memory and restored in `finally`. A recovery copy is written to `.eccode/cache/mutate-restore.json` before each mutant and replayed at the start of the next `mutate` if a run was killed.
- `--max` caps the mutants (default 25, chosen deterministically and spread across the lines), and `--timeout` caps each test run.

**Output.** Score (killed / (killed + survived)), the survivors with file:line and before → after, and counts of invalid mutants and timeouts.
- `--record --actor <role>` stores the result as evidence of kind `mutation`.
- Reviewers can cite that evidence.

## 3. `eccode fix verify`: proof that the regression test catches the bug

**What it does.**
1. Takes the files changed since the claim base (or `--base`) and splits them into test files and source files. There must be at least one of each.
2. Creates a temporary `git worktree` at the base and copies the current versions of the changed test files into it. It symlinks dependency directories (`node_modules`, `.venv`, `venv`) from the project.
3. Runs `--test "<cmd>"` there. It must **fail**, because the old code has the bug.
4. Runs the same command in the real tree. It must **pass**, because the fix works.
5. Records both runs as evidence and always removes the worktree.

**Verdicts.**
- *Proven*: the test fails before the fix and passes after it.
- *Not proven, the tests pass without the fix*: they do not catch the bug.
- *Not proven, the fix fails its own tests.*
- *Inconclusive*: the pre-fix run failed to load (import, syntax or module-not-found errors), which says nothing about the bug.

**Fix track.** A proven verification records the pre-fix run as a failing `reproduction` and the post-fix run as a passing check of the same command, so it satisfies the fix track's reproduction rule. An inconclusive pre-fix run is recorded as a plain `check`, so it cannot satisfy that rule.

## 4. The problem-solving method

The `debug-investigation` skill gains the method:
1. State the problem precisely: expected and actual behavior, scope, and when it started.
2. Reproduce it with the smallest failing check, recorded with `--purpose reproduction`.
3. Isolate it: `git bisect run`, bisecting the inputs, delta debugging.
4. Form hypotheses, each with a prediction, ranked by likelihood × cost to test.
5. Run experiments that change one variable at a time, recorded as evidence.
6. Find the root cause: the earliest point where state goes wrong; search for the same pattern elsewhere (`eccode bugs --all`, grep).
7. Make the minimal fix at the root.
8. Prove it with `eccode fix verify`.
9. Harden it with `eccode mutate` and `eccode bugs`.
10. Record a lesson.

It also lists anti-patterns: shotgun changes, patching callers, retrying flakes, and weakening or skipping tests.

`senior-review` adds `bugs` and `mutate` to the reviewer's checks. The learning-debugger, test-engineer and reviewer agents point to them.

**MCP.**
- `bugs` is available as a read-only tool.
- `mutate` and `fix_verify` run only approved commands, the same allowlist as `evidence_run`.

## Measurement (done before any claim is published)

- **Precision on real code.** Run `eccode bugs --all --no-external` on real corpora: the Python standard library, Go's standard library, the npm package that ships with Node, and ECCode itself. Hand-label every hit, or a sample of up to 20 per rule, as true or false positive, and report precision per rule. Rules are tuned on one half of each corpus and reported on the other half. A rule that stays imprecise is downgraded or removed, and the record says so.
- **Mutation testing.** On benchmark fixtures, compare a weak test with a strong test for the same code: survivors must name the untested behavior.
- **Fix verify.** On a fixture with a seeded bug: a test that catches it must give *proven*, one that doesn't must give *tests pass without the fix*, and a test that only fails to load must give *inconclusive*.
- **Live sessions.** A headless agent fixes a seeded bug following the method and proves it with `fix verify`. A second agent uses `mutate` to find and close a gap in its tests. Both transcripts go into docs/live/.

## Non-goals

- Replacing real static analyzers. ECCode runs them when present and keeps its own rules few and precise.
- Type checking.
- Security scanning beyond the existing secrets scan.
