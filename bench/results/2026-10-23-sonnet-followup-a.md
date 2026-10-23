# Benchmark run — 2026-10-23, claude -p (sonnet), pre-registered follow-up, half A (py-median, top-words)

**Pre-registered.** Protocol: [bench/protocols/2026-10-23-sonnet-code-lines.md](../protocols/2026-10-23-sonnet-code-lines.md), committed and pushed in b1077f8 at 08:30:36 UTC; every run below started after it (both halves at about 08:31 UTC). Design as registered: the four tasks of `bench/suites/followup`, never run with any model before, n=10 per variant per task, 540 s timeout, the registered agent command with `--suite bench/suites/followup`, executed in the two halves the protocol names. Primary outcome: code lines added per run (tests excluded). Nothing was stopped, repeated or dropped.

**Outcome (the pre-registered primary analysis): on Sonnet the skill makes the code smaller; its extra lines are tests.** Stratified permutation test on code lines, tests excluded, over both halves (labels shuffled within each task; 4 strata, 80 runs; `eccode bench tally --dir` over the two files): with − without = **−1.27 code lines per change in the pre-registered follow-up**, two-sided p ≤ 5.0e-5, the floor of 20,000 seeded resamples. Per task, code lines: go-truncate −1 and parse-duration −2 (exact p < 0.001 each), py-median −2 (p = 0.011), top-words +0 (p = 0.47) while its total lines rose by +6 (p = 0.009): its extra lines were tests.

**Secondary outcomes.** Total lines added, with − without: −1.60 per change (p = 0.15). Runs that changed a test file: 40/40 with the skill, 29/40 without. Hidden checks 160/160; 0 dependency additions; 0 agent failures.

**Decision rule applied as registered.** The tests-excluded mean is ≤ 0, so register row 36 closes as "Closed — by design": on these tasks the skill's extra lines on Sonnet are the tests it asks for, and the code itself is smaller. The earlier batch's +3.00 total lines per change on the original 8 tasks stays in the record as measured; that batch cannot be split into test and code lines, and its stopping rule forbids re-sampling those tasks, so the decomposition rests on these four new tasks.

Other half: [2026-10-23-sonnet-followup-b.md](2026-10-23-sonnet-followup-b.md). The report below is the harness's output, unedited.

# ECCode paired benchmark

Agent command: `cat PROMPT.md | claude -p --model sonnet --allowedTools "Read Grep Glob Edit Write Bash(npm test) Bash(node --test*) Bash(pytest*) Bash(go test*)"`. "with" prepends the lean-change skill text to the prompt; "without" is the bare prompt. Hidden checks never exist in the sandbox while the agent works. Each variant ran n >= 10 times per task. The exact permutation test enumerates every split, so the p-values are exact, not asymptotic. Read the raw rows alongside the medians.

| Task | Variant | n | Hidden checks | Median lines added | Median code lines added (tests excluded) | Runs adding a dependency | Runs changing a test | Median seconds |
|---|---|---|---|---|---|---|---|---|
| py-median | without | 10 | 20/20 | 23 | 11 | 0/10 | 6/10 | 26 |
| py-median | with | 10 | 20/20 | 17 | 9 | 0/10 | 10/10 | 23 |
| py-median | **paired Δ** |  |  | -6 (exact permutation p=0.240 over 184756 splits) | -2 (exact permutation p=0.011 over 184756 splits) |  |  |  |
| top-words | without | 10 | 20/20 | 10 | 10 | 0/10 | 4/10 | 19 |
| top-words | with | 10 | 20/20 | 16 | 10 | 0/10 | 10/10 | 31 |
| top-words | **paired Δ** |  |  | +6 (exact permutation p=0.009 over 184756 splits) | +0 (exact permutation p=0.474 over 184756 splits) |  |  |  |

Paired medians across 2 task(s): the "with" variant produced the smaller diff on 1, the larger on 1, equal on 0. Sign counts, not significance.

## Raw runs

