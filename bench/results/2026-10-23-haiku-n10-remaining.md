# Benchmark run — 2026-10-23, claude -p (haiku), n=10 per variant on the six remaining tasks

Pre-committed before the data existed: every task without an n>=10 batch
(csv-sum, dedupe-objects, fix-last-page, go-clamp, py-kebab, py-page-id) run
at n=10 per variant — 120 fresh live runs — with the results recorded
verbatim whatever they showed. With the earlier n=10 replication of
relative-time and slugify-reuse, every task in the suite now has an
adequately sized batch, and the report below carries the n>=10 header: the
permutation p-values are exact over all 184,756 splits.

What this batch shows: the with-skill variant produced the smaller median
diff on all six tasks. Three are individually significant at n=10
(dedupe-objects: -29.5 median lines, p=0.000; fix-last-page: -4, p=0.003;
csv-sum: -2.5, p=0.029) and three are direction-consistent but not
(go-clamp p=0.270, py-kebab p=0.285, py-page-id p=0.093 - the small Go and
Python tasks where the baseline already reuses and tests). All 120 runs
passed every hidden check, none added a dependency, and every run changed a
test file in both variants. The global stratified figure over the whole
record is recomputed by `eccode bench tally`.

# ECCode paired benchmark

Agent command: `cat PROMPT.md | claude -p --model haiku --allowedTools "Read Grep Glob Edit Write Bash(npm test) Bash(node --test*) Bash(pytest*) Bash(go test*)"`. "with" prepends the lean-change skill text to the prompt; "without" is the bare prompt. Hidden checks never exist in the sandbox while the agent works. Each variant ran n >= 10 times per task; the exact permutation test enumerates every split, so the p-values are exact, not asymptotic. Read the raw rows alongside the medians.

| Task | Variant | n | Hidden checks | Median lines added | Runs adding a dependency | Runs changing a test | Median seconds |
|---|---|---|---|---|---|---|---|
| csv-sum | without | 10 | 20/20 | 24.5 | 0/10 | 10/10 | 19 |
| csv-sum | with | 10 | 20/20 | 22 | 0/10 | 10/10 | 25 |
| csv-sum | **paired Δ** |  |  | -2.5 (exact permutation p=0.029 over 184756 splits) |  |  |  |
| dedupe-objects | without | 10 | 20/20 | 50 | 0/10 | 10/10 | 29 |
| dedupe-objects | with | 10 | 20/20 | 20.5 | 0/10 | 10/10 | 21 |
| dedupe-objects | **paired Δ** |  |  | -29.5 (exact permutation p=0.000 over 184756 splits) |  |  |  |
| fix-last-page | without | 10 | 20/20 | 13 | 0/10 | 10/10 | 25 |
| fix-last-page | with | 10 | 20/20 | 9 | 0/10 | 10/10 | 27 |
| fix-last-page | **paired Δ** |  |  | -4 (exact permutation p=0.003 over 184756 splits) |  |  |  |
| go-clamp | without | 10 | 20/20 | 26.5 | 0/10 | 10/10 | 18 |
| go-clamp | with | 10 | 20/20 | 22.5 | 0/10 | 10/10 | 24 |
| go-clamp | **paired Δ** |  |  | -4 (exact permutation p=0.270 over 184756 splits) |  |  |  |
| py-kebab | without | 10 | 20/20 | 12 | 0/10 | 10/10 | 15 |
| py-kebab | with | 10 | 20/20 | 11 | 0/10 | 10/10 | 20 |
| py-kebab | **paired Δ** |  |  | -1 (exact permutation p=0.285 over 184756 splits) |  |  |  |
| py-page-id | without | 10 | 20/20 | 12 | 0/10 | 10/10 | 17 |
| py-page-id | with | 10 | 20/20 | 11 | 0/10 | 10/10 | 27 |
| py-page-id | **paired Δ** |  |  | -1 (exact permutation p=0.093 over 184756 splits) |  |  |  |

