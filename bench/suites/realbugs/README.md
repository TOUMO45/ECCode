# realbugs: twenty real bugs at their pre-fix commits

Each task is a bug that was reported and fixed in a real open-source project, taken from [BugsInPy](https://github.com/soarsmu/BugsInPy). The agent gets the project's tree at the commit **before** the fix, with no git history (the sandbox gets a fresh one-commit repository, so the fix is nowhere in it). It also gets a bug report written as a user would write it: the symptom, an example, the expected behavior, and how tests run. The hidden checks are the fix's own tests, measured on this machine:

- **bug**: every test of the fixed commit's test files that fails on the pre-fix tree and passes on the fixed one;
- **regression**: every other test of those files (for thefuck the whole offline suite; for tqdm also `tests_tqdm.py`) that passes on both trees. Tests that fail on the fixed tree in this environment are deselected, and listed in each `task.json` under `measured`.

A run passes when it passes both. The hidden test files go into the sandbox only after the agent has finished, over whatever the agent left at those paths (`_hidden/place.js`).

| Project | Tasks (BugsInPy ids) | Environment |
|---|---|---|
| youtube-dl | 16, 9, 41, 4 | `py38` |
| black | 19, 10, 20, 17 | `black` |
| tornado | 10, 13, 7, 15 | `py38` |
| thefuck | 2, 24, 31, 22 | `thefuck` |
| tqdm | 6, 9, 1, 4 | `py38` |

**How they were chosen** (`_tools/selection.json`). Every bug of eight projects was screened under Python 3.8. The fixed commit's test files were copied onto the buggy commit; a bug was reproduced when BugsInPy's tests for it failed there and passed on the fixed commit. Five projects reproduced at least nine bugs each. Within each, the reproduced bugs were shuffled with a fixed seed and taken in that order, four per project. A bug was skipped only for one of three recorded reasons: a feature rather than a bug (black-23, thefuck-28), or fixed tests that call API the buggy code does not have (tqdm-2). No model saw any task before the selection was final.

**Files.**
- `_tools/build.py` writes the tasks from BugsInPy's metadata and the projects' repositories.
- `_tools/prompts.json` holds the bug reports, written by hand from each fix's tests.
- `_tools/setup.sh` builds the three Python environments from `_tools/requirements/`.
- `reference/fix.patch` is the real fix, used only to validate the task.

**Running it.**
```
ECCODE_REALBUGS_VENVS=$HOME/.cache/eccode/realbugs-venvs sh bench/suites/realbugs/_tools/setup.sh
ECCODE_REALBUGS_VENVS=$HOME/.cache/eccode/realbugs-venvs ECCODE_REALBUGS_VALIDATE=1 node --test tests/realbugs.test.js
ECCODE_REALBUGS_VENVS=$HOME/.cache/eccode/realbugs-venvs eccode bench --suite bench/suites/realbugs --agent "<cmd>" --variant without,debug
```
Keep `TMPDIR` short (under 60 characters): tornado's Unix-socket tests bind a socket in it, and a longer path fails them with `AF_UNIX path too long` whatever the agent did; `bench` warns when it is too long. The first run clones the five repositories into `ECCODE_BENCH_CACHE` (default `~/.cache/eccode/bench-repos`). The validation test checks every task end to end: the pre-fix tree fails the bug check and passes the regression check, and with the real fix applied both pass.

**Limits.** These are public bugs fixed years ago, so a model may have seen the fixes in training. That affects every variant alike, so it shifts pass rates without favoring any variant. The reports are written to be fair to the hidden tests: where a test pins an interface the fix chose (dfxp2srt taking bytes), the report states it. They still cannot rule out a correct fix that the original tests reject.

Third-party licenses for the copied test files and patches: see `NOTICE`.
