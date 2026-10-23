# Benchmark run — 2026-10-23, claude -p (haiku), fixed-protocol n=25 replication

Protocol, stated in the working session before any of these runs started: relative-time and slugify-reuse — the two tasks whose n=10 batch was direction-consistent but not significant — re-run once at a fixed n=25 per variant (100 fresh live runs), analysed with a permutation test on lines added, reported verbatim whatever the outcome, with no further sampling on these tasks afterward. **The protocol was not committed to the repository before the run**, so this is a fixed-protocol replication, not a pre-registration in the strict sense; the file name keeps its original wording.

One analysis change happened after the data came in: above the exact-enumeration cap the permutation test returned nothing, so a seeded Monte Carlo permutation test (100,000 resamples, reproducible) was added to the harness and used here. The effect estimates (median deltas) do not depend on it.

**Outcome: both effects replicate decisively.** relative-time: −11 median lines (Monte Carlo p = 6.0e-5); slugify-reuse: −4 median lines (p ≤ 1.0e-5 — no resample was as extreme, so this is an upper bound). 100/100 hidden checks passed, 0 dependency additions, every run wrote tests in both variants. The full batch sequence for these tasks stays on record: n=5 (significant), n=10 (direction-consistent, not significant), n=25 (decisive).

# ECCode paired benchmark

Agent command: `cat PROMPT.md | claude -p --model haiku --allowedTools "Read Grep Glob Edit Write Bash(npm test) Bash(node --test*) Bash(pytest*)"`. "with" prepends the lean-change skill text to the prompt; "without" is the bare prompt. Hidden checks never exist in the sandbox while the agent works. Each variant ran n >= 25 times per task. Where every split can be enumerated the permutation test is exact; above that it is a seeded Monte Carlo permutation test (each row says which), and "p≤" marks a p-value at the resampling floor. Read the raw rows alongside the medians.

| Task | Variant | n | Hidden checks | Median lines added | Runs adding a dependency | Runs changing a test | Median seconds |
|---|---|---|---|---|---|---|---|
| relative-time | without | 25 | 50/50 | 46 | 0/25 | 25/25 | 25 |
| relative-time | with | 25 | 50/50 | 35 | 0/25 | 25/25 | 25 |
| relative-time | **paired Δ** |  |  | -11 (Monte Carlo permutation p=6.00e-5 over 100000 seeded resamples) |  |  |  |
| slugify-reuse | without | 25 | 50/50 | 16 | 0/25 | 25/25 | 17 |
| slugify-reuse | with | 25 | 50/50 | 12 | 0/25 | 25/25 | 21 |
| slugify-reuse | **paired Δ** |  |  | -4 (Monte Carlo permutation p≤1.00e-5 over 100000 seeded resamples) |  |  |  |

Paired medians across 2 task(s): the "with" variant produced the smaller diff on 2, the larger on 0, equal on 0. Sign counts, not significance.

## Raw runs

