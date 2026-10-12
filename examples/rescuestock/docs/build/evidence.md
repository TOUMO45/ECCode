# Evidence (RescueStock)
Requirement-to-evidence matrix. Status: Passed | Failed | Unverified. Every row names the test or probe, the commit and the environment. Filled per slice; the final acceptance report is `docs/acceptance-report.md`.

**Superseded on 2026-10-12.** The rows below were filled per slice during phases B and C. The final, independently reviewed matrix for all 45 criteria is `docs/evidence-table.md` (28 verified, 2 fake-only, 15 LIVE-DEPENDENT; final-tree runs ev-mv4jijpz-01edcd99 and ev-mv4j2zpz-0142cd44, verification approved rev-mv4johr6-0184624c). The final report with the five verdicts is `docs/evidence/pilot-rescuestock/final-report.md` at the repository root. Where a row below disagrees with the evidence table, the evidence table is current.


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
| RS-01 bilingual extraction (text) | Passed (fake provider; LIVE-M1 unverified) | `test/api/extract.test.js` (`RS-01:`), EXT-1 corpus eval 200/200 on the fake (`test/eval/extraction-fake.test.js`); phase D review rev-mv372j5t-01a05e8f | every extraction in the suite comes from the fake; the real model run (LIVE-M1) needs the user's spend ceiling |
| RS-02 image extraction with provenance | Passed (stub-verified) | `test/api/extract-image.test.js` (`RS-02:`, `SEC-7:` image provenance limited to product fields, TR-D-11); reviewer probe P5 `ev-mv36n7ym-016a98f1` | image text cannot be checked server-side (SEC-D-3/14 residual) |
| RS-03 degraded path for every provider fault | Passed | `test/api/extract-degraded.test.js` (`RS-03:` incl. provider-level BUSY, TR-D-2); browser `test/browser/degraded-extraction.test.js` at 360 and 1280 px (`ev-mv3226jz-0198f037`) | — |
| RS-04 (extraction half: missing budget/deadline questions) | Passed | `test/api/extract.test.js`; the paypal/create half is e2 (`test/api/approve-guards.test.js` `RS-04:`) | — |
| RS-05 explanations | Passed (deterministic part); rephrasing unit-level only | `src/domain/explain.js` tests; `test/unit/ai/rephrase.test.js` (`RS-05:`); decision dec-mv330t7a-017a2211 (rephrasing not wired) | the model rephrasing clause is not wired in version one (FU-25 amended dec-mv38g19z-01f0a99f) |
| RS-13..RS-17, RS-27..RS-30, RS-33..RS-36 (phase C) | Passed | phase C submission and review rev-mv2zb2wy-019ac65d; rework-1 rev-mv31zsdx (access layer), rework-2 rev-mv32bt1y-019ab941, rework-3 rev-mv339qdf-01d94e2d | 13 non-blocking findings carried to the verification report |
| RS-29 provenance and log hygiene (log part) | Passed | `test/scan/secrets.test.js` (every log line carries `requestId`, no secret or payer marker in five encodings); `test/api/confirm-provenance.test.js` (`SEC-8:`) | responses, assets and screenshots are scanned in phase G |
| RS-39 upload limits | Passed | `test/api/uploads-retention.test.js` (magic bytes, 5 MiB cap, random names, 0600 files, tombstoning, retention sweep) | id reuse after a hard delete (FU-23) awaits the user-authorized rework-4 |
| NFR3 model spend ceiling | Passed (refusals) | `test/unit/ai/live-runner-refusal.test.js` (`NFR3:` exact two-decimal ceiling 0.01..5.00, 37 refused forms, TR-D-10); gate budgets in `test/api/model-budget-rate.test.js` | incident RISK-21: a review probe started a real run once (possible spend ≤ USD 1.10, recorded as an upper bound) |
| NFR5 API p95 | Passed | `npm test` latency check p95 54–115 ms over ~3,100 calls per run (`ev-mv364015-013062b3`) | — |
| NFR6 contract rows for every route | Passed through phase D; one red row until e6 | `test/api/contracts.test.js` (route table, fixture wrapper; phase D routes enabled, FU-18); phase E routes `GET /api/paypal/return`, `GET /api/paypal/cancel`, `POST /api/webhooks/paypal/:merchantKey` need `route:` rows from e6 | — |
| RS-18, RS-19, RS-21 (DENIED), RS-20 (return idempotency), RS-27 (payment half) | Passed (stub-verified, phase E build; not yet reviewed) | `test/api/paypal-create.test.js`, `paypal-return-idempotent.test.js`, `authorization-denied.test.js`, `amount-tampering.test.js`, `isolation.test.js` (e2 `ho-mv39qe6x-01666ddf`); adapters `test/unit/payments/**` (e1); PaymentProvider contract suite over both adapters (e0) | the Sandbox adapter has only ever talked to the loopback stub; LIVE-P1/P2 unverified |
| RS-23, RS-24 webhooks | Passed (stub-verified, phase E build; not yet reviewed) | `test/api/webhooks.test.js` (96 tests, e3 `ho-mv3aalih-011f4d67`) | real PayPal event shapes unverified (OQ-D5) |
| RS-20 (two-process execute), RS-22, RS-25, RS-26, RS-31, RS-32 | Unverified | e4 (saga, reconciler) waits on the user-authorized rework-4 (FU-23, SEC-R-1); e6 and phase F follow | — |

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
