# Bugs and problem solving

ECCode has three commands that look for bugs, so a fix doesn't rest on the agent's word:

- `eccode bugs` finds slips in the lines a change adds.
- `eccode mutate` measures whether the tests would notice a broken change.
- `eccode fix verify` proves that a regression test catches the bug it was written for.

The `debug-investigation` skill ties them into a ten-step problem-solving method.

## `eccode bugs`: slips in the lines a change adds

```bash
eccode bugs                       # lines added since HEAD (working tree + untracked files)
eccode bugs --task t3             # lines task t3 added since its claim
eccode bugs --base main           # lines added since a branch
eccode bugs --all                 # whole files: an audit of the repository
eccode bugs --no-external --json  # built-in rules only, machine-readable
```

**How it scans.** Before matching, each line is masked: string contents and comments become blanks, so a rule never fires on text. A line can opt out with a standard suppression comment (`noqa`, `eslint-disable-line`, `eslint-disable-next-line`, `nolint`, or `eccode-allow`). Minified or bundled files are skipped as generated.

**Built-in rules.** Errors block task completion; warnings are recorded.

| Rule | Severity | Catches |
|---|---|---|
| `js/focused-test` | error | `it.only`, `describe.only`, `fit`: every other test stops running (test files) |
| `js/debugger` | error | A `debugger` statement left in the code |
| `js/nan-compare` | error | `x === NaN`, which is always false (use `Number.isNaN`) |
| `js/typeof-typo` | error | `typeof x === 'undefind'`: a type name typeof never returns |
| `js/async-foreach` | error | `forEach(async …)`: nothing awaits the callbacks, so errors are lost |
| `js/assign-in-condition` | error | `if (x = 5)`, where `===` was meant. Assigning a call's result (`if (m = re.exec(s))`) is an idiom and is not flagged |
| `py/debugger` | error | `breakpoint()`, `pdb.set_trace()` |
| `py/is-literal` | error | `x is 1`, `x is ""`: identity instead of value |
| `py/assert-tuple` | error | `assert (cond, "msg")`, which is always true |
| `all/merge-marker` | error | `<<<<<<<` / `=======` / `>>>>>>>` left in code |
| `js/skipped-test`, `py/skipped-test`, `go/skipped-test` | warning | An unconditional skip (`it.skip`, `@pytest.mark.skip`, `t.Skip` outside an `if`) |
| `js/empty-catch` | warning | `catch (e) {}` with no comment saying why |
| `js/async-promise-executor` | warning | `new Promise(async …)`: a throw inside never rejects |
| `py/except-pass` | warning | A bare `except:` or `except Exception:` whose body is only `pass`, with no comment |
| `py/bare-except` | warning | `except:`, which also catches KeyboardInterrupt and SystemExit |
| `py/mutable-default` | warning | `def f(x=[])`: the default is shared between calls (a bug if mutated) |

**Installed analyzers.** These run when they are present; nothing is ever downloaded. Their findings are kept only for the scanned lines. When an analyzer reports the same thing as a built-in rule on the same line (ruff `F632` and `py/is-literal`, for example), it is shown once.
- `ruff`: undefined names, redefinitions, `is` with literals, syntax errors and similar count as errors; style codes are warnings.
- `go vet`: everything it reports is an error.
- `eslint`: only when the project has an eslint config.
- `semgrep`: only when the project has `.semgrep.yml`.

**At task completion.** The engine runs the built-in rules on the lines the task added.
- At the default `lean.level` (`full`), an error must be fixed or declared:
  ```json
  "acceptedFindings": [{ "rule": "js/debugger", "file": "src/demo.js", "reason": "the demo build pauses here on purpose" }]
  ```
- `strict` also requires warnings to be declared.
- `lite` only records findings.
- The counts and the accepted list appear in the task's lean record (`lean.bugs`) for the reviewer.

**Measured precision.** The rules were calibrated on real code before shipping; see [bench/bugs/precision-2026-10-23.md](../bench/bugs/precision-2026-10-23.md).
- On 2.29M lines of held-out Python, JavaScript and Go, the final error rules fired twice. Both hits were intentional debugger hooks.
- A whole-file scan of 1.8M lines of Go takes about 3.5 s.
- The built-in rules are a precise net for slips, not a static analyzer. Depth comes from the installed analyzers, from mutation testing, and from proving fixes.

## `eccode mutate`: would the tests notice?

