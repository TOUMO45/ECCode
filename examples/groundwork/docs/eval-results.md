# AI evaluation results (measured, not aspirational)

**Headline: the third and final sealed holdout (`hold3-*`) passed all metrics for both providers, on its first and only evaluation.** M1c was 1/434 = 0.23% (max 2%). This is measured evidence, not human acceptance: nothing here is recorded as accepted by a user. One false flag (`hold3-08`, NAME_NOT_IN_SOURCE) remains open. Two earlier holdouts failed M1c (3.07%, 2.50%) and are kept in the history below. All holdout caps are now used (the operator extended them from 2 to 3 per provider).

All numbers are quoted from the reports in `eval/reports/` and the logs `eval/usage.log`, `eval/holdout-runs.log`, `eval/tuning-log.md`. Dates 2026-10-08 and 2026-10-09, git commit `f1a82c44667dfc379de85452d434cb96f1a35f17` (working tree had uncommitted verifier changes), CLI version 2.1.295, model `claude-haiku-5-5`, prompt version `p2`. Thresholds are unattended defaults (ARCH-11, Q3); changing them needs a recorded user decision.

## Holdout history

1. **Holdout 1** (`eval/holdout-retired-1/`, manifest hash `7518992361a6e05fb43629cfc9b399c3dc3359ac652bc4987f914c4e9c784706`): run once per provider at 22:38. Both failed M1c at 13/423 = 3.07%. Retired, and later used as tune data in the final verifier fix.
2. **Verifier fix on tune data only** (see `eval/tuning-log.md`, "Verifier false-flag fix"): suffix stemming, sentence-initial -ly/-ing handling, some stopwords. Tune M1c 7/429 to 0/429 (optimistic).
3. **Holdout 2** (`eval/holdout-retired-2/`, cases `hold2-*`, manifest hash `dc184684cedcde1a11aa2e31938b94bb652cfaf6c2b1a6443a079637b65ed713`): run once per provider at 23:38. Both **FAILED, only on M1c, 11/440 = 2.50%**. Retired, and later used as tune data in the final fix.
4. **Final verifier fix** (rework-2, operator decision `dec-mv06pxds-01667e31`): magnitude normalisation, place-adjective tolerance, author-string name-set hardening, unit-word and prefix-extension handling, reporting verbs as stop words, each with fabrication-twin tests. Tuned on tune data, the verifier corpus and both retired holdouts (14 of 716 correct statements non-verified before, 2 after). Because the retired holdouts were tune data, those figures are optimistic.
5. **Holdout 3** (`eval/holdout/`, cases `hold3-*`, manifest hash `b0c36134893e8fb81161a27f5b31a752a7046a2e684abd5eaa3059f877fc98f9`): the third holdout and the final attempt, run once per provider on 2026-10-09 at 00:09 (logged in `eval/holdout-runs.log`; evidence ev:ev-mv07ju2a-015f3c20 fallback, ev:ev-mv07q6zs-01a855fd cli). The operator extended the holdout caps (2 to 3 per provider) for this run. Both **PASS all metrics on the first and only evaluation**. It is the only unbiased evidence: the verifier edits were tuned on the earlier holdouts. Authorship and access restrictions of the holdout author are recorded in `eval/tuning-log.md` (section holdout-3 authorship and provenance) and handoff ho-mv0884dm-012bc487; this is the author self-report.

## Verdicts

| Provider | Set | Verdict |
|---|---|---|
| CLI (`claude -p`) | **holdout 3** | **PASS** (M1c 0.23%) |
| Fallback extractor | **holdout 3** | **PASS** (M1c 0.23%; no model, not evidence of model quality) |
| CLI and fallback | holdout 2 (retired) | FAIL (M1c 2.50%) |
| CLI and fallback | holdout 1 (retired) | FAIL (M1c 3.07%) |
| CLI | tune (rework-2 runs) | PASS (tuned on, optimistic) |

## CLI, holdout 3 (report `cli-all-holdout-2026-10-09T00-09-05-400Z`) PASS

| Metric | Result | Threshold | Status |
|---|---|---|---|
| M1 | mean 90.6%, min 89.7% (761/840), Wilson95 [88.4, 92.4] | 85% | pass |
| M1b | 63/63 | 100% | pass |
| **M1c** | **1/434 = 0.23%** | max 2% | pass |
| M2 | mean 98.8% (237/240) | 75% | pass |
| M3 | 100% (72/72) | 70% | pass |
| M4 | 10 of 10 | 9 | pass |

