# Release checklist (delivery-lead; not reviewed). Code state: HEAD 6eb29f4 plus the uncommitted, rework-4-reviewed changes (22 deletions, README.md, docs/eval-results.md).

| Item | State | Notes |
|---|---|---|
| Install from docs works | Verified by the delivery-lead on a clone, with a caveat | Clone of HEAD 6eb29f4 plus the exact uncommitted diff: no install step (zero dependencies), `npm test` 285/285, `npm run seed`, `npm start`, `/api/health` ok, SIGTERM to the node process stops it (ev:ev-mv0ashe0-0144607e). At HEAD as committed the clone FAILS 6 tests because the 22 retired files are still committed (ev:ev-mv0as846-017d3f5d): commit the reviewed working tree first. Not independent; browser and live tests not run in the clone. |
| Config and secrets documented | Done, with a gap | README env-var table matches `src/config.js`. No `.env.example`. No `.env` loader. Secrets are not logged. `ANTHROPIC_API_KEY` is optional. |
| Rollback path | Documented, not exercised | `docs/operations.md` describes backup and rollback (manual copy of the SQLite files). A restore was not tested in this gate. |
| Monitoring | Not provided | Health route and structured JSON logs only; no metrics endpoint. |
| SIGTERM wrapper issue | Open, documented | Signal the node process, not the `npm start` wrapper. |
| Tests | Pass | npm test 285/285 (ev:ev-mv0apwf4-012ce6d7), browser 28/28 (ev:ev-mv0aq6cc-01b6e176), live 4/4 (ev:ev-mv0aqs0x-0169f95c), verifier eval PASS (ev:ev-mv0apwli-01b9fb79). |
| eccode audit | Pass | ev:ev-mv0apqho-01ab7df8. |
| AI eval | Holdout 3 passed all metrics, both providers | M1c 1/434 = 0.23% vs 2% (threshold unchanged). Holdouts 1 and 2 failed M1c and were retired. Measured only; no human acceptance is claimed. |
| Cap deviations | Disclosed, not accepted by a product owner | 12 full tune runs vs cap 8; 3 holdouts vs 2. Operator decisions dec-mv05ytch-0186a47a and dec-mv06pxds-01667e31 cover 11 tune runs and 3 holdouts; the 12th is uncovered (automatic reconcile re-run). See docs/eval-results.md "Deviations". Eval spend USD 1.55 vs USD 40 cap; runtime 167.9 of 900 min. |
| phase:release technical review | Done via rework-4 | rev-mv0aor6x-01fde66f (README, docs, eval content). |
| Open risks | 4 open, 8 mitigated; none accepted | OPEN: RISK-1, RISK-2, RISK-10, RISK-14. Dispositions in the report, section 6. These need product-owner decisions. |
