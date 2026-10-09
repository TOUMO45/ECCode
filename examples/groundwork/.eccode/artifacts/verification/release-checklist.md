# Release checklist (draft, delivery-lead; not reviewed)

| Item | State | Notes |
|---|---|---|
| Install from docs works | UNVERIFIED in this gate | README has setup, seed, run, test and eval commands. Requires Node >= 22.5. I did not do a clean-checkout run. README usage line is stale (F11) and one count is wrong (15 vs 16 usage.log entries). |
| Config and secrets documented | Done, with gap | Env-var table in README is authoritative. No `.env.example`. No `.env` loader. Secrets are not logged. `ANTHROPIC_API_KEY` is optional. |
| Rollback path | Partly | `docs/operations.md` exists. I did not test a restore from backup of the SQLite file; check that the document states the rollback steps. |
| Monitoring | Not provided | No metrics. Health route and logs only. |
| SIGTERM wrapper issue | Open | Stopping through the npm wrapper may not shut down cleanly. |
| Tests | Pass | npm test 285/285, browser 28/28, live 4/4, verifier eval PASS (ev:ev-mv08s4m5-01f02921, ev:ev-mv08sc9f-01432277, ev:ev-mv08syjt-0128c8fe, ev:ev-mv08sypz-01e6f633). |
| AI eval | Passed on holdout 3 only | Holdouts 1 and 2 failed M1c. Not human-accepted. |
| Cap overrun and raised holdout cap | Not accepted | Named acceptance required (F12, F13). |
| phase:release technical review | Missing | Only security-reviewer approved. |
| Open risks accepted or mitigated | NOT accepted | See report section 6. 9 high and 3 medium risks are open in the record. |