Usage: 66 calls, 0 failed, USD 0.1160. Latency mean 9.0 s, p95 14.0 s. Model `claude-haiku-5-5`, CLI 2.1.295, prompt p2.

## Fallback, holdout 3 (report `fallback-all-holdout-2026-10-09T00-09-05-115Z`) PASS

M1 100% (285/285), M1b 63/63, M1c 1/434 = 0.23%, M2 100% (80/80), M3 100% (24/24), M4 10/10, M5 pass. No model involved; these results are not evidence of model quality.

## Remaining false flag and limits

M1c scores the verifier on a fixed corpus of honest statements, so it is identical for both providers. The one false flag is `hold3-08` (NAME_NOT_IN_SOURCE); it is **still open** and no fix was made. Sample size is n = 434 with 1 flag, so the true rate is uncertain (a pass at n = 434 does not prove it is below 2%). The verifier is lexical: honest semantic paraphrase (for example "one search in five" for "20 percent", or "took ownership" for "picking this up") can still be wrongly flagged; no generic rule was found that covers it without weakening fabrication detection. M1b only covers the fabrication kinds seeded in the corpus. Effect on users: a person may have to edit or remove a correct statement before publishing; the verifier errs toward blocking.

## CLI, tune set (latest, report `cli-all-tune-2026-10-08T23-30-05-467Z`)

M1 94.7% (min 92.5%, 735/776), M1b 63/63, M1c 0/429 = 0.00%, M2 97.1% (233/240), M3 100% (78/78), M4 10/10. 66 calls, 0 failed, USD 0.0980, latency mean 8.0 s, p95 11.1 s. Verdict PASS. This set was used for tuning, so these numbers are weaker evidence than the holdout.

## Fallback, tune set (latest report `fallback-all-tune-2026-10-08T23-26-16-008Z`)

M1 100% (294/294), M1b 63/63, M1c 7/429 = 1.63%, M2 100% (80/80), M3 100% (26/26), M4 10/10, M5 pass. The CLI tune report 7 minutes later shows M1c 0/429, so this fallback report may predate the final verifier change; it was not re-run (no fallback tune cap is left to spend deliberately, and it is not needed for the verdict). The 100% timeline recall reflects the dataset shape (key event on the first line of each minute); the fallback timeline selection was changed during tuning after an earlier run scored M2 47.5%.

## Earlier failed holdouts (for the record)

Holdout 2 (retired, 2026-10-08 23:38): CLI report `cli-all-holdout-2026-10-08T23-38-21-233Z` M1 91.8%, M1b 63/63, **M1c 11/440 = 2.50% FAIL**, M2 98.1%, M3 100%, M4 10/10, USD 0.1126. Fallback report `fallback-all-holdout-2026-10-08T23-38-19-255Z`: M1c 11/440 FAIL, M3 92.3%, rest passing. False flags were in `hold2-01`, `-03`, `-04`, `-06` and `hold2-inj-06`.

Holdout 1 (retired):

CLI (report `cli-all-holdout-2026-10-08T22-38-25-160Z`): M1 86.3%, M1b 63/63, M1c 13/423 = 3.07% FAIL, M2 100%, M3 100%, M4 10/10, USD 0.1077. Fallback (`fallback-all-holdout-2026-10-08T22-38-22-459Z`): same M1c failure, everything else passing.

## Code state

The code and docs these reports describe are committed locally (not pushed) as git commit `679e3bcc0e29ff96ef44c2f3ce65814a3b521393`, which includes the rework-3 budget fix. The runs themselves were recorded in `eval/usage.log` with `gitCommit` `f1a82c44667dfc379de85452d434cb96f1a35f17` (the base commit, before the working tree was committed), so the verifier code that produced each report was the uncommitted tree at that time, not f1a82c4. Reports other than holdout ones under `eval/reports/` are git-ignored and not in the commit. Later doc-only commits may follow this one.

## Tuning history

(Full table in `eval/tuning-log.md`.)

