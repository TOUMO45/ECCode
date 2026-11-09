# S4 plan addendum 2: owner decisions O-1..O-3, the D-4 sample CSV, and the verified Stage 1 ECCode base

This addendum records owner decisions and one verification run made after addendum 1. It does **not** edit the plan
(`docs/build/gf-s4-plan.md`, frozen at `d4c8427`, freeze line added by `1240da2`) or addendum 1
(`docs/build/gf-s4-plan-addendum-1.md`, committed in `56ce6c4`). Where this addendum and either of them disagree, this
addendum records what changed and why. Branch: `s4-freeze/base`, created from `a530ae1`. Every count is from one run in
one container (n=1). No significance is claimed.

## 1. Owner decisions (final)

| Id | Decision | Source |
|---|---|---|
| O-1 | Arms b and c both use automated slice approval: `gf.approval.auto` **ON**, with the **same budget** (section 3). | owner, this session |
| O-2 | Arms b and c both start with the stack profile `python-fastapi-postgres-worker-compose`. | owner, this session |
| O-3 | The **operator script** sets both switches identically for b and c. The arm does not set them. They are part of the arm definition, not interventions (plan 6.1 "Not counted: the arm-definition config in section 3"). | owner, this session |
| D-3 | R-1, R-2, R-4 and R-5 stay open. | unchanged from addendum 1 |
| D-4 | The sample CSV is the owner's file `sample_readings.csv` (section 4), byte for byte. | owner, this session |
| D-5 | Model `claude-opus-5-5` for every arm. | unchanged from addendum 1 |
| D-6 | Arms get no docker socket. | unchanged from addendum 1 |
| P-1 | `gf.runtime.enforce` stays opt-in. It is ON only in arm c. | unchanged from addendum 1 |

**Labeling consequence (to be stated in every report):** arm b is **"default engine + compose profile +
auto-approval"**. It is **not** the pure ECCode default: at this base, `init` without `--stack` selects
`python-fastapi-sqlalchemy-sqlite`, and `gf.approval.auto` is absent (approves nothing, GF-AUTO-0). Arm c is
"default engine + compose profile + auto-approval + `gf.runtime.enforce`". The b-vs-c comparison still isolates exactly
one switch, `gf.runtime.enforce`.

## 2. Stage 1 ECCode base (verified)

**Base commit: `a530ae12fd07a4a28566e89b7211acad332f8c69` (`a530ae1`)**, head of `origin/s4-prereq/finish` (it is on
origin; checked with `git merge-base --is-ancestor`). Exported as addendum 1 section 2 says
(`git archive <commit>`, excluding `docs/`). `git diff 35d5cc9 a530ae1 -- . ':!docs'` is empty, so the engine content
equals `35d5cc9`. The commits on `s4-freeze/base` after `a530ae1` touch only `docs/`, so an export of any of them
excluding `docs/` is identical to the base.

### 2.1 One clean full run at `a530ae1` (n=1)

Command: `ECCODE_PYTHON=/root/.cache/eccode/phase3-venv/bin/python npm test` (`node --test tests/*.test.js`). Nothing
else was running. Node v22.23.4, bwrap 0.9.0-1ubuntu0.3, `DEBUG` unset, `ECCODE_SEED_KEY` set.
Evidence: `docs/build/gf-s4-freeze-record/evidence/` (`full-run-summary.txt`, `full-run-skipped-tests.txt`,
`full-run.log.gz`, `names-new-vs-1240da2-baseline.tsv`, `install.log`, `mealie-targeted-run.log`,
`validate-toolkit.txt`).

| Run | Commit | Tests | Pass | Fail | Skip |
|---|---|---|---|---|---|
| Regression baseline | `1240da2` | 1798 | 1738 | 0 | 60 |
| Last run (S4-PREREQ-B) | content `9faeed2` (= `a530ae1` outside `docs/`) | 1831 | 1761 | 0 | 70 |
| **This run** | **`a530ae1`** | **1862** | **1844** | **0** | **18** |

`scripts/validate-toolkit.js`: passed (15 agents, 10 skills, 13 commands, hooks wired).