Paired medians across 6 task(s): the "with" variant produced the smaller diff on 6, the larger on 0, equal on 0. Sign counts, not significance.

## Raw runs

| Task | Variant | Hidden | Lines +/− | New deps | Test files | Seconds | Agent exit |
|---|---|---|---|---|---|---|---|
| csv-sum | without | 2/2 | +28/−1 | — | 1 | 18 | 0 |
| csv-sum | without | 2/2 | +22/−1 | — | 1 | 23 | 0 |
| csv-sum | without | 2/2 | +27/−1 | — | 1 | 25 | 0 |
| csv-sum | without | 2/2 | +22/−1 | — | 1 | 24 | 0 |
| csv-sum | without | 2/2 | +25/−1 | — | 1 | 21 | 0 |
| csv-sum | without | 2/2 | +22/−1 | — | 1 | 20 | 0 |
| csv-sum | without | 2/2 | +24/−1 | — | 1 | 18 | 0 |
| csv-sum | without | 2/2 | +27/−1 | — | 1 | 18 | 0 |
| csv-sum | without | 2/2 | +28/−1 | — | 1 | 17 | 0 |
| csv-sum | without | 2/2 | +22/−1 | — | 1 | 14 | 0 |
| csv-sum | with | 2/2 | +22/−1 | — | 1 | 31 | 0 |
| csv-sum | with | 2/2 | +25/−1 | — | 1 | 24 | 0 |
| csv-sum | with | 2/2 | +22/−1 | — | 1 | 23 | 0 |
| csv-sum | with | 2/2 | +21/−1 | — | 1 | 34 | 0 |
| csv-sum | with | 2/2 | +21/−1 | — | 1 | 27 | 0 |
| csv-sum | with | 2/2 | +18/−1 | — | 1 | 27 | 0 |
| csv-sum | with | 2/2 | +17/−1 | — | 1 | 25 | 0 |
| csv-sum | with | 2/2 | +23/−1 | — | 1 | 23 | 0 |
| csv-sum | with | 2/2 | +26/−1 | — | 1 | 16 | 0 |
| csv-sum | with | 2/2 | +22/−1 | — | 1 | 19 | 0 |
| dedupe-objects | without | 2/2 | +27/−2 | — | 1 | 27 | 0 |
| dedupe-objects | without | 2/2 | +41/−2 | — | 1 | 23 | 0 |
| dedupe-objects | without | 2/2 | +50/−2 | — | 1 | 33 | 0 |
| dedupe-objects | without | 2/2 | +51/−2 | — | 1 | 40 | 0 |
| dedupe-objects | without | 2/2 | +51/−2 | — | 1 | 34 | 0 |
| dedupe-objects | without | 2/2 | +30/−2 | — | 1 | 30 | 0 |
| dedupe-objects | without | 2/2 | +45/−2 | — | 1 | 22 | 0 |
| dedupe-objects | without | 2/2 | +50/−2 | — | 1 | 32 | 0 |
| dedupe-objects | without | 2/2 | +53/−2 | — | 1 | 28 | 0 |
| dedupe-objects | without | 2/2 | +56/−5 | — | 1 | 19 | 0 |
| dedupe-objects | with | 2/2 | +24/−2 | — | 1 | 20 | 0 |
| dedupe-objects | with | 2/2 | +19/−2 | — | 1 | 21 | 0 |
| dedupe-objects | with | 2/2 | +25/−2 | — | 1 | 21 | 0 |
| dedupe-objects | with | 2/2 | +20/−2 | — | 1 | 21 | 0 |
| dedupe-objects | with | 2/2 | +22/−2 | — | 1 | 21 | 0 |
| dedupe-objects | with | 2/2 | +19/−2 | — | 1 | 26 | 0 |
| dedupe-objects | with | 2/2 | +15/−2 | — | 1 | 22 | 0 |
| dedupe-objects | with | 2/2 | +21/−2 | — | 1 | 27 | 0 |
| dedupe-objects | with | 2/2 | +19/−2 | — | 1 | 24 | 0 |
| dedupe-objects | with | 2/2 | +22/−2 | — | 1 | 20 | 0 |
| fix-last-page | without | 2/2 | +10/−2 | — | 1 | 24 | 0 |
| fix-last-page | without | 2/2 | +13/−2 | — | 1 | 28 | 0 |
| fix-last-page | without | 2/2 | +10/−2 | — | 1 | 20 | 0 |
| fix-last-page | without | 2/2 | +13/−2 | — | 1 | 34 | 0 |
| fix-last-page | without | 2/2 | +10/−2 | — | 1 | 21 | 0 |
| fix-last-page | without | 2/2 | +21/−2 | — | 1 | 25 | 0 |
| fix-last-page | without | 2/2 | +10/−2 | — | 1 | 26 | 0 |
| fix-last-page | without | 2/2 | +20/−2 | — | 1 | 28 | 0 |
| fix-last-page | without | 2/2 | +14/−2 | — | 1 | 25 | 0 |
| fix-last-page | without | 2/2 | +14/−2 | — | 1 | 24 | 0 |
| fix-last-page | with | 2/2 | +8/−2 | — | 1 | 28 | 0 |
| fix-last-page | with | 2/2 | +10/−2 | — | 1 | 23 | 0 |
| fix-last-page | with | 2/2 | +9/−2 | — | 1 | 29 | 0 |
| fix-last-page | with | 2/2 | +9/−4 | — | 1 | 26 | 0 |
| fix-last-page | with | 2/2 | +9/−4 | — | 1 | 26 | 0 |
| fix-last-page | with | 2/2 | +9/−2 | — | 1 | 20 | 0 |
| fix-last-page | with | 2/2 | +9/−2 | — | 1 | 27 | 0 |
| fix-last-page | with | 2/2 | +9/−2 | — | 1 | 24 | 0 |
| fix-last-page | with | 2/2 | +13/−2 | — | 1 | 31 | 0 |
| fix-last-page | with | 2/2 | +9/−4 | — | 1 | 30 | 0 |
| go-clamp | without | 2/2 | +24/−0 | — | 1 | 16 | 0 |
| go-clamp | without | 2/2 | +28/−0 | — | 1 | 15 | 0 |
| go-clamp | without | 2/2 | +18/−0 | — | 1 | 19 | 0 |
| go-clamp | without | 2/2 | +33/−0 | — | 1 | 18 | 0 |
| go-clamp | without | 2/2 | +27/−0 | — | 1 | 27 | 0 |
| go-clamp | without | 2/2 | +28/−0 | — | 1 | 20 | 0 |
| go-clamp | without | 2/2 | +29/−0 | — | 1 | 21 | 0 |
| go-clamp | without | 2/2 | +26/−0 | — | 1 | 14 | 0 |
| go-clamp | without | 2/2 | +18/−0 | — | 1 | 16 | 0 |
| go-clamp | without | 2/2 | +17/−0 | — | 1 | 18 | 0 |
| go-clamp | with | 2/2 | +27/−0 | — | 1 | 25 | 0 |
| go-clamp | with | 2/2 | +20/−0 | — | 1 | 20 | 0 |
| go-clamp | with | 2/2 | +26/−0 | — | 1 | 24 | 0 |
| go-clamp | with | 2/2 | +17/−0 | — | 1 | 24 | 0 |
| go-clamp | with | 2/2 | +20/−0 | — | 1 | 22 | 0 |
| go-clamp | with | 2/2 | +25/−0 | — | 1 | 26 | 0 |
| go-clamp | with | 2/2 | +20/−0 | — | 1 | 26 | 0 |
| go-clamp | with | 2/2 | +25/−0 | — | 1 | 26 | 0 |
| go-clamp | with | 2/2 | +26/−0 | — | 1 | 23 | 0 |
| go-clamp | with | 2/2 | +17/−0 | — | 1 | 24 | 0 |
| py-kebab | without | 2/2 | +10/−1 | — | 1 | 14 | 0 |
| py-kebab | without | 2/2 | +12/−1 | — | 1 | 14 | 0 |
| py-kebab | without | 2/2 | +12/−1 | — | 1 | 16 | 0 |
| py-kebab | without | 2/2 | +11/−1 | — | 1 | 15 | 0 |
| py-kebab | without | 2/2 | +10/−1 | — | 1 | 16 | 0 |
| py-kebab | without | 2/2 | +12/−1 | — | 1 | 14 | 0 |
| py-kebab | without | 2/2 | +12/−1 | — | 1 | 14 | 0 |
| py-kebab | without | 2/2 | +14/−1 | — | 1 | 22 | 0 |
| py-kebab | without | 2/2 | +14/−1 | — | 1 | 24 | 0 |
| py-kebab | without | 2/2 | +10/−1 | — | 1 | 13 | 0 |
| py-kebab | with | 2/2 | +11/−1 | — | 1 | 25 | 0 |
| py-kebab | with | 2/2 | +10/−1 | — | 1 | 26 | 0 |
| py-kebab | with | 2/2 | +11/−1 | — | 1 | 21 | 0 |
| py-kebab | with | 2/2 | +10/−1 | — | 1 | 25 | 0 |
| py-kebab | with | 2/2 | +12/−1 | — | 1 | 19 | 0 |
| py-kebab | with | 2/2 | +12/−1 | — | 1 | 16 | 0 |
| py-kebab | with | 2/2 | +11/−1 | — | 1 | 20 | 0 |
| py-kebab | with | 2/2 | +11/−1 | — | 1 | 14 | 0 |
| py-kebab | with | 2/2 | +12/−1 | — | 1 | 23 | 0 |
| py-kebab | with | 2/2 | +10/−1 | — | 1 | 20 | 0 |
| py-page-id | without | 2/2 | +12/−1 | — | 1 | 15 | 0 |
| py-page-id | without | 2/2 | +12/−1 | — | 1 | 17 | 0 |
| py-page-id | without | 2/2 | +12/−1 | — | 1 | 15 | 0 |
| py-page-id | without | 2/2 | +12/−1 | — | 1 | 18 | 0 |
| py-page-id | without | 2/2 | +13/−1 | — | 1 | 23 | 0 |
| py-page-id | without | 2/2 | +12/−1 | — | 1 | 15 | 0 |
| py-page-id | without | 2/2 | +12/−1 | — | 1 | 17 | 0 |
| py-page-id | without | 2/2 | +12/−1 | — | 1 | 17 | 0 |
| py-page-id | without | 2/2 | +11/−1 | — | 1 | 15 | 0 |
| py-page-id | without | 2/2 | +12/−1 | — | 1 | 18 | 0 |
| py-page-id | with | 2/2 | +10/−1 | — | 1 | 26 | 0 |
| py-page-id | with | 2/2 | +11/−1 | — | 1 | 30 | 0 |
| py-page-id | with | 2/2 | +11/−1 | — | 1 | 27 | 0 |
| py-page-id | with | 2/2 | +10/−1 | — | 1 | 23 | 0 |
| py-page-id | with | 2/2 | +14/−1 | — | 1 | 27 | 0 |
| py-page-id | with | 2/2 | +11/−1 | — | 1 | 27 | 0 |
| py-page-id | with | 2/2 | +12/−1 | — | 1 | 31 | 0 |
| py-page-id | with | 2/2 | +11/−1 | — | 1 | 33 | 0 |
| py-page-id | with | 2/2 | +11/−1 | — | 1 | 23 | 0 |
| py-page-id | with | 2/2 | +11/−1 | — | 1 | 17 | 0 |
