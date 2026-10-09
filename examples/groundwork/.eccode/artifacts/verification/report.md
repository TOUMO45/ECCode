# Verification report: Groundwork (rework of the reopened gate)
Author: delivery-lead. Not self-reviewed. Run date 2026-10-09.
Code state: git HEAD 6eb29f451ab866c6993969566b9d2f24a78c88a8 plus uncommitted changes that were reviewed in phase:rework-4: deletion of the 22 retired holdout-1 files under `eval/holdout/`, and edits to `README.md` and `docs/eval-results.md`. phase:rework-4 is approved (review rev-mv0aor6x-01fde66f). `eccode audit` passes (ev:ev-mv0apqho-01ab7df8: "Audit OK: 707 events, chain intact, approved artifacts unchanged").

Update 2026-10-09, after delivery and phase:rework-5 (the user reopened this gate): see section 11. Code state for that section: git HEAD 06b1ac2a0208f4bb2f6836ac4b678304b599991c plus the uncommitted rework-5 changes (`public/js/dom.js`, `public/js/views/incident.js`, `public/js/views/postmortems.js`, `public/js/views/incidents.js`, `test/browser/journey.test.js`, `README.md`, new `.env.example`); `git status` shows no other change to the project besides the record under `.eccode/`. `eccode audit` passes on that state (ev:ev-mv0tizzb-018c2c36: "Audit OK: 772 events, chain intact, approved artifacts unchanged"). Sections 1 to 10 are unchanged from the submission reviewed in rev-mv0ay7tb-010829ac except where marked.

This report records measured results and disclosures only. NO human acceptance is claimed anywhere in it, and no decision is recorded on anyone's behalf. The operator of this run is not the product owner.

## 1. Bottom line
- All deterministic checks pass in the working tree (section 2).
- The M1c threshold (`eval/thresholds.json`, max 2%) was never changed. The final holdout (holdout 3) meets it: 1/434 = 0.23% for both providers, on its first and only evaluation. Holdouts 1 (13/423 = 3.07%) and 2 (11/440 = 2.50%) failed it and were retired.
- What deviated are the team's own run-count caps (section 4). They are disclosed in `docs/eval-results.md`, section "Deviations".
- Four risks remain open and need product-owner decisions (section 6). Nothing is marked accepted.
- A clean-checkout run of HEAD as committed FAILS (6 test failures) because the 22 retired files are still committed there; with the reviewed uncommitted changes applied, it passes (section 3, D9). The orchestrator needs to commit the reviewed working tree.

## 2. Evidence run in this gate (fresh, after rework-4 approval)
| Check | Result | Evidence |
|---|---|---|
| `eccode audit` | Audit OK | ev:ev-mv0apqho-01ab7df8 |
| `npm test` | 285/285 pass | ev:ev-mv0apwf4-012ce6d7 |
| `npm run test:browser` | 28/28 pass (journey at 360 and 1280 px) | ev:ev-mv0aq6cc-01b6e176 |
| `npm run test:live` (live CLI, small model) | 4/4 pass, 0 skipped | ev:ev-mv0aqs0x-0169f95c |
| `node eval/run.js --verifier` | M1b 63/63, M1c 0/429 (tune corpus) PASS | ev:ev-mv0apwli-01b9fb79 |
| Clean clone of HEAD 6eb29f4 plus the exact uncommitted diff: npm test, seed, start, health, stop | 285/285 pass; seed ok; `/api/health` returned `{"status":"ok","version":"1.0.0","schemaVersion":2}`; server stopped on SIGTERM | ev:ev-mv0ashe0-0144607e |
| Clean clone of HEAD 6eb29f4 as committed (reproduction) | FAIL: 6 failing tests (holdout manifest, holdout hygiene, retired-holdout, runner cap tests) | ev:ev-mv0as846-017d3f5d |

Superseded evidence, not to be relied on: ev:ev-mv0ar5ur-017f4b2d and ev:ev-mv0arjnp-01afbbe5 are earlier attempts of the clean-clone script whose `npm test | grep` pipe hid the exit status; the engine labels them "passed" although the second shows `# fail 6`. The two runs above replace them.

Not run, by design (caps): holdout evals and any full CLI tune run. Cited, not re-measured: holdout 3 CLI ev:ev-mv07q6zs-01a855fd, holdout 3 fallback ev:ev-mv07ju2a-015f3c20. Reconcile re-runs of those are refused by the holdout cap guard with exit 64 (for example ev:ev-mv0a02m3-0ab9659f); that is the cap working. `eval/usage.log` has not changed in this gate (no runner runs were made; `git diff` is empty for it).

