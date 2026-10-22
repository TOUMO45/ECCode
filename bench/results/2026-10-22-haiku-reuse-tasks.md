# Paired run: 2026-10-22, claude-haiku (headless), reuse/dependency-temptation tasks, n=5

Executed with `eccode bench --tasks dedupe-objects,slugify-reuse --runs 5` (20
agent runs). These two tasks were added specifically to discriminate on the
lean ladder's reuse and dependency rungs. Honest reading:

- **Hidden checks: 40/40 passed in both variants.**
- **Dependencies: 0/20 runs added one.** Haiku resisted the library temptation
  even bare on tasks this small; the harness's ability to catch dependency
  bloat is proven by the scripted-agent tests, not by this model's behavior.
- **Diff size: smaller with the skill on both tasks** (−3 and −2 median
  lines), and notably **more consistent**: dedupe-objects "without" spiked to
  +44 and +45 lines in 2 of 5 runs, while all five "with" runs stayed within
  +22…+25.
- Combined with the first suite: **the "with" variant produced the smaller
  median diff on 4 of 5 tasks** (equal-ish on csv-sum at +1). Sign counts,
  not significance; a strong claim still needs more tasks, runs and models.

# ECCode paired benchmark

Agent command: `cat PROMPT.md | claude -p --model haiku --allowedTools "Read Grep Glob Edit Write Bash(npm test) Bash(node --test*) Bash(pytest*)"`. "with" prepends the lean-change skill text to the prompt; "without" is the bare prompt. Hidden checks never exist in the sandbox while the agent works. Small n means a demonstration, not a statistic — read the raw rows, not just the medians.

| Task | Variant | n | Hidden checks | Median lines added | Runs adding a dependency | Runs changing a test | Median seconds |
|---|---|---|---|---|---|---|---|
| dedupe-objects | without | 5 | 10/10 | 27 | 0/5 | 5/5 | 21 |
| dedupe-objects | with | 5 | 10/10 | 24 | 0/5 | 5/5 | 19 |
| dedupe-objects | **paired Δ** |  |  | -3 |  |  |  |
| slugify-reuse | without | 5 | 10/10 | 14 | 0/5 | 5/5 | 18 |
| slugify-reuse | with | 5 | 10/10 | 12 | 0/5 | 5/5 | 22 |
| slugify-reuse | **paired Δ** |  |  | -2 |  |  |  |

Paired medians across 2 task(s): the "with" variant produced the smaller diff on 2, the larger on 0, equal on 0. Sign counts, not significance.

## Raw runs

| Task | Variant | Hidden | Lines +/− | New deps | Test files | Seconds | Agent exit |
|---|---|---|---|---|---|---|---|
| dedupe-objects | without | 2/2 | +25/−2 | — | 1 | 21 | 0 |
| dedupe-objects | without | 2/2 | +44/−2 | — | 1 | 27 | 0 |
| dedupe-objects | without | 2/2 | +26/−2 | — | 1 | 16 | 0 |
| dedupe-objects | without | 2/2 | +27/−2 | — | 1 | 18 | 0 |
| dedupe-objects | without | 2/2 | +45/−2 | — | 1 | 21 | 0 |
| dedupe-objects | with | 2/2 | +22/−2 | — | 1 | 19 | 0 |
| dedupe-objects | with | 2/2 | +25/−2 | — | 1 | 19 | 0 |
| dedupe-objects | with | 2/2 | +24/−2 | — | 1 | 16 | 0 |
| dedupe-objects | with | 2/2 | +24/−2 | — | 1 | 23 | 0 |
| dedupe-objects | with | 2/2 | +22/−2 | — | 1 | 18 | 0 |
| slugify-reuse | without | 2/2 | +14/−2 | — | 1 | 19 | 0 |
| slugify-reuse | without | 2/2 | +14/−2 | — | 1 | 16 | 0 |
| slugify-reuse | without | 2/2 | +19/−2 | — | 1 | 19 | 0 |
| slugify-reuse | without | 2/2 | +14/−2 | — | 1 | 18 | 0 |
| slugify-reuse | without | 2/2 | +14/−2 | — | 1 | 17 | 0 |
| slugify-reuse | with | 2/2 | +12/−2 | — | 1 | 23 | 0 |
| slugify-reuse | with | 2/2 | +11/−2 | — | 1 | 25 | 0 |
| slugify-reuse | with | 2/2 | +12/−2 | — | 1 | 22 | 0 |
| slugify-reuse | with | 2/2 | +13/−2 | — | 1 | 17 | 0 |
| slugify-reuse | with | 2/2 | +13/−2 | — | 1 | 17 | 0 |

## Exact statistics across both haiku suites (added after the runs)

Two-sided exact permutation tests on per-run lines added (difference of
means, all 252 relabelings enumerated; minimum attainable p with n=5+5 is
0.0079). Computed by `lib/bench.js permutationTest` from the raw rows above:

| Task | with (lines) | without (lines) | exact p |
|---|---|---|---|
| relative-time | 34,31,27,28,33 | 46,44,42,60,38 | **0.0079** |
| slugify-reuse | 12,11,12,13,13 | 14,14,19,14,14 | **0.0079** |
| dedupe-objects | 22,25,24,24,22 | 25,44,26,27,45 | **0.0159** |
| fix-last-page | 8,9,8,9,14 | 19,10,14,9,10 | 0.214 |
| csv-sum | 23,22,27,24,21 | 18,29,22,31,18 | 1.0 |

Reading: on the three tasks where leanness has room to act (existing helpers
to reuse, a library temptation), the reduction is individually significant at
p < 0.05 with exact tests; on the two tasks that are already minimal, there
is honestly nothing to reduce. Reports generated from now on print these
p-values automatically.
