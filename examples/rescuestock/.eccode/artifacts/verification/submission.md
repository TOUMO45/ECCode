# RescueStock: verification report (verification gate submission)

Author: delivery-lead. Gate: `verification`. Date: 2026-10-12. Runs: `run-mv4iama4-01df062e` (triage) and `run-mv4iv7wq-01505288` (re-runs and submission).

**Tree:** HEAD `a3669fe`. Its code, tests and documents are identical to rework-8's `e299d01`: since then only record files changed, including the masked review draft in `7acbba5`. Every final run below carries tree digest `00d2d372…`.

**Status: READY FOR INDEPENDENT REVIEW.** On the final tree, every run is green:
- **g3's verification command** (ev:ev-mv4j2zpz-0142cd44):
  - `npm test`: 2406 tests, 2398 pass, 0 fail, 8 skipped;
  - `npm run test:browser`: 28/28;
  - the clean checkout: `npm install`, then `npm test` 2406/2396/0 fail/10 skipped, then `npm start` with health 200.
- **The +30-day `npm test`** (ev:ev-mv4j576c-01b87898): 2406/2398/0 fail/8 skipped.

**What is not verified:** every live item (section 4). Nothing in this project rests on a live run. Four high risks stay open for the user's acceptance (6.1).

## 1. The red run of the first attempt: cause and fix

- **What failed:** the first final-tree runs failed one test (`test/scan/secrets.test.js:853`, "RS-29: every tracked or unignored file … holds no canary and no secret shape"):
  - ev:ev-mv4idy1w-018b0e70 (g3 command: 2406/2397/**1 fail**/8 skipped);
  - ev:ev-mv4ig7cd-0172e1bc (+30-day, the same failure);
  - ev:ev-mv4im8xt-013d5123 (`secrets.test.js` alone, 18/19).
- **The hit:** `.eccode/reviews/drafts/rework-8-security-1.md` L68, flagged as an Anthropic-style API key shape.
- **Cause: not a secret.** It was a 23-character fake placeholder that the test sources define on purpose: `test/scan/secrets.test.js` L563, L564, L583 and L591; `test/api/extract-degraded.test.js` L188; `test/unit/http/app.test.js` L12.
  - The rework-8 security reviewer quoted it in its FINAL draft while explaining the scan's exemptions. That draft was last written at 00:18:39, after every green full run (the latest ended at 00:15:02).
  - The whole-project scan exempts fakes only by path plus exact fragment, and the new draft was not on its list.
  - The failure was deterministic: the same hit in three runs. The clean copy, which excludes `.eccode/`, passed.
- **Fix (b), chosen by the orchestrator:** the security reviewer masked the quote in its own draft and added a dated note, commit `7acbba5`.
  - No test, source or exemption entry changed.
  - The reviewer's own run: `secrets.test.js` 19/19, ev:ev-mv4iuu0h-01ba6f90.
- **Re-runs on the fixed tree: green** (section 2). The RS-29 whole-project test is `ok` in both parts of ev:ev-mv4j2zpz-0142cd44: the main tree, and the clean copy.
- **This report does not quote the fragment,** because the scan reads this file too.

## 2. Runs on the final tree

All full-suite runs held `flock /tmp/rescuestock-suite.lock` (`dec-mv43s14b-01addb18`). For g3's command the lock was held around the whole `eccode evidence run`, and the command was passed as one argument.

| Run | Result | Evidence |
|---|---|---|
| g3's verification command, verbatim (`ls … && npm test && npm run test:browser && sh scripts/clean-checkout.sh`), `--timeout 2400` | **exit 0, 345.7 s.**<br>**`npm test`:** 2406 tests, **2398 pass, 0 fail**, 8 skipped, 0 todo. ECCODE_EVAL 200/200. NFR5 p95 **58.7 ms** (p50 2.9 ms) over 7603 requests; suite 106.0 s.<br>**`npm run test:browser`:** **28/28**, 0 skipped.<br>**Clean checkout:** it copies tracked and unignored files without `.eccode/`, then `npm install` from the registry, then `npm test` 2406 tests, 2396 pass, 0 fail, 10 skipped (p95 57.8 ms, 103.3 s), then `npm start` with GET `/api/health` 200. | **ev:ev-mv4j2zpz-0142cd44** |
| `env CLOCK_SHIFT_DAYS=30 NODE_OPTIONS=--import=./test/helpers/shift-clock.mjs npm test` | **exit 0.** 2406 tests, **2398 pass, 0 fail**, 8 skipped. p95 58.5 ms, 102.2 s. | **ev:ev-mv4j576c-01b87898** |
| `test/scan/secrets.test.js` after the fix (security reviewer) | 19/19 | ev:ev-mv4iuu0h-01ba6f90 |
| **First attempt, before the fix** (kept as the record) | g3 command exit 1 (1 fail, section 1); +30-day exit 1 (the same failure); secrets alone 18/19. The separate runs were green: browser 28/28 (ev:ev-mv4ij9st-014fb4cf) and clean checkout (ev:ev-mv4ilpl4-01e9e320). | ev:ev-mv4idy1w-018b0e70, ev:ev-mv4ig7cd-0172e1bc, ev:ev-mv4im8xt-013d5123 |

- **Skipped tests.** In every `npm test` the same 8 are skipped by their own code, each with a reason:
  - the fake model has no `busy` fault (1);
  - the fake payment adapter has no wire or OAuth (7; these run and pass for the Sandbox adapter against the loopback stub).
  - **The clean copy also skips 2 by design:** the table's cited-run check (no record in a copy) and the screenshot scan (no screenshots in a copy).
  - No skipped test is counted as passed.