| Task | Variant | Hidden | Lines +/− | New deps | Test files | Seconds | Agent exit | Lines added in tests |
|---|---|---|---|---|---|---|---|---|
| py-median | without | 2/2 | +11/−0 | — | 0 | 19 | 0 | 0 |
| py-median | without | 2/2 | +11/−0 | — | 0 | 22 | 0 | 0 |
| py-median | without | 2/2 | +27/−1 | — | 1 | 40 | 0 | 18 |
| py-median | without | 2/2 | +11/−0 | — | 0 | 25 | 0 | 0 |
| py-median | without | 2/2 | +23/−1 | — | 1 | 33 | 0 | 14 |
| py-median | without | 2/2 | +25/−1 | — | 1 | 24 | 0 | 14 |
| py-median | without | 2/2 | +29/−1 | — | 1 | 28 | 0 | 18 |
| py-median | without | 2/2 | +11/−0 | — | 0 | 18 | 0 | 0 |
| py-median | without | 2/2 | +23/−1 | — | 1 | 32 | 0 | 14 |
| py-median | without | 2/2 | +27/−1 | — | 1 | 31 | 0 | 18 |
| py-median | with | 2/2 | +17/−1 | — | 1 | 22 | 0 | 8 |
| py-median | with | 2/2 | +16/−1 | — | 1 | 24 | 0 | 7 |
| py-median | with | 2/2 | +17/−1 | — | 1 | 24 | 0 | 8 |
| py-median | with | 2/2 | +17/−1 | — | 1 | 23 | 0 | 8 |
| py-median | with | 2/2 | +17/−1 | — | 1 | 23 | 0 | 8 |
| py-median | with | 2/2 | +17/−1 | — | 1 | 24 | 0 | 8 |
| py-median | with | 2/2 | +17/−1 | — | 1 | 22 | 0 | 8 |
| py-median | with | 2/2 | +16/−1 | — | 1 | 28 | 0 | 7 |
| py-median | with | 2/2 | +16/−1 | — | 1 | 22 | 0 | 7 |
| py-median | with | 2/2 | +17/−1 | — | 1 | 24 | 0 | 8 |
| top-words | without | 2/2 | +16/−2 | — | 1 | 24 | 0 | 6 |
| top-words | without | 2/2 | +10/−1 | — | 0 | 18 | 0 | 0 |
| top-words | without | 2/2 | +10/−1 | — | 0 | 16 | 0 | 0 |
| top-words | without | 2/2 | +16/−2 | — | 1 | 31 | 0 | 6 |
| top-words | without | 2/2 | +10/−1 | — | 0 | 19 | 0 | 0 |
| top-words | without | 2/2 | +10/−1 | — | 0 | 18 | 0 | 0 |
| top-words | without | 2/2 | +16/−2 | — | 1 | 26 | 0 | 6 |
| top-words | without | 2/2 | +16/−2 | — | 1 | 30 | 0 | 6 |
| top-words | without | 2/2 | +10/−1 | — | 0 | 15 | 0 | 0 |
| top-words | without | 2/2 | +10/−1 | — | 0 | 16 | 0 | 0 |
| top-words | with | 2/2 | +13/−2 | — | 1 | 28 | 0 | 5 |
| top-words | with | 2/2 | +16/−2 | — | 1 | 27 | 0 | 6 |
| top-words | with | 2/2 | +16/−2 | — | 1 | 24 | 0 | 6 |
| top-words | with | 2/2 | +16/−2 | — | 1 | 33 | 0 | 6 |
| top-words | with | 2/2 | +16/−2 | — | 1 | 32 | 0 | 6 |
| top-words | with | 2/2 | +16/−2 | — | 1 | 25 | 0 | 6 |
| top-words | with | 2/2 | +16/−2 | — | 1 | 30 | 0 | 6 |
| top-words | with | 2/2 | +14/−2 | — | 1 | 34 | 0 | 6 |
| top-words | with | 2/2 | +17/−2 | — | 1 | 35 | 0 | 7 |
| top-words | with | 2/2 | +16/−2 | — | 1 | 37 | 0 | 6 |