**Test total.** 1798 + 33 slice tests (`tests/gf-approval.test.js` 20, `tests/gf-profile-compose.test.js` 13) = 1831.
Another 31 per-flaw subtests of `tests/phase3-fixture-app.test.js` (`b1-*` … `c-*`) exist only when the Python
interpreter is present: 1831 + 31 = 1862. Against the committed baseline name list, 0 baseline names are missing. That
list holds 1794 names for 1798 tests: the 4 missing names are depth-2 subtests of `tests/pilot.test.js` "chain mode",
which ran in the baseline and in this run.

**Skip count: how it was resolved.**
- The 1240da2 baseline also had **no** Python test environment. Its committed name list carries the 46 "no interpreter
  with fastapi …" skips. Baseline 60 = 46 interpreter + 14 others.
- The last run's 70 = baseline 60 + 4 "no Mealie mirror" + 6 "freeze commit … is not in this clone". **Correction:**
  `docs/build/gf-s4-prereq-evidence.md` section 1 and addendum 1 section 2 attribute the +10 to the missing Python
  environment. The skip lists show the cause was the Mealie mirror (4) and the clone's missing freeze commits (6).
  Neither file is edited here.
- This run: the recreated venv resolved the 46 interpreter skips. This clone has the freeze commits, which resolved the
  6 freeze-commit skips. The Mealie mirror was absent during the run, so 4 "no Mealie mirror" skips remained:
  18 = 14 + 4.
- **Follow-up (not a full-suite re-run):** the Mealie bare mirror was then created with the engine's own command
  (`lib/bench.js` `mirrorFor`: `git clone -q --bare https://github.com/mealie-recipes/mealie.git`). `tests/mealie.test.js`
  alone was run once: 21 tests, 17 pass, 0 fail, 4 skip. The 4 "`<suite>`: no prompt contains a line of its fix or names
  a file it changes" tests **pass**. Its 4 skips are the live-validation tests, which the baseline skipped too.
- **Result:** every test that ran at `1240da2` has run at `a530ae1` in this session, and none failed. Zero regressions
  against the baseline, at n=1.

**Still skipped (14). All 14 were skipped in the 1240da2 baseline too:** 6 × no Mealie checkout at
`/root/.cache/eccode/mealie-seed` (needs a seeded Mealie app; not fabricated); 4 × Mealie live validation (needs
`ECCODE_MEALIE_VALIDATE=1` and per-task venvs); 1 × realbugs live validation (`ECCODE_REALBUGS_VALIDATE=1`);
1 × `ECCODE_CBM` unset; 1 × codebase-memory-mcp not installed; 1 × kotlinc not installed.

## 3. Switches: exact names, lines and values

| Switch | Exact text from the code | Value for arms b and c |
|---|---|---|
| auto-approval | `lib/greenfield/approval.js:3`: `.eccode/config.json  "gf": { "approval": { "auto": { "enabled": true, "maxSlices": N, "maxTokens": T, "maxWallClockMinutes": M } } }` | `{"enabled": true, "maxSlices": 12, "maxTokens": 170000000, "maxWallClockMinutes": 480}` |
| stack profile | profile name `lib/greenfield/profiles.js:25`: `const NAME = 'python-fastapi-postgres-worker-compose';` selected at init, usage line `bin/eccode-gf.js:17`: `init --name <n> --idea <text> [--stack python-fastapi-sqlalchemy-sqlite\|python-fastapi-postgres-worker-compose]`, parsed at `bin/eccode-gf.js:98`: `stackProfile: flags.stack === undefined ? undefined : flags.stack` | `--stack python-fastapi-postgres-worker-compose` |
| runtime enforcement | `lib/greenfield/runtime.js:205`: `return Boolean(config && config.gf && config.gf.runtime && config.gf.runtime.enforce === true);` | b: absent. c: `"gf": {"runtime": {"enforce": true}}` (plan section 3, unchanged) |

**Auto-approval budget and its source.** Addendum 1 contains **no** budget value: it leaves O-1, including
`maxSlices`, `maxTokens` and `maxWallClockMinutes`, as an open question. The value is therefore the owner's, decided
this session: **at most 12 auto-approved slices, at most 170M all-processed tokens, at most 8 hours wall-clock,
identical for arms b and c. Budget exhaustion is a hard stop and counts as a human intervention.** Unit check:
`maxTokens` is compared with the sum of the closures' `accounting` deltas (`approval.js` `tokensOf`), whose unit is
fixed to `all-processed-tokens` (`lib/greenfield/closure.js:15`, `lib/greenfield/events.js:104`). 8 h = 480 minutes,
measured from `init` (`approval.js`: "wall clock since init").

