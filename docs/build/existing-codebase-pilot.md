# Existing-codebase pilot (W4): can the weak model change a large codebase it did not write?

Written and committed before any run. The results section is filled in afterwards; nothing above it is edited after
the first run.

## Why

W1, W2 and W3 all started from an empty folder with a few hundred lines to write, and the weak model alone scored
full marks every time (four projects, twelve runs). None of them could show a tool helping. The work this project is
meant for is different: a large codebase the agent did not write, where it has to find the right place and respect
rules it was not told. This test measures that.

## The codebase and the tasks

The codebase is this repository as it was at commit `475b5328` (about 1,800 files, 118 test files, a test suite of
roughly 1,800 tests that takes several minutes). The three tasks are changes that were really made to it later; the
agent gets the repository from before they existed.

| Task | Change | Where the real change landed | Checks |
| --- | --- | --- | --- |
| t1 | Missing input file is a refusal, `--version`, a failed check exits 3 | 3 places in the CLI | 8 |
| t2 | A reviewer must have run each pinned verification command to approve | the review rules | 7 |
| t3 | `task complete --done` and `gate review --approve --summary` | CLI and review rules, new function | 10 |

Each task is given as `TASK.md` (text in `tools/existing/tasks/`) with the prompt: "This directory is the ECCode
repository. Make the change described in TASK.md. I am unreachable, so do not ask me anything: decide and finish."

## Arms

| Arm | Model | What it gets |
| --- | --- | --- |
| w | Haiku | the prompt |
| k | Haiku | the prompt starting with "Use the autonomous-supervisor skill for this work.", and the skill installed |
| s | Sonnet | the prompt (reference only) |

**There is no ECCode arm yet, on purpose.** Today's ECCode contains the finished answer to all three tasks, so an
agent with the plugin installed could read the solution from the plugin's own files. An ECCode arm needs tasks that
do not exist in ECCode yet. It will be defined, with new tasks, only if arm w leaves room for a tool to help.

Same tools, 200 turns, 45 minutes, no user settings, no other plugins.

## Measure

Two things, both required:

1. **New behaviour.** `tools/existing/oracle.js` drives the agent's CLI from outside in throwaway projects.
   Self-check: the base scores 3/8, 2/7 and 4/10; each reference change (`tools/existing/reference/`) scores full
   marks; so does today's ECCode.
2. **Nothing broken.** The test files from the base commit are run against the agent's tree. A test counts as
   broken if it fails there, did not fail on the untouched base on the same machine, and is not one of the tests the
   reference change itself has to change (listed in `tools/existing/base.json`). The agent's own edits to test files
   are ignored for this count: it cannot make a broken test pass by rewriting it.

A run is **solved** when the new behaviour scores full marks and nothing is broken. Cost, turns and time are
recorded.

## Order and rules fixed in advance

1. Arm w first: each task twice (6 runs).
2. If all 6 are solved, the weak model alone handles this kind of work too, the test cannot show a tool helping, and
   it stops. That is recorded as it is.
3. Otherwise: arm k on the tasks that were not solved every time, twice each, and arm s once per task. A new set of
   tasks for an ECCode arm is then written and registered separately.
4. A tool helps on a task if it solves it in both runs where arm w did not. With two runs per cell this is a pilot:
   it can show a clear difference or none, not a rate.

A run is thrown out only if `contaminated` is true or the runner crashed. A run that hits the time limit counts as
not solved.

## How to run

The output folder must be outside the repositories. The first run in a new output folder measures the base test
suite on that machine once (several minutes).

```
node tools/existing/run.js --task t1 --arm w --run 1 --out <dir>
```

## Results

None yet.
