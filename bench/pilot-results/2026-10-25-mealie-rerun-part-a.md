# The Mealie rerun, Part A: model-free measurements at P2 over W2

Protocol: [bench/protocols/2026-10-25-mealie-rerun.md](../protocols/2026-10-25-mealie-rerun.md), Part A. These are the pilot's scripts, measures, labels and criteria, unchanged, with:
- P2 = `dedc6cc7` (v3.27.0) in place of P;
- W2 = v3.27.0..v3.29.0 (215 commits, history no fix was built from) in place of W.

ECCode ran at the protocol commit `8662f5e`, after Parts B and C ended, with no agent running. The table is rendered by `bench/pilot/mealie/report.js` from [results-rerun](../pilot/mealie/results-rerun) and [labels-rerun](../pilot/mealie/labels-rerun); every label was committed before the table was rendered. The rest of the rerun: [2026-10-25-mealie-rerun.md](2026-10-25-mealie-rerun.md).

## As measured

| Capability | Measure | Criterion | Result | Met |
|---|---|---|---|---|
| Index (A1) | Python intra-project imports resolved | ≥ 95% | 1 | met |
| Index (A1) | TS/JS intra-project imports resolved | ≥ 90% | 0.998 | met |
| Index (A1) | onboard cold, ms | ≤ 120,000 | 487 | met |
| Index (A1) | onboard warm, ms | ≤ 10,000 | 302 | met |
| Index (A1) | onboard after a one-file edit, ms | ≤ 10,000 | 291 | met |
| Impact (A2) | median recall against coverage, static | ≥ 0.90 | 1 | met |
| Impact (A2) | median recall against coverage, with --trace | ≥ 0.95 | 1 | met |
| Impact (A2) | median share of all test files selected | ≤ 0.5 | 0.784 | missed |
| Impact (A2) | recall against injected faults, pooled over the fault runs | ≥ 0.90 | 1 | met |
| Compat (A3) | precision of detections over the window | ≥ 0.90 | 0.571 (14 labelled) | missed |
| Compat (A3) | recall against FastAPI's route table | ≥ 0.90 | — | — |
| fix verify (A4) | agreement with running the tests directly, each disagreement labelled engine-wrong or oracle-wrong | 100% | 1 (raw agreement 0.871; 4 disagreements labelled) | met |
| mutate (A5) | runs completing | ≥ 90% | 1 | met |
| Bug rules (A6) | false positives per 10,000 changed lines | ≤ 1 | 0.701 (1 hits, 0 unlabelled) | met |
| Stack (A7) | stacks detected at the pin | Python and Node | node, python | met |
| Stack (A7) | detected checks runnable, result equal to the tool run directly | all | 5/5 | met |
| Secrets (A7) | error-level false positives at the pin | ≤ 5 | 0 (0 error-level hits) | met |

## In short

- **Fourteen of seventeen criteria are met as measured.** Two are missed and one has no verdict:
  - impact's share of the suite (row 74);
  - compat precision, 0.571;
  - route recall (no verdict).

  For comparison, the pilot met 10 as measured and 15 after its fixes, both on its own window W.
- **Reading the results closely found that two "met" rows and the one "no verdict" rest on instruments that could not see what they measured:**
  - **A3's route table read none of Mealie's API routes**, at P2 and also at the pilot's P. FastAPI keeps an included router as a single node, and the table read only top-level routes, so it saw the four documentation routes. "No route removed in the sample" was true by construction. This holds for the pilot's row 76 as much as for this run.
  - **A7's two frontend checks failed on both sides, so "equal" proved nothing.**
    - Through ECCode, pnpm refused the `node_modules` the benchmark links in (`ERR_PNPM_UNSAFE_MODULES_DIR`, at its pre-run dependency check).
    - Run directly, the instrument called yarn. Mealie's frontend has used pnpm 11 since before P2 (`"packageManager": "pnpm@11.23.0"`).
- **The other findings:**
  - **Two A4 disagreements were only names.** The oracle says not-proven where `fix verify` says tests-pass-without-fix.
  - **A6's one false positive came from the instrument:** its scratch repo lacked Mealie's `pyproject.toml`, so ruff judged Python 3.14 code by an older target.
  - **An ECCode defect in `mutate`:** a timed-out mutant's tests went on running. Two pytest processes from A5 were still running 50 minutes later, after their scratch repository had been deleted (row 128).
  - **Compat's six false detections fall in two classes:**
    - the definitions of a deleted standalone dev script (fixed, row 125);
    - edits to applied migrations that change nothing a database ran (named, row 126).
- **Each defect is fixed with a test that failed first; the after-fix figures are below, run post hoc and not registered.**
  - Compat precision rises to 0.80 (8 of 10). Route recall is 1 of 1 on W2's sample, the first removal the table could see.
  - A6 has no false positives, and A7's frontend checks pass both ways.

## Reading the measures

**A1, the index.** Every criterion is met, at about the pilot's speed: 487 ms cold, 302 ms warm, 291 ms after a one-file edit. The tree has 650 Python files (75,548 lines) and 507 JS/TS files (56,680 lines).
- Python imports: 2,460 of 2,460 resolve.
- TS/JS imports: 1,316 of 1,318 resolve. The two left are a `~/types/…` placeholder and Nuxt's generated `./.nuxt/eslint.config.mjs`.
- The three dynamic loaders are flagged.