- Prompt `p1` to `p2` after CLI tune run 1 scored M4 6/10 (the model wrote meta statements about injected instructions); p2 gave M4 10/10.
- Fallback timeline selection changed (M2 47.5% to 100% on tune).
- Verifier fix described above.
- Run accounting (source of truth `eval/usage.log`, 16 entries, all provider `cli`, model `claude-haiku-5-5`, total USD 1.552): 3 holdout runs (22:38 and 23:38 on 2026-10-08; 00:09 on 2026-10-09) and 13 non-holdout runs (12 full, 1 injections-only), which include automatic re-runs triggered by `reconcile --verify` and the rework-2 tune runs. The original caps (8 tune runs, 2 holdout runs) were exceeded; the holdout extension was an operator decision, and no user acceptance of the overruns is claimed.
- Run counts, corrected: `eval/usage.log` has 16 entries: 3 holdout runs, 1 injections-only run (not a full run) and **12 non-holdout full CLI tune runs** (an earlier note said 11). The cap was 8, so it was overrun by 4 (the delivery plan of 3 was exceeded by 9). The cap guard was a no-op until rework-3: `isFullTune()` in `eval/lib/budget.js` matched COMPLETE/INCOMPLETE but `eval/run.js` writes PASS/FAIL/INCOMPLETE, so it counted 0 and never refused. Fixed with regression test `test/eval/budget.test.js` (fails before, passes after). No waiver or acceptance of the overrun is recorded; any further full CLI tune run is now refused.
- Logged cost: USD 1.552 across the 16 entries (USD 1.215 non-holdout), plus unitemised diagnostics and live tests (about USD 0.015 per pass), so the true total is somewhat higher. This is under the USD 3 per-run and USD 40 aggregate caps and the delivery plan's roughly USD 8.
- Verifier-only runs (no model) are not in `usage.log` or `holdout-runs.log`.

## Status and open items

Holdout 3 passed, but: the sample is small (n = 434, 1 false flag); verifier edits were tuned on holdouts 1 and 2 so holdout 3 is the only unbiased figure; `hold3-08` remains an open false flag; semantic paraphrase limits remain; thresholds were not changed. No human has accepted these results or the open flag. Decision `dec-mv06n1v2-012ac0d8` concerned the earlier miss, and the further work followed operator decision `dec-mv06pxds-01667e31`; no user acceptance of the current state is claimed here. `npm test` does not run the holdout; the holdout reports are the evidence.

## Deviations

All figures are computed from `eval/usage.log` (16 entries), `eval/holdout-runs.log` (6 entries) and the reports in `eval/reports/`. Decision ids are from the ECCode decision records (`eccode status --json`).

**What did not deviate.** The M1c threshold (`eval/thresholds.json`, `m1c.max` = 0.02) was never changed. The final holdout (holdout 3) meets it: 1/434 = 0.23% for both providers. No other threshold was changed either.

**What deviated: the team's own run-count caps.**

| Cap (source) | Limit | Actual | Deviation |
|---|---|---|---|
| Full non-holdout tune CLI runs (`MAX_FULL_TUNE_CLI_RUNS`, decision `dec-mv05ytch-0186a47a`) | 8 | 12 | 4 over the cap of 8. Decision `dec-mv06pxds-01667e31` authorised "at most 3 more", so 11 were authorised and the 12th (2026-10-09 00:31) is covered by no recorded decision. |
| Holdout runs per provider (`MAX_HOLDOUT_RUNS`) | 2 | 3 | 1 over, authorised by `dec-mv06pxds-01667e31` ("1 holdout run per provider"). |
| Delivery plan live tune runs | 3 | 12 | Exceeded by 9. Several were automatic `reconcile --verify` re-runs. |

Counts by time: 6 full tune runs before the first operator decision (23:24:44Z), 2 between the two decisions (23:27 and 23:30, which is the 8th), 4 after the second decision (23:47, 23:51, 23:56 and, on 2026-10-09, 00:31). The cap guard was a no-op (see the rework-3 correction in `eval/tuning-log.md`), so no run was refused; it was fixed in rework-3 and now refuses further full tune runs. The 12th run (usage.log entry 2026-10-09T00:31:25.832Z) was an automatic `reconcile --verify` re-run of the recorded command "full CLI tune run 2 (confirm M4)" (evidence ev-mv08i4sz-083fa321, event seq 507, 259.7 s, recorded 00:35:45). It started right after the batch at seq 502-506 (starting with ev-mv08cjq6-033fa701), in which the re-runs of the holdout 3 commands (seq 503 and 504) were refused by the holdout cap guard with exit 64. The full-tune cap guard did not refuse it because it was a no-op until rework-3.

