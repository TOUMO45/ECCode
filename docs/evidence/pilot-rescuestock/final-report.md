# ECCode and RescueStock: final report

**Date:** 2026-10-12. **Author:** the orchestrator (the session that dispatched every agent; it wrote no product code).
**Release record:** RescueStock code at `e299d01`, release record `a3669fe` and later record-only commits, branch `claude/serene-heisenberg-h9o5vo`. **Toolkit:** ECCode 0.3.5.
**Record of truth:** `examples/rescuestock/.eccode/events.jsonl` (hash-chained; `eccode audit` OK). The run-by-run account is in [pilot-report.md](pilot-report.md).

## Status in one paragraph

Every RescueStock gate is approved: architecture, design, plan, phases B to G, reworks 1 to 8, and verification. The verification approval was independent: `rev-mv4johr6-0184624c`, with the reviewer's own full re-run `ev-mv4jijpz-01edcd99`. **`eccode deliver` has not run yet.** The engine refuses delivery while a high or critical risk is open. Four high risks can only be closed by a live PayPal run or accepted by the user, and only the user can accept a risk (RISK-1, 2, 13, 16, section 3). Nothing in this report rests on a live PayPal or live model run, because none was run.

## The five verdicts

| # | Verdict | Status |
|---|---|---|
| 1 | ECCode repair verification | **Verified on the declared scope** (Linux, Node 22; Windows through the gating CI job). Three toolkit defect candidates found by the pilot remain unrepaired, and release blocker RB-1 is the user's. |
| 2 | RescueStock functional completion | **Locally complete; delivery pending the user's risk acceptance.** 28 of 45 criteria verified offline, 2 verified against the simulated provider only, 15 locally ready with the live part unverified. |
| 3 | Real-model and PayPal Sandbox integration | **Unverified.** "Locally ready; external integration unverified." No live run happened; the blockers are credentials, network access and a spend ceiling. |
| 4 | Hackathon submission readiness | **Not ready.** The rules are unverified against the primary source, the live PayPal integration is unverified, and four submission items are the user's. |
| 5 | What the pilot proves about ECCode | It proves the gates were enforced and caught real defects on one real multi-phase build. It does **not** prove ECCode beats other workflows. The earlier failed requirement-7 verdict stands unchanged. |

Details for each verdict are in section 4.

## 1. Requirements

All 45 rows are generated from the independently reviewed [evidence table](../../../examples/rescuestock/docs/evidence-table.md), so the statuses cannot drift from it. "Verified (offline, final tree)" means the named tests pass on the final tree, with the fake model and the fake PayPal or loopback stub where a provider is involved. "Locally ready; external integration unverified" means the deterministic part is verified and the live part is not. Each row names its blocker.