- **Evals.** The only offline eval, `test/eval/extraction-fake.test.js`, runs inside `npm test`: `ECCODE_EVAL {"passed":200,"total":200}`. It runs on the **fake** extraction provider, so it is evidence about the pipeline, not about model quality. The live-model eval (`npm run test:live-model`) was **not run** (LIVE-M1). No other eval exists outside `npm test`.
- **Performance (NFR5).** API p95 is 56–60 ms against a 300 ms limit; suite time is 102–109 s against 300 s. It is measured by `scripts/report-p95.js` over the deterministic API calls of each full run, on this host only (Linux, Node 22.22, 4 CPUs).
- **Cost.** No live model or PayPal call was made, so the product spent nothing. Model spend controls are verified offline (NFR6). RISK-21 is the one past incident: possible spend of at most USD 1.10.
- **Network.** Only the clean checkout's `npm install` left 127.0.0.1, to reach the npm registry. No live suite was run, and `RS_LIVE_MODEL` and `RS_LIVE_PAYPAL` were never set.

## 3. The 45 criteria

**Source:** `docs/evidence-table.md` (45 rows: **28 verified, 2 fake-only, 15 LIVE-DEPENDENT**), as rework-8 left it.

**My independent check** (`scratchpad/spotcheck2.mjs`, read-only) applies the table's own contract:
- each `file :: title` is text in its file;
- a cited run's log shows a test containing it as `ok`, not skipped and not todo;
- every cited run passed with exit 0.

**Result: 45 rows, 104 named tests, 0 problems.** The cited runs are rework-8's, on code identical to the final tree.

**My first final-tree run confirms the same families.** Leaf counts are from ev:ev-mv4idy1w-018b0e70, where only the RS-29 whole-project test failed; that test is `ok` in ev:ev-mv4j2zpz-0142cd44.

| Family | Leaf tests |
|---|---|
| RS-13 / RS-14 / RS-15 / RS-16 | 15 / 11 / 16 / 9 |
| RS-20 / RS-21 / RS-22 / RS-25 / RS-26 | 12 / 6 / 10 / 8 / 3 |
| RS-27 / RS-28 / RS-30 | 15 / 5 / 47 |
| RS-05 / RS-38 / NFR6 | 44 / 26 / 146 |
| ARCH-23, ARCH-26, F-TR-6, F-TR-7, FU-41, FU-45, TR-F-1, SEC-11, FU-59 | all ok |

**Legend:** D = deterministic `npm test`; B = browser; I = inspection by a person; LM = live model; LP = live PayPal. LM and LP mark parts that were not run.