## 3. Criteria to evidence
- D1: verified for the journey in real Chromium at 360 and 1280 px (ev:ev-mv0aq6cc-01b6e176). Other widths in between are not separately tested.
- D2, D3, D5, D6, D7: covered by the automated suite (ev:ev-mv0apwf4-012ce6d7: API, persistence, IDOR, rbac, csrf, rate limit and audit tests) and earlier phase reviews. Not every test body was re-read for this report.
- D4: live CLI provider verified (ev:ev-mv0aqs0x-0169f95c, 4/4); fallback labelled in API and UI. Injection resistance is statistical, 10 cases.
- D8: thresholds fixed before implementation and unchanged. Holdout 3 passes all metrics for both providers (section 5). Holdouts 1 and 2 failed M1c, and the history is disclosed. Product-owner acceptance of the D8 outcome has not been given and is not claimed.
- D9: a clean-checkout run was done on a clone in a fresh directory (`git clone /mnt/sbx/work`, commit 6eb29f451ab866c6993969566b9d2f24a78c88a8). Following the README: there is no install step (`dependencies` and `devDependencies` are both undefined), `npm test` passes, `npm run seed` works, `npm start` serves `/api/health`, and the server stops on SIGTERM sent to the node process. This passed only after applying the reviewed uncommitted diff; at HEAD as committed it fails (above). Not exercised in the clone: `test:browser` and `test:live` (they need Playwright and the authenticated CLI on the host, and were run in the working tree). The run was done by the delivery-lead on the same host, not by an independent reviewer.
- D10: no known blocking defect other than the open items in sections 6 and 7; every open risk is listed.

