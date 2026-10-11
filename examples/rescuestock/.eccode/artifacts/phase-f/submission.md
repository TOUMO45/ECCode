# Phase f-compensation: submission

Author: delivery-lead. Gate: `phase:f-compensation`. Date: 2026-10-11. Run: `run-mv43scns-01e8c28e`. Iteration 1.

- **Plan:** `.eccode/artifacts/plan/plan.json`, phase `f-compensation` ("F: replanning, compensation and restart recovery").
  - **Plan criteria:** RS-13, RS-15, RS-17, RS-22, RS-26, RS-32(a), RS-37, RS-38, F-TR-2, F-TR-6, plus "npm test and npm run test:browser pass".
  - **Also mapped below, at the orchestrator's request:** RS-21 and RS-25 (phase E criteria whose code paths f2 changed), and the follow-ups assigned to F: FU-36, FU-38, FU-41, FU-42, FU-43, FU-45 (and FU-19, FU-34, FU-39, FU-40, which F also touched).
- **Reviewers:** **technical + security.** Phase F moves money: compensation, refunds, voids, lease takeover, admin `refund_order` and forced reset.
- **Tree:**
  - My first seven runs were on HEAD `545e5ff`, **clean**, tree digest `8687eb08…` (the same digest as f4's final runs).
  - While I worked, the orchestrator committed `d6cc385` and `8542265`. They hold the rework-5 review and its iteration 2, which changes only `test/api/admin-basic.test.js` (+9/−3, a rework-5 file), plus my `followups.md` draft.
  - The later commit `aab23e6` changes record files only, so its code equals `8542265`.
  - I re-ran `npm test` on HEAD `aab23e6` (digest `a9aba38c…`; see the runs table). **No phase F file changed** between `545e5ff` and `aab23e6`.
- **Phase base:** `bf1a723`, the claim base of f2 and f3.
  - Code diff `bf1a723..8542265`: 61 files, +9,646/−85.
    - `src`: 5 files, +219/−39, all f2's.
    - `public`: 9 files, +236/−33, f3's.
    - `test`: 47 files, +9,191/−13.
  - Two of those files are rework-5's (`test/api/lost-response.test.js`, `test/api/admin-basic.test.js`), under their own gate. The other 59 are phase F's.
- **Follow-ups:** `.eccode/artifacts/plan/followups.md` gains the section "Added after phase F". It is submitted with this file. It contains:
  - the status of FU-19, 33–36, 38–43 and 45;
  - new FU-46 and FU-48..FU-51 (FU-47 was withdrawn, settled by the rework-5 review);
  - verification-report items 16–19.
- **Artifacts:** the engine adds every phase task's declared files (59) to this file and `followups.md`. See "Artifact coverage".
- **Safety:**
  - `RS_LIVE_MODEL` and `RS_LIVE_PAYPAL` were never set by me or, per their handoffs, by any engineer.
  - No live suite was run and no PayPal host was contacted. Every API and integration run goes through `test/helpers/net-guard.js` (127.0.0.1 only).
  - Every full-suite run of mine ran inside `flock /tmp/rescuestock-suite.lock` (`dec-mv43s14b-01addb18`).

## What the phase delivers

| Task | Owner | Handoffs | Engineer's runs (cited in the handoffs) | Delivered |
|---|---|---|---|---|
| f1-supersession-refusal-expiry | backend-engineer | ho-mv40suhb-012306c3 | **Plan command:** 40/40, ev:ev-mv40ospd-01dc6128.<br>**Browser:** 10/10, ev:ev-mv40rqyo-0197eef2.<br>**`npm test`:** **red by 2**, ev:ev-mv40r6im-01e3bb9b. The two stale tests in f2's area were fixed by rework-5.<br>**Mutation:** 30 mutants in a scratch copy, **no ev id**. 26 killed; 4 survived as equivalent through layered guards (expiry SELECT/CAS filters, the ignored return value). | **No source change.** The supersession, refusal, expiry and drain code already existed (c3, e2, e4); f1 found no defect, so no test failed first.<br>**Four test files, 40 tests:**<br>- `supersession.test.js` (RS-13, RS-32 supersession half);<br>- `replan-queue.test.js` (F-TR-2);<br>- `supplier-refusal.test.js` (RS-17 [D], RS-32 refusal half);<br>- `reservation-expiry.test.js` (+5 RS-15 tests). |
| f2-compensation-takeover-admin | backend-engineer | ho-mv41a3s6-0138e24d | **Plan command:** 56/56, ev:ev-mv40mlp2-015002c8.<br>**Failing first** on the base source (scratch copy): 29 pass / 27 fail, ev:ev-mv40r2b6-0183d269.<br>**Mutation:** **25 mutants, 25 killed** (incl. the reviewers' M6), ev:ev-mv418etg-01b71dfe.<br>**`npm test`:** **red by 2** (the stale tests), ev:ev-mv40pczl-017d0a64.<br>**Browser:** 10/10, ev:ev-mv40qizh-0178646b. | **`calls.js`:** FU-45 (EXPIRED read back after a refused void = settled); FU-42 (the refund reads `supplier_orders.total_cents`).<br>**`saga.js`:** FU-41(a) `readBeforeResend`; an archived plan is never resumed; `releaseIfSettled` ignores a reservation with no live operation.<br>**`reconciler.js`:** exported, budgeted `readResolvePass`; the takeover skips plans whose operations are all archived.<br>**`admin.js`, `routes/admin.js`:** SEC-11 forced reset (voids, one 30 s read-resolve pass, a `stranded` list in the response and the audit); any reset closes `reconciling` reservations without restock; `refund_order` sends after commit (Sender table), keeps its `denied` audit row, and answers 404 for an archived operation.<br>**Five test files, 56 tests.**<br>**Defects found and fixed:** SEC-11 missing; the reset left `reconciling` open (later double restock); an archived executing plan could be taken over and marked executed; `refund_order` not sent; the `denied` audit row rolled back. |
| f3-frontend-recovery | frontend-engineer | ho-mv403lay-01fa3938; reset ho-mv42ei0w-019037ae (fixture `labels`) | **First:**<br>- plan 205/205, ev:ev-mv4030ui-01746563;<br>- browser 10/10, ev:ev-mv403f9d-01e25091;<br>- `npm test` red by 2 (the stale tests), ev:ev-mv401efc-01b9dffb, not cited as proof by f3.<br>**Reset:** plan 205/205, ev:ev-mv42dwq7-01826dd5; contracts 81/81, ev:ev-mv42eayv-01724429. | **Recovery UI:**<br>- the status header (`review` action, `replanning` only while WAIT, "Contact the organiser");<br>- Approve on REVIEW_NEW_PLAN;<br>- "If something fails" with void/refund kinds and a summary line;<br>- truthful Re-plan success lines;<br>- the supplier refuse form;<br>- the admin faults form per kind, and the forced-reset `stranded` list.<br>**Follow-ups:** FU-38 fixture fix; FU-43 notice; FU-40 polling while executed and confirmed.<br>**Files:** 25 recovery contract fixtures; `recovery.test.js`; scan/unit updates. 36 files in all. |
| f4-restart-takeover-browser | test-engineer | ho-mv43p246-01228012 | **Plan command (final tree):** `npm test` 2267/2259/0 fail/8 skipped and browser 14/14, ev:ev-mv43mqlq-01b00d12. This was a re-run once after the FU-33 race in ev:ev-mv43j15k-01209f8b.<br>**Multi-process files ×4 at concurrency 4:** 28/28, ev:ev-mv43nz3i-015ad25b.<br>**`contracts.test.js`:** 81/81, ev:ev-mv43ohq1-01bc3f1c.<br>**Bite proof, recorded:**<br>- M1 ev:ev-mv41xci3-014ccf69;<br>- M1b ev:ev-mv41zi15-015b8359;<br>- M3 ev:ev-mv41znig-013106f7;<br>- M5b ev:ev-mv4221p9-01d81f4b;<br>- M6 ev:ev-mv4207ii-01b07056;<br>- M7 ev:ev-mv420ljh-012e3426;<br>- M8 ev:ev-mv4245d2-011141cc;<br>- M9 ev:ev-mv424wf5-0141f67c;<br>- M10 ev:ev-mv425a8b-017ed7a1;<br>- **M5 survived** ev:ev-mv42027q-01074419 (a redundant backstop). | **Real OS processes on one SQLite file:**<br>- `rs26-restart.test.js` (2 tests, SIGKILL via the freeze hook);<br>- `lease-takeover.test.js` (ARCH-26 variants A and B, SIGSTOP/SIGCONT, lease 1500 ms, timeout 500 ms, interval 200 ms);<br>- `return-crash.test.js` (F-TR-3 a, b, c).<br>**`contracts.test.js`:** a recovery table drives the real routes into 23 states, checked against f3's fixtures (57 → 81 tests).<br>**Browser:** `refusal.test.js` (RS-17) and `journey-replacement.test.js` (RS-32(a)), each at 360 and 1280 px.<br>**Helpers:** `saga-flow.js`, `recovery-flow.js`, `browser/helpers/recovery.js`. |

**Rework-5.** The two red tests in f1's, f2's and f3's full runs were made stale by behaviour the spec requires, which f2 added (FU-41(a) and the Sender table refund row).
- **Opened:** by decision `dec-mv41b2g0-018dc143` (test-engineer, test-only, commit `0c7b37b`).
- **Reviewed:** `sub-mv43raev-013fd872` was reviewed as `rev-mv44amic-012cf420`, changes requested:
  - **TR-R5-1 (major):** the `refund_order` subtest's `notEqual 'refund_requested'` let mutant MB pass the whole suite. MB changes `calls.js` L296 so that a provider-rejected refund is recorded as `refunded`.
  - **TR-R5-2 (minor):** the citation.
- **Iteration 2:** `ho-mv44fohe-01197e16`, in commit `8542265`. It pins `refund_failed` and `last_error_code INVALID_RESOURCE_ID` and awaits re-review.
- **Relevance to phase F:** the `rejected` refund mapping lives in f2's `calls.js`, but **no f2 test reaches it**. The rework-5 test is the only one (followups item 19). The phase F reviewers may want an f2-side test.
- **Coverage of my runs:** my runs on `545e5ff` include iteration 1; my last `npm test` (on `aab23e6`, code = `8542265`) includes iteration 2.

## Delivery-lead runs (the first seven on `545e5ff`, clean, digest `8687eb08…`; the last on `aab23e6`, digest `a9aba38c…`)

| Run | Result | Evidence |
|---|---|---|
| f1 plan command, verbatim | **40 tests, 40 pass, 0 fail** | **ev:ev-mv43ueu9-01c69050** |
| f2 plan command, verbatim | **56 tests, 56 pass, 0 fail** | **ev:ev-mv43ut0r-0139a5a9** |
| f3 plan command, verbatim | **205 tests, 205 pass, 0 fail** | **ev:ev-mv43uw5a-01419a34** |
| `flock … npm test` | exit 0. **2267 tests: 2259 pass, 0 fail, 8 skipped, 0 todo, 0 cancelled.** ECCODE_EVAL 200/200. NFR5: **p95 60.2 ms** (p50 2.9 ms) over 7130 requests; suite 103.7 s. The RS-39 timer test (FU-33) and SEC-B-1 both passed. | **ev:ev-mv43x96q-018bb5f5** |
| `flock … npm run test:browser` | exit 0, **14/14**, 0 skipped. RS-03 (3), FU-17 (2), RS-31(a) (2), RS-33 (3), **RS-32(a) (2: 360x800, 1280x800)**, **RS-17 (2: 360x800, 1280x800)**. | **ev:ev-mv43yetb-016478e8** |
| f4 plan command, verbatim, inside the lock | **FAILED (exit 1)**. `npm test` part: 2267 tests, 2257 pass, **2 fail**, 8 skipped; the browser part did not run (`&&`). The two failures are below. | **ev:ev-mv445oiq-01166891** |
| f4 plan command, verbatim, inside the lock, **re-run once** | exit 0.<br>`npm test` part: **2267/2259/0 fail/8 skipped**, ECCODE_EVAL 200/200, p95 70.3 ms (p50 3.8 ms) over 7130 requests, 115.3 s.<br>Browser part: **14/14**. | **ev:ev-mv44c150-01e43728** |
| `flock … npm test` on HEAD **`aab23e6`** (code = `8542265`: rework-5 iteration 2 in `admin-basic.test.js`), digest `a9aba38c…` | exit 0. **2267 tests: 2259 pass, 0 fail, 8 skipped, 0 todo.** ECCODE_EVAL 200/200; p95 61.0 ms (p50 2.9 ms) over 7279 requests; 102.0 s. The pinned `refund_order` subtest passes. | **ev:ev-mv44j3fw-01fb2787** |

### The red f4 run (ev:ev-mv445oiq-01166891): failing tests and cause

- **Failure 1:** `test/api/uploads-retention.test.js:677`, "RS-39: startApp removes an expired image at startup and another one on the next tick".
  - The file still existed when its row was gone.
  - This is the known FU-33 race (`dec-mv3tqbn4-01d43152`): the sweep deletes the row, then unlinks the file.
- **Failure 2:** `test/timing/planner-sec-b1.test.js:58`, SEC-B-1 "the seeded catalog shape … stays fast".
  - One of 1,008 planner calls took **327.9 ms** against the per-call limit of 100 ms (line 70).
  - This is the same test that failed at 186.9 ms in ev:ev-mv43keu0-0102c57c during rework-5. That run is the reason for `dec-mv43s14b-01addb18` and FU-46.
- **Why both failed: the whole suite ran 2.1× slower.** I compared the per-file durations of this run with my green `npm test` ten minutes earlier (ev:ev-mv43x96q-018bb5f5):
  - the 876 shared top-level entries took 780.8 s against 339.8 s (2.30×);
  - the median ratio over the 147 entries longer than 0.5 s is **2.13**.
  - Every file was slower, so the cause is CPU taken away from the suite, not one test. Both failing tests use wall-clock limits.
- **The lock worked:**
  - My run waited about 107 s for the technical reviewer's locked `npm test` (ev:ev-mv440vx2-01e97c0b, 17:38:55–17:41:27).
  - It then ran alone, about 17:41:27–17:45:10.
  - The reviewer's next locked suite (scratch copy `tr-r5/mb`) started only at 17:45:11.
  - No other evidence was recorded in that window, and no other test directory was written then.
- **What took the CPU is not proven:**
  - The VM reports **host CPU steal**: 135.8 s accumulated from boot to 17:45:45.
  - A sampler I started right after the red run measured steal at **about 14% of the 4 CPUs** from 17:45:37 to 17:46:39.
  - During my green re-run (17:47:28–17:50:07) it was **about 1%**, and that run was back to a 1.12× ratio.
  - Steal is therefore a likely cause, but I did not measure it during the red run itself.
  - Unrecorded processes of another agent are the other possibility; the decision only locks full suites.
- **Decision for this gate:**
  - The re-run is green, and neither test is in a phase F file.
  - Neither failure involves phase F code: the retention sweep is d3's, and the planner is b2's.
  - Both tests are already routed: FU-33 to phase G, SEC-B-1 as FU-46.
  - I cite both runs.

### Skipped tests (8 in `npm test`, 0 todo)

These are the same 8 as phase E (see `.eccode/artifacts/phase-e/submission.md` › "Skipped tests"):
- seven fake-harness OAuth and wire-mapping cases of `provider-contract.test.js`;
- `RS-03: fake maps busy to PROVIDER_BUSY …`.

None belongs to phase F. **`npm test` grew from 2109 tests at phase E's approval to 2267** (rework-5 changed no counts), **and the browser suite from 10 to 14.** Every phase F test passes, and none is skipped.

## Criteria → task → tests → evidence

Counts are passing **leaf** tests (YAML type `test`) in my `npm test` run ev:ev-mv43x96q-018bb5f5 plus my browser run ev:ev-mv43yetb-016478e8, whose names contain the id. They include earlier-phase and frontend tests with the same id. The named tests are the phase F ones that carry the criterion. No test with any of these ids failed or was skipped.

**Real or simulated:**
- **[D]** means the fake provider (`src/payments/fake.js`, DB-backed, simulated) on real SQLite with real code.
- **[B]** means real Chromium against the app on `localhost`, with the fake approval page on `127.0.0.1`.
- **Every phase F criterion is verified with the fake provider only.** The LIVE-DEPENDENT parts are named in the last column and in "What is REAL and what is SIMULATED".

| Criterion | Task(s) | Proving tests (file: name, abridged) | Leaf tests passing | Evidence | Fake-only / LIVE-DEPENDENT |
|---|---|---|---|---|---|
| **RS-13** [D] price/fee/ready-time change supersedes; 409 PLAN_SUPERSEDED; voids; release; exact message; not after confirm/claim | f1 | **`supersession.test.js`:**<br>- `RS-13: voids one per authorization, reservation released with one ledger row per item, orders cancelled, 409 PLAN_SUPERSEDED on reserve and execute, then a recalculated version and the exact message`;<br>- `RS-13: a prep fee and a ready-time change read …`;<br>- `RS-13: after the affected supplier confirmed, its price change supersedes nothing …`;<br>- `RS-13: after the execute claim a price, fee, ready-time or withdrawal change (and the admin depletion fault) supersedes nothing …`;<br>- `RS-13: a version that is executing is never selected …`;<br>- `RS-13: another customer's reservation …`;<br>- `RS-13: a withdrawn offer and an on_hand drop supersede with the reason …`.<br>**UI:** `recovery.test.js` RS-13 rows ("Prices changed: review plan vN"). | 14 | ev:ev-mv43x96q-018bb5f5, ev:ev-mv43ueu9-01c69050 | Fake only. The void calls go to the fake. |
| **RS-15** [D] expiry released once; no-op after claim; voids; RESERVATION_EXPIRED; exact message | f1 | **`reservation-expiry.test.js`:**<br>- `RS-15: the tick releases the reservation once, voids every authorization once, the plan is non_executable (RESERVATION_EXPIRED) and the request shows the exact message with the next step REPLAN, not a queued re-plan`;<br>- `RS-15: a second tick is a no-op …`;<br>- `RS-15: two reconcilers racing release it exactly once …`;<br>- `RS-15: claimed (202) and the time runs past expires_at before the first capture: the reservation stays consumed …`;<br>- `RS-15: past expires_at but before the pass, the execute claim is refused 409 RESERVATION_EXPIRED …`;<br>- plus the `RS-15 (part)` tests.<br>**Multi-process:** `return-crash.test.js` `F-TR-3 (b): the reservation expires before the restart …`. | 15 | ev:ev-mv43x96q-018bb5f5, ev:ev-mv43ueu9-01c69050, ev:ev-mv44c150-01e43728 | Fake only. The 29-day authorization expiry (RISK-13) is LIVE-DEPENDENT and not tested here. |
| **RS-17** [D + B] refusal before the claim: voids, release, SUPPLIER_REFUSED, cancelling while a void is outstanding, reason, new plan without the supplier | f1, f3, f4 | **[D]** `supplier-refusal.test.js`:<br>- `RS-17: the refusal is audited, the order refused with its reason, the other order cancelled, both authorizations voided once, the reservation released, the plan non_executable (SUPPLIER_REFUSED)`;<br>- `RS-17: while a void is outstanding the request reads cancelling …; after the void it reads replanning; the drain gives the new plan without the refusing supplier …`;<br>- `RS-17: the exclusion outlasts the next re-plans …`;<br>- `RS-17: after the execute claim the refusal is 409 ORDER_EXECUTED …`;<br>- `RS-17: the refusal reason is validated … (1-300 characters …)`.<br>**[B]** `refusal.test.js`: `RS-17: at 360x800 …` and `… at 1280x800 the refusal reason, the voided authorization, "Review the new plan" and the B + E plan are shown`. | 23 (2 browser) | ev:ev-mv43x96q-018bb5f5, **ev:ev-mv43yetb-016478e8**, ev:ev-mv43ueu9-01c69050 | Fake approval page and fake voids. |
| **RS-21** [D] DENIED/PENDING (phase E criterion, re-verified) | e2, e4; f2 changed `saga.js`/`calls.js` | `authorization-denied.test.js`, `authorization-pending.test.js`: unchanged phase E tests, still green after f2's changes. | 6 | ev:ev-mv43x96q-018bb5f5 | Fake only. The live DENIED/PENDING semantics are LIVE-P1 facts. |
| **RS-22** [D] compensation: refund the first capture, void the rest; `refund_requested → refund_pending → refunded\|refund_failed`; CAPTURE_FAILED; `reconciling → released` with restock; HANDOVER_BLOCKED; PENDING capture with a constant epoch (F-TR-7) | f2 | **`capture-compensation.test.js`:**<br>- `RS-22: the second capture is declined: plan non_executable (CAPTURE_FAILED, supplier B), reservation reconciling then released …`;<br>- `RS-22: compensation after the post-claim authorization check (AUTHORIZATION_EXPIRED) …`;<br>- `RS-22: the refund results decide the release: refunded releases with restock rows, refund_pending keeps the reservation reconciling …, refund_failed escalates …`;<br>- `RS-22: compensation is ONE transaction under the fence …`;<br>- `RS-22: capture_pending across many ticks, with the lease long lapsed: lease_epoch stays 1, nothing is sent …`;<br>- `RS-22: an unknown capture that cannot be read yet … also keeps the epoch constant …`.<br>**UI:** `recovery.test.js` refunding / failed_needs_attention rows. | 10 | ev:ev-mv43x96q-018bb5f5, ev:ev-mv43ut0r-0139a5a9 | **Fake only.** Capture DECLINED/PENDING and refund PENDING/FAILED/COMPLETED are the fake's model of PayPal. **No live file covers RS-22**, although RISK-18's title names it (followups item 18). |
| **RS-25** [D] lost capture response (phase E criterion; FU-41(a) changed its trail) | e4; f2; rework-5 | `lost-response.test.js` (6), including `RS-25: nothing was applied (a timeout): …`, now with the trail `get_authorization, get_authorization, capture, capture` (rework-5). | 6 | ev:ev-mv43x96q-018bb5f5, ev:ev-mv44c150-01e43728 | Fake only. PayPal-Request-Id retention is LIVE-DEPENDENT. |
| **RS-26** [D] SIGKILL and restart keeps everything; takeover after lease expiry; variants A/B, one non-replayed capture per order; return-crash a/b/c (F-TR-3) | f4, f2 | **`rs26-restart.test.js`:**<br>- `RS-26: killed with the first capture applied at the provider and not recorded: the new process reads it, captures supplier B, the plan is executed`;<br>- `RS-26: killed after the first capture was recorded and the second applied …`.<br>**`lease-takeover.test.js`:**<br>- `ARCH-26 variant A (freeze_after_capture_apply): process 2 reads the applied capture … the late result of process 1 is fenced`;<br>- `ARCH-26 variant B (freeze_before_capture_apply): process 2 reads CREATED and sends the capture with the same request id; after SIGCONT the frozen request is a replay`.<br>**`return-crash.test.js`:** `F-TR-3 (a)`, `(b)`, `(c)`.<br>**In-process (f2):** `ARCH-23: the epoch grows by exactly one, in one step, and only when lease_until <= now …`. | 2 RS-26 + 2 ARCH-26 variants + 3 F-TR-3 multi-process (9 ARCH-23, 5 ARCH-26 in all) | ev:ev-mv43x96q-018bb5f5, ev:ev-mv44c150-01e43728; f4: ev:ev-mv43nz3i-015ad25b (×4, 28/28) | Real OS processes and signals, real SQLite; the provider is the fake. Run on **Node 22.22 only**; the spec's 22.5 condition is the user's run. |
| **RS-32(a)** [B] B withdrawn by the stock-depletion fault before B confirms; the 9500-cent A+E plan; old plan superseded, voids, B cancelled; completes through collection with the round-trip assertion | f4, f1, f3 | **[B]** `journey-replacement.test.js`: `RS-32(a): at 360x800 …` and `… at 1280x800 the old plan is superseded with a void, B is cancelled, the A + E plan ($95.00) is bought and collected`.<br>**[D] halves (f1):**<br>- `RS-32 (supersession half): the admin stock_depletion fault withdraws the supplier's offer …`;<br>- `RS-32: refuses every open order of the supplier like the supplier …`;<br>- `RS-32: after the claim the fault changes nothing`. | 18 (2 browser) | **ev:ev-mv43yetb-016478e8**, ev:ev-mv44c150-01e43728, ev:ev-mv43x96q-018bb5f5 | Fake approval page. **RS-32(b)** (PayPal's hosted Sandbox page) is **LIVE-P2, not claimed, Unverified.** |
| **RS-37** [D] reset 409 RESET_BLOCKED while money is held; forced reset per SEC-11; archive, not delete | f2 | **`admin-reset.test.js`:**<br>- `SEC-11: authorized operations of an approved plan are voided at the provider …, rows are archived not deleted`;<br>- `SEC-11: an authorized operation whose plan is executing is voided too …; a capture that is still PENDING is listed as stranded with its provider ids`;<br>- `SEC-11: the read-resolve pass resolves an unknown operation by reading …`;<br>- `SEC-11: the pass is bounded …`;<br>- `SEC-11: the budget is 30 seconds`;<br>- `RS-37: a refused reset (money held, no force) changes nothing …`;<br>- `RS-37: operations that are already archived are ignored by the reconciler …`.<br>**`admin-basic.test.js` (c3):** the RESET_BLOCKED rows. | 7 RS-37 + 7 SEC-11 | ev:ev-mv43x96q-018bb5f5, ev:ev-mv43ut0r-0139a5a9 | Fake only. The voids and reads of a forced reset in the real Sandbox are LIVE-DEPENDENT. |
| **RS-38** [D] UPDATE/DELETE on audit/ledger fails; every reserve, release, expire, consume and restock writes a ledger row; sums equal on_hand and reserved | f2 | **`ledgers.test.js`:**<br>- `RS-38: reserve writes one reserve row per item and abandon one release row per item …`;<br>- `… an expired reservation writes one expire row per item …`;<br>- `… the claim writes one consume row per item …`;<br>- `… a compensation writes one restock row per item when the reservation is released …`;<br>- `… while a refund is outstanding nothing is restocked; two reconcilers … settle restock exactly once`;<br>- `… a supplier stock change writes a restock row (up) or an adjust row (down)`.<br>**`admin-reset.test.js`:** three RS-38 reset cases.<br>**Append-only triggers:** earlier-phase tests, e.g. rework-4's `migrate-006.test.js` › `RS-38: after 006 the append-only triggers still refuse UPDATE and DELETE, and REPLACE cannot re…`, and c3's `supplier-orders.test.js` › `RS-38: onHand changes write ledger rows …`, still green. | 26 | ev:ev-mv43x96q-018bb5f5, ev:ev-mv43ut0r-0139a5a9 | Local only (no provider). |
| **F-TR-2** [D] the re-plan queue never drops an entry and backs off | f1 (e4's drain) | **`replan-queue.test.js`:**<br>- `F-TR-2: a supersession enqueues once; the entry is answered only by the stored run …`;<br>- `F-TR-2: three conflicting attempts: nothing stored, the entry stays with failed_drains 1 …`;<br>- `F-TR-2: the back-off doubles … (15 s, 30 s, 1 min, 2 min, 4 min, then 5 min) …`;<br>- `F-TR-2: after five failed drains the next step is REPLAN …`;<br>- `F-TR-2: a queued entry is data: a reconciler started later (after a restart) drains it …`;<br>- `row 4a: a tick drains at most two due entries …`. | 9 F-TR-2 (+4 row 4a) | ev:ev-mv43x96q-018bb5f5, ev:ev-mv43ueu9-01c69050 | Local only. |
| **F-TR-6** [D] a capture landing after the void intent ends refunded: one capture, one void attempt, one refund call | f2 | **`void-capture-race.test.js`:**<br>- `F-TR-6: capture_lands_after_void_intent: the void is rejected, the read shows CAPTURED, and the operation ends refunded: one capture, one void attempt, one refund call`;<br>- the F-TR-6 atomicity test;<br>- `F-TR-6: the void answer was lost and a capture landed PENDING …`;<br>- `F-TR-6: a webhook capture of a cancelled operation is refunded on the next tick, exactly once` (FU-34). | 7 | ev:ev-mv43x96q-018bb5f5, ev:ev-mv43ut0r-0139a5a9 | Fake only. PayPal's answer to a void after capture is a LIVE-P1 fact. |
| **FU-36** ledger row format of consume/restock | f2 | `ledgers.test.js` › `FU-36: a consume row and a restock row carry the same fields as a reserve row …` | 1 | as RS-38 | Local only. |
| **FU-38** `view-non-executable.json` is the post-claim state | f3 | `recovery.test.js` › `FU-38: a real abandon cancels the orders; "Cancelled — payment did not complete" belongs to the post-claim state only`; the fixture's variant is checked. | 2 | ev:ev-mv43uw5a-01419a34, ev:ev-mv43x96q-018bb5f5 | Fixture and view model. |
| **FU-41** (a) read before re-sending an unknown capture; (b) pause on a new capture_pending/unknown; M6 killed | f2 | **`capture-compensation.test.js`:**<br>- `FU-41(a): before the lease holder sends an unknown capture again it reads the authorization itself; one that is CAPTURED by then is held, never sent …`;<br>- `FU-41(a): the saga's …`;<br>- `FU-41(a): a read that fails under the lease sends nothing …`;<br>- `FU-41(b): an operation that becomes unknown after the takeover and before the resumed run: the saga pauses and sends nothing …`;<br>- `FU-41(b): the same for … capture_pending …`.<br>**Mutants:** M6 killed (ev:ev-mv418etg-01b71dfe); rework-5's mutant (`readBeforeResend` returns `'send'`) turns `lost-response` red (ev:ev-mv43azjb-01f640ff). | 5 | ev:ev-mv43ut0r-0139a5a9, ev:ev-mv43x96q-018bb5f5 | Fake only. **Open question for the reviewers: FU-49.** |
| **FU-42** capture and refund use `supplier_orders.total_cents` | f2 | `FU-42: capture and refund both use supplier_orders.total_cents although payment_operations.amount_cents disagrees` (capture-compensation); `FU-42: the capture and the refund both ask for supplier_orders.total_cents …` (admin-refund-order) | 2 | ev:ev-mv43ut0r-0139a5a9 | Fake only. |
| **FU-43** neutral notice for `not_approved`/`check_failed` | f3 | `recovery.test.js` › `FU-43: not_approved and check_failed show one neutral sentence and no claim about money`; `FU-43: the notice goes once the order has moved on …` | 2 | ev:ev-mv43uw5a-01419a34 | View model; the redirect outcomes are from phase E. |
| **FU-45** EXPIRED after a refused void = settled | f2 | `void-capture-race.test.js`:<br>- `FU-45: the void is refused because the authorization EXPIRED: the operation is voided (settled), void_failed stays 0 …`;<br>- `FU-45: an unknown void (timeout) on an authorization that expired meanwhile is settled the same way …`;<br>- `FU-45 (limit): a void the provider refuses while the authorization is still CREATED … escalates`. | 3 | ev:ev-mv43ut0r-0139a5a9 | **LIVE-DEPENDENT:** whether PayPal answers a void of an expired authorization with a read status `EXPIRED` is an OQ-D5 fact. |
| **NFR6** recovery contract rows (f3 fixtures × f4 table) | f3, f4 | `contracts.test.js` › `NFR6 (phase F): the recovery fixtures in test/fixtures/contracts/recovery match what the server answers` (23 states, one row per fixture); `plan-replan-feasible.json` without tolerance | (in the 81 contract tests) | ev:ev-mv43x96q-018bb5f5; f4: ev:ev-mv43ohq1-01bc3f1c | Local only. |
| **npm test and npm run test:browser pass** | all | — | 2259 / 0 fail / 8 skipped; 14/14 | **ev:ev-mv43x96q-018bb5f5, ev:ev-mv43yetb-016478e8, ev:ev-mv44c150-01e43728, ev:ev-mv44j3fw-01fb2787** (one red run, ev:ev-mv445oiq-01166891, explained above) | — |

**Note on the criteria lists.** The orchestrator's list for this submission names RS-21 and RS-25, which are phase E criteria, and omits RS-37, RS-38 and F-TR-6, which are phase F plan criteria. I mapped the union. The engine's required criteria for this gate are the four task ids and `phase:f-compensation`. The plan's phase criteria are listed below.

### The phase's own acceptance criteria (plan.json, `f-compensation`)

| # | Plan criterion | Status | Where |
|---|---|---|---|
| 1 | RS-13 [D] | met | table above |
| 2 | RS-15 [D] | met | table above |
| 3 | RS-17 [D + B] | met; browser 2/2 at 360 and 1280 | table above |
| 4 | RS-22 [D], including F-TR-7 | met | table above |
| 5 | RS-26 [D], including ARCH-26 A/B and F-TR-3 a/b/c | met (Node 22.22) | table above |
| 6 | RS-32(a) [B] | met; browser 2/2. RS-32(b) is LIVE-P2, not claimed | table above |
| 7 | RS-37 [D], including SEC-11 | met | table above |
| 8 | RS-38 [D] | met | table above |
| 9 | F-TR-2 and F-TR-6 | met | table above |
| 10 | `npm test` and `npm run test:browser` pass | met on re-run; one red run with its cause stated | runs table |

### Task criteria worth a reviewer's eye

- **f1, F-PL-3:** f1 changed no code in f2's files. Its handoff declares only its four test files, and git shows none of f1's owned source files changed since `bf1a723`.
- **f2, takeover:** "epoch + 1 … only when `lease_until <= now` and no operation is capture_pending or unknown (F-TR-7)". The tests listed for RS-22 and RS-26 show this. **FU-49** asks the reviewers to confirm the FU-41(a) hold path against it.
- **f3:** "textContent only". `test/scan/frontend.test.js` is green inside ev:ev-mv43uw5a-01419a34.
- **f4:** "at 360 and 1280 px with the approval round-trip helper". The browser run shows both widths for both journeys.

## What is REAL and what is SIMULATED

**Every payment in phase F ran against the DB-backed fake (`src/payments/fake.js`). No engineer and no run of mine contacted a PayPal host. No credentials exist in this environment (RISK-1, RISK-2).**

| Part | Status |
|---|---|
| Compensation, refunds, voids, F-TR-6, FU-45, `refund_order`, forced reset | **Simulated provider.** The tests prove our state machines, fences and call protocol against **our model of PayPal**. |
| Restart, SIGKILL, SIGSTOP/SIGCONT takeover, return-crash | **Real** OS processes, signals and SQLite file. The provider is the fake, and the freeze hooks are test-only fake faults. |
| Refusal and replacement journeys | **Real Chromium**, cross-site (`localhost` app, `127.0.0.1` fake approval page). This is not PayPal's hosted page. |
| Supersession, expiry, re-plan queue, ledgers | Real code on real SQLite with a pinned clock; no provider facts involved, except the void calls (fake). |

**LIVE-P1 and LIVE-P2 stay open and Unverified, and OQ-D5 stays open.** Phase F adds no live test and claims none.

**The live-dependent facts phase F relies on:**
- `final_capture`;
- `AUTHORIZATION_ALREADY_CAPTURED`;
- PayPal-Request-Id retention over a takeover;
- capture DECLINED and PENDING;
- refund PENDING/FAILED/COMPLETED;
- the read status after a void of an expired authorization (FU-45);
- void-after-capture answers (F-TR-6);
- the 29-day expiry and honour window (RISK-13).

RS-32(b) (hosted Sandbox approval page with the replacement plan) is LIVE-P2.

## Remaining issues the handoffs disclose, with my assessment

| # | Issue (source) | Assessment |
|---|---|---|
| 1 | **Two stale approved tests** (f1 1, f2 1, f3 2) | **Resolved by rework-5** (`dec-mv41b2g0-018dc143`). Green in all my runs. Its review `rev-mv44amic-012cf420` found TR-R5-1 (major), fixed in iteration 2 (`ho-mv44fohe-01197e16`), which awaits re-review. FU-47 was withdrawn. **TR-R5-1 also shows a phase F gap:** no f2 test reaches the `rejected` refund mapping in `calls.js` L296 (followups item 19). |
| 2 | **FU-39 not done** (f1 2) | **Decided**, `dec-mv40tgp9-0139d534`. |
| 3 | **Handler-side drain deviation** (f1 3) | **Decided**, `dec-mv40tgfo-01d03e4f`. Up to one interval (15 s) of "Finding a new plan …". Verification report item 16. |
| 4 | **View between supersession/refusal and the drain** (f1 4) | **Accepted.** f3 offers Approve only on REVIEW_NEW_PLAN/APPROVE_PLAN, and f4's contract rows pin rows 4, 4a and 12. Item 16. |
| 5 | **Guard symptom** of `mem-sd-mv1audrd-013b7102` for a call from the outer repository (f1 5) | Recovered by `cd`; no data affected. See Lessons. |
| 6 | **A forced reset needs the real void port** (f2 2) | **Documented** (item 16). `startApp` wires it; the app as shipped is correct. |
| 7 | **An archived `executing` plan stays `executing`** in the metrics (f2 3) | **FU-48.** It is fenced; only the count in `plansByStatus` is affected. |
| 8 | **The `send_token` fence is not separately provable; DB error in `resolveRejectedVoid`** (f2 4) | **Residual**, item 17. The epoch fence and the lease checks are mutant-proved. |
| 9 | **`refund_order` waits for the provider** (up to `RS_PAYPAL_TIMEOUT_MS` + 1 s) (f2 5) | **Documented**, item 16 (g2). |
| 10 | **FU-41(a) hold path re-takes the plan each tick while the read fails** (f2 6) | **FU-49, for the reviewers.** No money moves (no send), but it needs confirming against F-TR-7. |
| 11 | **Design deltas** (f2 7) | Item 16. FU-42 changed the refund's amount source (delta 24). |
| 12 | **f3 contract assumptions F1-a..F2-c and the return redirect** (f3 3–10) | **Checked by f4's contract table.** The real routes are driven into the 23 recovery states and compared with f3's fixtures (status, rule, nextStep, field types). F2-c: `stranded` entries now carry `providerAuthorizationId`/`providerCaptureId` (`src/services/admin.js` L222), as f3 expected. |
| 13 | **f3 test hooks; no confirm dialog on Refuse** (f3 11–12) | **Accepted.** The reason form is the safeguard; f4's journey uses it. |
| 14 | **FU-40 UX partly** (f3 13) | **FU-40** remains for g3 (`journey-happy` still reloads) and g2 (docs). |
| 15 | **360 px checked ad hoc only for the recovery views** (f3 14) | **FU-51** (g3). |
| 16 | **FU-33 recurred** (f4 1; my ev:ev-mv445oiq-01166891) | **Open, phase G.** It passed on each re-run. |
| 17 | **The fixture tolerance is removed** (f4 2) | **Resolved** (f3 reset ho-mv42ei0w-019037ae; ev:ev-mv43ohq1-01bc3f1c). |
| 18 | **Mutant M5 survived** (f4 3) | **Accepted**: a redundant backstop. Item 17. |
| 19 | **Test-process row writes in return-crash (b)/(c); the real 5 s back-off** (f4 4–5) | **Disclosed.** The writes are the rows the product itself writes, made while no server runs (b) or to arm a fault (c). |
| 20 | **"If something fails" is empty after the voids are done and a new plan exists** (f4 6) | **FU-50**: a product decision, then UI or report. |
| 21 | **Node 22.5 not available** (f4 7) | **The user's run**; listed in the verification report. |
| 22 | **SEC-B-1 per-call bound under contention** (rework-5; my ev:ev-mv445oiq-01166891) | **FU-46** (g3), `dec-mv43s14b-01addb18`. |

**Risks the phase touches (status changes are the orchestrator's):**
- **RISK-3** (double capture): offline evidence in RS-26 A/B (one non-replayed capture per order across a takeover) and FU-41.
- **RISK-4** (oversell): RS-38 sums and expiry exactly once.
- **RISK-8** (lost outcomes): RS-22, F-TR-6, FU-45, SEC-11 read-resolve.
- **RISK-20**: now has an expiry pass with voids (RS-15).
- **RISK-13 and RISK-18** depend on the live run. RISK-18's title names live RS-22 evidence that no live file produces (followups item 18).

## Process notes

1. **Order of work:**
   - f3 and f2 were claimed together from `bf1a723`.
   - f1 was claimed after f3 completed (base `308dc65`) and ran beside f2 under F-PL-3.
   - f4 was claimed after f1, f2 and f3 (base `5541ce0`).
   - The orchestrator reset f3 once, for the `labels` fixture field f4's contract rows found.
   - Rework-5 then fixed the two stale tests, and f4 completed on the tree holding both.
2. **Limits:** the user raised `limits.maxReworks` to 12 and `limits.maxRuntimeMinutes` to 4800 in commit `88c6c4d` (`.eccode/config.json`), which allowed rework-5.
3. **Decisions in this phase:**
   - `dec-mv40tgfo-01d03e4f` (drain in the reconciler);
   - `dec-mv40tgp9-0139d534` (FU-39 not done);
   - `dec-mv41b2g0-018dc143` (rework-5);
   - `dec-mv43s14b-01addb18` (the full-suite lock).
4. **Evidence pinning:** every engineer run cited above and all of mine carry a tree digest (TK-6 merged since phase E).
5. **Tests written after the code:**
   - f1 found no defect, so no test failed first, and its 30 mutants have no ev id.
   - f2's failing-first run and mutation run are recorded.
   - f4's bite proofs are recorded per mutant.
   - f3's ad hoc Chromium check is not recorded.
6. **Guard refusal in this submission**, verbatim: my first `evidence run` used a shell variable for the eccode command and was refused with "The guard cannot verify who this eccode command acts as: "$E" runs a command through a variable or substitution; call the eccode CLI directly so its --actor can be checked." That is the actor check working as designed; I re-ran with the CLI called directly.
7. **Budget:** `eccode status` showed 1512.01 of 4800 minutes and USD 1.1 of 25 (110 runs with unknown usage) before this submission.

## Lessons

- **My search:** `compensation refund void lease takeover restart reconciler supersession recovery UI timing test contention`, `--check-env`. It returned only `mem-sd-mv1audrd-013b7102` (guard root resolution in nested projects).
- **The engineers' decisions:** all four phase F tasks (and rework-5) recorded it **not-applicable**, because none builds or changes a hook, guard or root discovery. I agree.
- f1's one refusal from the outer repository is the lesson's symptom, but f1 did not design root discovery. My refusal above is an actor check, not a root problem.

## Artifact coverage

**Before submitting** (scratch script with the same set logic as `.eccode/drafts/phase-artifacts-check.mjs`, base `bf1a723`):
- **Declared:** 59 distinct files across the five completions (f1 4, f2 10, f3 36, f4 9). `plan-replan-feasible.json` is declared in both of f3's handoffs. No file is declared by two tasks.
- **Changed since `bf1a723` under phase F ownership:** 59.
- **Mismatches:** changed but undeclared 0; declared but unchanged 0; declared outside the phase's ownership 0.
- **Changed since the base outside phase F ownership (informational):** `test/api/admin-basic.test.js` and `test/api/lost-response.test.js` (rework-5, its own gate).
- **What the engine pins:** the engine adds every declared file of the phase's tasks to the submission (`lib/gates.js` `phaseChangedFiles`). So the 59 files are pinned without listing them, and I pass only this file and `followups.md`. A reviewer sees the final state of every phase F file.
- **After submitting**, I run `.eccode/drafts/phase-artifacts-check.mjs` against the real submission and report the result to the orchestrator.

## Handoff index

| Task | Handoffs (in order) | Files declared |
|---|---|---|
| f1-supersession-refusal-expiry | ho-mv40suhb-012306c3 | 4 |
| f2-compensation-takeover-admin | ho-mv41a3s6-0138e24d | 10 |
| f3-frontend-recovery | ho-mv403lay-01fa3938, ho-mv42ei0w-019037ae | 36 |
| f4-restart-takeover-browser | ho-mv43p246-01228012 | 9 |
| rework-5 (separate gate; changes requested rev-mv44amic-012cf420, iteration 2 done) | ho-mv43etq7-01598938, ho-mv44fohe-01197e16 | 2 |
