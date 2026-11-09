# S4-PREREQ evidence (n=1 runs): D-2, D-1 and D-6 built red-then-green; 0 failures in a clean full run; gf-pin failure not reproduced in 15 reruns

**Conclusion.** The three prerequisite items are opt-in and leave the v1 default path unchanged. All 33 new tests pass,
and no existing test was edited. The earlier `gf-pin` failure did not reproduce in 15 sequential reruns at either
commit. Its mechanism points to the container's commit-signing service, not to this slice. One clean full run had
**0 failures**, but **10 more skips** than the baseline, because the Python test environment was absent in a recycled
container. Those 10 tests were therefore not exercised. The spend forecast PS-3 was refuted.

Branches: `s4-prereq/engine` (`e72497a`, `caeafec`, `35d5cc9`, `9faeed2`, all on origin; plus a local-only close-out
commit `8cff0f9`, superseded by this branch) and `s4-prereq/finish` (from `9faeed2`; local). Proposed Stage 1 ECCode
base: the head of `s4-prereq/finish`, whose engine content is identical to `35d5cc9` (addendum:
`docs/build/gf-s4-plan-addendum-1.md`). Frozen predictions: `docs/build/gf-s4-prereq-record/predictions.md`, unchanged
since `e72497a`. Every count is from one run (or the stated number of reruns) in one container. No significance is
claimed.

## 1. Summary