## 4. Deviations (V1 and V2)
Full detail and wording: `docs/eval-results.md`, section "Deviations".
- M1c threshold: never changed. Holdout 3 meets it (1/434 = 0.23%).
- Run-count caps (the team's own): 12 full non-holdout tune CLI runs against a cap of 8, and 3 holdout runs per provider against a cap of 2.
- Authorisation: the operator recorded decisions `dec-mv05ytch-0186a47a` (caps: 8 tune runs, 2 holdouts per provider) and `dec-mv06pxds-01667e31` ("at most 3 more full CLI tune runs and 1 holdout run per provider"). These cover 11 full tune runs and 3 holdouts per provider. The 12th full tune run (usage.log 2026-10-09T00:31:25.832Z) is not covered by any decision: it was an automatic `reconcile --verify` re-run (ev:ev-mv08i4sz-083fa321, event seq 507) that started right after the batch in which the holdout re-runs were refused by the cap guard. The tune cap guard (`isFullTune`) was a no-op until rework-3 fixed it (regression test `test/eval/budget.test.js`).
- All of this lies within the USER's authorisation in SCOPE.md (USD 150 and 900 minutes). Eval spend logged in `eval/usage.log`: USD 1.5515 over 16 entries (non-holdout 1.2152), against the USD 40 eval cap; the largest run was USD 0.1160 against the USD 3 per-run cap. Engine-recorded project totals now: runtime 167.9 of 900 minutes, 3,015,397 tokens, recorded costUsd 0 (runs were recorded without cost figures, so total real spend is not independently established beyond the eval log).
- The operator is NOT the product owner. The decisions say so themselves ("not a decision of the human product owner"). No product-owner acceptance of the deviations is claimed.
- Left for the product owner: whether to accept the run-count deviations and the holdout history. This report does not assert that this blocks anything; it is recorded as open.

## 5. AI eval (model claude-haiku-5-5, CLI 2.1.295, prompt p2; thresholds unchanged)
- Holdout 1 (retired, manifest 7518992361a6...): CLI M1 86.3%, M1b 63/63, M1c 13/423 = 3.07% FAIL, M2 100%, M3 100%, M4 10/10.
- Holdout 2 (retired, manifest dc184684cedc...): M1c 11/440 = 2.50% FAIL (both providers).
- Holdout 3 (manifest b0c36134893e...) CLI: M1 90.6% (min 89.7%), M1b 63/63, M1c 1/434 = 0.23%, M2 98.8%, M3 100%, M4 10/10. PASS.
- Holdout 3 fallback: M1 100%, M1b 63/63, M1c 1/434, M2 100%, M3 100%, M4 10/10, M5 pass. PASS (no model; not evidence of model quality).
- The verifier edits were tuned on the tune data and both retired holdouts, so only holdout 3 is unbiased. Its author's access restrictions are a self-report (handoff ho-mv0884dm-012bc487).
- hold3-08: the single false flag, 1/434 = 0.23% against the 2% limit (Wilson 95% about 0.04% to 1.29%). The honest statement "At 14:10 Sofia.Lindqvist said Swedish customers reported password reset emails going to spam." cites line 1, which says "Sweden"; the verifier reported NAME_NOT_IN_SOURCE for the demonym "Swedish". It is a correct statement wrongly blocked (the safe direction) and was deliberately not fixed, to avoid tuning on the final holdout.

## 6. Risk dispositions (V4)
The risk list is from the engine record. Status is as recorded; nothing is marked accepted. "Left" means what remains for the product owner.

| Risk | Sev. | Status | Mitigation | Measured residual | Left for the product owner |
|---|---|---|---|---|---|
| RISK-1 semantically wrong but lexically grounded statement published | high | OPEN | Lead reviews before publish; limitation note beside Publish in the UI; README "What verified means". | Lexical verifier. M1b 63/63 covers seeded kinds only; an earlier probe outside them caught 2 of 6. Not measurable by M1c. | Accept the residual or require stronger semantic checks. |
| RISK-2 CLI model misses D8 thresholds | high | OPEN (set back to open in rework-4) | Prompt p1 to p2; holdout 3 passed (M1 90.6% vs 85, M2 98.8% vs 75, M3 100% vs 70, M4 10/10 vs 9). | Model-dependent (haiku, CLI 2.1.295); n small; two earlier holdouts failed M1c. 12 tune runs vs cap 8, 3 holdouts vs 2; the 12th run is covered by no decision. | Acceptance of the run-count deviations. |
| RISK-4 prompt injection sways model | high | mitigated | Data-only prompting, no tools, deterministic verifier is authoritative. | M4 10/10 on holdout 3 for CLI and fallback (threshold 9); 10 cases only; novel injections can still sway model text, and the verifier blocks ungrounded output from publishing. | Nothing recorded as pending. A larger injection set could be considered. |
| RISK-6 holdout contamination | high | mitigated | Hash manifests; run log with enforced cap (reconcile re-runs refused, ev:ev-mv0a02m3-0ab9659f); holdouts 1 and 2 retired. | Holdout 3 is the only unbiased figure; its author's restrictions are self-reported. | Whether the self-report is sufficient. |
| RISK-10 sensitive notes sent to an external provider | high | OPEN | UI marks providers that send notes off host; local fallback keeps notes on the machine; README privacy note; CLI runs without tools and with a restricted environment. | Not removable by design with the CLI or API provider. No automatic data retention policy. | A data-handling and retention policy. |
| RISK-11 CLI ambient config or env leak | high | mitigated | CLI isolation (empty tools, temp cwd, env allowlist, version recorded); live isolation test passes (ev:ev-mv0aqs0x-0169f95c). | Depends on CLI flags staying stable (2.1.295). The child inherits HOME/CLAUDE_CONFIG_DIR (SEC-1/2). | Nothing recorded as pending. |
| RISK-12 publish race / stale status | high | mitigated | Publish re-verifies in one transaction with a version check; publish and rbac tests pass (ev:ev-mv0apwf4-012ce6d7). | SQLite, single node only. | Nothing recorded as pending. |
| RISK-13 fallback timeline recall | high | mitigated | Fallback timeline tuned on the tune set; holdout 3 fallback M2 100% (80/80, threshold 55%), M3 100%. | The synthetic data shape flatters recall. | Nothing recorded as pending. |
| RISK-14 M1c false flags / paraphrase gaps | high | OPEN (set back to open in rework-4) | Threshold unchanged; verifier fix; holdout 3 M1c 1/434 = 0.23%; hold3-08 deliberately not fixed. | n = 434; true rate uncertain (Wilson upper bound about 1.29%); lexical paraphrase flags remain possible; the verifier errs toward blocking. | Accept the residual. |
| RISK-3 node:sqlite experimental | medium | mitigated | Node pinned `>=22.5`; thin wrapper; persistence tests pass. | Stays experimental on future Node versions. | Retest on Node upgrades. |
| RISK-5 CLI flakiness in tests | medium | mitigated | Fake provider is the default; live tests are opt-in; evals average 3 repetitions. | Occasional failed live calls (1 failed call in 3 of 13 tune runs; 0 in the 3 holdout runs). | Nothing recorded as pending. |
| RISK-15 live CLI injection 8/10 in an unofficial probe | medium | mitigated | Official runs: holdout 3 M4 10/10; tune M4 10/10 after p1 to p2. | 10-case set. | Nothing recorded as pending. |

## 7. Known limitations
1. The verifier is lexical; honest semantic paraphrase can be wrongly flagged ("one search in five" vs "20 percent"). 2. M1b covers only the seeded fabrication kinds. 3. Injection resistance rests on 10 cases. 4. hold3-08 is an unfixed false flag. 5. `.env.example` is documentation only (added in rework-5; the server has no `.env` loader, so copying it to `.env` changes nothing unless the shell or service manager exports the values). 6. No metrics endpoint. 7. SIGTERM sent to the `npm start` wrapper alone does not stop the server (documented; the clean-clone run signalled the node process). 8. Browser test covers 360 and 1280 px only and needs a global Playwright. 9. Non-holdout eval reports are git-ignored. 10. The login rate limiter is in memory. 11. Total real spend is not independently established beyond `eval/usage.log`.

## 8. Not verified
Holdout and full CLI evals were not re-run. The holdout author's restrictions were not independently checked. The clean-checkout run was done by the delivery-lead, not an independent reviewer, and `test:browser` and `test:live` were not run in the clone. Nothing about the product owner's position is known.
After rework-5 (section 11): holdout evals, full CLI tune runs and `npm run test:live` were not re-run; no clean-checkout run was made on the rework-5 state (its changes are uncommitted, so a clone of HEAD would not contain them); the fallback-draft review (T3) and the "Not found" and error states are not scanned for stray text in a browser (reviewer finding R5-4, info: those paths were read and use `h()` or `appendAll`). The reviewer's own Playwright probe (ev:ev-mv0tdqpn-01b5c29b) is not in the repository and was not re-run by the delivery-lead.

## 9. Needs the product owner (not asserted as blocking)
Decisions on the open risks (RISK-1, RISK-2, RISK-10, RISK-14), on the run-count deviations (including the uncovered 12th run), on the holdout history and hold3-08, and on the D8 outcome. None is recorded, and none is claimed.

## 10. Housekeeping for the orchestrator
Uncommitted in the working tree: 22 deletions under `eval/holdout/{incidents/hold-01..12,injections/hold-inj-01..10}.json`, and modified `README.md` and `docs/eval-results.md`. These were reviewed in phase:rework-4. They must be committed for HEAD to match the reviewed state and for a clean clone to pass.

Superseded on 2026-10-09 after rework-5: those rework-4 changes are no longer in the uncommitted set. The working tree now differs from HEAD 06b1ac2 only by the rework-5 files listed in section 11, which are likewise uncommitted and must be committed for HEAD to match the reviewed state.

## 11. Rework-5 (after delivery), 2026-10-09
Author: delivery-lead. Not self-reviewed. Measured results and disclosures only; no human acceptance is claimed.

### What happened
Groundwork was delivered on 2026-10-09 (`.eccode/delivery/final-handoff.md`). Afterwards the user reopened this gate (event seq 732, "complete the open items; reopen verification for a rework that fixes the stray 'null' text under the incident title and under Draft review and adds .env.example") and opened phase:rework-5 (seq 733, owner frontend-engineer, files `public/js/views/incident.js`, `.env.example`, `README.md`, `test/browser/**`; extended by the orchestrator at seq 752 to `public/js/views/postmortems.js`, `public/js/views/incidents.js` and `public/js/dom.js` after finding R5-1).

### The defect
Conditional children written as `cond ? h(...) : null` were passed to native `Element.append`, which renders a null child as the literal text "null". Visible under the incident title (no description) and under "Draft review" (non-fallback draft) in `public/js/views/incident.js`, and, as the reviewer found (R5-1), under the postmortem title on the published-postmortem page a viewer sees (`public/js/views/postmortems.js`); the same latent pattern was at `public/js/views/incidents.js:104` (R5-2, not confirmed user-visible). The implementer's reproductions, recorded before the fixes, failed as expected: ev:ev-mv0sm6xz-01bf18df (round one, "incident page: literal \"null\" text rendered in div", both viewports) and ev:ev-mv0t9ex5-01506ac8 (round two, "viewer-postmortem: literal \"null\" text rendered in main#main", both viewports).

### What changed (final files, approved submission sub-mv0tcdks-01398a01)
- `public/js/dom.js`: new exported `appendAll(el, ...children)` next to `h()`; flattens children, skips `undefined`, `null` and `false` (the same rule as `h()`), appends Nodes as they are and other values as text nodes, returns `el`.
- `public/js/views/incident.js` (renderHead and renderReview), `public/js/views/postmortems.js` (root append with the description and fallback-banner children) and `public/js/views/incidents.js` (`canCreate ? form : null`): the four native-append call sites that passed a conditional child now use `appendAll`. The reviewer's static check found no remaining `: null` / `: undefined` child outside `h()`/`appendAll` in `public/js`.
- `test/browser/journey.test.js`: `assertNoStrayNull(page, label)` scans every element under `body` for a direct text node whose trimmed content is exactly "null"; it runs at the top of `auditLayout` (login, incidents, draft-review, published, viewer-postmortem, incidents-empty, at 360 and 1280 px) and directly after the incident page opens and after the fake draft renders.
- `.env.example` (new, project root): the 15 variables of `src/config.js` and the README configuration table (PORT, HOST, GW_DB_PATH, GW_COOKIE_SECURE, GW_LOG, GW_ENABLE_FAKE, GW_CLI_MODEL, GW_CLI_MAX_BUDGET_USD, GW_CLI_TIMEOUT_MS, GW_CLAUDE_BIN, GW_CLI_ENV_PASS, ANTHROPIC_API_KEY, GW_ANTHROPIC_MODEL, GW_ANTHROPIC_URL, GW_SEED_PASSWORD) with their defaults and a one-line comment each; secrets left empty. `.env` stays git-ignored; `.env.example` is not.
- `README.md`: the Configuration note and the limitations entry that said no `.env.example` is shipped now describe the file and state that the server has no `.env` loader.
- No change to `src/`, `eval/`, thresholds, holdouts or docs other than README.md. The AI-eval figures, deviations and risk dispositions in sections 4 to 6 are unaffected and were not re-measured.

### Gate history of phase:rework-5
- Submission 1 (sub-mv0splpg-01e6f2a6): rejected by technical-reviewer, rev-mv0suzex-016f2cc3, finding R5-1 major (published-postmortem page still rendered "null"; reproduced in the real app, ev:ev-mv0stgd1-01d07e41), R5-2 info (latent pattern in incidents.js), R5-3 info (handoff said 16 variables, the file has 15).
- Submission 2 (sub-mv0tcdks-01398a01): approved by technical-reviewer, rev-mv0tfif0-015659c8, R5-1 to R5-3 resolved; one info finding R5-4 (fallback-draft review and not-found/error states covered by code path, not by a browser assertion). Reviewer's checks after the resubmission: `npm test` 285/285 ev:ev-mv0tdxf4-01a729aa; `npm run test:browser` 28/28 ev:ev-mv0teewl-015f461f; reviewer's own Playwright probe of the real app, every visited page clean including the viewer's postmortem page ev:ev-mv0tdqpn-01b5c29b.

### Fresh checks by the delivery-lead on the final files (this submission)
| Check | Result | Evidence |
|---|---|---|
| `npm test` | 285/285 pass, 0 fail, 0 skipped | ev:ev-mv0thoz9-018ee287 |
| `npm run test:browser` (real Chromium, 360 and 1280 px, stray-null scan on every audited page) | 28/28 pass | ev:ev-mv0tiu03-01f83764 |
| `eccode audit` | Audit OK: 772 events, chain intact, approved artifacts unchanged | ev:ev-mv0tizzb-018c2c36 |

The sha256 of each rework-5 file in the working tree equals the hash recorded in the approved submission sub-mv0tcdks-01398a01 (checked by the delivery-lead with `sha256sum`; the audit's "approved artifacts unchanged" covers the same).

Not run, by design: holdout evals (the cap guard refuses a fourth run; the holdout results in section 5 stand as measured), full CLI tune runs, and `npm run test:live` (no live-model test was run in this submission; the last live run remains ev:ev-mv0aqs0x-0169f95c from before rework-5, and rework-5 touched no provider code). No clean-checkout run was made on the rework-5 state.

### Criteria of the last verification review (rev-mv0ay7tb-010829ac), restated for this submission
- C1 deterministic checks: pass on the final files (table above).
- C2 D9 clean checkout: not repeated; the earlier run stands for the code it covered. The rework-5 changes are uncommitted, so a clone of HEAD would not contain them.
- C3 D8: untouched by rework-5; nothing re-measured; section 5 and `docs/eval-results.md` unchanged.
- C4 D10: the stray-"null" defect is fixed and no longer open; `.env.example` is no longer a gap; the four open risks (RISK-1, RISK-2, RISK-10, RISK-14) and the items in section 9 remain exactly as they were. The record is audit-clean (ev:ev-mv0tizzb-018c2c36).

### Still open after rework-5
A human product owner has still not signed off on anything: the decisions listed in section 9 (open risks, run-count deviations, holdout history, hold3-08, the D8 outcome) are not recorded and not claimed. The rework-5 changes are uncommitted in the working tree (housekeeping for the orchestrator; the delivery-lead does not commit).