| Requirement | Status | Evidence and tested version | Limitation or blocker |
|---|---|---|---|
| RS-01 | Locally ready; external integration unverified | 2 named test(s), suites D LM; cited ev:ev-mv4gkvne-01368b23; final-tree re-run ev-mv4jijpz-01edcd99 (reviewer) and ev-mv4j2zpz-0142cd44; code e299d01, release record a3669fe; Node 22.22, Linux, Chromium (Playwright 1.56.1) | LIVE-M1 (A4/Q3): English and Arabic through the REAL model are not shown equal; offline the fake parser and the CLI and Anthropic adapters (recorded transcript, loopback stub) are. |
| RS-02 | Locally ready; external integration unverified | 2 named test(s), suites D LM; cited ev:ev-mv4gkvne-01368b23; final-tree re-run ev-mv4jijpz-01edcd99 (reviewer) and ev-mv4j2zpz-0142cd44; code e299d01, release record a3669fe; Node 22.22, Linux, Chromium (Playwright 1.56.1) | LIVE-M1 (A4/Q3): reading real photos with the real model, and the CLI image input shape (`schemaAccepted`, F-TR-13), are not run. |
| RS-03 | Locally ready; external integration unverified | 3 named test(s), suites D B LM; cited ev:ev-mv4gkvne-01368b23 ev:ev-mv4gserr-01d67650; final-tree re-run ev-mv4jijpz-01edcd99 (reviewer) and ev-mv4j2zpz-0142cd44; code e299d01, release record a3669fe; Node 22.22, Linux, Chromium (Playwright 1.56.1) | LIVE-M1 (A4/Q3): the EXT-1 ambiguous images are not run against the real model. Degraded paths (timeout, invalid JSON, schema, budget, rate) are verified with the fake. |
| RS-04 | Verified (offline, final tree) | 2 named test(s), suites D; cited ev:ev-mv4gkvne-01368b23; final-tree re-run ev-mv4jijpz-01edcd99 (reviewer) and ev-mv4j2zpz-0142cd44; code e299d01, release record a3669fe; Node 22.22, Linux, Chromium (Playwright 1.56.1) | None recorded for the offline scope. |
| RS-05 | Locally ready; external integration unverified | 2 named test(s), suites D LM; cited ev:ev-mv4gkvne-01368b23; final-tree re-run ev-mv4jijpz-01edcd99 (reviewer) and ev-mv4j2zpz-0142cd44; code e299d01, release record a3669fe; Node 22.22, Linux, Chromium (Playwright 1.56.1) | LIVE-M1 (A4/Q3): resistance of the REAL model to injection (the EXT-1 injection cases) is not run; offline, the structure (data line, fixed prompt, no tool, output shape without permissions) and the fake are verified. |
| RS-06 | Verified (offline, final tree) | 2 named test(s), suites D; cited ev:ev-mv4gkvne-01368b23; final-tree re-run ev-mv4jijpz-01edcd99 (reviewer) and ev-mv4j2zpz-0142cd44; code e299d01, release record a3669fe; Node 22.22, Linux, Chromium (Playwright 1.56.1) | None recorded for the offline scope. |
| RS-07 | Verified (offline, final tree) | 2 named test(s), suites D; cited ev:ev-mv4gkvne-01368b23; final-tree re-run ev-mv4jijpz-01edcd99 (reviewer) and ev-mv4j2zpz-0142cd44; code e299d01, release record a3669fe; Node 22.22, Linux, Chromium (Playwright 1.56.1) | None recorded for the offline scope. |
| RS-08 | Verified (offline, final tree) | 1 named test(s), suites D; cited ev:ev-mv4gkvne-01368b23; final-tree re-run ev-mv4jijpz-01edcd99 (reviewer) and ev-mv4j2zpz-0142cd44; code e299d01, release record a3669fe; Node 22.22, Linux, Chromium (Playwright 1.56.1) | None recorded for the offline scope. |
| RS-09 | Verified (offline, final tree) | 2 named test(s), suites D; cited ev:ev-mv4gkvne-01368b23; final-tree re-run ev-mv4jijpz-01edcd99 (reviewer) and ev-mv4j2zpz-0142cd44; code e299d01, release record a3669fe; Node 22.22, Linux, Chromium (Playwright 1.56.1) | None recorded for the offline scope. |
| RS-10 | Verified (offline, final tree) | 1 named test(s), suites D; cited ev:ev-mv4gkvne-01368b23; final-tree re-run ev-mv4jijpz-01edcd99 (reviewer) and ev-mv4j2zpz-0142cd44; code e299d01, release record a3669fe; Node 22.22, Linux, Chromium (Playwright 1.56.1) | None recorded for the offline scope. |
| RS-11 | Verified (offline, final tree) | 1 named test(s), suites D; cited ev:ev-mv4gkvne-01368b23; final-tree re-run ev-mv4jijpz-01edcd99 (reviewer) and ev-mv4j2zpz-0142cd44; code e299d01, release record a3669fe; Node 22.22, Linux, Chromium (Playwright 1.56.1) | None recorded for the offline scope. |
| RS-12 | Verified (offline, final tree) | 2 named test(s), suites D; cited ev:ev-mv4gkvne-01368b23; final-tree re-run ev-mv4jijpz-01edcd99 (reviewer) and ev-mv4j2zpz-0142cd44; code e299d01, release record a3669fe; Node 22.22, Linux, Chromium (Playwright 1.56.1) | None recorded for the offline scope. |
| RS-13 | Verified (offline, final tree) | 2 named test(s), suites D; cited ev:ev-mv4gkvne-01368b23; final-tree re-run ev-mv4jijpz-01edcd99 (reviewer) and ev-mv4j2zpz-0142cd44; code e299d01, release record a3669fe; Node 22.22, Linux, Chromium (Playwright 1.56.1) | The voids go to the fake provider; a plain void on the real Sandbox is checked by LIVE-P2 (RS-32(b) asserts both authorizations VOIDED at PayPal), which was not run. |
| RS-14 | Verified (offline, final tree) | 2 named test(s), suites D; cited ev:ev-mv4gkvne-01368b23; final-tree re-run ev-mv4jijpz-01edcd99 (reviewer) and ev-mv4j2zpz-0142cd44; code e299d01, release record a3669fe; Node 22.22, Linux, Chromium (Playwright 1.56.1) | None recorded for the offline scope. |
| RS-15 | Verified (offline, final tree) | 2 named test(s), suites D; cited ev:ev-mv4gkvne-01368b23; final-tree re-run ev-mv4jijpz-01edcd99 (reviewer) and ev-mv4j2zpz-0142cd44; code e299d01, release record a3669fe; Node 22.22, Linux, Chromium (Playwright 1.56.1) | The voids that expiry queues go to the fake provider; a plain void on the real Sandbox is checked by LIVE-P2 (RS-32(b)), which was not run. |
| RS-16 | Verified (offline, final tree) | 1 named test(s), suites D; cited ev:ev-mv4gkvne-01368b23; final-tree re-run ev-mv4jijpz-01edcd99 (reviewer) and ev-mv4j2zpz-0142cd44; code e299d01, release record a3669fe; Node 22.22, Linux, Chromium (Playwright 1.56.1) | None recorded for the offline scope. |
| RS-17 | Verified (offline, final tree) | 2 named test(s), suites D B; cited ev:ev-mv4gkvne-01368b23 ev:ev-mv4gserr-01d67650; final-tree re-run ev-mv4jijpz-01edcd99 (reviewer) and ev-mv4j2zpz-0142cd44; code e299d01, release record a3669fe; Node 22.22, Linux, Chromium (Playwright 1.56.1) | The authorization voids run against the fake provider. |
| RS-18 | Locally ready; external integration unverified | 2 named test(s), suites D LP; cited ev:ev-mv4gkvne-01368b23; final-tree re-run ev-mv4jijpz-01edcd99 (reviewer) and ev-mv4j2zpz-0142cd44; code e299d01, release record a3669fe; Node 22.22, Linux, Chromium (Playwright 1.56.1) | LIVE-P1 (A6/Q2), (A2): cancel and abandon against the real Sandbox are not run (`rs18-cancel-abandon.test.js` exists and refuses without its flag). |
| RS-19 | Locally ready; external integration unverified | 2 named test(s), suites D LP; cited ev:ev-mv4gkvne-01368b23; final-tree re-run ev-mv4jijpz-01edcd99 (reviewer) and ev-mv4j2zpz-0142cd44; code e299d01, release record a3669fe; Node 22.22, Linux, Chromium (Playwright 1.56.1) | LIVE-P1 (A6/Q2), (A2): the amount the real Sandbox receives and its refusal of tampering are not run; the fake and the loopback stub show the exact request body the adapter sends. |
| RS-20 | Locally ready; external integration unverified | 3 named test(s), suites D LP; cited ev:ev-mv4gkvne-01368b23 ev:ev-mv4gvr0e-018f354c; final-tree re-run ev-mv4jijpz-01edcd99 (reviewer) and ev-mv4j2zpz-0142cd44; code e299d01, release record a3669fe; Node 22.22, Linux, Chromium (Playwright 1.56.1) | LIVE-P1 (A6/Q2), (A2), OQ-D5; SEC-18: the double-capture argument's layers 4 and 5 (`PayPal-Request-Id` replay, `final_capture` refusing a second capture) rest on the fake's model of PayPal until the live run. The exactly-one-capture-per-order result holds against the fake. |
| RS-21 | Locally ready; external integration unverified | 2 named test(s), suites D; cited ev:ev-mv4gkvne-01368b23; final-tree re-run ev-mv4jijpz-01edcd99 (reviewer) and ev-mv4j2zpz-0142cd44; code e299d01, release record a3669fe; Node 22.22, Linux, Chromium (Playwright 1.56.1) | LIVE-P1 does NOT cover this (FU-52): authorization DENIED or PENDING is exercised by no live file; the fake's model is the only evidence (OQ-D5). |
| RS-22 | Locally ready; external integration unverified | 2 named test(s), suites D; cited ev:ev-mv4gkvne-01368b23; final-tree re-run ev-mv4jijpz-01edcd99 (reviewer) and ev-mv4j2zpz-0142cd44; code e299d01, release record a3669fe; Node 22.22, Linux, Chromium (Playwright 1.56.1) | LIVE-P1 does NOT cover this (FU-52): capture PENDING or DECLINED, refund PENDING or FAILED, a void after a capture and the EXPIRED read after a refused void are exercised by no live file; compensation rests on the fake's model of PayPal (SEC-18, OQ-D5). |
| RS-23 | Locally ready; external integration unverified | 1 named test(s), suites D LP; cited ev:ev-mv4gkvne-01368b23; final-tree re-run ev-mv4jijpz-01edcd99 (reviewer) and ev-mv4j2zpz-0142cd44; code e299d01, release record a3669fe; Node 22.22, Linux, Chromium (Playwright 1.56.1) | LIVE-P1 (A6/Q2), (A2), Q6 (a public webhook URL): real signed deliveries and the real event names (OQ-D5) are not run. |
| RS-24 | Locally ready; external integration unverified | 1 named test(s), suites D LP; cited ev:ev-mv4gkvne-01368b23; final-tree re-run ev-mv4jijpz-01edcd99 (reviewer) and ev-mv4j2zpz-0142cd44; code e299d01, release record a3669fe; Node 22.22, Linux, Chromium (Playwright 1.56.1) | LIVE-P1 (A6/Q2), (A2): real PayPal verification is not run. Cross-merchant signature rejection (FU-44) is not covered by LIVE-P1 either: the fake's signing string does not include the merchant key. |
| RS-25 | Verified against the simulated provider only | 2 named test(s), suites D; cited ev:ev-mv4gkvne-01368b23; final-tree re-run ev-mv4jijpz-01edcd99 (reviewer) and ev-mv4j2zpz-0142cd44; code e299d01, release record a3669fe; Node 22.22, Linux, Chromium (Playwright 1.56.1) | OQ-D5, SEC-18: no live file covers a lost capture answer (LIVE-P1 does NOT; the fake's model is the only evidence): that the real Sandbox shows what the fake shows after a lost answer (the capture visible through a read of the authorization and the order) is not run. |
| RS-26 | Locally ready; external integration unverified | 4 named test(s), suites D; cited ev:ev-mv4gkvne-01368b23 ev:ev-mv4gvr0e-018f354c; final-tree re-run ev-mv4jijpz-01edcd99 (reviewer) and ev-mv4j2zpz-0142cd44; code e299d01, release record a3669fe; Node 22.22, Linux, Chromium (Playwright 1.56.1) | LIVE-P1 does NOT cover this (FU-52): `PayPal-Request-Id` retention across a process takeover is exercised by no live file. SEC-18: RS-26 on the Sandbox rests on the fake's model of PayPal. The process-level behaviour (kill, restart, takeover, one non-replayed capture per order) is verified with the fake; only Linux was run (SIGSTOP). |
| RS-27 | Verified (offline, final tree) | 2 named test(s), suites D; cited ev:ev-mv4gkvne-01368b23; final-tree re-run ev-mv4jijpz-01edcd99 (reviewer) and ev-mv4j2zpz-0142cd44; code e299d01, release record a3669fe; Node 22.22, Linux, Chromium (Playwright 1.56.1) | None recorded for the offline scope. |
| RS-28 | Verified (offline, final tree) | 1 named test(s), suites D; cited ev:ev-mv4gkvne-01368b23; final-tree re-run ev-mv4jijpz-01edcd99 (reviewer) and ev-mv4j2zpz-0142cd44; code e299d01, release record a3669fe; Node 22.22, Linux, Chromium (Playwright 1.56.1) | None recorded for the offline scope. |
| RS-29 | Verified (offline, final tree) | 7 named test(s), suites D B I; cited ev:ev-mv4gkvne-01368b23 ev:ev-mv4gsi7o-01ea49ae; final-tree re-run ev-mv4jijpz-01edcd99 (reviewer) and ev-mv4j2zpz-0142cd44; code e299d01, release record a3669fe; Node 22.22, Linux, Chromium (Playwright 1.56.1) | Scope (SEC-G-1): every git-tracked or untracked-unignored file is read, including the project record `.eccode/` and its run logs in `.eccode/evidence`, `src/`, `scripts/`, `package.json`, the lockfile, every document of any type, every PNG chunk except pixel data and the bytes after IEND, and the screenshots of the browser run (the B tag: the browser run writes them, the scan reads them). Each file is checked for every canary and for the high-confidence secret shapes (bearer, basic, API key, PayPal token, assigned credential, URL password, private key, JWT, a long mixed-case token); exceptions are listed by path and exact fragment (test sources that hold fake credentials on purpose, a few lines of the record that quote a probe) and a stale entry fails. The security review's planting probe (17 plants) is caught in full. Screenshots are rasters: their file names and PNG chunks are scanned, not their pixels (the application never draws a secret). Secret SHAPES are matched by patterns, so a secret of an unknown shape would pass; the canaries are the strong check. (I) inspected by the phase G technical review (rev-mv4fdv59-01732f16): the screenshots labelling-sandbox-stub-1280, six-questions-1280 and a11y-stranded-1280, `docs/submission` and the README hold no secret value. |
| RS-30 | Verified (offline, final tree) | 2 named test(s), suites D; cited ev:ev-mv4gkvne-01368b23; final-tree re-run ev-mv4jijpz-01edcd99 (reviewer) and ev-mv4j2zpz-0142cd44; code e299d01, release record a3669fe; Node 22.22, Linux, Chromium (Playwright 1.56.1) | None recorded for the offline scope. |
| RS-31 | Locally ready; external integration unverified | 2 named test(s), suites D B LP; cited ev:ev-mv4gkvne-01368b23 ev:ev-mv4gserr-01d67650; final-tree re-run ev-mv4jijpz-01edcd99 (reviewer) and ev-mv4j2zpz-0142cd44; code e299d01, release record a3669fe; Node 22.22, Linux, Chromium (Playwright 1.56.1) | LIVE-P1, LIVE-P2 (A6/Q2): RS-31(b), the hosted Sandbox approval page with a Sandbox buyer account and its screenshots, is not run. |
| RS-32 | Locally ready; external integration unverified | 4 named test(s), suites D B LP; cited ev:ev-mv4gkvne-01368b23 ev:ev-mv4gserr-01d67650; final-tree re-run ev-mv4jijpz-01edcd99 (reviewer) and ev-mv4j2zpz-0142cd44; code e299d01, release record a3669fe; Node 22.22, Linux, Chromium (Playwright 1.56.1) | LIVE-P1, LIVE-P2 (A6/Q2): RS-32(b), the same replacement on the hosted Sandbox, is not run. |
| RS-33 | Verified (offline, final tree) | 2 named test(s), suites D B; cited ev:ev-mv4gkvne-01368b23 ev:ev-mv4gserr-01d67650; final-tree re-run ev-mv4jijpz-01edcd99 (reviewer) and ev-mv4j2zpz-0142cd44; code e299d01, release record a3669fe; Node 22.22, Linux, Chromium (Playwright 1.56.1) | None recorded for the offline scope. |
| RS-34 | Verified against the simulated provider only | 4 named test(s), suites D B; cited ev:ev-mv4gkvne-01368b23 ev:ev-mv4gserr-01d67650; final-tree re-run ev-mv4jijpz-01edcd99 (reviewer) and ev-mv4j2zpz-0142cd44; code e299d01, release record a3669fe; Node 22.22, Linux, Chromium (Playwright 1.56.1) | LIVE-P1 (A2, SEC-3): the Sandbox adapter's labels were shown against the loopback stub in test mode only; the same page against the real Sandbox host (no test-mode banner, the real single-credential notice) is not run. |
| RS-35 | Verified (offline, final tree) | 2 named test(s), suites D B I; cited ev:ev-mv4gkvne-01368b23 ev:ev-mv4gserr-01d67650; final-tree re-run ev-mv4jijpz-01edcd99 (reviewer) and ev-mv4j2zpz-0142cd44; code e299d01, release record a3669fe; Node 22.22, Linux, Chromium (Playwright 1.56.1) | (I) inspected by the phase G technical review (rev-mv4fdv59-01732f16): the screenshot six-questions-1280 answers all six questions from codes. |
| RS-36 | Verified (offline, final tree) | 3 named test(s), suites D I; cited ev:ev-mv4gkvne-01368b23; final-tree re-run ev-mv4jijpz-01edcd99 (reviewer) and ev-mv4j2zpz-0142cd44; code e299d01, release record a3669fe; Node 22.22, Linux, Chromium (Playwright 1.56.1) | (I) F-TR-9, the inspection that `domain/derive.js` implements the derivation table row by row, is a person's and was done: the phase G technical review (FU-62, `rev-mv4fdv59-01732f16`) read the final `derive.js` against the brief's table and revision 2 row by row, found that it conforms, and found no table that stores a rescue status; the phase B review (`rev-mv1hc5zg-01a3fc75`) had done it for revision 2. Row 12 also accepts `draft`, a real plan status the table does not name (a harmless totalising extension, TR-G-6). A later edit of `derive.js` voids the inspection; the tests above pin the rows. |
| RS-37 | Verified (offline, final tree) | 2 named test(s), suites D; cited ev:ev-mv4gkvne-01368b23; final-tree re-run ev-mv4jijpz-01edcd99 (reviewer) and ev-mv4j2zpz-0142cd44; code e299d01, release record a3669fe; Node 22.22, Linux, Chromium (Playwright 1.56.1) | The forced reset's void and read-resolve pass run against the fake provider (SEC-11). |
| RS-38 | Verified (offline, final tree) | 2 named test(s), suites D; cited ev:ev-mv4gkvne-01368b23; final-tree re-run ev-mv4jijpz-01edcd99 (reviewer) and ev-mv4j2zpz-0142cd44; code e299d01, release record a3669fe; Node 22.22, Linux, Chromium (Playwright 1.56.1) | None recorded for the offline scope. |
| RS-39 | Verified (offline, final tree) | 2 named test(s), suites D; cited ev:ev-mv4gkvne-01368b23; final-tree re-run ev-mv4jijpz-01edcd99 (reviewer) and ev-mv4j2zpz-0142cd44; code e299d01, release record a3669fe; Node 22.22, Linux, Chromium (Playwright 1.56.1) | None recorded for the offline scope. |
| NFR1 | Verified (offline, final tree) | 3 named test(s), suites D I; cited ev:ev-mv4gkvne-01368b23; final-tree re-run ev-mv4jijpz-01edcd99 (reviewer) and ev-mv4j2zpz-0142cd44; code e299d01, release record a3669fe; Node 22.22, Linux, Chromium (Playwright 1.56.1) | USER-Q9: the run on the Node 22.5 branch (the floor the user has not yet confirmed) is the user's; only Node 22.22 was available, and the older binaries used by `start-old-node` are 20 and 21. The clean-checkout run is in the handoff, not in this table. |
| NFR2 | Verified (offline, final tree) | 5 named test(s), suites D B; cited ev:ev-mv4gkvne-01368b23 ev:ev-mv4gserr-01d67650; final-tree re-run ev-mv4jijpz-01edcd99 (reviewer) and ev-mv4j2zpz-0142cd44; code e299d01, release record a3669fe; Node 22.22, Linux, Chromium (Playwright 1.56.1) | Chromium only (other browsers, screen readers and real touch devices were not run). No accessibility library was used: the audit is hand-written (names, 44 px targets, computed 4.5:1 contrast, focus indicators, no horizontal scroll); a native date-time control's focus is shown by comparing pictures of it, not by its style. |
| NFR3 | Verified (offline, final tree) | 5 named test(s), suites D I; cited ev:ev-mv4gkvne-01368b23; final-tree re-run ev-mv4jijpz-01edcd99 (reviewer) and ev-mv4j2zpz-0142cd44; code e299d01, release record a3669fe; Node 22.22, Linux, Chromium (Playwright 1.56.1) | That the live scripts REFUSE is verified, including the real `npm run test:live-model` and `npm run test:live-paypal` lines run without a flag under the net guard (the second prints six refusals and exits 1, as the runbook says); that they RUN correctly is not (LIVE-M1, LIVE-P1: never run). (I) inspected by the phase G technical review (rev-mv4fdv59-01732f16): both runners label their reports (live-support.js L93-L95; run-live-model.js L182-L187). |
| NFR4 | Verified (offline, final tree) | 2 named test(s), suites D I; cited ev:ev-mv4gkvne-01368b23; final-tree re-run ev-mv4jijpz-01edcd99 (reviewer) and ev-mv4j2zpz-0142cd44; code e299d01, release record a3669fe; Node 22.22, Linux, Chromium (Playwright 1.56.1) | (I) inspected by the phase G technical review (rev-mv4fdv59-01732f16): secrets are read only from process.env, and the secret entries of `.env.example` are commented placeholders. |
| NFR5 | Verified (offline, final tree) | 2 named test(s), suites D; cited ev:ev-mv4gkvne-01368b23; final-tree re-run ev-mv4jijpz-01edcd99 (reviewer) and ev-mv4j2zpz-0142cd44; code e299d01, release record a3669fe; Node 22.22, Linux, Chromium (Playwright 1.56.1) | The API p95 and the suite time are printed by `scripts/report-p95.js` in the log of each full `npm test` run (below), on this host only. |
| NFR6 | Locally ready; external integration unverified | 2 named test(s), suites D LM; cited ev:ev-mv4gkvne-01368b23; final-tree re-run ev-mv4jijpz-01edcd99 (reviewer) and ev-mv4j2zpz-0142cd44; code e299d01, release record a3669fe; Node 22.22, Linux, Chromium (Playwright 1.56.1) | LIVE-M1 (A4/Q3): the real cost report is not run. The budget case runs with RS_MODEL_CUSTOMER_DAILY_SHARE=1 (F-TR-18): it shows the global daily budget refusing the third extract; with the default per-customer share a single customer is stopped earlier, which the unit tests of the gate show separately. |

**Counts:** 28 verified offline, 2 verified against the simulated provider only (RS-25, RS-34), 15 locally ready with the live part unverified (RS-01, 02, 03, 05, 18 to 24, 26, 31, 32, NFR6).

**Final-tree runs** (all under the suite lock):

| Check | Result | Evidence |
|---|---|---|
| `npm test`, including the fake-provider extraction eval 200/200 | 2,406 tests: 2,398 pass, 0 fail, 8 skipped, each skip with a printed reason | `ev-mv4jijpz-01edcd99` (independent reviewer), `ev-mv4j2zpz-0142cd44` |
| Browser suite, Chromium at 360 and 1280 px | 28 of 28 | same runs |
| Clean checkout: install from the registry, test, start, health check | passes | same runs |
| Full suite with the clock 30 days past the tests' pinned date | 2,398 pass, 0 fail | `ev-mv4jlh46-01a3c88c` |
| API p95 latency and suite time | 56.6 ms against 300 ms; 103.6 s against 300 s | `ev-mv4jijpz-01edcd99` |

## 2. Accepted limits

The verification report lists every limit with its decision: `examples/rescuestock/.eccode/artifacts/verification/submission.md`, section 5. The ones a user is most likely to meet:

- **Demo address.** Open `http://localhost:3000`, not 127.0.0.1. The simulated PayPal approval returns to `localhost`, and the login follows the host name. Two lines still mention 127.0.0.1: README L77 and live-paypal.md L115.
- **Static scans are a safety net, not proof.** The SQL scan misses three paths through allow-listed query builders, and two obfuscated forms. No such code exists today (dec-mv4i8iob-01e31f5a). The secrets scan matches known shapes only, and reads files rather than git history.
- **Narrower than asked.** Audit rows for refused admin requests cover the refund action only. The unresolved metric counts failed refunds but not escalated reservations. Completed holds of a cancelled plan are not listed for the café (dec-mv47vma5-01d0d177).
- **Lockfile.** The lockfile lacks playwright's optional macOS-only `fsevents` entry, so a macOS install fetches it without an integrity pin.
- **Platform.** Tested on Linux, Node 22.22 and Chromium only. The Node 22.5 floor is the user's question (USER-Q9).

## 3. Open risks and what the user decides

**Critical risks, all mitigated with evidence on the final tree:** double capture (RISK-3), oversell (RISK-4) and access across accounts (RISK-5). Also mitigated: prompt injection containment (RISK-6), lost payment outcomes (RISK-8), secrets leakage (RISK-9) and model spend abuse (RISK-17). Scope against time (RISK-11) is closed.

**Mitigated against PayPal as simulated, not the real one.** RISK-3 and RISK-8 are mitigated only against the fake provider's model of PayPal: PayPal's own replay protection, and the payment outcomes no live test covers (the FU-52 list), stay unverified until new live tests exist. Running the existing runbooks does not close those gaps (finding TR-V-1).

**High risks only the user can accept, or close with a live run:**

| Risk | What is unverified | What the code does | How to verify live |
|---|---|---|---|
| RISK-1 | Every live PayPal item, because this environment cannot reach PayPal's Sandbox hosts | A fake provider and a loopback stub implement the full provider contract with fault injection; every live row names its blocker | `examples/rescuestock/docs/runbooks/live-paypal.md` §1–6 on a networked machine |
| RISK-2 | The live model and live PayPal runs, because no credentials or model key exist here | Credentials are read only from the environment; the live scripts refuse without their flags, and that is tested | Provide the runbooks' variables as environment secrets |
| RISK-13 | PayPal's real authorization validity, honour window and expired status | It re-reads expiry with a 10-minute margin, cancels expired holds, settles an expired read after a refused void, and caps the wait at the 30-minute reservation lifetime; all of this is tested against the fake only | LIVE-P1 shows the statuses; the expired-after-void case needs a new live test |
| RISK-16 | The real hosted approval page and its redirect back, which could lose the café's login | SameSite=Lax cookies, an owner-checked idempotent return, and real Chromium cross-site journeys pass | Runbook §6 with a Sandbox buyer account, using `localhost` |

**Medium risks, not blocking:** RISK-7, 10, 12, 14, 18, 19, 20 and 21. RISK-21 is the one accidental live-model start during a phase D review, with possible spend of at most USD 1.10. The actual amount is unknown until the user checks their usage.

## 4. The verdicts in detail

### Verdict 1: ECCode repair verification. Verified on the declared scope.

- **Original findings F1 to F9.** An independent verifier found three new bypasses at 0.3.0 (`docs/evidence/verification-0.3.0/REPORT.md`). The repairs were then independently reviewed and approved: engine NEW-1 to NEW-5, and the guard after five rounds. At 0.3.1 every finding was closed on the declared scope, each with its named residual (`docs/build/eccode-verification.md`).
- **Defects the pilot found in the toolkit,** each repaired on its own branch with failing-first tests and an independent review, never hot-patched:
  - **Nested-root guard (0.3.1).** The guard judged a nested project by the outer repository's record.
  - **TK-1 and TK-2.** Phase artifacts were read from the latest handoff only, and the test suite read the real shared-memory store.
  - **TK-3.** A Windows record-lock race.
  - **TK-6 (0.3.4).** In a nested project the tree digest was silently null, so evidence tree-pinning was off. All 19 earlier pilot submissions carry no commit or tree, which the release check reports as ten baseline warnings.
  - **TK-8 (0.3.5).** Approval order: an older rework approval overrode a newer phase approval of the same file.
- **Today.** `npm run check` on 0.3.5: validation passes and 332 of 332 tests pass (orchestrator re-run, 2026-10-12). Windows runs through the gating CI job (RB-2 closed).
- **Not repaired, filed for the next maintenance pass:**
  - **TK-4.** Unknown CLI flags are ignored silently.
  - **TK-7.** Non-ASCII paths are C-quoted by git.
  - **TK-9.** The guard reads a quoted `>` in a note as a redirection. This is one of several raw-text over-denials, each with a documented workaround.
  - **TK-5 withdrawn as a defect.** The engine deliberately refuses a re-claim while owned files are uncommitted (`DIRTY_OWNERSHIP`). The orchestrate skill should state "commit the first round before re-dispatching a reset task".
- **Release blocker RB-1 is the user's.** The documented install path (the marketplace's default branch) does not install this version until the work branch is merged or the marketplace points at the release commit.

