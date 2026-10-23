# Benchmark run — 2026-10-23, claude -p (haiku), Python reuse temptation, n=5 per variant

`py-page-id` is the Python mirror of `slugify-reuse`: an existing `normalize()`
helper in the same module, and a prompt that never mentions it. The JS original
showed one of the suite's strongest effects (p=0.0079, with-skill runs reusing
the helper for visibly smaller diffs). This run asks whether that effect
reproduces in Python with the same model.

**It does not — and that is the result.** Both variants passed 10/10 hidden
checks, added 0 dependencies, wrote a test on every run, and produced the same
median diff (11 lines; exact permutation p=1.000). Reading the raw rows, the
baseline agent reuses the in-file helper unprompted in Python, so the lean
skill is a no-op here apart from ~8 median seconds of reading time.

**What this means for the suite.** The skill's measured value concentrates
where the unskilled baseline drifts — JS reuse and dependency temptations,
tasks that tempt a caller-side patch — and goes to zero where the baseline is
already disciplined. The harness reports both directions with the same
machinery; a benchmark that only ever finds wins would not be worth trusting.

# ECCode paired benchmark

Agent command: `cat PROMPT.md | claude -p --model haiku --allowedTools "Read Grep Glob Edit Write Bash(npm test) Bash(node --test*) Bash(pytest*)"`. "with" prepends the lean-change skill text to the prompt; "without" is the bare prompt. Hidden checks never exist in the sandbox while the agent works. Small n means a demonstration, not a statistic — read the raw rows, not just the medians.

| Task | Variant | n | Hidden checks | Median lines added | Runs adding a dependency | Runs changing a test | Median seconds |
|---|---|---|---|---|---|---|---|
| py-page-id | without | 5 | 10/10 | 11 | 0/5 | 5/5 | 16 |
| py-page-id | with | 5 | 10/10 | 11 | 0/5 | 5/5 | 25 |
| py-page-id | **paired Δ** |  |  | +0 (exact permutation p=1.000 over 252 splits) |  |  |  |

Paired medians across 1 task(s): the "with" variant produced the smaller diff on 0, the larger on 0, equal on 1. Sign counts, not significance.

## Raw runs

| Task | Variant | Hidden | Lines +/− | New deps | Test files | Seconds | Agent exit |
|---|---|---|---|---|---|---|---|
| py-page-id | without | 2/2 | +12/−1 | — | 1 | 14 | 0 |
| py-page-id | without | 2/2 | +11/−1 | — | 1 | 17 | 0 |
| py-page-id | without | 2/2 | +11/−1 | — | 1 | 19 | 0 |
| py-page-id | without | 2/2 | +12/−1 | — | 1 | 16 | 0 |
| py-page-id | without | 2/2 | +11/−1 | — | 1 | 15 | 0 |
| py-page-id | with | 2/2 | +10/−1 | — | 1 | 25 | 0 |
| py-page-id | with | 2/2 | +14/−1 | — | 1 | 26 | 0 |
| py-page-id | with | 2/2 | +11/−1 | — | 1 | 21 | 0 |
| py-page-id | with | 2/2 | +11/−1 | — | 1 | 25 | 0 |
| py-page-id | with | 2/2 | +11/−1 | — | 1 | 23 | 0 |
