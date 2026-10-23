# Pre-registered protocol: on Sonnet, are the skill's extra lines code or tests?

Committed and pushed before any run of this batch starts; the git commit timestamp is the registration.

**Why.** The pre-registered Sonnet n=10 batch (`2026-10-23-sonnet-n10-a.md`, `-b.md`) found the lean-change skill makes Sonnet's diffs larger (+3.00 lines per change, p = 1.0e-4) while raising the runs that write tests from 45/80 to 80/80. Those reports count test lines together with code lines, so they cannot say whether the extra lines are the tests the skill asks for or extra code. Register row 36 stays open on that question. That batch's stopping rule forbids re-sampling its 8 tasks, so this batch uses four new tasks and the harness's new per-run count of lines added in test files.

**Design (fixed in advance).**
- Model and agent command: as in the earlier batch, `cat PROMPT.md | claude -p --model sonnet --allowedTools "Read Grep Glob Edit Write Bash(npm test) Bash(node --test*) Bash(pytest*) Bash(go test*)"`, with `--suite bench/suites/followup`.
- Tasks: the four tasks of `bench/suites/followup` (top-words, py-median, go-truncate, parse-duration; JavaScript, Python and Go). Each has an existing helper to reuse and a visible test convention. They were written for this batch, validated by scripted reference solutions (`tests/bench-reference/`, checked in `tests/bench.test.js`), and have never been run with any model.
- n = 10 per variant per task (80 runs), 540 s timeout per run. Execution in two parallel halves of two tasks each (top-words + py-median, go-truncate + parse-duration), decided now.
- **Primary outcome: code lines added per run**, meaning lines added outside test files (lines added minus the harness's "Lines added in tests").
- **Primary analysis:** the stratified permutation test on code lines (labels shuffled within each task; 20,000 seeded resamples; two-sided), over this batch's two report files, as printed by `eccode bench tally --dir <those two files>` in the "tests excluded" figure for sonnet.
- Secondary outcomes: total lines added (same test); per-task exact permutation tests on code lines and on total lines (in the reports); runs changing a test file; hidden checks; dependency additions.
- **Decision rule for register row 36:**
  - tests-excluded mean (with − without) ≤ 0: row 36 closes as "Closed — by design". On these tasks the skill's extra lines on Sonnet are the tests it asks for, not more code. A non-positive estimate shows no sign of extra code at this sample size; it does not prove a zero effect, and the row will say so.
  - mean > 0 and p < 0.05: row 36 stays open, restated as "the skill makes Sonnet write more code". The next step is revising the skill under a new protocol.
  - mean > 0 and p ≥ 0.05: inconclusive. Row 36 stays open, restated with the estimate.
- Reporting: both reports are committed verbatim whatever they show, with this protocol cited.
- Stopping rule: one batch. No further Sonnet sampling on these four tasks after it.
