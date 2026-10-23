# Benchmark run — 2026-10-23, claude -p (sonnet), pre-registered follow-up, half B (go-truncate, parse-duration)

**Pre-registered.** Protocol: [bench/protocols/2026-10-23-sonnet-code-lines.md](../protocols/2026-10-23-sonnet-code-lines.md), committed and pushed in b1077f8 at 08:30:36 UTC; every run below started after it (both halves at about 08:31 UTC). Design as registered: the four tasks of `bench/suites/followup`, never run with any model before, n=10 per variant per task, 540 s timeout, the registered agent command with `--suite bench/suites/followup`, executed in the two halves the protocol names. Primary outcome: code lines added per run (tests excluded). Nothing was stopped, repeated or dropped.

The outcome for the whole batch, both halves together, is stated in [2026-10-23-sonnet-followup-a.md](2026-10-23-sonnet-followup-a.md).

Other half: [2026-10-23-sonnet-followup-a.md](2026-10-23-sonnet-followup-a.md). The report below is the harness's output, unedited.

# ECCode paired benchmark

Agent command: `cat PROMPT.md | claude -p --model sonnet --allowedTools "Read Grep Glob Edit Write Bash(npm test) Bash(node --test*) Bash(pytest*) Bash(go test*)"`. "with" prepends the lean-change skill text to the prompt; "without" is the bare prompt. Hidden checks never exist in the sandbox while the agent works. Each variant ran n >= 10 times per task. The exact permutation test enumerates every split, so the p-values are exact, not asymptotic. Read the raw rows alongside the medians.

| Task | Variant | n | Hidden checks | Median lines added | Median code lines added (tests excluded) | Runs adding a dependency | Runs changing a test | Median seconds |
|---|---|---|---|---|---|---|---|---|
| go-truncate | without | 10 | 20/20 | 35 | 13 | 0/10 | 9/10 | 18 |
| go-truncate | with | 10 | 20/20 | 33 | 12 | 0/10 | 10/10 | 22 |
| go-truncate | **paired Δ** |  |  | -2 (exact permutation p=1.000 over 184756 splits) | -1 (exact permutation p=0.000 over 184756 splits) |  |  |  |
| parse-duration | without | 10 | 20/20 | 23 | 10 | 0/10 | 10/10 | 32 |
| parse-duration | with | 10 | 20/20 | 19 | 8 | 0/10 | 10/10 | 29 |
| parse-duration | **paired Δ** |  |  | -4 (exact permutation p=0.000 over 184756 splits) | -2 (exact permutation p=0.000 over 184756 splits) |  |  |  |

Paired medians across 2 task(s): the "with" variant produced the smaller diff on 2, the larger on 0, equal on 0. Sign counts, not significance.

## Raw runs

| Task | Variant | Hidden | Lines +/− | New deps | Test files | Seconds | Agent exit | Lines added in tests |
|---|---|---|---|---|---|---|---|---|
| go-truncate | without | 2/2 | +35/−0 | — | 1 | 18 | 0 | 22 |
| go-truncate | without | 2/2 | +35/−0 | — | 1 | 27 | 0 | 22 |
| go-truncate | without | 2/2 | +35/−0 | — | 1 | 19 | 0 | 22 |
| go-truncate | without | 2/2 | +41/−0 | — | 1 | 21 | 0 | 22 |
| go-truncate | without | 2/2 | +34/−0 | — | 1 | 13 | 0 | 21 |
| go-truncate | without | 2/2 | +35/−0 | — | 1 | 18 | 0 | 22 |
| go-truncate | without | 2/2 | +35/−0 | — | 1 | 17 | 0 | 22 |
| go-truncate | without | 2/2 | +35/−0 | — | 1 | 25 | 0 | 22 |
| go-truncate | without | 2/2 | +35/−0 | — | 1 | 22 | 0 | 22 |
| go-truncate | without | 2/2 | +13/−0 | — | 0 | 13 | 0 | 0 |
| go-truncate | with | 2/2 | +33/−0 | — | 1 | 26 | 0 | 21 |
| go-truncate | with | 2/2 | +34/−0 | — | 1 | 21 | 0 | 22 |
| go-truncate | with | 2/2 | +33/−0 | — | 1 | 22 | 0 | 21 |
| go-truncate | with | 2/2 | +33/−0 | — | 1 | 35 | 0 | 21 |
| go-truncate | with | 2/2 | +33/−0 | — | 1 | 20 | 0 | 21 |
| go-truncate | with | 2/2 | +33/−0 | — | 1 | 27 | 0 | 21 |
| go-truncate | with | 2/2 | +34/−0 | — | 1 | 17 | 0 | 22 |
| go-truncate | with | 2/2 | +34/−0 | — | 1 | 19 | 0 | 22 |
| go-truncate | with | 2/2 | +33/−0 | — | 1 | 30 | 0 | 21 |
| go-truncate | with | 2/2 | +34/−0 | — | 1 | 22 | 0 | 21 |
| parse-duration | without | 2/2 | +25/−2 | — | 1 | 46 | 0 | 16 |
| parse-duration | without | 2/2 | +22/−2 | — | 1 | 28 | 0 | 12 |
| parse-duration | without | 2/2 | +21/−2 | — | 1 | 31 | 0 | 11 |
| parse-duration | without | 2/2 | +20/−2 | — | 1 | 27 | 0 | 11 |
| parse-duration | without | 2/2 | +37/−1 | — | 1 | 25 | 0 | 25 |
| parse-duration | without | 2/2 | +22/−2 | — | 1 | 34 | 0 | 11 |
| parse-duration | without | 2/2 | +21/−2 | — | 1 | 30 | 0 | 11 |
| parse-duration | without | 2/2 | +24/−2 | — | 1 | 38 | 0 | 15 |
| parse-duration | without | 2/2 | +27/−2 | — | 1 | 39 | 0 | 16 |
| parse-duration | without | 2/2 | +37/−1 | — | 1 | 39 | 0 | 25 |
| parse-duration | with | 2/2 | +20/−2 | — | 1 | 33 | 0 | 11 |
| parse-duration | with | 2/2 | +18/−2 | — | 1 | 23 | 0 | 10 |
| parse-duration | with | 2/2 | +18/−2 | — | 1 | 26 | 0 | 10 |
| parse-duration | with | 2/2 | +19/−2 | — | 1 | 24 | 0 | 11 |
| parse-duration | with | 2/2 | +20/−2 | — | 1 | 26 | 0 | 11 |
| parse-duration | with | 2/2 | +19/−2 | — | 1 | 31 | 0 | 11 |
| parse-duration | with | 2/2 | +18/−2 | — | 1 | 36 | 0 | 10 |
| parse-duration | with | 2/2 | +19/−2 | — | 1 | 42 | 0 | 11 |
| parse-duration | with | 2/2 | +20/−2 | — | 1 | 27 | 0 | 11 |
| parse-duration | with | 2/2 | +19/−2 | — | 1 | 35 | 0 | 11 |