**The three holdouts** (manifest hashes as logged in `eval/holdout-runs.log`; one run per provider each, 6 logged runs):

| Holdout | Manifest sha256 | Run at (UTC) | Used for |
|---|---|---|---|
| 1 (`eval/holdout-retired-1/`, cases `hold-NN`) | `7518992361a6e05fb43629cfc9b399c3dc3359ac652bc4987f914c4e9c784706` | 2026-10-08 22:38 | First evaluation. Failed M1c, 13/423 = 3.07%. Retired and then used as tune data in the final verifier fix. |
| 2 (`eval/holdout-retired-2/`, cases `hold2-NN`) | `dc184684cedcde1a11aa2e31938b94bb652cfaf6c2b1a6443a079637b65ed713` | 2026-10-08 23:38 | Fresh holdout after the first verifier fix. Failed M1c, 11/440 = 2.50%. Retired and then used as tune data in the final verifier fix. |
| 3 (`eval/holdout/`, cases `hold3-NN`) | `b0c36134893e8fb81161a27f5b31a752a7046a2e684abd5eaa3059f877fc98f9` | 2026-10-09 00:09 | Final attempt, evaluated once per provider, no change afterwards. Passed all metrics. The only unbiased figure. |

**Spend.** Evaluation spend logged in `eval/usage.log` is USD 1.5515 (sum of `costUsd`; USD 1.2152 non-holdout and USD 0.3363 for the three holdout CLI runs; the sum of `costUpperBoundUsd` is USD 1.8515). That is 3.9% of the USD 40 eval cap; the largest single run was USD 0.1160 against the USD 3 per-run cap. Unitemised diagnostics and live tests (about USD 0.015 per pass) are not in the log. The engine's recorded project totals at the start of this rework are costUsd 0 (runs were recorded without cost figures, so this is not a measure of spend), 158.78 of 900 runtime minutes and 2,647,729 tokens. The SCOPE.md authorisation is USD 150 and 900 minutes. Recorded runtime is within it; recorded cost cannot show more than the eval log above, so total real spend is not independently established beyond that log. Decision `dec-mv05ytch-0186a47a` also accepted an earlier cost overrun of "USD ~0.53".

**Authorisation.** The operator's recorded decisions cover up to 11 full tune runs (8, plus "at most 3 more") and 3 holdout runs per provider. The 12th full tune run is not covered by any decision: it breached the operator's own cap. All runs stayed within the USER's authorisation in SCOPE.md (USD 150, 900 minutes), which the cap decisions did not and could not waive. `dec-mv05ytch-0186a47a` (2026-10-08 23:24Z): "The tune-run and holdout-run counts of eval/thresholds.json cost rules apply (at most 8 full tune CLI runs, 2 holdout runs per provider, USD 40 eval cap) ... Total spend stays within the user's USD 150 / 900 minute authorization." `dec-mv06pxds-01667e31` (2026-10-08 23:45Z): "Run-count caps are extended for this attempt only: at most 3 more full CLI tune runs and 1 holdout run per provider; the USD 40 eval cap and the total USD 150 / 900 minute authorization are unchanged." `dec-mv0acn9a-01b09c56` (2026-10-09 01:27Z) raised `limits.maxReworks` from 3 to 4 for this rework. Each states that it is the operator's decision, recorded as `--actor user` because the engine reserves it, and "not a decision of the human product owner".

**Not a product-owner acceptance.** The operator is NOT the product owner. No human product-owner acceptance of the run-count deviations, the holdout history, the open false flag, the M1 to M4 results or any risk is claimed anywhere in this repository. These are measured results and disclosures only.

