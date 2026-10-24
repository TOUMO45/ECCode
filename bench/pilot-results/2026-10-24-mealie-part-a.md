# Mealie pilot, Part A: model-free measurements

| Capability | Measure | Criterion | Result | Met |
|---|---|---|---|---|
| Index (A1) | Python intra-project imports resolved | ≥ 95% | 1.000 | met |
| Index (A1) | TS/JS intra-project imports resolved | ≥ 90% | 0.376 | missed |
| Index (A1) | onboard cold, ms | ≤ 120,000 | 400 | met |
| Index (A1) | onboard warm, ms | ≤ 10,000 | 256 | met |
| Index (A1) | onboard after a one-file edit, ms | ≤ 10,000 | 317 | met |
| Impact (A2) | median recall against coverage, static | ≥ 0.90 | 1 | met |
| Impact (A2) | median recall against coverage, with --trace | ≥ 0.95 | 1 | met |
| Impact (A2) | median share of all test files selected | ≤ 0.5 | 0.459 | met |
| Impact (A2) | recall against injected faults, pooled over the fault runs | ≥ 0.90 | 0.938 | met |
| Compat (A3) | precision of detections over the window | ≥ 0.90 | 0.087 (23 labelled) | missed |
| Compat (A3) | recall against FastAPI's route table | ≥ 0.90 | — | — |
| fix verify (A4) | agreement with running the tests directly, each disagreement labelled engine-wrong or oracle-wrong | 100% | 0.974 (raw agreement 0.897; 4 disagreements labelled) | missed |
| mutate (A5) | runs completing | ≥ 90% | 0.976 | met |
| Bug rules (A6) | false positives per 10,000 changed lines | ≤ 1 | 4.506 (92 hits, 0 unlabelled) | missed |
| Stack (A7) | stacks detected at the pin | Python and Node | python | missed |
| Stack (A7) | detected checks runnable, result equal to the tool run directly | all | 1/2 | missed |
| Secrets (A7) | error-level false positives at the pin | ≤ 5 | 0 (0 error-level hits) | met |