## 4. D-4: the sample CSV

- File: `docs/build/gf-s4-plan-record/meterline/sample_readings.csv`. Owner-written, committed byte for byte:
  18 lines, 710 bytes, ASCII/UTF-8, LF only, trailing newline, starts with `buil` (not `PK`); `file`: "CSV ASCII text".
- **sha256: `5a9a98a6f7f5f8fc4be69f86aea4c3eb17ab9715a9e66da09fcc00a37db6c7f7`**
- Paragraph for the master prompt: `docs/build/gf-s4-plan-record/meterline/master-prompt-csv-paragraph.md`
  (sha256 `b3615f4d7d2cf1610c6f3b03129f44805d43c51ef3b7ba5ee565bcc2411d65a8`).
- **The sample CSV fixes the file FORMAT only:** the columns `building_id, meter_id, timestamp_utc, reading_kwh`, their
  order, ISO 8601 UTC timestamps, and `reading_kwh` as the energy used in a 15-minute interval. It **deliberately leaves
  undefined** the deduplication key semantics, the lateness window, and the meaning of "strange" and "spike". The file
  carries no anomaly labels, expected outputs or comments, and no expected-output file exists.

## 5. Plan items these decisions change (the plan text is not edited)

| Plan location | Plan says | Now |
|---|---|---|
| 3, arm b | "ECCode default": export of `650df34`, project created by `init` with defaults; `gf.runtime.enforce` absent | Export of `a530ae1` (engine = `35d5cc9`). The operator script runs `init` with `--stack python-fastapi-postgres-worker-compose` and writes `gf.approval.auto` with the section 3 budget. `gf.runtime.enforce` absent. Label: "default engine + compose profile + auto-approval". |
| 3, arm c | "as b" plus `gf.runtime.enforce` | As the new arm b, plus `"gf": {"runtime": {"enforce": true}}`. All three settings are written by the operator script. |
| 3, arm a | bare, plus master prompt and attachment | Unchanged, except that the attachment is now `sample_readings.csv`. Arm a has no approval mechanism, so O-1 does not apply to it. |
| 3, "Held equal" | same attachment | The attachment is `sample_readings.csv` (sha256 above) for all three arms. |
| 2.3 | proposed file `sample-readings.csv`, columns `meter_id,building_id,timestamp,reading_kwh`, hourly values that look cumulative; "deliberately unstated: that `reading_kwh` is a cumulative register, the time zone of a day, the threshold for stops reporting, how broken rows look" | Replaced by the owner's file (section 4): different name, column order and column name (`timestamp_utc`), 15-minute cadence. The paragraph **states** that `reading_kwh` is per-interval energy, so the "cumulative register" probe no longer applies. Timestamps are stated to be UTC, but the time zone of a "day" for daily usage is still unstated. The stops-reporting threshold and the look of broken rows are still unstated. |
| 2.1, 2.2 | frozen master prompt texts | The CSV paragraph is to accompany the master prompt. Its text is fixed (section 4). How it is joined to the frozen prompt text, and the resulting prompt sha256, are not recorded yet (Q-1). |
| 6, M2 (requirements-quality probes) | includes the cumulative-register probe from 2.3 | That probe is withdrawn by the paragraph. The other 2.3 probes stand. |
| 6.1, Not counted | "automated approvals done by an engine mechanism within a pre-set budget" | Now applies to arms b and c, budget as in section 3. **New rule:** exhausting the auto-approval budget is a hard stop and counts as a human intervention (Q-2). |
| 6.1, decision table | "ECCode gate waits for owner approval → approve iff …" | With auto-approval on, the gate waits only when the approver refuses (GF-AUTO-0..4). Budget refusals (GF-AUTO-2) follow the new rule above. For the other refusals, see Q-3. |
| 9.2 | per-arm ceilings 170M tokens and 8 h (build phase) | The auto-approval budget uses the same numbers, but it measures a subset: tokens recorded by closures, and wall clock since `init` (Q-2). |
| 10.1 M4, M7 | bases written for `650df34` | As addendum 1 section 4 says. O-2 = yes, so the M7 basis "no compose/worker in the engine's stack profile" is obsolete. The M4 prediction is not rewritten. Reports state the arm config with the arm b label from section 1. |
| 11 P-2, P-5, D-4 | open | Decided: P-2 on in b and c, P-5 compose profile in b and c, D-4 owner file attached. |
| Addendum 1, section 2 (test status) and section 3 (O-1..O-3) | 1831/1761/0/70 with a Python-environment explanation; O-1..O-3 open | Superseded by sections 1 and 2.1 of this addendum. |

