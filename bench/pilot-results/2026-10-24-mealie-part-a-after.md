# Mealie pilot, Part A: after the fixes

The same measures at the same pin P, with ECCode at the fixes: worktree `2be2f16` for A1 to A6, and `1b850b9` for A7, after the fix for a false `tsc` check that this run found. Rendered by `bench/pilot/mealie/report.js` from [bench/pilot/mealie/results-after](../pilot/mealie/results-after); A7 at `2be2f16` is kept as `a7-stack.at-2be2f16.json`. A5 and A4 were run a second time after the session's disk filled during the first attempt. The measured run, verbatim: [2026-10-24-mealie-part-a.md](2026-10-24-mealie-part-a.md). Reading notes are in the [pilot report](2026-10-24-mealie-pilot.md).

| Capability | Measure | Criterion | Result | Met |
|---|---|---|---|---|
| Index (A1) | Python intra-project imports resolved | ≥ 95% | 1 | met |
| Index (A1) | TS/JS intra-project imports resolved | ≥ 90% | 0.998 | met |
| Index (A1) | onboard cold, ms | ≤ 120,000 | 573 | met |
| Index (A1) | onboard warm, ms | ≤ 10,000 | 643 | met |
| Index (A1) | onboard after a one-file edit, ms | ≤ 10,000 | 457 | met |
| Impact (A2) | median recall against coverage, static | ≥ 0.90 | 1 | met |
| Impact (A2) | median recall against coverage, with --trace | ≥ 0.95 | 1 | met |
| Impact (A2) | median share of all test files selected | ≤ 0.5 | 0.817 | missed |
| Impact (A2) | recall against injected faults, pooled over the fault runs | ≥ 0.90 | 1 | met |
| Compat (A3) | precision of detections over the window | ≥ 0.90 | 1 (2 labelled) | met |
| Compat (A3) | recall against FastAPI's route table | ≥ 0.90 | — | — |
| fix verify (A4) | agreement with running the tests directly, each disagreement labelled engine-wrong or oracle-wrong | 100% | 1 (raw agreement 0.927; 3 disagreements labelled) | met |
| mutate (A5) | runs completing | ≥ 90% | 0.976 | met |
| Bug rules (A6) | false positives per 10,000 changed lines | ≤ 1 | 0 (1 hits, 0 unlabelled) | met |
| Stack (A7) | stacks detected at the pin | Python and Node | node, python | met |
| Stack (A7) | detected checks runnable, result equal to the tool run directly | all | 5/5 | met |
| Secrets (A7) | error-level false positives at the pin | ≤ 5 | 0 (0 error-level hits) | met |