| Run | Commit | Tests | Pass | Fail | Skip | Evidence |
|---|---|---|---|---|---|---|
| Baseline run 1 (container as delivered) | `1240da2` | 1798 | 1731 | 1 | 66 | `evidence/baseline.txt` (A1, no bwrap) |
| **Regression baseline** (bwrap 0.9.0 installed) | `1240da2` | 1798 | 1738 | 0 | 60 | `evidence/baseline.txt` |
| Previous session final run | `35d5cc9` | 1831 | 1770 | 1 | 60 | log not committed (previous session's scratchpad) |
| **This session, clean full run** | `s4-prereq/finish` = `9faeed2` | 1831 | **1761** | **0** | **70** | `evidence/finish/full-run-summary.txt`, `full-run-skipped-tests.txt` |
| Expected for zero regressions | | 1831 | 1771 | 0 | 60 | brief |

`scripts/validate-toolkit.js`: passed (`evidence/finish/validate-toolkit.txt`).

**The difference from the expected counts (pass −10, skip +10) is explained by the environment, but not proven
harmless.** The container was recycled before this session (host boot 15:24:04Z), and bwrap was absent again. The
Python environment the earlier runs had is also gone: `/root/.cache/eccode/phase3-venv` is absent, `python3` has no
`fastapi`, and `ECCODE_PYTHON` is unset (`evidence/finish/environment.txt`). 46 of the 70 skips say "no interpreter
with fastapi …". The other 24 say "no Mealie checkout" or "set ECCODE_MEALIE_VALIDATE=1", as in the baseline. The
committed baseline name list (`baseline-test-names.tsv`) marks every test `ok` and does not distinguish skips, so the 10
newly skipped tests **cannot be named from committed evidence**. Their regression status is **unverified** in this run.
No test that ran failed. No second full run was made (brief 2.4). To close this, install the Python test environment
and run the suite once more.

### 1.1 gf-pin classification: (c) inconclusive by the brief's definition; the evidence points to (a), environmental

| Reruns of `node --test tests/gf-pin.test.js` (sequential) | Result |
|---|---|
| 5 at `1240da2` (read-only worktree) | 31/31 pass ×5 |
| 5 at `9faeed2` (read-only worktree) | 31/31 pass ×5 |
| 5 at `9faeed2` with `env -u DEBUG` | 31/31 pass ×5 |
| Full run on `s4-prereq/finish` | 0 failures |

Evidence: `evidence/finish/gf-pin-reruns.txt`. `DEBUG` was **unset** in the original environment.

- **Not reproduced.** It did not fail at `1240da2`, and it did not fail with `DEBUG` set (DEBUG was never set). Neither
  trigger for (a) was observed, so the strict classification is (c). It also did not fail consistently at `9faeed2`,
  so it is not (b).
- **Mechanism.** The test `GF-CONF-1 negative: pinning with a reason under 10 characters …` (generated in the loop
  at `tests/gf-pin.test.js:71`) builds its fixture with `gfProject()`. That fixture runs a plain
  `git commit` (`tests/helpers.js:51`). The global `~/.gitconfig` sets `commit.gpgsign=true`, `gpg.format=ssh` and
  `gpg.ssh.program=/tmp/code-sign`, which is a symlink to the environment's signing service. So every fixture commit
  depends on that service. A probe commit made the same way in this session exited 0 with empty stderr and a `gpgsig`
  header.
- **The two reported error texts are one failure.** The previous session saw "signing server returned status 503 …
  fatal: failed to write commit object". This brief quotes "Debug: Namespace set to "git" (ignored)". Both fit a
  failed signing call whose stderr git passes through. "Namespace set to" occurs nowhere in `lib/`, `bin/`, `scripts/`,
  `tests/` or `tools/`. The grep found no literal in the signing binary, so its exact origin inside the service is
  **not confirmed**.
- **Slice code is not on the path.** `git diff 1240da2 9faeed2` touches none of `lib/greenfield/pin.js`,
  `lib/greenfield/wrap.js`, `tests/helpers.js`, `tests/fixtures/` or `tests/gf-pin.test.js`. It does touch
  `lib/greenfield/audit.js` (+13 lines, the stack-profile section), but the failing test does not call `audit`.
- The test was not edited.

## 2. Per-item red/green evidence (logs in `docs/build/gf-s4-prereq-record/evidence/`)

| Item | Red | Green | Files |
|---|---|---|---|
| D-2 approver + intervention counter | 0/20 (against a stub) | 20/20 | `d2-red.log`, `d2-green.log`; `tests/gf-approval.test.js` |
| D-1 compose profile | 1/13 (the one pass is the pre-existing "unknown profile refused" guard) | 13/13 | `d1-red.log`, `d1-green.log`; `tests/gf-profile-compose.test.js` |
| D-6 static | n/a | `bash -n` OK; shellcheck 0.9.0, 0 findings | `d6-static.log` |
| D-6 behaviour | worker healthcheck removed → exit 2 | `--dry-run` with a dead `DOCKER_HOST` → exit 0; live mode with no daemon → exit 1 "daemon not reachable" | `d6-dry-run.log` |
| New tests at `9faeed2` (this session) | | 33/33 | `node --test tests/gf-approval.test.js tests/gf-profile-compose.test.js` |

## 3. Gates and protected paths (re-checked this session)
- `9faeed2` is on `origin/s4-prereq/engine`, and `1240da2` is reachable from `origin/s4-plan/experiment`.
- S3 hidden suite: 4/4 OK.
- Isolation tests after the bwrap install: `tests/gf-iso-sandbox.test.js` 18/18.
- `git diff --stat 1240da2 HEAD` on the frozen plan, `gf-s3-record`, `gf-s3-1-record`, `gf-s3-comparator-record` and
  `tests/gf-flow.test.js` is empty.
- `predictions.md` has no diff since `e72497a`.
- `git diff --name-status 1240da2 HEAD -- tests/` shows only `A tests/gf-approval.test.js` and
  `A tests/gf-profile-compose.test.js`, so no existing test was edited.
- `git diff 1240da2 HEAD -- lib/greenfield/runtime.js` is empty, so the `gf.runtime.enforce` default is unchanged.
- `ECCODE_SEED_KEY`: set.

## 4. Predictions vs outcomes (predictions not rewritten)

| Id | Verdict | Note |
|---|---|---|
| P2-1 | Confirmed (caveat) | Red was against a stub. |
| P2-2 | Confirmed | Default config: 0 approvals, GF-AUTO-0 recorded; CLI `approve` exits 2. |
| P2-3 | Confirmed | Attempts beyond maxSlices refused 3/3; a forged over-budget event is reported. |
| P2-4 | Confirmed | One test per precondition. |
| P2-5 | Confirmed | Counter exact on a synthetic record. |
| P2-6 | Inconclusive by design | No arm ran. |
| P1-1 | Confirmed | Default `cfg.gf` unchanged; `gf-flow.test.js` untouched and green. |
| P1-2 | Confirmed | `docker compose config` exits 0 without a daemon. |
| P1-3 | Confirmed | 4/4 healthchecks; missing or disabled ones refused. |
| P1-4 | Confirmed | Ownership map exact; uncovered map refused. |
| P1-5 | Confirmed | Unknown profile refused with GF-INIT-1. |
| P1-6 | Inconclusive by design | No daemon-dependent check was run. |
| P6-1 | Confirmed | `d6-static.log` |
| P6-2 | Confirmed | `d6-dry-run.log` |
| PS-1 | **Confirmed for every test that ran; not fully verified** | 0 failures in the clean run; `gf-pin` not reproduced in 15 reruns. 10 tests skipped for lack of the Python environment (section 1). |
| PS-2 | Confirmed | Section 3. |
| PS-3 | **Refuted** | Forecast 5-15M; 17,758,382 tokens at snapshot 01 of session `7d8762f2` (section 7). |

## 5. Known gaps and limits
- **Approver:** it approves only closed slices. It does not close slices, approve G1 gates, accept limits, defer
  findings or amend contracts. Its token budget relies on the orchestrator-recorded closure accounting, which it does
  not meter itself. It has been **exercised only by tests on synthetic records, never on a real build**.
- **Counted interventions** (restart, unblock, correction) appear only if the operator records them.
- **Profile:** it generates scaffolding only: no application logic, images pinned by tag (not digest). It has **never
  been run with a docker daemon** (P-7 open). The runtime guard is untested on its `services/api` layout. Scaffold
  coverage is not enforced when a breakdown is submitted; the audit after seal does check it.
- **Not built:** the bare-arm transcript counter (P-4), the adapter smoke for `deploy-check.sh --smoke`, and rootless
  docker (sketch only).
- R-1, R-2, R-4 and R-5 remain open (D-3).
- **This run:** 10 tests unexercised (section 1). The full-run log is summarized in the record, not committed in full.

## 6. Deviations
Previous engineering session (`7d8762f2`):
1. `snap4.js` was not at `tools/`. Snapshot 00 was taken by inline arithmetic. The helper was later copied to `snap5.js`
   (config-only diff).
2. A red baseline (A1, no bwrap) was resolved without asking, by installing bubblewrap 0.9.0 (environment only).
3. `profiles.js` was drafted before its red run. The red run was against a stub.
4. A full run was killed mid-run when D-1 edits landed during it. No result from it was used.
5. `deploy-check` live mode was invoked twice on an unbuilt scaffold with a dead `DOCKER_HOST`. Nothing was built. A
   teardown fix followed.
6. The D-2 CLI wiring landed in `35d5cc9`, so `caeafec` alone fails 1 of 20.
7. shellcheck was installed via apt.
8. R9 stop: context 312,915 > 300K before Steps 5-7.
9. The final full run had 1 failure (`gf-pin`), possibly overlapping other activity; investigated here.
10. The owner authorized and received a push of `s4-prereq/engine` (head `9faeed2`).

Close-out work in this same session (`c84deff9`), before this brief:

11. A close-out commit `8cff0f9` was made **locally** on `s4-prereq/engine` (an addendum and report, not pushed). It is
    superseded by this branch. Its addendum text was reused and revised here.
12. **This brief arrived as a continuation of session `c84deff9`, not a brand-new session.** Snapshot 00 for this brief
    was cumulative (2,652,655 tokens) and was taken with the session's existing scratch helper. Its latest-message
    cache-read was 182,670 (PASS).

This brief (S4-PREREQ-B):

13. bwrap was absent (the container was recycled). bubblewrap 0.9.0-1ubuntu0.3 was installed via apt (environment
    only). Isolation tests: 18/18.
14. The Python test environment is absent and was not re-created, which gives +10 skips (section 1). Not fixed, to
    avoid a second full run.
15. Read-only worktrees were created under the session scratchpad at `1240da2` and `9faeed2`.
16. A `strings` search of the signing binary produced a large output in context. It found no literal match.
17. The previous session's error text (signing 503) and this brief's ("Namespace set to git") differ. Both are
    recorded, and section 1.1 treats them as one failure.

## 7. Spend (all-processed tokens / IEQ = input + 0.1·cache_read + 1.25·cache_write + 5·output; relative unit)

| Session / span | Tokens | IEQ | Source |
|---|---|---|---|
| `7d8762f2` snapshot 00 | 258,261 | 121,117.4 | `snaps/00-inline.json` |
| `7d8762f2` snapshot 01 | 17,758,382 | 2,521,042.8 | `snaps/01.json` |
| `7d8762f2` handoff (02, as reported; transcript not in this container) | 22,266,418 | 3,017,359.2 | handoff |
| `c84deff9` earlier close-out (to snapshot "prereqB-00") | 2,652,655 | 492,069.5 | scratch copy of `snap5.js` |
| `c84deff9` this brief, B00 → B02 (before this report) | 5,922,153 | 711,172.7 | same helper; B02 cache-read 227,263 (PASS) |

The sessions are reported separately. The final figure for this brief is given in the commit's final message.

## 8. Reproduction
```
git fetch origin s4-prereq/engine s4-plan/experiment
git merge-base --is-ancestor 9faeed2 origin/s4-prereq/engine && git merge-base --is-ancestor 1240da2 origin/s4-plan/experiment
(cd docs/build/gf-s3-record/hidden-suite && sha256sum -c ../hidden-suite-manifest.sha256)          # 4/4 OK
node --test tests/gf-iso-sandbox.test.js                                                           # 18/18 with bwrap
for i in 1 2 3 4 5; do node --test tests/gf-pin.test.js; done                                      # at 1240da2 and 9faeed2 worktrees
for i in 1 2 3 4 5; do env -u DEBUG node --test tests/gf-pin.test.js; done
node --test tests/gf-approval.test.js tests/gf-profile-compose.test.js                             # 33/33
npm test; node scripts/validate-toolkit.js                                                         # 1831/1761/0/70 here
git config --show-origin --get-regexp 'gpg|commit.gpgsign'                                         # signing path
git diff --stat 1240da2 9faeed2 -- lib/greenfield/pin.js lib/greenfield/wrap.js tests/helpers.js tests/fixtures tests/gf-pin.test.js  # empty
git diff --name-status 1240da2 HEAD -- tests/                                                      # 2 added files only
git diff --stat e72497a HEAD -- docs/build/gf-s4-prereq-record/predictions.md                      # empty
bash -n tools/deploy-check.sh && shellcheck tools/deploy-check.sh
```
