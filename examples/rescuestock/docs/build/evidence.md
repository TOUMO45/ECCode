# Evidence (RescueStock)
Requirement-to-evidence matrix. Status: Passed | Failed | Unverified. Every row names the test or probe, the commit and the environment. Filled per slice; the final acceptance report is `docs/acceptance-report.md`.

| Requirement | Status | Evidence and tested version | Limitation or blocker |
|---|---|---|---|
| RS-06 plan A+B 8400 cents, A×2 guard | Passed | `test/unit/domain/planner-fixture.test.js` (`RS-06:` tests); phase B approval `rev-mv1k04zq-01814d87`, reviewer's own run `ev-mv1jv3k8-01ae4b0c` and brute-force agreement on 6,000 random catalogs; Node 22.22, Linux | deterministic suite only |
| RS-07 C rejected `INCOMPATIBLE_LID_DIAMETER` | Passed | same file (`RS-07:`), same review | — |
| RS-08 D rejected `READY_AFTER_DEADLINE` | Passed | same file (`RS-08:`), same review | — |
| RS-09 B removed → A+E 9500 | Passed | same file (`RS-09:`), same review | — |
| RS-10 budget 9000 → two relaxations | Passed | same file (`RS-10:`), same review | — |
| RS-11 max pickups 1 → per-candidate codes | Passed | same file (`RS-11:`), same review | — |
| RS-12 (planner half) | Passed | `planner-fixture.test.js`; the approval half is phase C | API refusal not yet built |
| RS-36 derivation table | Passed (prerequisite) | `test/unit/domain/derive.test.js` incl. 25,000-walk totality; the endpoint half is phase C | endpoint not yet built |
| RS-38 append-only ledgers | Passed (prerequisite) | `test/unit/db/triggers.test.js` incl. `SEC-B-2:` REPLACE cases; ledger writes are phase F | — |
| NFR1 (RS-NF-1) clean checkout, Node floor | Passed | `scripts/clean-checkout.sh` run by b3 (`ev-mv1gwcdw-01e502bd`) and by the reviewer (`ev-mv1jvwq5-01042767`); `start-old-node` on real Node 20.20 and 21.7 | Node 22.5 branch verified by version simulation only (USER-Q9) |
| NFR4 (RS-NF-4) secrets by environment only | Passed | `test/scan/env-example.test.js` (`NFR4:`), config secret tests, `/api/config` scans; security probe of 22 secret variables | — |
| NFR5 planner timing | Passed (planner part) | `test/timing/planner-generator.test.js`, `planner-sec-b1.test.js` (worst call 38 ms on the reviewer's run) | API p95 is phase C+ |
| RS-01..RS-05, RS-13..RS-35, RS-37, RS-39, NFR2, NFR3, NFR6 | Unverified | phases C–G not started | runtime budget decision pending (see state.md) |

## Id mapping (ARCH-8)
The gate's criterion-id grammar allows one hyphen, so the user's non-functional ids are carried in the brief and all reports as:

| User id (goal.md) | Brief / report id |
|---|---|
| RS-NF-1 clean-checkout setup | NFR1 |
| RS-NF-2 desktop/mobile/keyboard/states | NFR2 |
| RS-NF-3 separate live suites | NFR3 |
| RS-NF-4 secrets via environment only | NFR4 |
| (added by the brief) performance | NFR5 |
| (added by the brief) cost and observability | NFR6 |

The functional ids RS-01..RS-33 are used verbatim; RS-34..RS-39 are additions made by the brief (labelling, six on-screen answers, separate state machines, guarded reset, append-only ledgers, upload limits).