| Task | Variant | Hidden | Lines +/− | New deps | Test files | Seconds | Agent exit |
|---|---|---|---|---|---|---|---|
| relative-time | without | 2/2 | +41/−2 | — | 1 | 26 | 0 |
| relative-time | without | 2/2 | +46/−2 | — | 1 | 21 | 0 |
| relative-time | without | 2/2 | +60/−2 | — | 1 | 36 | 0 |
| relative-time | without | 2/2 | +48/−2 | — | 1 | 27 | 0 |
| relative-time | without | 2/2 | +40/−2 | — | 1 | 32 | 0 |
| relative-time | without | 2/2 | +50/−2 | — | 1 | 24 | 0 |
| relative-time | without | 2/2 | +35/−2 | — | 1 | 26 | 0 |
| relative-time | without | 2/2 | +51/−2 | — | 1 | 23 | 0 |
| relative-time | without | 2/2 | +53/−8 | — | 1 | 19 | 0 |
| relative-time | without | 2/2 | +55/−2 | — | 1 | 28 | 0 |
| relative-time | without | 2/2 | +36/−2 | — | 1 | 26 | 0 |
| relative-time | without | 2/2 | +46/−2 | — | 1 | 23 | 0 |
| relative-time | without | 2/2 | +44/−2 | — | 1 | 23 | 0 |
| relative-time | without | 2/2 | +46/−2 | — | 1 | 22 | 0 |
| relative-time | without | 2/2 | +36/−2 | — | 1 | 22 | 0 |
| relative-time | without | 2/2 | +60/−8 | — | 1 | 23 | 0 |
| relative-time | without | 2/2 | +57/−2 | — | 1 | 25 | 0 |
| relative-time | without | 2/2 | +35/−2 | — | 1 | 23 | 0 |
| relative-time | without | 2/2 | +55/−2 | — | 1 | 25 | 0 |
| relative-time | without | 2/2 | +51/−2 | — | 1 | 28 | 0 |
| relative-time | without | 2/2 | +50/−2 | — | 1 | 22 | 0 |
| relative-time | without | 2/2 | +54/−2 | — | 1 | 25 | 0 |
| relative-time | without | 2/2 | +39/−2 | — | 1 | 26 | 0 |
| relative-time | without | 2/2 | +39/−2 | — | 1 | 25 | 0 |
| relative-time | without | 2/2 | +35/−2 | — | 1 | 27 | 0 |
| relative-time | with | 2/2 | +38/−2 | — | 1 | 26 | 0 |
| relative-time | with | 2/2 | +67/−2 | — | 2 | 46 | 0 |
| relative-time | with | 2/2 | +37/−2 | — | 1 | 25 | 0 |
| relative-time | with | 2/2 | +35/−2 | — | 1 | 25 | 0 |
| relative-time | with | 2/2 | +36/−2 | — | 1 | 23 | 0 |
| relative-time | with | 2/2 | +42/−2 | — | 1 | 30 | 0 |
| relative-time | with | 2/2 | +25/−2 | — | 1 | 24 | 0 |
| relative-time | with | 2/2 | +36/−2 | — | 1 | 26 | 0 |
| relative-time | with | 2/2 | +36/−2 | — | 1 | 33 | 0 |
| relative-time | with | 2/2 | +33/−2 | — | 1 | 26 | 0 |
| relative-time | with | 2/2 | +43/−2 | — | 1 | 25 | 0 |
| relative-time | with | 2/2 | +23/−2 | — | 1 | 22 | 0 |
| relative-time | with | 2/2 | +40/−2 | — | 1 | 22 | 0 |
| relative-time | with | 2/2 | +26/−2 | — | 1 | 21 | 0 |
| relative-time | with | 2/2 | +37/−2 | — | 1 | 21 | 0 |
| relative-time | with | 2/2 | +32/−2 | — | 1 | 31 | 0 |
| relative-time | with | 2/2 | +45/−2 | — | 1 | 26 | 0 |
| relative-time | with | 2/2 | +33/−2 | — | 1 | 27 | 0 |
| relative-time | with | 2/2 | +43/−2 | — | 1 | 23 | 0 |
| relative-time | with | 2/2 | +27/−2 | — | 1 | 23 | 0 |
| relative-time | with | 2/2 | +35/−2 | — | 1 | 28 | 0 |
| relative-time | with | 2/2 | +23/−2 | — | 1 | 23 | 0 |
| relative-time | with | 2/2 | +33/−2 | — | 1 | 22 | 0 |
| relative-time | with | 2/2 | +34/−2 | — | 1 | 30 | 0 |
| relative-time | with | 2/2 | +34/−2 | — | 1 | 20 | 0 |
| slugify-reuse | without | 2/2 | +17/−2 | — | 1 | 18 | 0 |
| slugify-reuse | without | 2/2 | +14/−2 | — | 1 | 14 | 0 |
| slugify-reuse | without | 2/2 | +13/−2 | — | 1 | 18 | 0 |
| slugify-reuse | without | 2/2 | +17/−2 | — | 1 | 14 | 0 |
| slugify-reuse | without | 2/2 | +14/−2 | — | 1 | 17 | 0 |
| slugify-reuse | without | 2/2 | +14/−2 | — | 1 | 15 | 0 |
| slugify-reuse | without | 2/2 | +23/−2 | — | 1 | 21 | 0 |
| slugify-reuse | without | 2/2 | +16/−2 | — | 1 | 18 | 0 |
| slugify-reuse | without | 2/2 | +23/−2 | — | 1 | 21 | 0 |
| slugify-reuse | without | 2/2 | +23/−2 | — | 1 | 23 | 0 |
| slugify-reuse | without | 2/2 | +11/−2 | — | 1 | 15 | 0 |
| slugify-reuse | without | 2/2 | +14/−2 | — | 1 | 15 | 0 |
| slugify-reuse | without | 2/2 | +22/−2 | — | 1 | 20 | 0 |
| slugify-reuse | without | 2/2 | +14/−2 | — | 1 | 16 | 0 |
| slugify-reuse | without | 2/2 | +14/−2 | — | 1 | 16 | 0 |
| slugify-reuse | without | 2/2 | +19/−2 | — | 1 | 17 | 0 |
| slugify-reuse | without | 2/2 | +22/−2 | — | 1 | 20 | 0 |
| slugify-reuse | without | 2/2 | +26/−1 | — | 1 | 15 | 0 |
| slugify-reuse | without | 2/2 | +14/−2 | — | 1 | 16 | 0 |
| slugify-reuse | without | 2/2 | +14/−2 | — | 1 | 17 | 0 |
| slugify-reuse | without | 2/2 | +27/−2 | — | 1 | 24 | 0 |
| slugify-reuse | without | 2/2 | +15/−2 | — | 1 | 22 | 0 |
| slugify-reuse | without | 2/2 | +14/−2 | — | 1 | 16 | 0 |
| slugify-reuse | without | 2/2 | +16/−2 | — | 1 | 20 | 0 |
| slugify-reuse | without | 2/2 | +19/−2 | — | 1 | 20 | 0 |
| slugify-reuse | with | 2/2 | +20/−2 | — | 1 | 26 | 0 |
| slugify-reuse | with | 2/2 | +12/−2 | — | 1 | 18 | 0 |
| slugify-reuse | with | 2/2 | +12/−2 | — | 1 | 19 | 0 |
| slugify-reuse | with | 2/2 | +13/−2 | — | 1 | 23 | 0 |
| slugify-reuse | with | 2/2 | +11/−2 | — | 1 | 26 | 0 |
| slugify-reuse | with | 2/2 | +13/−2 | — | 1 | 18 | 0 |
| slugify-reuse | with | 2/2 | +12/−2 | — | 1 | 17 | 0 |
| slugify-reuse | with | 2/2 | +13/−2 | — | 1 | 17 | 0 |
| slugify-reuse | with | 2/2 | +12/−2 | — | 1 | 19 | 0 |
| slugify-reuse | with | 2/2 | +11/−2 | — | 1 | 24 | 0 |
| slugify-reuse | with | 2/2 | +14/−2 | — | 1 | 19 | 0 |
| slugify-reuse | with | 2/2 | +11/−2 | — | 1 | 24 | 0 |
| slugify-reuse | with | 2/2 | +11/−2 | — | 1 | 26 | 0 |
| slugify-reuse | with | 2/2 | +13/−2 | — | 1 | 24 | 0 |
| slugify-reuse | with | 2/2 | +13/−2 | — | 1 | 19 | 0 |
| slugify-reuse | with | 2/2 | +15/−2 | — | 1 | 42 | 0 |
| slugify-reuse | with | 2/2 | +12/−2 | — | 1 | 21 | 0 |
| slugify-reuse | with | 2/2 | +13/−2 | — | 1 | 21 | 0 |
| slugify-reuse | with | 2/2 | +12/−2 | — | 1 | 15 | 0 |
| slugify-reuse | with | 2/2 | +12/−2 | — | 1 | 23 | 0 |
| slugify-reuse | with | 2/2 | +16/−2 | — | 1 | 21 | 0 |
| slugify-reuse | with | 2/2 | +12/−2 | — | 1 | 20 | 0 |
| slugify-reuse | with | 2/2 | +13/−2 | — | 1 | 21 | 0 |
| slugify-reuse | with | 2/2 | +12/−2 | — | 1 | 28 | 0 |
| slugify-reuse | with | 2/2 | +13/−2 | — | 1 | 17 | 0 |