### Verdict 2: RescueStock functional completion. Locally complete; delivery pending.

- **Built and reviewed.** The full product is built: emergency cup and lid purchasing for cafés, with a deterministic planner, authorize-then-capture payments with compensation and recovery, three dashboards, labelled simulations, and model extraction behind a narrow adapter.
- **Every gate approved by independent reviewers.** Reviews were recorded only after the security reviewer's draft was final, from phase F on.
- **Delivery waits on the user.** `eccode deliver` is refused only by the four high risks in section 3. Once the user accepts them or closes them with live runs, the delivery-lead runs `eccode deliver` and the final handoff is produced.

### Verdict 3: Real-model and PayPal Sandbox integration. Unverified.

No live run happened. The adapters exist and are tested against a recorded transcript, a loopback stub and a fake with fault injection. What remains open:

- **LIVE-M1:** the live model evaluation, cost report and image input shape.
- **LIVE-P1:** live Sandbox orders, authorize, capture, void, refund and webhooks.
- **LIVE-P2:** the hosted approval journey.
- **OQ-D5:** PayPal behaviours the design assumed.
- **FU-52:** outcomes that need new live tests even after a clean live run.

The blockers are the Sandbox network allow-list, credentials, and a model spend ceiling with a logged-in CLI or API key. The runbooks give the exact steps.

