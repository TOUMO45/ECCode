# S4-PREREQ pre-registered predictions (frozen before any engine code)

Base: branch `s4-prereq/engine` from `1240da2` (plan freeze `d4c8427`). The regression baseline is the full `npm test`
run after bubblewrap 0.9.0 was installed (deviation D-02); its counts are recorded in `evidence/baseline.txt`.
Before bwrap was installed the suite showed 1731 pass / 1 fail / 66 skip; the failing test was A1 in
`tests/gf-iso-sandbox.test.js`, the same environmental failure S3 recorded.

This file is frozen once committed. Outcomes are compared to it in the evidence report. It is never rewritten.

## D-2: automated slice approval inside a budget

What it should enable: when a project opts in (`gf.approval.auto`), an engine mechanism can approve a closed slice
without a human, inside a per-run budget. Each such approval is a hash-chained event of type `auto-approval`, so the
plan's M4 count can separate automated approvals from counted human interventions using the record alone.

| Id | Prediction | Verified by | Counts as FAILURE of D-2 |
|---|---|---|---|
| P2-1 | Every approver rule (preconditions all-or-stop, budget hard stop, sealed-contract/hidden-path refusal, `auto-approval` event, off by default) has a test that fails before the implementation exists and passes after it. | red log + green log in `evidence/` | any rule without a red-then-green pair (0 tolerated) |
| P2-2 | With the default config written by `initProject`, the approver approves 0 slices and stops with a recorded reason. | test | ≥ 1 approval with default config |
| P2-3 | With `maxSlices = N`, the (N+1)th attempt is refused in 100% of attempts, and an `auto-approval` event that exceeds its budget is reported by the approval audit. | test | N+1 approvals recorded, or a forged over-budget event not reported |
| P2-4 | The approver refuses when any single precondition fails: slice not validly closed, G1 not sealed or a contract file differs from its sealed/amended hash, a contract amendment since the last approval, a new denial in the rejection log since the last approval, a hidden-suite path inside the slice tree, a token or wall-clock budget exceeded or unmeasurable. One test per precondition. | tests | any single-precondition failure that is approved |
| P2-5 | The intervention counter, run on a synthetic record with known contents, returns exactly the known counts per type (approval, clarification-answer, correction, restart, unblock) and the exact number of auto-approvals. | test on synthetic record | any count off by ≥ 1 |
| P2-6 | The effect on Stage 1 M4 (fewer counted approvals for ECCode arms) is NOT measured in this slice. | n/a | n/a: this is inconclusive by design (R11: no arm runs) |

## D-1: stack profile for compose + background worker + dashboard

What it should enable: `eccode-gf init --stack <new profile>` creates a project whose engine-owned scaffold is a
`docker-compose.yml` with api, worker, dashboard and a database service, a health convention for every service, a
worker scheduling convention, and an ownership map. The engine still writes no application logic.

| Id | Prediction | Verified by | Counts as FAILURE of D-1 |
|---|---|---|---|
| P1-1 | `initProject` with the new profile succeeds; the default init is byte-for-byte unchanged in `cfg.gf` (`tests/gf-flow.test.js:38` stays green, untouched). `C.STACK_PROFILES` still equals the one v1 profile. | tests | default `cfg.gf` changes, or any existing test edited or red |
| P1-2 | `docker compose -f docker-compose.yml config -q` exits 0 on the generated file without a running daemon. | test + `evidence/` log | exit code ≠ 0 |
| P1-3 | Every service in the generated compose file has a healthcheck: 4 of 4. The engine check refuses a compose file with a service that lacks one. | tests | < 4/4, or a missing healthcheck accepted |
| P1-4 | The ownership map covers every engine-generated path exactly once: 0 uncovered, 0 covered twice. The engine check refuses a map that leaves a path uncovered. | tests | ≥ 1 uncovered or doubly-covered path accepted |
| P1-5 | Profile selection: an unknown profile is still refused with GF-INIT-1; the new profile is selectable by name. | tests | unknown profile accepted |
| P1-6 | Daemon-dependent checks (`docker compose up`, live health endpoints, worker tick) are NOT run in this slice. | listed in the report | n/a: inconclusive by design |

## D-6: operator deployment check

| Id | Prediction | Verified by | Counts as FAILURE |
|---|---|---|---|
| P6-1 | `tools/deploy-check.sh` passes `bash -n`, and shellcheck reports 0 errors if shellcheck can be installed. | log | syntax error, or ≥ 1 shellcheck error |
| P6-2 | `tools/deploy-check.sh --dry-run <tree>` exits 0 on a generated scaffold with `DOCKER_HOST` pointing at a socket that does not exist (it never contacts a daemon). | log | exit ≠ 0, or it contacts a daemon |

## Whole slice

| Id | Prediction | Counts as FAILURE |
|---|---|---|
| PS-1 | Full existing suite: 0 regressions against the post-bwrap baseline (every test that passed still passes; the only new tests are the ones this slice adds). | ≥ 1 regression |
| PS-2 | `git diff --stat 1240da2 -- <protected paths>` is empty; S3 hidden-suite hashes 4/4 OK; `gf.runtime.enforce` default unchanged; `tests/gf-flow.test.js` untouched. | any of these violated |
| PS-3 | Spend for this slice: 5M-15M all-processed tokens (forecast, no anchor for an engineering-only slice). | > 24M (pause threshold) |