| Id | Status | Suites | Named tests | Cited runs (`ev:`) | Unverified part and blocker (from the table, verbatim unless marked) |
|---|---|---|---|---|---|
| RS-01 | LIVE-DEPENDENT | D LM | 2 | ev-mv4gkvne-01368b23 | LIVE-M1 (A4/Q3): English and Arabic through the REAL model are not shown equal; offline the fake parser and the CLI and Anthropic adapters (recorded transcript, loopback stub) are. |
| RS-02 | LIVE-DEPENDENT | D LM | 2 | ev-mv4gkvne-01368b23 | LIVE-M1 (A4/Q3): reading real photos with the real model, and the CLI image input shape (`schemaAccepted`, F-TR-13), are not run. |
| RS-03 | LIVE-DEPENDENT | D B LM | 3 | ev-mv4gkvne-01368b23, ev-mv4gserr-01d67650 | LIVE-M1 (A4/Q3): the EXT-1 ambiguous images are not run against the real model. Degraded paths (timeout, invalid JSON, schema, budget, rate) are verified with the fake. |
| RS-04 | verified | D | 2 | ev-mv4gkvne-01368b23 | — |
| RS-05 | LIVE-DEPENDENT | D LM | 2 | ev-mv4gkvne-01368b23 | LIVE-M1 (A4/Q3): resistance of the REAL model to injection (the EXT-1 injection cases) is not run; offline, the structure (data line, fixed prompt, no tool, output shape without permissions) and the fake are verified. |
| RS-06 | verified | D | 2 | ev-mv4gkvne-01368b23 | — |
| RS-07 | verified | D | 2 | ev-mv4gkvne-01368b23 | — |
| RS-08 | verified | D | 1 | ev-mv4gkvne-01368b23 | — |
| RS-09 | verified | D | 2 | ev-mv4gkvne-01368b23 | — |
| RS-10 | verified | D | 1 | ev-mv4gkvne-01368b23 | — |
| RS-11 | verified | D | 1 | ev-mv4gkvne-01368b23 | — |
| RS-12 | verified | D | 2 | ev-mv4gkvne-01368b23 | — |
| RS-13 | verified | D | 2 | ev-mv4gkvne-01368b23 | The voids go to the fake provider; a plain void on the real Sandbox is checked by LIVE-P2 (RS-32(b) asserts both authorizations VOIDED at PayPal), which was not run. |
| RS-14 | verified | D | 2 | ev-mv4gkvne-01368b23 | — |
| RS-15 | verified | D | 2 | ev-mv4gkvne-01368b23 | The voids that expiry queues go to the fake provider; a plain void on the real Sandbox is checked by LIVE-P2 (RS-32(b)), which was not run. |
| RS-16 | verified | D | 1 | ev-mv4gkvne-01368b23 | — |
| RS-17 | verified | D B | 2 | ev-mv4gkvne-01368b23, ev-mv4gserr-01d67650 | The authorization voids run against the fake provider. |
| RS-18 | LIVE-DEPENDENT | D LP | 2 | ev-mv4gkvne-01368b23 | LIVE-P1 (A6/Q2), (A2): cancel and abandon against the real Sandbox are not run (`rs18-cancel-abandon.test.js` exists and refuses without its flag). |
| RS-19 | LIVE-DEPENDENT | D LP | 2 | ev-mv4gkvne-01368b23 | LIVE-P1 (A6/Q2), (A2): the amount the real Sandbox receives and its refusal of tampering are not run; the fake and the loopback stub show the exact request body the adapter sends. |
| RS-20 | LIVE-DEPENDENT | D LP | 3 | ev-mv4gkvne-01368b23, ev-mv4gvr0e-018f354c | LIVE-P1 (A6/Q2), (A2), OQ-D5; SEC-18: the double-capture argument's layers 4 and 5 (`PayPal-Request-Id` replay, `final_capture` refusing a second capture) rest on the fake's model of PayPal until the live run. The exactly-one-capture-per-order result holds against the fake. |
| RS-21 | LIVE-DEPENDENT | D | 2 | ev-mv4gkvne-01368b23 | LIVE-P1 does NOT cover this (FU-52): authorization DENIED or PENDING is exercised by no live file; the fake's model is the only evidence (OQ-D5). |
| RS-22 | LIVE-DEPENDENT | D | 2 | ev-mv4gkvne-01368b23 | LIVE-P1 does NOT cover this (FU-52): capture PENDING or DECLINED, refund PENDING or FAILED, a void after a capture and the EXPIRED read after a refused void are exercised by no live file; compensation rests on the fake's model of PayPal (SEC-18, OQ-D5). |
| RS-23 | LIVE-DEPENDENT | D LP | 1 | ev-mv4gkvne-01368b23 | LIVE-P1 (A6/Q2), (A2), Q6 (a public webhook URL): real signed deliveries and the real event names (OQ-D5) are not run. |
| RS-24 | LIVE-DEPENDENT | D LP | 1 | ev-mv4gkvne-01368b23 | LIVE-P1 (A6/Q2), (A2): real PayPal verification is not run. Cross-merchant signature rejection (FU-44) is not covered by LIVE-P1 either: the fake's signing string does not include the merchant key. |
| RS-25 | fake-only | D | 2 | ev-mv4gkvne-01368b23 | OQ-D5, SEC-18: no live file covers a lost capture answer (LIVE-P1 does NOT; the fake's model is the only evidence): that the real Sandbox shows what the fake shows after a lost answer (the capture visible through a read of the authorization and the order) is not run. |
| RS-26 | LIVE-DEPENDENT | D | 4 | ev-mv4gkvne-01368b23, ev-mv4gvr0e-018f354c | LIVE-P1 does NOT cover this (FU-52): `PayPal-Request-Id` retention across a process takeover is exercised by no live file. SEC-18: RS-26 on the Sandbox rests on the fake's model of PayPal. The process-level behaviour (kill, restart, takeover, one non-replayed capture per order) is verified with the fake; only Linux was run (SIGSTOP). |
| RS-27 | verified | D | 2 | ev-mv4gkvne-01368b23 | — |
| RS-28 | verified | D | 1 | ev-mv4gkvne-01368b23 | — |
| RS-29 | verified | D B I | 7 | ev-mv4gkvne-01368b23, ev-mv4gsi7o-01ea49ae; final tree ev-mv4j2zpz-0142cd44 | *(Summarised; the full scope text is in the table.)* Scope (SEC-G-1): every git-tracked or untracked-unignored file, including `.eccode/` and its run logs, every document, every PNG chunk except pixel data, and the browser screenshots. Each file is checked for every canary and for the high-confidence secret shapes; exceptions are listed by path and exact fragment, and a stale entry fails. The security review's 17-plant probe is caught in full. Screenshots are scanned by file name and PNG chunks, not pixels; unknown secret shapes would pass, and the canaries are the strong check. (I) phase G technical review (rev-mv4fdv59-01732f16). **On the final tree the whole-project test is `ok`, after the section 1 fix.** |
| RS-30 | verified | D | 2 | ev-mv4gkvne-01368b23 | — |
| RS-31 | LIVE-DEPENDENT | D B LP | 2 | ev-mv4gkvne-01368b23, ev-mv4gserr-01d67650 | LIVE-P1, LIVE-P2 (A6/Q2): RS-31(b), the hosted Sandbox approval page with a Sandbox buyer account and its screenshots, is not run. |
| RS-32 | LIVE-DEPENDENT | D B LP | 4 | ev-mv4gkvne-01368b23, ev-mv4gserr-01d67650 | LIVE-P1, LIVE-P2 (A6/Q2): RS-32(b), the same replacement on the hosted Sandbox, is not run. |
| RS-33 | verified | D B | 2 | ev-mv4gkvne-01368b23, ev-mv4gserr-01d67650 | — |
| RS-34 | fake-only | D B | 4 | ev-mv4gkvne-01368b23, ev-mv4gserr-01d67650 | LIVE-P1 (A2, SEC-3): the Sandbox adapter's labels were shown against the loopback stub in test mode only; the same page against the real Sandbox host (no test-mode banner, the real single-credential notice) is not run. |
| RS-35 | verified | D B I | 2 | ev-mv4gkvne-01368b23, ev-mv4gserr-01d67650 | (I) inspected by the phase G technical review (rev-mv4fdv59-01732f16): the screenshot six-questions-1280 answers all six questions from codes. |
| RS-36 | verified | D I | 3 | ev-mv4gkvne-01368b23 | *(Summarised.)* (I) F-TR-9 inspection done by the phase G technical review (FU-62, rev-mv4fdv59-01732f16): the final `derive.js` was read row by row against the table and conforms; the phase B review did it for revision 2. Row 12 also accepts `draft`, a harmless totalising extension (TR-G-6). A later edit of `derive.js` voids the inspection; the tests pin the rows. |
| RS-37 | verified | D | 2 | ev-mv4gkvne-01368b23 | The forced reset's void and read-resolve pass run against the fake provider (SEC-11). |
| RS-38 | verified | D | 2 | ev-mv4gkvne-01368b23 | — |
| RS-39 | verified | D | 2 | ev-mv4gkvne-01368b23 | — |
| NFR1 | verified | D I | 3 | ev-mv4gkvne-01368b23; final tree ev-mv4j2zpz-0142cd44 | USER-Q9: the run on the Node 22.5 branch (the floor the user has not yet confirmed) is the user's; only Node 22.22 was available, and the older binaries used by `start-old-node` are 20 and 21. *(Added: the clean checkout passed on the final tree.)* |
| NFR2 | verified | D B | 5 | ev-mv4gkvne-01368b23, ev-mv4gserr-01d67650 | Chromium only (other browsers, screen readers and real touch devices were not run). No accessibility library was used: the audit is hand-written (names, 44 px targets, computed 4.5:1 contrast, focus indicators, no horizontal scroll); a native date-time control's focus is shown by comparing pictures of it, not by its style. |
| NFR3 | verified | D I | 5 | ev-mv4gkvne-01368b23 | That the live scripts REFUSE is verified, including the real `npm run test:live-model` and `npm run test:live-paypal` lines run without a flag under the net guard (the second prints six refusals and exits 1, as the runbook says); that they RUN correctly is not (LIVE-M1, LIVE-P1: never run). (I) inspected by the phase G technical review (rev-mv4fdv59-01732f16): both runners label their reports (live-support.js L93-L95; run-live-model.js L182-L187). |
| NFR4 | verified | D I | 2 | ev-mv4gkvne-01368b23 | (I) inspected by the phase G technical review (rev-mv4fdv59-01732f16): secrets are read only from process.env, and the secret entries of `.env.example` are commented placeholders. |
| NFR5 | verified | D | 2 | ev-mv4gkvne-01368b23 | The API p95 and the suite time are printed by `scripts/report-p95.js` in the log of each full `npm test` run, on this host only. *(Added: final tree p95 58.7 ms, 106.0 s, ev-mv4j2zpz-0142cd44.)* |
| NFR6 | LIVE-DEPENDENT | D LM | 2 | ev-mv4gkvne-01368b23 | LIVE-M1 (A4/Q3): the real cost report is not run. The budget case runs with RS_MODEL_CUSTOMER_DAILY_SHARE=1 (F-TR-18): it shows the global daily budget refusing the third extract; with the default per-customer share a single customer is stopped earlier, which the unit tests of the gate show separately. |

### Verified, assumed, not tested

- **Verified** (with `ev:` ids):
  - the 28 `verified` rows;
  - the offline parts of the 2 `fake-only` and 15 `LIVE-DEPENDENT` rows;
  - the Chromium browser journeys;
  - the clean checkout;
  - the +30-day run.
- **Assumed** (reasoning, no execution):
  - that the real PayPal Sandbox behaves as the fake and the loopback stub model it (SEC-18, OQ-D5);
  - that the real model returns the schema the adapters expect (F-TR-13);
  - that the inspected `I` parts (RS-29, RS-35, RS-36, NFR3, NFR4) stay true. A later edit voids them.
- **Not tested, with reason:**
  - every live suite: no credentials and no network to the Sandbox or model hosts (RISK-1, RISK-2);
  - Node 22.5 (USER-Q9);
  - macOS, Windows, other browsers, screen readers and touch devices (environment).

## 4. Live items still open, with the step that closes each

**Nothing in this project rests on a live run. No live suite was ever run.** RISK-21 was one accidental live-model start during a review; it is reported, not counted.

| Item | What it would show | Exact step to close it |
|---|---|---|
| **LIVE-M1** (RS-01, RS-02, RS-03, RS-05, NFR6 cost report) | English and Arabic parity, real photos, ambiguous images and injection resistance through the real model, and the real cost per extraction | `docs/runbooks/live-model.md` › "Prerequisites": an authenticated Claude CLI or `ANTHROPIC_API_KEY`, and the user's approval of the USD 5 ceiling. Then › "Steps":<br>1. dry run: `RS_LIVE_MODEL=1 RS_LIVE_MODEL_CEILING_USD=5 npm run test:live-model -- --dry-run`;<br>2. run: `RS_LIVE_MODEL=1 RS_LIVE_MODEL_CEILING_USD=5 npm run test:live-model`.<br>The report location is in "Where the report is". |
| **LIVE-P1** (RS-18, RS-19, RS-20, RS-23, RS-24 live parts) | Cancel/abandon, amounts, double-capture layers 4–5, webhook dedupe and signature verification against the real Sandbox | `docs/runbooks/live-paypal.md`:<br>- §1 prepare a Sandbox app and webhook (seven mapped events only);<br>- §2 allow-list `api-m.sandbox.paypal.com` and `www.sandbox.paypal.com`;<br>- §3 set `RS_PAYPAL_DEFAULT_CLIENT_ID`, `RS_PAYPAL_DEFAULT_CLIENT_SECRET` and `RS_PAYPAL_DEFAULT_WEBHOOK_ID` (or the per-supplier sets) as environment secrets;<br>- §4 `RS_LIVE_PAYPAL=1 node test/live/paypal/run-live-paypal.js` (one exit code), or `RS_LIVE_PAYPAL=1 npm run test:live-paypal`;<br>- §5 for RS-23 with a genuine delivery: `RS_LIVE_PAYPAL=1 RS_LIVE_PAYPAL_WEBHOOK_SAMPLE=/path/to/sample.json npm run test:live-paypal`.<br>Single-credential mode weakens the per-supplier evidence (A2, RISK-18). |
| **LIVE-P2** (RS-31(b), RS-32(b)) | The hosted Sandbox approval page with a Sandbox buyer account, with screenshots | `docs/runbooks/live-paypal.md` §6: `RS_LIVE_PAYPAL=1 RS_LIVE_PAYPAL_HEADED=1 node test/live/paypal/run-live-paypal.js test/live/paypal/journey-sandbox.test.js`, with a Sandbox buyer account. Also the demo video's hosted-approval scene. |
| **OQ-D5** (facts about the real PayPal API) | Approval link relation, authorization statuses including EXPIRED, `final_capture`, PayPal-Request-Id replay and retention, findable capture and refund ids, webhook event names | LIVE-P1 and LIVE-P2 settle the list in `docs/runbooks/live-paypal.md` › "What the live run settles". **Not settled even by a clean LIVE-P1/P2 run (FU-52):** DENIED/PENDING authorizations (RS-21), void after capture (F-TR-6), Request-Id retention across a takeover, capture PENDING/DECLINED, refund PENDING/FAILED, the EXPIRED read after a refused void, RS-22/25/26 on the Sandbox, and cross-merchant signature rejection (FU-44). These need **new live tests**, which do not exist. |
| **USER-Q9** (NFR1 on Node 22.5) | The multi-process tests on the 22.5 branch | README › "Node floor and the 22.5 branch (Q9)". The user decides whether to support 22.5–22.12. If yes: `engines.node` becomes `>=22.5`, the gate checks 22.5, and the npm scripts gain `--experimental-sqlite`. Then run `npm test` (including the multi-process files) on Node 22.5. Today the floor is 22.13 and the branch is not enabled. |

## 5. Accepted limits and decisions

| # | Limit or decision | Where recorded |
|---|---|---|
| 1 | **SQL scan (T20) static limits.** The scan does not see:<br>- data flowing into an allow-listed builder without assignment (`parts.push` in `buildTimeline`);<br>- column names from input in a pinned loop (`findOperations` taking `event.lookup`);<br>- a template literal passed to the allow-listed `ids()` helper (`requestScope`) — SEC-R8-1;<br>- computed member calls, or a parameter shadowing a RegExp constant — SEC-R8-I1, adversarial only.<br>No such code exists today. Every change still goes through independent review, and the tests exercise these routes. The allow-list design itself is the accepted T20 deviation. | `dec-mv4i8iob-01e31f5a`; rev-mv4i9dg7-010c7d6f; phase G review |
| 2 | **Secrets scan limits.** Two whole files are exempt: the shape-sample file skips the shape checks, and the canary holders skip the canary check. Unknown credential shapes are not matched. Screenshots are scanned by name and PNG chunks, not pixels (SEC-R8-I2). | `dec-mv4i8iob-01e31f5a` |
| 3 | **TR-R8-1 (PAMB2).** The evidence table's cited-run check reads *recorded* logs. A cited test later changed to `test.skip` stays green in the table check; only a fresh full run would show 9 skips instead of 8, and nothing ties that count to the table. A design residual: the table cites runs, not the current tree. **My final-tree runs show the usual 8 skips.** | rev-mv4i9dg7-010c7d6f |
| 4 | **TR-R8-2 / SEC-R8-I3 (wording).**<br>- README L77 says `npm start` serves http://127.0.0.1:3000.<br>- `docs/runbooks/live-paypal.md` L115 lists 127.0.0.1 first.<br>- README L13 (the corrected demo) says to open **localhost**: without `RS_PUBLIC_URL` the simulated approval returns to `http://localhost:<port>`, and the session belongs to the host name used. A reader following L77 who opens 127.0.0.1 comes back signed out after the approval.<br>The bind is 127.0.0.1 (`config.js` L243), so this is not a security issue. **Use http://localhost:3000.** | `dec-mv4i8iob-01e31f5a`; rev-mv4i9dg7-010c7d6f |
| 5 | **TR-G-6.**<br>- `scripts/clean-checkout.sh` copies tracked **and untracked-unignored** working-tree files, so it checks the working tree, not a commit. My runs were on a clean HEAD.<br>- It does not run `npm run seed`. The README run seeded a fresh copy successfully (phase G review).<br>- The keep option (`RS_KEEP_CLEAN_CHECKOUT=1`) works since rework-8.<br>- `derive.js` row 12 also accepts plan status `draft`, a harmless totalising extension. | rev-mv4fdv59-01732f16 |
| 6 | **FU-50.** Completed voids of a closed plan are not listed in "If something fails". An admin sees past operations. | `dec-mv47vma5-01d0d177` |
| 7 | **FU-53.** A forced reset does not fence a live executing saga. Stranded statuses are **as of the archive**. A capture in flight for an executing plan can complete after it: its result is recorded on the archived row, the refund the hook queues is never sent (`startCall` refuses archived operations), and the stranded entry still says `authorized`. Demo-only, admin-only, needs force plus a reason. No `lease_epoch` bump was added. | `dec-mv46ovt6-01a662af`; TR-F-6 |
| 8 | **FU-55, narrower.** A denied audit row is written for `refund_order` 404 and 422 only; a 422 on the other fault kinds writes none. | rework-7; TR-R7-2 |
| 9 | **FU-57, narrower.** `reconciler.unresolved` counts `refund_failed` operations, but not reservations with an escalation. Those show in the request status and `operationsByStatus`. | rework-7; TR-R7-2 |
| 10 | **TR-R7-2 (also).** The refusal-reason rule refuses control and bidi override characters, but leaves U+200B–200D, U+FEFF and U+061C. These do not reorder text, and the reason is isolated in `<bdi>` when shown. | rev-mv4c60ve-01105860 |
| 11 | **Lockfile.** `package-lock.json` has no `node_modules/fsevents` entry: an optional, darwin-only development dependency of Playwright. A macOS `npm install` fetches it without an integrity pin. No effect on Linux or CI. A regenerated lock with exactly that one extra block exists (g3 handoff, sha256 `d870b67d…dd62`). The README limits state it since rework-8. | `dec-mv4eaw35-013b929e`, `dec-mv4eresb-01e74e36`, `dec-mv4feq7b-01e42a8f` |
| 12 | **TR-R6-3 (record correction).** Rework-6's disclosure said no mutant shows SEC-B-1's 1000 ms ceiling alone firing. That is inaccurate: mutant pl-nolb-cap (no lower-bound cut, node cap 40M) is killed by the ceiling alone. The p95 line is still not shown firing by any mutant. | rev-mv4954l0-01d87f48 |
| 13 | **Spec wording `dec-mv44nzj5-01fbc177` never edited.** ARCH-26 (2) and saga step 6 say intents "(queued or started)" are resolved by reading after a takeover. The code reads first only for **started** intents: a queued call is provably unsent. The approved spec is pinned, and the operations runbook states the behaviour. | `dec-mv44nzj5-01fbc177`; TR-R5-3 |
| 14 | **Clock-shift blind spots** (`test/helpers/shift-clock.mjs` header). A passing +30-day run says nothing about:<br>- Chromium;<br>- SQLite (the app uses no SQL clock);<br>- `FileHandle.stat`;<br>- string times passed to `utimes`;<br>- `Intl.DateTimeFormat()` without a date;<br>- `Date()` without `new` (throws);<br>- children spawned with a minimal environment (live-refusal checks, the seed runner, start-old-node). | phase G review |
| 15 | **Platform.** Chromium only (Playwright 1.56.1, at 360 and 1280 px), Linux only, Node 22.22 only. Node 20 and 21 are used only to check the refusal of old versions. | evidence table › Limits |
| 16 | **Other recorded decisions:**<br>- `dec-mv40tgfo-01d03e4f`: the re-plan drain is the reconciler's; up to one interval of "Finding a new plan…";<br>- `dec-mv40tgp9-0139d534`: FU-39 not done;<br>- `dec-mv48g2fj-018e0ca7`: the canonical single-credential sentence;<br>- `dec-mv46ovf2-017bf12d` / `dec-mv4740d4-015b3589`: a refunded order is not handed over, per order;<br>- `dec-mv3uqze6-0196f887`: `test:live-paypal` exits 1 as a whole;<br>- `dec-mv3abkne-01161cf3`: unmapped webhook types are 400;<br>- `dec-mv3abkv0-011839e9`: `RS_PAYPAL_WEBHOOK_ALGOS` is an environment fallback;<br>- `dec-mv3u4zzu-01f07c5a`: run migration 006 as a single process before traffic. | records |

## 6. Risk triage (delivery-lead, on the final tree)

Delivery is refused while a critical or high risk is open. I marked a risk **mitigated** only where the mitigation is implemented and its tests pass on the final tree.

For mitigated risks, the evidence is:
- the final-tree runs ev:ev-mv4j2zpz-0142cd44 and ev:ev-mv4j576c-01b87898;
- the first-attempt run ev:ev-mv4idy1w-018b0e70, whose only failure was the section 1 hit;
- rework-8's green run ev:ev-mv4hjjqn-013f05aa on identical code;
- the multi-process ×4 run ev:ev-mv4gvr0e-018f354c;
- the phase reviews.

Every update is recorded with `eccode risk update … --actor delivery-lead`.

| Risk | Severity | Status now | Evidence and note |
|---|---|---|---|
| RISK-1: Sandbox hosts blocked here | high | **open: residual for the user** | Cannot be mitigated in this environment. See 6.1. |
| RISK-2: no PayPal credentials or API key | high | **open: residual for the user** | See 6.1. |
| RISK-3: double capture | critical | **mitigated** | RS-20 two-process, RS-25, ARCH-23/26 A/B, FU-41, TR-F-1 ok; phase E/F reviews. **Residual stated:** layers 4–5 (Request-Id replay, `final_capture`) rest on the fake's model until LIVE-P1 (SEC-18). |
| RISK-4: oversell | critical | **mitigated** | RS-14 two-process and DB_BUSY, RS-15, RS-16, RS-38 ok. No live dependency. |
| RISK-5: cross-account access | critical | **mitigated** | RS-27 (15), RS-28 (5), RS-30 (47) ok; security review of every phase approved. |
| RISK-6: prompt injection | high | **mitigated** (containment) | RS-05 (44) ok. The controls do not depend on model behaviour: data line, no tools, schema-validated output, nothing privileged from model output, buyer confirms each field. **Residual stated:** the real model's resistance is LIVE-M1. |
| RISK-7: model unavailability, latency, cost | medium | open: residual | Degraded paths verified with the fake (RS-03). Real latency and cost are LIVE-M1. |
| RISK-8: lost or unknown outcome | high | **mitigated** | RS-22, RS-25, RS-26, F-TR-6, FU-45, TR-F-1, SEC-11 ok; phase F review. **Residual stated:** real Sandbox PENDING/DECLINED/FAILED semantics (FU-52). |
| RISK-9: secrets leak | high | **mitigated** | All RS-29 tests ok in ev:ev-mv4j2zpz-0142cd44 (main tree and clean copy); secrets 19/19 ev:ev-mv4iuu0h-01ba6f90. The earlier hit was a fake placeholder quoted in a review draft, masked in `7acbba5` (section 1). **Limits accepted** in `dec-mv4i8iob-01e31f5a`. |
| RISK-10: hackathon facts unverified | medium | open: user action | FU-61; release checklist. |
| RISK-11: scope versus time | high | **closed** | The build is complete. Every phase gate (B–G) and reworks 1–8 are approved; unverified parts are recorded. |
| RISK-12: Sandbox webhooks unreachable | medium | open: residual | The polling fallback and signature verification are verified offline; a public webhook URL is the user's (LIVE-P1 §5). |
| RISK-13: authorization expiry and honour window | high | **open: residual for the user** | See 6.1. |
| RISK-14: Playwright download on clean clones | medium | open: residual | `npm test` never launches a browser (NFR1/NFR3). The README documents `npx playwright install chromium`. Judges' networks are outside our control. |
| RISK-15: node:sqlite experimental | medium | mitigated (earlier) | Unchanged. |
| RISK-16: session lost on the cross-site return | high | **open: residual for the user** | See 6.1. |
| RISK-17: model spend abuse | medium | **mitigated** | NFR6 (146 leaf tests incl. budget, per-customer share and rate limit) ok. Real cost report is LIVE-M1. |
| RISK-18: single-credential weakens live evidence | medium | open | Applies only once LIVE-P1 runs; rows labelled (A2). |
| RISK-19: planner node cap reachable | medium | open: accepted design residual | A typed 422 (FU-1) and the planning rate limit. An integer DP is not built in version one. |
| RISK-20: stock hoarding within the cap | medium | open | The expiry pass runs on the reconciler tick (RS-15 ok, including expiry voided in the tick). Hoarding within the cap is a product decision kept for version one. I could not confirm the specific running-server test the record asks for (SEC-C-1), so it is not marked mitigated. |
| RISK-21: incident, a review probe started a real live-model run | medium | open | Status, honestly: possible spend of at most USD 1.10, recorded as an upper bound (run correction on `run-mv330tea-0177469c`); the actual spend is unknown. The runner's ceiling parsing was fixed (TR-D-10), and the live scripts refuse without their flag (NFR3, verified). **The user's own usage check is still pending.** |

### 6.1 Residual risks for the user to accept (high severity; the delivery-lead cannot accept them)

- **RISK-1: PayPal Sandbox hosts blocked from the build environment.**
  - **Unverified:** every LIVE-P1 and LIVE-P2 item.
  - **Why:** the build environment cannot reach `api-m.sandbox.paypal.com` or `www.sandbox.paypal.com`.
  - **What the code does:** a DB-backed fake and a loopback stub implement the full provider contract with fault injection. The Sandbox adapter is unit-tested against the stub. Every live row is marked Unverified with its blocker.
  - **How to verify:** on a machine with network access, follow `docs/runbooks/live-paypal.md` §1–6 (section 4 above).
- **RISK-2: no PayPal credentials and no model API key here.**
  - **Unverified:** LIVE-M1, LIVE-P1, LIVE-P2.
  - **Why:** no Sandbox credentials or model key were provided to this environment.
  - **What the code does:** credentials are read only from the environment (NFR4, inspected). The live scripts refuse without their flag and name missing variables, never values (NFR3, verified).
  - **How to verify:** provide the variables named in the runbooks as environment secrets and run them.
- **RISK-13: authorization expiry or honour window while waiting for suppliers.**
  - **Unverified:** PayPal's real authorization validity, its honour window, and the status after expiry (OQ-D5).
  - **Why:** these are properties of the real Sandbox.
  - **What the code does:**
    - re-reads `expiration_time` at revalidation with a 10-minute margin;
    - an expired authorization is compensated as AUTHORIZATION_EXPIRED (RS-22 variant);
    - an EXPIRED read after a refused void is settled (FU-45);
    - the 30-minute reservation TTL bounds the wait.
    - All of this is verified against the fake's model.
  - **How to verify:** LIVE-P1 shows the status set. The EXPIRED-after-void read needs a new live test (FU-52).
- **RISK-16: session lost on the cross-site PayPal return.**
  - **Unverified:** the real hosted Sandbox approval page and its redirect back (RS-31(b), RS-32(b), LIVE-P2).
  - **What the code does:**
    - the session cookie is SameSite=Lax;
    - the return handler is owner-checked and idempotent;
    - `test:browser` drives a real cross-site round trip (app on localhost, fake approval page on 127.0.0.1; RS-31(a), RS-32(a), RS-17; 28/28 in ev:ev-mv4j2zpz-0142cd44).
  - **Note:** the host-name pitfall in limit 4: open localhost, not 127.0.0.1.
  - **How to verify:** `docs/runbooks/live-paypal.md` §6 with a Sandbox buyer account.

**Medium residuals** (they do not block delivery; listed for completeness): RISK-7, RISK-10, RISK-12, RISK-14, RISK-18, RISK-19, RISK-20 and RISK-21, as in the table.

## 7. Release checklist (from `plan.md` › "Release checklist", completed)

- [x] **Install from the README works on a clean copy:** `scripts/clean-checkout.sh` passed on the final tree inside ev:ev-mv4j2zpz-0142cd44: npm install, then `npm test` 2406/2396/0 fail/10 skipped, then `npm start` with `/api/health` 200. Limits are in item 5 of section 5.
- [x] **`npm test` and `npm run test:browser` pass on the release commit, and NFR5 passes:**
  - `npm test` 2406/2398/0 fail/8 skipped;
  - browser 28/28;
  - NFR5 p95 58.7 ms, 106.0 s;
  - all in ev:ev-mv4j2zpz-0142cd44, and the +30-day run ev:ev-mv4j576c-01b87898 is green.
- [x] **Config and secrets are documented by name only** (`.env.example`, README, runbooks; NFR4 inspected; docs scan green), **and the RS-29 scan is clean** over assets, responses, logs, screenshots, submission files and the project record. Every RS-29 test is ok in ev:ev-mv4j2zpz-0142cd44, and secrets 19/19 in ev:ev-mv4iuu0h-01ba6f90. Limits are in items 1–2 of section 5.
- [x] **Labels are shown** (RS-34): Simulated, PayPal Sandbox — no real money, Demo data, Test prices, and test mode. Browser `RS-34` (two adapters × two widths) and API labelling are ok in ev:ev-mv4j2zpz-0142cd44. The Sandbox page without test mode is LIVE-P1.
- [x] **Rollback path:** tag the release commit. Migrations are append-only (no down-migration), so a rollback redeploys the previous commit with its database backup (`VACUUM INTO`, README › Backups; operations runbook). Admin reset restores RS-FIX-1 for demos. Migration 006 should run as a single process before traffic (`dec-mv3u4zzu-01f07c5a`).
- [x] **Monitoring is in place:**
  - JSON logs carry `requestId` (NFR6 log tests);
  - `GET /api/admin/metrics` shows the reconciler's last tick, unresolved operations (FU-57 reading), provider latency and model spend;
  - `failed_needs_attention` is visible (TR-F-1 escalation);
  - a forced reset lists stranded operations with `planStatus` and `owedRefund` (FU-54).
- [ ] **Open risks:** every critical risk is mitigated with evidence, and every high risk is mitigated or closed except four. **RISK-1, RISK-2, RISK-13 and RISK-16 stay open for the user's acceptance** (6.1); the delivery-lead cannot accept them. **Delivery is refused until the user accepts them** (`eccode risk update --id RISK-n --status accepted --actor user`).
- [x] **The evidence table and this report** mark LIVE-M1, LIVE-P1, LIVE-P2 and USER-Q9 as Unverified with their blockers, and state the NFR6 share pin (F-TR-18) and the SEC-18 wording (RS-20, RS-25, RS-26).
- [ ] **User-side items remain (FU-61):**
  1. **Own-decisions line:** edit `docs/submission/project-description.md` L42, replacing "[Edit this to say exactly which decisions I actually made myself.]".
  2. **URL placeholders:** fill in the repository URL and the demo video URL (project description L59 and the drafts).
  3. **Hackathon facts:** re-check every fact in `docs/submission/checklist.md` against the Devpost rules page (https://paypalaihackathon.devpost.com/rules), including the deadline, video length and hosting, judging criteria and repository rules (Q5, Q7). The Devpost connector needs the user to sign in again.
  4. **Also the user's:** the demo video showing PayPal's hosted Sandbox approval page (LIVE-P2), the Q10 daily budget, the RISK-21 usage check, and the residual acceptances of 6.1.

## 8. Artifacts and process

- **What this submission pins:** this file plus **every deliverable file**, meaning every non-empty git-tracked file of the project outside `.eccode/`, at its current content. The reviewer therefore sees the final state of every file that ships.
- **Unreviewed changes:** the engine's `unreviewedChanges` check reports no file change that no review covers. It lists only ten release-baseline warnings: the early approvals (architecture to phase D, reworks 1–4) recorded no commit (TK-6). These are flagged `unpinned` and do not block.
- **Evidence pinning:** every final run here carries the tree digest `00d2d372…`.
- **Guard refusals in these runs, all raw-text readings:**
  - `$0` in an `awk` line;
  - a command substitution in a `grep -F` argument;
  - a `->` inside a grep pattern, read as a redirect into a record file.
  - I redid each without the construct.
- **Harness refusal:** the harness refused a subagent write to `.eccode/artifacts/verification/report.md`. On the orchestrator's instruction the report is this `submission.md`.
- `eccode metrics` is the orchestrator's to report.

## 9. Lessons

`mem-sd-mv1audrd-013b7102` (guard root resolution) is the only lesson retrieved in this project's searches. It does not apply: this report builds no hook or guard, and the refusals above are the raw-text over-denials its "Not applicable when" list names.

**A new lesson candidate** (for the engineering-memory owner, not recorded by me): a whole-project secret scan that reads the project record fails on any later review draft that quotes a test's fake credential, because the exemptions are by path plus exact fragment. Review drafts should mask secret-shaped quotes (section 1), or the scan should treat the test's own declared fakes as known values wherever the record quotes them.