### Verdict 4: Hackathon submission readiness. Not ready.

- **Rules.** The hackathon rules, deadline and judging criteria were checked only through web search on 2026-10-09. The Devpost pages were blocked, and the Devpost connector now needs the user to sign in again. The submission checklist marks every fact unverified.
- **PayPal.** A PayPal hackathon entry is unlikely to be judged well without a real Sandbox run, which is verdict 3.
- **The user's items:**
  - edit the "own decisions" line in `examples/rescuestock/docs/submission/project-description.md` (L42);
  - fill in the repository and video links;
  - record the demo video;
  - re-check every hackathon fact on https://paypalaihackathon.devpost.com/rules;
  - decide RB-1 and keep the repository public with its MIT licence.
- **Drafted, nothing submitted:** the submission drafts, the README and the runbooks are written.

### Verdict 5: What the pilot does and does not prove about ECCode.

**It proves, on this one build,** that the gates were enforced and that independent reviews caught defects the authors missed:

| Defect caught by a reviewer | Effect if missed |
|---|---|
| Plan verification commands that passed before any work existed (F-PL-1) | Tasks could have been marked done on nothing |
| A test loosened during rework-5 (TR-R5-1) | A refund PayPal refused would have shown as money returned |
| A payment plan stuck on failing reads (TR-F-1) | The café would never be told to act |
| A plan-wide handover block in the orchestrator's own decision | A sibling order would have been blocked by its neighbour's refund |
| A secrets scan that missed 10 of 17 planted canaries | Credentials in those places would have gone undetected |
| A date dependency | Tests could have failed on their own nine days later |