**A2, impact.** Recall stays complete: 1.0 static and with `--trace` over 40 sampled modules, and 1.0 against injected faults pooled over ten runs. The median share of test files selected is 0.784, against ≤ 0.5. That is row 74: every integration test loads the app, so static reach selects most of the suite for any module the app imports. Static precision is 0.27.

**A3, compat.**
- **Precision: 8 of 14 detections are true breaking changes.** The true ones:
  - a removed seeder class;
  - a database fix function;
  - two public time helpers (`parse_iso8601_duration`, `format_time`);
  - two database event functions;
  - the seeder route `POST /api/groups/seeders/labels`;
  - one destructive migration (`DELETE FROM` without `WHERE` in `upgrade()`).
- **The six false ones:**
  - four definitions of `dev/scripts/convert_seed_files_to_new_format.py`. It is a one-off script with a main guard, outside any package, that nothing imports, deleted in 3d1978a;
  - two edits to applied migrations in e1d0ffd, the Python 3.14 upgrade: a connection cleanup in a helper (`engine.dispose()`) and an unquoted type annotation. Neither changes anything a database ran.
- **Route recall: no verdict.** The table saw no route at all (above).

**A4, `fix verify`.** 31 of the 32 fixes in W2 were replayed. c266cff was skipped correctly: it changed only a message file and a test, and the engine answered that there is no fix to verify. Raw agreement with running the tests directly is 0.871. All four disagreements are labelled oracle-wrong:
- **643c4901:** the AttributeError the oracle reads as a missing API is the bug. An admin's edit in another household reached the route with no household and answered 500.
- **c794a53c:** the oracle's missing-API pattern matched elsewhere in the output. The failure is `KeyError 'sodiumContent'`, and creating a recipe answered 400: the bug.
- **10fa95e2 and eaf8415c:** the tests pass before the fix. The oracle calls that not-proven; the engine names the same case tests-pass-without-fix.

**A5, `mutate`.** All 32 runs completed. 116 of 168 mutants were killed (0.69; no criterion). One run, 29457ba0, timed out on two mutants. Their pytest processes outlived the timeout: the engine defect above (row 128). They started at about 04:33Z, ran beside the last A5 runs and the whole of A7, and were found and stopped at about 05:26Z. They ran in their own deleted scratch directory, so they shared only the CPU with other runs. A7 judges exit codes, not times.

**A6, bug rules.** One hit in 14,268 changed lines (0.70 per 10,000, met): F821 `Branding` in `mealie/core/settings/branding.py:17`. It is a false positive. Mealie targets Python 3.14, which evaluates annotations lazily, and a scan of the full tree finds nothing. The instrument's scratch repo held only the changed files, without `pyproject.toml`, so ruff assumed an older target.

**A7, stack.**
- **Stacks:** both found (Node, Python).
- **Checks:** pytest, ruff and mypy pass through ECCode and directly. The two frontend checks failed on both sides for the reasons above. The criterion counts them as equal, but they are not evidence.
- **Secrets:** no error-level hit. The one warning is the Amazon affiliate link in a scraped recipe page kept as test data, the same one the pilot labelled.

## Defects and limits this Part A found

| Row | What | Disposition |
|---|---|---|
| 125 | Compat read a standalone Python script's definitions as public API | Fixed: a script (main guard, no `__init__.py` beside it, named by no project import) has no import surface (lib/compat.js; tests/compat.test.js) |
| 126 | An edit to an applied migration is reported whatever it changes | Named: telling a connection cleanup from a changed operation needs the migration's meaning, not its text. The finding names the file, so the author can say why the edit is safe |
| 127 | Part A's instruments assumed the pilot's environment:<br>• the route table read only top-level routes;<br>• A4's oracle used its own verdict names;<br>• A6's scratch repo had no lint configuration;<br>• A7 ran the frontend with yarn | Fixed, each with a test:<br>• the table walks FastAPI's included routers (`fastapi-routes.py`);<br>• the oracle uses `fix verify`'s names;<br>• the scratch repo keeps `pyproject.toml` and the other lint configuration;<br>• A7 takes the package manager from the commit's lockfile (tests/pilot.test.js) |
| 128 | A timed-out mutant's tests went on running after `mutate` moved on | Fixed: each mutant's command runs in its own process group, stopped whole when it ends or times out (lib/mutate.js; tests/mutate.test.js) |
| 101 | pnpm refused the benchmark's linked `node_modules` | Mitigated: every Mealie task, and the Part A environment, sets `pnpm_config_verify_deps_before_run=false` (tests/mealie.test.js). `go-task` is still not installed |

## After the fixes (post hoc, not registered)

ECCode at the fix commits, the same window and pin, the same labels. Results: [results-rerun-after](../pilot/mealie/results-rerun-after).

AFTER_TABLE

## How it ran

- **Order:**
  - Parts B and C ended before Part A began.
  - A1 and A2 ran first, alone (02:15Z–03:12Z).
  - A3 then A6 ran beside A4 and beside A5, the arrangement the pilot used (03:12Z–04:41Z).
  - A7 ran last (04:41Z–05:00Z).

  The sequential runner was stopped once A2 ended, and a second one ran the rest in the pilot's arrangement, with the same scripts, arguments and results directory.
- **Machine:** the same session container as Parts B and C. The A5 orphans above ran during A7.
- **Environment:** `node_modules` for the frontend is linked from a shared environment (row 101). The Python venv is built per lockfile with uv.
