# Paired run: 2026-10-22, claude-sonnet (headless), cross-model check, n=3

Executed with `eccode bench --tasks relative-time,dedupe-objects,slugify-reuse
--runs 3 --model sonnet` (18 runs) to test whether the haiku findings carry
across models. Honest reading:

- **Hidden checks: 36/36 passed in both variants.**
- **The diff-size effect largely disappears on the stronger model.** Bare
  Sonnet already writes lean code (8-line dedupe solutions); with n=3 the
  exact permutation tests show no significant difference (p=0.30, 1.0, 1.0).
- **The test-discipline effect appears instead:** bare Sonnet shipped a test
  in only 1 of 3 dedupe runs; with the skill, 3 of 3 (and 7/9 vs 9/9 overall).
- Dependencies: 0/18 runs added one.

Combined picture across both models (68 runs total): the lean discipline's
measurable effect concentrates wherever the model's default behavior has a
gap — diff bloat on haiku (three tasks individually significant at exact
p < 0.05), skipped tests on sonnet — and the harness detects both. Hidden
correctness checks passed in 136/136 runs across all suites and variants.

# ECCode paired benchmark

Agent command: `cat PROMPT.md | claude -p --model sonnet --allowedTools "Read Grep Glob Edit Write Bash(npm test) Bash(node --test*) Bash(pytest*)"`. "with" prepends the lean-change skill text to the prompt; "without" is the bare prompt. Hidden checks never exist in the sandbox while the agent works. Small n means a demonstration, not a statistic — read the raw rows, not just the medians.

| Task | Variant | n | Hidden checks | Median lines added | Runs adding a dependency | Runs changing a test | Median seconds |
|---|---|---|---|---|---|---|---|
| dedupe-objects | without | 3 | 6/6 | 8 | 0/3 | 1/3 | 16 |
| dedupe-objects | with | 3 | 6/6 | 14 | 0/3 | 3/3 | 22 |
| dedupe-objects | **paired Δ** |  |  | +6 (exact permutation p=1.000 over 20 splits) |  |  |  |
| relative-time | without | 3 | 6/6 | 34 | 0/3 | 3/3 | 21 |
| relative-time | with | 3 | 6/6 | 32 | 0/3 | 3/3 | 19 |
| relative-time | **paired Δ** |  |  | -2 (exact permutation p=0.300 over 20 splits) |  |  |  |
| slugify-reuse | without | 3 | 6/6 | 13 | 0/3 | 3/3 | 19 |
| slugify-reuse | with | 3 | 6/6 | 13 | 0/3 | 3/3 | 19 |
| slugify-reuse | **paired Δ** |  |  | +0 (exact permutation p=1.000 over 20 splits) |  |  |  |

Paired medians across 3 task(s): the "with" variant produced the smaller diff on 1, the larger on 1, equal on 1. Sign counts, not significance.

## Raw runs

| Task | Variant | Hidden | Lines +/− | New deps | Test files | Seconds | Agent exit |
|---|---|---|---|---|---|---|---|
| dedupe-objects | without | 2/2 | +26/−1 | — | 1 | 19 | 0 |
| dedupe-objects | without | 2/2 | +8/−1 | — | 0 | 16 | 0 |
| dedupe-objects | without | 2/2 | +8/−1 | — | 0 | 11 | 0 |
| dedupe-objects | with | 2/2 | +14/−2 | — | 1 | 24 | 0 |
| dedupe-objects | with | 2/2 | +18/−2 | — | 1 | 22 | 0 |
| dedupe-objects | with | 2/2 | +14/−4 | — | 1 | 20 | 0 |
| relative-time | without | 2/2 | +32/−2 | — | 1 | 22 | 0 |
| relative-time | without | 2/2 | +34/−2 | — | 1 | 20 | 0 |
| relative-time | without | 2/2 | +44/−2 | — | 1 | 21 | 0 |
| relative-time | with | 2/2 | +32/−8 | — | 1 | 20 | 0 |
| relative-time | with | 2/2 | +29/−2 | — | 1 | 19 | 0 |
| relative-time | with | 2/2 | +32/−2 | — | 1 | 17 | 0 |
| slugify-reuse | without | 2/2 | +13/−2 | — | 1 | 19 | 0 |
| slugify-reuse | without | 2/2 | +13/−2 | — | 1 | 18 | 0 |
| slugify-reuse | without | 2/2 | +13/−2 | — | 1 | 20 | 0 |
| slugify-reuse | with | 2/2 | +13/−2 | — | 1 | 20 | 0 |
| slugify-reuse | with | 2/2 | +13/−2 | — | 1 | 17 | 0 |
| slugify-reuse | with | 2/2 | +12/−2 | — | 1 | 19 | 0 |