```bash
eccode mutate --task t3                       # the task's planned verification command
eccode mutate --test "npm test" --max 40      # lines added since HEAD
eccode mutate --test "pytest -q" --min-score 80 --record --actor test-engineer
```

**What it does.**
1. Runs the test command once on the unmodified code. If it fails, nothing can be judged and the run stops.
2. For each mutant, makes one small change to a changed, non-test code line: a boundary (`<` ↔ `<=`, `>` ↔ `>=`), an equality (`===` ↔ `!==`), a logical operator (`&&` ↔ `||`, `and` ↔ `or`), a boolean, `+` ↔ `-`, or a dropped negation.
3. Runs the tests again.
   - **Killed:** the tests fail. They noticed.
   - **Survived:** the tests still pass. No test checks that behavior.
4. Puts the file back.

**Safety.**
- Mutants are generated on the masked text, so strings and comments never change.
- A mutant that does not parse (`node --check`, `ast.parse`, `gofmt -e`, or the project's own TypeScript compiler for TS/JSX) counts as invalid, never as killed. Without a TypeScript compiler, TS/JSX mutants are skipped and counted in the report.
- Every file is restored in `finally`. A recovery copy under `.eccode/cache/` lets the next run repair a file left behind by a killed process.
- The session runs inside the record's integrity window.

**Options.**
- `--max` caps the mutants (default 25, spread evenly).
- `--record` stores the score and the survivors as evidence that reviewers can cite.
- `--min-score` turns the score into a gate that fails below the threshold.

**Limit: equivalent mutants.** Some mutants cannot be killed because they change nothing. In `clamp(x, lo, hi)`, `x < lo` and `x <= lo` both return `lo` when `x == lo`. Read each survivor before writing a test for it, and say so in the handoff when one is equivalent.

## `eccode fix verify`: proof that the regression test catches the bug

```bash
eccode fix verify --actor learning-debugger --task t7 --test "npm test"
eccode fix verify --actor backend-engineer --base main --test "pytest -q tests/test_cart.py"
```

**What it does.**
1. Creates a temporary `git worktree` at the base: the task's claim base, or `--base`.
2. Copies the current versions of the changed test files into it, and links `node_modules`, `.venv`, `venv` and `vendor`.
3. Runs the test command there. On the pre-fix code it must **fail**.
4. Runs it in the working tree. With the fix it must **pass**.
5. Records both runs as evidence and removes the worktree.

**Verdicts.**

| Verdict | Meaning |
|---|---|
| **PROVEN** | The test fails on the pre-fix code and passes with the fix. The two runs also satisfy the `fix` track's reproduction rule. |
| `tests-pass-without-fix` | The tests pass on the pre-fix code, so they do not catch the bug |
| `fix-fails-tests` | The tests fail before the fix and still fail after it, so the fix is incomplete |
| `inconclusive` | The pre-fix run failed, but the failure says nothing about the bug. It is recorded as a plain check, not as a reproduction. |

A pre-fix failure counts only when **a test assertion failed, or an error was raised inside the code the fix changed**. It is *inconclusive* when:
- the tests failed to load (module not found, syntax error);
- the tests called API that the fix adds (for example `sum is not a function`);
- a file the run needed exists only in the working tree (untracked, ignored or generated), so the two environments differ;
- the run crashed in the test's own code, timed out, or failed during setup.

It exits 0 only for PROVEN. Whether the behavior the test catches is *the reported* bug stays the reviewer's judgment. The engine proves that the test asserts a behavior the fix changed.

## The method (`debug-investigation` skill)

1. State the problem precisely.
2. Reproduce it with the smallest failing check.
3. Isolate it: `git bisect run`, input halving.
4. Form hypotheses with predictions, cheapest likely one first.
5. Run experiments that change one thing at a time.
6. Find the root cause, then search for the same mistake elsewhere (`eccode bugs --all`).
7. Make the minimal fix at the root.
8. Prove it: `eccode fix verify`, PROVEN only.
9. Harden it: `eccode mutate`, `eccode bugs`.
10. Record a lesson that an independent reviewer verifies.

The skill also lists the anti-patterns reviewers treat as findings: shotgun changes, patching callers, retrying flakes, and weakening or skipping tests.

## MCP

A role's MCP server offers the same commands as typed tools, so agents without a shell can use them too.
- `bugs` is read-only.
- `mutate` and `fix_verify` run only approved commands, the same allowlist as `evidence_run`: planned verification commands, the behavior command, and detected stack checks.