**The one false flag, `hold3-08`.** On holdout 3, 1 of 434 honest statements was flagged: 1/434 = 0.23% against the 2% limit (the verifier scores a fixed corpus, so CLI and fallback report the same figure; reports `cli-all-holdout-2026-10-09T00-09-05-400Z` and `fallback-all-holdout-2026-10-09T00-09-05-115Z`, field `m1cFalseFlags`). The Wilson 95% interval for 1/434 is about 0.04% to 1.29%, so even its upper end is under 2%, but one event is a thin basis. The case is `hold3-08` ("Transactional email lands in spam folders", SEV3). The flagged honest statement is "At 14:10 Sofia.Lindqvist said Swedish customers reported password reset emails going to spam.", citing line 1, which reads "Customers in Sweden say password reset emails are going to spam". The verifier reported `NAME_NOT_IN_SOURCE` for "Swedish": it treats the capitalised demonym as a name and does not connect it to "Sweden" in the cited line. This is a correct statement wrongly blocked, the safe direction: a person must edit or remove it before publishing. It was deliberately not fixed, to avoid tuning on the final holdout.

**Record repair (rework-4).** The 22 files `eval/holdout/incidents/hold-01..12.json` and `eval/holdout/injections/hold-inj-01..10.json` were approved in phase:eval and later deleted from `eval/holdout/` when holdout 1 was retired. Their copies are in `eval/holdout-retired-1/`. All 22 copies are byte-identical to the sha256 values pinned in the phase:eval gate submission `sub-mv02vh78-010deeca`, and match `eval/holdout-retired-1/MANIFEST.sha256`. (They were never committed to git at the old paths, so git could not be used for this check.) Because the engine only counts files changed since a task's claim, rework-4 restored the 22 files from the retired copies (hash-verified) and then deleted them inside the task, so the deletion is listed in the task handoff. `eval/usage.log` also changed after rework-2 was approved, because later runs were appended.

## Risk dispositions

Status values are those in the engine record. Nothing below is accepted on anyone's behalf. Risks marked open need a product-owner decision.

**RISK-1 (open, high): a lexically grounded but semantically wrong statement is published.**
- Mitigation: the lead must review the draft before publishing; the UI shows a limitation note beside Publish (`LIMITATION` in `public/js/views/incident.js`); README section "What verified means".
- Measured residual: the verifier is lexical. M1b is 63/63 but covers only seeded fabrication kinds; an earlier probe of kinds outside the seed caught 2 of 6, and no later evidence changes that. M1c measures false flags, not this risk, so it gives no figure for it. A wrong causal link, negation or paraphrase reusing words from the cited lines can pass.
- Left to the product owner: accept the residual or require stronger semantic checks. Stays open.

**RISK-10 (open, high): sensitive notes are sent to an external provider.**
- Mitigation: the provider picker marks providers that send notes off host (`sendsNotesOffHost`, `public/js/views/incident.js`); the local deterministic fallback keeps notes on the machine; the README privacy note warns about it; the CLI runs without tools and with a restricted environment.
- Measured residual: not removable by design with the CLI or API provider. Data retention is not automatic (README privacy note).
- Left to the product owner: a data-handling and retention policy. Stays open.

**RISK-2 (open, high): the CLI model misses the D8 thresholds.** Holdout 3 passed all CLI thresholds (M1 mean 90.6% against 85%, M2 98.8%, M3 100%, M4 10/10), but the run counts deviated: 12 full tune runs against 8, and 3 holdouts per provider against 2. The operator's decisions cover 11 tune runs and the 3 holdouts, not the 12th tune run (see Deviations). Product-owner acceptance of these deviations is pending and has not been given, so this risk is set back to open. An earlier mitigation text calling all 12 runs "operator-authorised" is wrong; this section supersedes it.

**RISK-14 (open, high): M1c false flags.** Holdout 3 M1c is 1/434 = 0.23% (Wilson upper bound about 1.29%) against the 2% limit; the one flag is hold3-08, left unfixed. Product-owner acceptance of the residual is pending and has not been given, so this risk is set back to open. Residual: n = 434, lexical paraphrase false flags remain possible, and the verifier errs toward blocking.

**Other risks.** RISK-3, 4, 5, 6, 11, 12, 13 and 15 are recorded as mitigated, with their evidence in the engine record; none depends on a pending product-owner acceptance.

## Cost rules recap

Small model only, per-call cap `GW_CLI_MAX_BUDGET_USD` (0.10), per-run cap USD 3, aggregate cap USD 40 (enforced against `eval/usage.log`), at most 8 full tune CLI runs (12 logged, overrun by 4; guard fixed in rework-3), at most 3 holdout runs per provider (extended from 2 by operator decision; all used). See the README.