**What the engine itself did:**
- refused evidence recorded on a stale tree;
- refused a re-claim over uncommitted work;
- refused review records that cited failing runs.

**Record counts:**
- 30 recorded reviews;
- 12 of 30 reviews requested changes (40%);
- 13 review records refused by the gate rules;
- 8 reworks;
- 55 recorded decisions;
- 1,052 recorded evidence runs.

**It does not prove superiority.** RescueStock is a case study whose requirements the developers know. It is one run, with no control condition, and one orchestrator wrote every dispatch prompt (deviation D2). The failed requirement-7 verdict in `docs/acceptance-report.md` stands: no valid new evaluation exists, so "ECCode beats competing workflows" remains **FAILED**.

**Costs and human help were real:**
- About 22.9 million recorded agent tokens over about 2,114 minutes. This is a lower bound, because some runs have no usage figure.
- USD 1.10 is the upper bound of the one incident; other model spend is not measured in dollars.
- The user raised the rework and runtime limits twice.
- Several orchestrator errors were caught and recorded: an overstated planner claim, a wrong handover rule, a brief that led to a refused claim, and a README promise with no owner.
- The engineering memory was consulted (44 applicability checks) but cited only once; no lesson changed an outcome in this build.

## 5. What the user does next

1. **Accept or close the four high risks.** Run the commands the orchestrator gave in the session, from a terminal; each asks you to type "yes". Then tell the orchestrator, so the delivery-lead can run `eccode deliver`.
2. **Reconnect the Devpost connector,** so the rules can be checked against the primary source.
3. **Complete the submission items** listed under verdict 4.
4. **Optional, for a stronger entry:** run the live PayPal runbook and the live model runbook with your own credentials.
5. **Check your model usage** for the RISK-21 incident.
6. **Decide RB-1:** merge to the default branch.
