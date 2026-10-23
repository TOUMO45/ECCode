# Precision of the built-in bug rules on real code (2026-10-23)

`node bench/bugs/fp-audit.js <corpus> <hits.json>` ran every built-in rule over whole files (`eccode bugs --all --no-external`). Every error-level hit was labelled by hand; warnings were spot-checked. Released, tested code is expected to contain few real slips, so the main question here is how often a rule fires where nothing is wrong. Recall on genuine slips is covered by a positive and a near-miss unit test per rule (tests/bugs.test.js); it is not measured here.

## Method

- **Dev corpora**, used to tune the rules (every hit was read):
  - the Python 3 standard library (281k lines);
  - npm and its bundled dependencies, plus ESLint's `lib/` (228k lines of JavaScript);
  - the Go standard library (1.82M lines);
  - ECCode itself (21.6k lines).
- **Held-out corpora**, chosen before they were scanned:
  - every third-party Python package installed on the machine (2.06M lines);
  - the other globally installed Node packages, among them Playwright, TypeScript, Prettier, nodemon and ts-node (71.5k lines after skips);
  - Go's compiler test suite and `misc/` (158k lines).

## What the dev corpora changed

| Rule | Finding on dev corpora | Change |
|---|---|---|
| `py/mutable-default` | 24 hits, 0 real bugs. All were intended caches (`cache={}`, `_seen={}`), sentinels or read-only defaults. | Error → warning. It is a bug only when the function mutates the argument. |
| `js/assign-in-condition` | 2 hits, both the intended `if (m = re.exec(s))` idiom | Fires only when the right side is a literal or a plain name, the typo shape |
| `js/empty-catch`, `py/except-pass` | 13 of 13 hits in ECCode had an explanatory comment in the block | A comment in the block marks it as intended |
| `py/except-pass` | 558 hits in the stdlib, mostly `except KeyError: pass` control flow | Broad catches only (bare, `Exception`, `BaseException`) |
| `go/skipped-test` | 1395 hits, nearly all `if testing.Short() { t.Skip() }` or platform skips | Unconditional skips only |
| `js/parseInt` radix | Since ES5, a missing radix no longer means octal | Removed before measuring, as style rather than a bug |

## Held-out results

| Corpus | Lines | Error hits before the held-out fixes | Error hits after | Real slips among them |
|---|---|---|---|---|
| Third-party Python | 2,057,482 | 3 `py/debugger` | 2 | 0 |
| Global Node packages | 71,528 | 7 `js/assign-in-condition` + 1 `js/async-promise-executor` (warning) | 0 | 0 |
| Go test suite | 157,518 | 0 | 0 | 0 |

The held-out run found two false-positive sources, and both were fixed:
- **Minified bundles.** All 8 JavaScript hits were inside generated bundles (Playwright's `*BundleImpl.js`, Prettier's plugins), where minifiers write `if(t.contents=r||null,!r)`. Files whose characters sit mostly in lines over 1000 characters are now treated as generated and skipped.
- **Suppression comments.** One `breakpoint()` was annotated `# noqa: T100`. `noqa`, `eslint-disable-line`, `eslint-disable-next-line`, `nolint` and `eccode-allow` are now honored.

These fixes were made after seeing held-out data, so the "after" column is no longer a clean held-out measurement. Both columns are shown for that reason.

The two remaining hits are pyparsing's deliberate break-into-debugger feature (`pdb.set_trace()` in its debug helper), vendored twice. They are labelled false positives: intended code, not a leftover.

## Warnings: does the pattern match what the message says?

| Rule | Held-out hits | Spot check |
|---|---|---|
| `py/except-pass` | 115 | 23 of 23 sampled are a broad catch with a bare `pass` and no comment |
| `py/bare-except` | 186 | Literal pattern (`except:`); flake8 reports the same as E722 |
| `py/mutable-default` | 89 | Literal pattern; per the dev corpora, usually intended |
| `py/skipped-test` | 13 | 5 of 5 sampled are unconditional `@pytest.mark.skip` decorators with a reason |
| `js/empty-catch` | 11 | Sampled hits are `catch (e) {}` with no comment, in hand-written files |

## Reading

On 2.29M lines of held-out real code, the final error rules fire twice, and both times on intentional debugger hooks. They found no genuine bugs in released code, which is expected, because these rules target slips in a change before it ships. The warning rules match what they claim, but in mature code they mostly flag deliberate choices. That is why they are recorded rather than refused, unless the lean level is `strict`. Real bug-finding depth comes from the analyzers ECCode runs when they are installed (ruff, go vet, eslint, semgrep), from mutation testing (`eccode mutate`) and from regression proof (`eccode fix verify`).

Speed: 1.82M lines of Go took 3.4 s and 2.06M lines of Python took 6.3 s for a whole-file scan. A diff scan touches only the changed files.