## 6. Prerequisites still open before Stage 1 (list only; none started here)

- P-4: the bare-arm transcript intervention counter, and its test on the S3 record.
- P-7: whether a docker daemon runs in the Stage 1 container.
- P-8: `criteria.py`, `repro-union.py`, adapter checklist, adapter smoke for `tools/deploy-check.sh --smoke`, coin-flip
  seed, contamination scan list.
- The hidden acceptance suite and its manifest (plan section 4, Appendix A). Not authored or designed here.
- The operator script that, for arms b and c, runs `init` with the compose profile and writes `gf.approval.auto` (and
  `gf.runtime.enforce` for c), then builds the sandbox and runs the arms in coin-flip order.
- The final master prompt bytes (prompt + CSV paragraph) and their sha256 (Q-1).
- Record `claude --version` for the arms.
- Push of `s4-freeze/base` (awaiting owner authorization).

## 7. Open owner questions

- **Q-1.** How is the CSV paragraph joined to the frozen prompt 2.2 (and 2.1 in Stage 2)? For example: appended after
  one blank line. The answer fixes the master prompt bytes and sha256 for all three arms.
- **Q-2.** The auto-approval budget equals the per-arm ceilings of plan 9.2. Plan 6.1 logs a ceiling stop as no
  intervention, but under O-1 an exhausted auto-approval budget counts as one. The approver counts only closure-recorded
  tokens, and wall clock from `init`. So the operator's arm ceiling will usually be reached first, except for the
  12-slice limit. Which rule applies when both are reached, and does the 12-slice stop count as an intervention?
- **Q-3.** For approver refusals other than the budget (GF-AUTO-0, -1, -3, -4), does the 6.1 row "ECCode gate waits for
  owner approval → approve iff the engine's own checks report no problem" apply, as a counted approval?
- **Q-4.** Which `--name` and `--idea` values does the operator script pass to `init` for arms b and c?
- **Q-5.** Prompt 2.2 says "Flag readings that go backwards". With `reading_kwh` defined as per-interval energy, should
  what "go backwards" means stay undefined, like "strange" and "spike"?

## 8. Deviations and environment (this session)

- **E-1 (environmental).** Container recycled (host boot 18:59:17Z). bwrap was absent and was installed: apt
  `bubblewrap` 0.9.0-1ubuntu0.3. The install command had an `apt-get update` retry fallback, and the log does not record
  whether the fallback branch ran.
- **E-2 (environmental).** The Python test venv was recreated at `/root/.cache/eccode/phase3-venv` with binary wheels
  only, pinned as in `docs/build/handoff-s3.md`, plus `coverage` (named by a skip reason). Full freeze in `install.log`.
- **E-3 (environmental).** The Mealie bare mirror (900M) was created after the full run with the engine's own clone
  command. Only `tests/mealie.test.js` was run against it. The full suite was not re-run.
- **DV-1.** The committed metering helper could not be called blindly (its session id and paths are hard-coded), so
  snapshot 00 was computed inline from this session's transcript. Raw: all-processed 116,862 (input 2, cache-read
  65,316, cache-write 50,041, output 1,503); the S3 IEQ formula gives 76,599.9. Later snapshots use
  `docs/build/gf-s4-freeze-record/tools/snap6.js`, a sed copy of `snap5.js` with the arithmetic unchanged.
- **DV-2.** The test total (1862) differs from both reference runs. Section 2.1 explains the difference; it is not a
  regression.
- **DV-3.** This session found that the earlier explanation of the +10 skips was wrong (section 2.1). It is recorded
  here and not corrected in the earlier files.
- No existing test, frozen file, hidden suite, manifest, prediction file or record under `docs/build/gf-s3-record/`
  was modified. The S3 hidden-suite manifest verified 4/4 OK at the start. No arm, comparator or Meterline build was
  run. No Meterline hidden test was written, read or designed.
