# Phase submission: eval

Tasks done: datasets-tune-verifier, datasets-holdout, eval-harness, eval-tests.

Criterion (plan): "Thresholds fixed and tested before tuning; holdout manifest guarded; fallback and CLI evaluated separately (D8)".

## Acceptance criteria -> evidence

| Criterion part | Evidence | Notes |
|---|---|---|
| Thresholds fixed and tested before tuning | ev:ev-mv02racy-0114b465 (full npm test: 267 tests, 264 pass, 0 fail, 1 skipped, 2 todo); ev:ev-mv02luhd-01d70db8 (thresholds regression); ev:ev-mv02fyni-01bd7f84, ev:ev-mv02g4in-01b85263 (datasets task); eval/thresholds.json, test/eval/thresholds.test.js | Thresholds were not weakened to hide misses; both misses are visible as `todo` tests. eval/tuning-log.md records no verifier parameter change so far. |
| Holdout manifest guarded | ev:ev-mv02m26h-018c5dc6 (manifest test); ev:ev-mv02racy-0114b465 (test/eval/manifest.test.js in full suite) | eval/holdout/MANIFEST.sha256. Two earlier manifest-test runs failed (ev:ev-mv02lidz-01295960, ev:ev-mv02lu47-01ee2ed5) before the passing one. Holdout was not tuned on. |
| Fallback and CLI evaluated separately (D8) | ev:ev-mv02rb2i-01590629 (fallback run, FAILED on M2); ev:ev-mv02me7y-01426973 (live CLI injections, FAILED on M4); ev:ev-mv02mkw4-01e8720e, ev:ev-mv02raov-0133c943 (verifier only, no model) | Separate reports labelled by provider; fallback output states it says nothing about model quality. A CLI "all" run reported NOT_RUN (CLI unavailable at that moment) and was not logged as a run. |
| Plan still valid | ev:ev-mv02rb8d-01641fb9 | 5 phases, 13 tasks. |

## Results of integration runs (as recorded, failures included)
- Full npm test (ev:ev-mv02racy-0114b465): PASSED, 0 fail, 1 skipped (public/index.html check, ui phase), 2 todo (below).
- `npm run eval -- --verifier` (ev:ev-mv02raov-0133c943): PASS. M1b 63/63, M1c 7/429 = 1.63% (max 2%), tune set.
- `npm run eval -- --provider fallback` (ev:ev-mv02rb2i-01590629): **FAILED, exit 1**. M1 100% (494/494), M1b PASS, M1c PASS 1.63%, **M2 47.5% (38/80) vs 60% FAIL**, M3 100% (26/26), M4 10/10, M5 PASS.
- `eccode plan validate` (ev:ev-mv02rb8d-01641fb9): PASSED.

## Unmet items and known gaps (stated plainly)
1. **Fallback M2 47.5% vs 60% threshold: not met.** Cause per test comment: the fallback caps the timeline at 30 statements (MAX_TIMELINE in src/ai/fallback.js). Kept as a `todo` test in test/eval/fallback-tune.test.js (plus a floor guard at 47%). Tuning is scheduled in task live-eval (phase release), which must remove the todo.
2. **Holdout M1c 3.07% (13/423) vs max 2%: not met.** `todo` in test/eval/m1b-m1c.test.js. Holdout must not be tuned on; any improvement has to be derived from the tune set and verifier corpus only.
3. **Live CLI injection probe M4 8/10 vs threshold 9: not met.** Single non-standard repetition (standard is 3), explicitly not an official run (ev:ev-mv02me7y-01426973, cost about 0.016 USD). No official CLI run exists yet; M1, M2, M3 for the CLI are unmeasured.
4. **Verifier known-gap probes: only 2/6 flagged.** Probes outside the seeded fabrication kinds are measured and reported, not asserted (test/eval/thresholds.test.js). The verifier misses 4 of 6 such kinds.
5. **Natural-paraphrase false flags:** all 7 tune-set M1c false flags (WEAK_SUPPORT x2, NAME_NOT_IN_SOURCE x5: c-payments-nat3/4/5, c-auth-nat7, c-batch-nat13, c-search-nat17/20) are in the natural-paraphrase subset. 1.63% is close to the 2% cap.
6. Thresholds are unattended defaults (Q3); changes need a recorded user decision.

## Phase verdict requested
The harness, datasets, manifest guard, scorer and deterministic tests are delivered and passing. The phase does not claim that quality thresholds are met: items 1-3 are open and carried into live-eval.

## Changed files (from task handoffs)
- datasets-tune-verifier: eval/thresholds.json, eval/tune/incidents/*, eval/tune/injections/*, eval/verifier/{correct.json,fabrications.json,forbidden-stopwords.txt,probes.json,notes/*}, test/eval/thresholds.test.js
- datasets-holdout: eval/holdout/MANIFEST.sha256, eval/holdout/incidents/*, eval/holdout/injections/*, test/eval/manifest.test.js
- eval-harness: eval/run.js, eval/lib/{wilson,manifest,load,score,budget,report}.js, eval/tuning-log.md, eval/usage.log
- eval-tests: test/eval/{scorer,fallback-tune,m1b-m1c}.test.js

## Response to review rev-mv02twvt-01ee97f3 (F1-F4)

The plan was NOT changed. No plan.json edit was made and the plan gate was not touched.

- **F1 (major): live-eval criteria do not enforce resolution of the todo misses.** The reviewer's recommended fix (amend plan, re-approve plan gate) is not available: reopening the plan gate is user-only (gate reopen with actor user), the user is unavailable in this unattended run, and that reopening is pending. Instead the orchestrator recorded open risks RISK-13, RISK-14 and RISK-15 (see eccode status) with owner and mitigation. They bind live-eval to: (a) turn the fallback M2 todo (47.5% vs 60%) in test/eval/fallback-tune.test.js into a hard assertion and remove the todo; (b) do the same for the holdout M1c todo (3.07% vs 2%) in test/eval/m1b-m1c.test.js, using only changes derived from the tune set and verifier corpus, each logged in eval/tuning-log.md; (c) do one holdout re-run after the last tuning change and report it as measured; (d) use --max-cost 1.5 on each run; (e) surface any still-unmet miss to the user at the verification gate. These are risk-register controls, not plan criteria, so this finding is mitigated, not resolved as the reviewer defined it. The plan-amendment route stays open for the user.
- **F2 (minor): holdout verifier run prints failing item ids (hold-03, hold-07, hold-11).** Noted. live-eval is instructed not to use or consult failing holdout item ids when tuning, and its tuning-log entries must state that no holdout item was consulted. Limiting the harness output to aggregate counts is not done in this phase.
- **F3 (minor): verifier misses 4 of 6 out-of-scope fabrication kinds.** The README open-risks (D10) section, owned by docs-devops, must list this gap and state that M1b 100% covers only the seeded kinds.
- **F4 (info): USD 8 agent cap and USD 1.5 per-run cap are not harness-enforced.** live-eval passes --max-cost 1.5 on every run and keeps to the 3 tune-run cap. No change to the harness.
