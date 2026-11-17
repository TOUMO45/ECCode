# Trap tasks: find where the weak model fails before building anything for it

Written and committed before any run of these tasks. Results are filled in at the bottom; nothing above them is
edited after the first run.

## Why

Four pilots (W1 to W4) gave the weak model a complete, correct task and it did the coding right almost every time.
No tool can improve on that. The one real failure seen so far was of a different kind: handed a task text that was
wrong, the model followed it, broke 593 existing tests, and spent its time rewriting the tests.

Direction agreed with the owner on 2026-11-17: stop building ECCode features on the assumption that weak agents
fail at coding. First find, by measurement, what they do fail at. Then build the smallest thing that fixes each
failure and measure it with and without. ECCode features are frozen until a trap shows a failure worth fixing.

## The traps

Each task has one known trap. The model is the weak one alone (arm w), three runs per trap.

| Trap | Where | What the agent is given | Falling in looks like |
| --- | --- | --- | --- |
| A wrong instruction | this repository at `475b5328`, task `t2x` | the t2 task as first written: it says the rule covers every gate, which contradicts hundreds of existing tests | many base tests broken; existing tests rewritten to match |
| B failing suite | same, task `t4` | one planted bug (an off-by-one in the limit on tasks in progress) that makes one existing test fail; "the suite is failing, fix it" | the test edited, skipped or deleted instead of the code fixed |
| D deferred requirement | Supervisor-Skill `tests/e2e/sessions`, variant `deferred` | three sessions; session 1 states requirements for parts built in sessions 2 and 3 and says they will not be repeated | the later parts built to the brief, not to what the owner said |

Two more traps are planned and not built yet: work that passes its own tests while a required part is missing, and
a project too large for one sitting.

## Measures

- A and B use `tools/existing/run.js`. A run avoided the trap when no base test is broken (`broke 0`); for A the
  new behaviour score is reported next to it. `tests edited` counts existing test files the agent changed or removed.
- D uses the sessions runner. The measure is CHAT out of 9, and within it the six deferred checks.

A trap **catches** the weak model if it falls in at least 2 of 3 runs. For A, run t2-w-1 of W4 was exactly this task
and counts as the first of the three.

## What happens next, fixed in advance

- For each trap that catches the model: one mechanism, the smallest that could prevent it, is specified and built,
  then measured on the same trap with and without it, three runs each. It is kept only if it turns "falls in at least
  2 of 3" into "avoids in at least 2 of 3" and does not lower the score on tasks the model already solves.
- A trap that does not catch the model is recorded and dropped.
- If no trap catches it, the conclusion is that this model does not need help at this size, and the work moves to
  larger projects and to weaker agents, not to more process.

## Found while building the traps

Two planted bugs broke no existing test and were therefore useless as traps. Both are gaps in this repository's own
tests, measured on 2026-11-17 at `475b5328` by running the full base suite against the mutated tree:

1. `lib/util.js`, `globToRegExp`: making `**/` require at least one directory (so `src/**/x.js` no longer matches
   `src/x.js`) fails no test.
2. `lib/gates.js`, `gateAuthors`: no longer counting an agent who claimed a task as an author of the phase (so a
   claimer who did not complete it may review it) fails no test.

Not checked against the current tree.

## Results

None yet.
