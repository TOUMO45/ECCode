# Verification report: Groundwork
Author: delivery-lead (text written to file by the orchestrator, because subagents cannot write this file). Not self-reviewed. Runs: 2026-10-09. Code state: git HEAD e4f55a29.

## 1. Bottom line
- All deterministic checks pass (section 2).
- D8 (AI evaluation) is NOT cleanly passed. M1c (verifier false-flag rate on honest statements, max 2%) failed on holdout 1 (13/423 = 3.07%) and holdout 2 (11/440 = 2.50%). The verifier was then tuned on data that included both retired holdouts. M1c passed only on holdout 3 (1/434 = 0.23%), on its first and only evaluation. That is the only unbiased figure; it is one sample and the true rate is uncertain.
- NO human has accepted the M1c result, the raised holdout cap (2 to 3 per provider) or the tune-run cap overrun (12 runs vs a cap of 8). Technical-reviewer draft findings F12/F13 say a named person must. Operator decisions authorised the work; they are not recorded as human acceptance.
- The technical review of phase:release was not recorded; only security-reviewer approved it.

## 2. Evidence run in this gate
| Check | Result | Evidence |
|---|---|---|
| npm test | 285/285 pass | ev:ev-mv08s4m5-01f02921 |
| npm run test:browser | 28/28 pass (journey at 360 and 1280 px) | ev:ev-mv08sc9f-01432277 |
| npm run test:live | 4/4 pass | ev:ev-mv08syjt-0128c8fe |
| node eval/run.js --verifier | M1b 63/63, M1c 0/429 (tune corpus) PASS | ev:ev-mv08sypz-01e6f633 |

Not re-run (caps exhausted): holdout and full CLI evals. Cited, not re-measured: holdout 3 CLI ev:ev-mv07q6zs-01a855fd, holdout 3 fallback ev:ev-mv07ju2a-015f3c20. Reconcile re-runs of those two (ev-mv08cjv2-04d3ed17, ev-mv08cjzp-053bf96f) failed with exit 64 "HOLDOUT REFUSED: holdout cap reached" (see their recorded logs); that is the cap working, not a regression.

## 3. Criteria to evidence
D1 verified for the journey at 360/1280 px only. D2, D3, D5, D6, D7 covered by the automated suite and prior phase reviews (not every test body re-read for this report). D4 live CLI path verified; injection resistance statistical. D8 PARTIAL (above). D9 PARTIAL: README exists; no clean-checkout install in this gate. D10 PARTIAL: hold3-08 false flag open.

## 4. AI eval (model claude-haiku-5-5, prompt p2; thresholds unchanged)
- Holdout 1 (retired): CLI M1 86.3%, M1b 63/63, M1c 13/423 = 3.07% FAIL, M2 100%, M3 100%, M4 10/10.
- Holdout 2 (retired): M1c 11/440 = 2.50% FAIL (both providers).
- Holdout 3 CLI: M1 90.6%, M1b 63/63, M1c 1/434 = 0.23%, M2 98.8%, M3 100%, M4 10/10. PASS.
- Holdout 3 fallback: M1 100%, M1b 63/63, M1c 0.23%, M2 100%, M3 100%, M4 10/10, M5 pass. PASS (no model; not evidence of model quality).
- Caveats: hold3-08 (NAME_NOT_IN_SOURCE) is an open unfixed false flag. The holdout-3 author's access restrictions are a self-report (handoff ho-mv0884dm-012bc487). M4 is 10/10 on 10 cases. Semantic paraphrase ("one in five" vs "20 percent") remains unfixed. M1b covers only seeded fabrication kinds.

## 5. Cost, latency, caps
eval/usage.log: 16 entries, USD 1.552 logged (non-holdout 1.215), far under the USD 40 eval cap. Tune-run overrun: 12 full CLI tune runs vs cap 8; the guard (eval/lib/budget.js isFullTune) was a no-op until rework-3 fixed it (reproduction ev:ev-mv08kmqd-019b3e58, fix ev:ev-mv08kpnc-01a54421). The fix is verified; the overrun and the raised holdout cap are not accepted by any human.

## 6. Open risks (recorded, none accepted)
High: RISK-1, 2, 4, 6, 10, 11, 12, 13, 14. Medium: RISK-3, 5, 15. Some risk texts predate holdout 3.

## 7. Known limitations
1. README line ~123 usage figures stale (15 entries / USD 1.454 vs 16 / 1.552) (F11). 2. No .env.example. 3. No metrics endpoint. 4. SIGTERM to the npm start wrapper does not stop the server (documented). 5. Verifier is lexical; honest semantic paraphrase can be wrongly flagged. 6. Injection resistance statistical (10 cases). 7. hold3-08 open. 8. Browser test only at 360 and 1280 px. 9. Non-holdout eval reports are git-ignored. 10. Child CLI inherits HOME/CLAUDE_CONFIG_DIR; GW_CLI_ENV_PASS not validated beyond name pattern (SEC-1/2).

## 8. Not verified
No clean-checkout install; no holdout or CLI evals re-run; holdout author restrictions not independently checked.

## 9. Needs a human
A named person must accept or reject: the M1c result, the raised holdout cap, the tune overrun, hold3-08, the open high risks. phase:release has no recorded technical review.
