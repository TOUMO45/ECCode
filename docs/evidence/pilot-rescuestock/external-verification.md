# RescueStock: external verification (real model and PayPal Sandbox)

**Date:** 2026-10-12. **Author:** the orchestrator. **Status: NOT VERIFIED.** No real-model call and no PayPal Sandbox call has been made for verification. The user has **not** accepted RISK-1, RISK-2, RISK-13 or RISK-16 (instruction of 2026-10-12), and the orchestrator has not changed any risk's status.

This file sits outside the RescueStock project tree (`examples/rescuestock`), so writing it does not change any reviewed file or the delivery state. The project's own `docs/evidence-table.md` is a reviewed artifact of the approved verification gate. Live results will be folded into it through a reviewed change once they exist (section 6).

## 1. Three points clarified

### 1.1 The 8 tests that did not pass out of 2,406

They are **skipped, not failed**: 0 tests failed. Final verification run `ev-mv4jijpz-01edcd99` reports 2,406 tests, 2,398 pass, 0 fail, 8 skipped. Each skip prints its reason, and each skipped case passes for the other providers in the same run (checked in that log: every skipped title also appears as `ok` without a skip).

| # | Skipped test | Why | Where the same check passes |
|---|---|---|---|
| 1 | RS-03: maps busy to PROVIDER_BUSY | The simulated model provider has no "busy" fault | The Claude CLI adapter and the Anthropic HTTP adapter, against a recorded transcript and a loopback stub |
| 2–3 | Token timeout; token rate limit (HTTP 429) | The simulated PayPal provider has no OAuth step | The PayPal Sandbox adapter against the loopback stub |
| 4–8 | PayPal-Request-Id on every call; one cached OAuth token; createOrder body; method, path and body of each call; webhook verification body | The simulated PayPal provider is not a REST client, so it has no wire format | The PayPal Sandbox adapter against the loopback stub |

None of these 8 touches a real service. Passing for the Sandbox adapter means it sends the right requests to a local stub, not that PayPal accepts them.

### 1.2 The three possible ECCode defects, reproduced on 2026-10-12

Each was reproduced on toolkit 0.3.5 in a throwaway directory under the session scratchpad, not in any project record. None is repaired. Repairs would go on separate branches with failing-first tests and an independent review.

| Id | Defect | Reproduction | Effect |
|---|---|---|---|
| TK-4 | The CLI silently ignores an unknown or misspelled flag | `run correct <id> --cost 1.10` printed "corrected", exited 0, and the budget stayed at $0 (the flag is `--cost-usd`) | A correction or setting can silently not happen; the orchestrator only noticed during the pilot by re-reading the budget |
| TK-7 | Changed-file detection calls git without `-z`, so git returns a non-ASCII path quoted and escaped | An untracked `ü.js` is listed as `"\303\274.js"`; with `-z` it is `ü.js` | A task touching a non-ASCII file name would be refused as undeclared, or miss the file. RescueStock has no such names, so the pilot was not affected |
| TK-9 | The guard reads a quoted `>` inside a note as a shell redirection | The same `gate submit` for delivery-lead was allowed with "then" and **denied** with `"Admin routes > refund_order"`, in single or double quotes, as "no claimed task" | A legitimate command is refused; the workaround is to drop the character |

### 1.3 "No live run" versus "an accidental model run"

Both are true, and they mean different things:

- **No live run as evidence.** No real-model or PayPal Sandbox result is cited anywhere, and every live criterion is marked unverified.
- **One accidental start, recorded as incident RISK-21.** During the phase D security review (run `run-mv330tea`), a probe of the live-model runner used the ceiling 5.0000001. The runner rounded it to 5 before checking it, so it accepted it. With the session's logged-in Claude CLI on the PATH, a real run started for up to 30 seconds before the probe's timeout stopped it.
- **What is unknown.** Nobody knows whether any call completed or was billed: at most USD 0.05 per call, USD 1.10 in the worst case.
- **How it was handled.** Nothing from it was cited. The rounding bug was fixed (TR-D-10), and later probes ran with no CLI on the PATH. The USD 1.10 is recorded as an upper bound.
- **Still open.** Only the user can check the account's actual usage.

## 2. Hackathon rules

**The public rules page could not be reached from this environment.**
- `https://paypalaihackathon.devpost.com/rules`, `devpost.com` and `developer.paypal.com` are refused by the environment's network proxy: `CONNECT tunnel failed, response 403`.
- The web-fetch tool could not resolve any outside host.
- So the rules remain **unverified against the primary source**. The Devpost connector is not needed: allowing those hosts in the environment's network settings, or the user reading the page, is enough.

**Secondary source only** (web search on 2026-10-12, which returned quotes attributed to the official rules page; not read here):

| Item | As quoted by search results | Note |
|---|---|---|
| Submission period | Oct 1, 2026 (9:15 am PT) to Nov 12, 2026 (12:00 pm PT) | One third-party site says 2:00 pm PT; the official page decides |
| Judging | Dec 1 to Dec 15, 2026; winners around Dec 21 | |
| Criteria | Five, equally weighted: technological implementation ("a real, non-trivial use of PayPal and AI"), design, potential impact, innovation, presentation | |
| Requirements | Meaningful use of PayPal and AI; a working demo judges can run or a hosted version (mockups do not count); a public GitHub repository with an open-source licence file; a demo video under 3 minutes on YouTube; a text description | Judges may score on the description, images and video alone |
| Prizes | Devpost lists USD 67,500; PayPal's blog says USD 60,000+ | |

Sources: [Devpost rules page](https://paypalaihackathon.devpost.com/rules) (not reachable here), [PayPal community blog](https://developer.paypal.com/community/blog/PayPal_AI_Hackathon/), [The GenAI Magazine](https://thegenaimagazine.com/paypal-ai-hackathon-2026-ideas-deadline-prizes), [DevGrants Daily](https://devgrantsdaily.com/items/2026-10-02-paypal-ai-hackathon-2026/), [Course Joiner](https://coursejoiner.com/hackathon/paypal-ai-hackathon-2026/).

**Consequence for RescueStock.** If these quotes are accurate, "a real, non-trivial use of PayPal" and "a working demo judges can run" weigh heavily. Today the PayPal side runs only against a simulated provider and a local stub.

## 3. Missing setup data and how to provide it safely

Never paste a key, secret or password into the chat. Add each value in the cloud environment's settings: the environment menu in the session's title bar, then Edit. Use Network secrets if offered, otherwise environment variables. A new session picks them up. Network access is changed in the same place, under Allowed domains, keeping "Allow package managers" ticked. See <https://code.claude.com/docs/en/cloud-environments#network-access>.

| What | Name the app reads | How to provide it | Status today |
|---|---|---|---|
| Network access to PayPal Sandbox | — | Allowed domains: `api-m.sandbox.paypal.com`, `www.sandbox.paypal.com` | **Blocked** (proxy 403) |
| Network access to the rules page | — | Allowed domains: `paypalaihackathon.devpost.com` (and `devpost.com`) | **Blocked** (proxy 403) |
| PayPal Sandbox app credentials | `RS_PAYPAL_DEFAULT_CLIENT_ID`, `RS_PAYPAL_DEFAULT_CLIENT_SECRET` (or the per-supplier sets in `.env.example`) | Network secrets or environment variables, from a Sandbox REST app at developer.paypal.com | Not set |
| PayPal webhook id | `RS_PAYPAL_DEFAULT_WEBHOOK_ID` | Same, after creating the webhook for the seven mapped events (runbook §1) | Not set |
| A genuine webhook delivery sample (RS-23) | `RS_LIVE_PAYPAL_WEBHOOK_SAMPLE` (path to a JSON file) | Captured from the Sandbox dashboard's webhook events; contains no secret, but keep it out of the repository | Not provided |
| Sandbox buyer (personal) account | — | Used by a person at PayPal's approval page; never stored by the app | Needed for every authorization |
| Model spend ceiling | `RS_LIVE_MODEL_CEILING_USD` (0.01 to 5.00) | Stated by the user in chat as a number; it is not a secret | **Not given; no model call will be made until it is** |
| Model route | the logged-in `claude` CLI, or `ANTHROPIC_API_KEY` | The CLI here is logged in with the session's own account, and `api.anthropic.com` is reachable. Using it bills that account, so it waits for the ceiling | CLI present; API key not set |
| Live opt-in flags | `RS_LIVE_MODEL=1`, `RS_LIVE_PAYPAL=1` | Set only for the live run itself; never in the offline build | Not set (by rule) |

## 4. The four scenarios requested, against the live tests that exist

| Scenario | Live test today | Can run in this cloud container once data is provided? | Gap |
|---|---|---|---|
| Duplicate capture | **RS-20** (`rs20-double-capture.test.js`): three return hits per order give one authorization; five execute calls give one capture; PayPal refuses a second capture | Yes, but a person must approve each Sandbox order at PayPal (links are printed, 10 minutes per order); the test polls PayPal from the container | None, once run |
| Return to the customer's session | **RS-31(b)** (`journey-sandbox.test.js`, `RS_LIVE_PAYPAL_HEADED=1`): a visible browser, the person approves, and the test checks the browser is back on the app with the session | **No.** It needs a visible browser and PayPal redirecting to the app's `localhost`, so it must run on the user's own machine (runbook §6) | Run by the user |
| Payment failure handling | **None.** The offline suite covers declined, pending and failed outcomes against the simulated provider only (FU-52) | — | A new live test is needed, e.g. with PayPal's Sandbox negative-testing header (`PayPal-Mock-Response`, per PayPal's documentation, not checked here because developer.paypal.com is blocked). The adapter has no hook for that header today, so this needs a reviewed code change |
| Refund | **None.** The refund path is covered offline only | — | A new live test is needed: capture, then refund, then read the capture's refund status at PayPal. This is also a reviewed code change |

**Why new tests need the user first.** The verification gate is approved. The engine allows a change after that only if the user reopens the gate (`eccode gate reopen verification --actor user --resolution "<why>"` in a terminal), or delegates that action. Then a rework adds the two live tests, and both reviewers re-check them.

## 5. Per-criterion status, real integration separated from simulation

Generated from the reviewed evidence table, so it cannot drift from it. "Real integration result" is **Not run** for every row that has a live part: no live run happened. When live runs happen, this column gets the evidence id of each run, and its failures as well as its passes.

| Criterion | Simulation / offline result | Real integration result | Not provable here, and why |
|---|---|---|---|
| RS-01 | Passed (deterministic part, fake model or fake PayPal / loopback stub) | Not run (no credentials, PayPal hosts blocked, no spend ceiling) | LIVE-M1 (A4/Q3): English and Arabic through the REAL model are not shown equal; offline the fake parser and the CLI and Anthropic adapters (recorded transcript, loopback stub) are. |
| RS-02 | Passed (deterministic part, fake model or fake PayPal / loopback stub) | Not run (no credentials, PayPal hosts blocked, no spend ceiling) | LIVE-M1 (A4/Q3): reading real photos with the real model, and the CLI image input shape (`schemaAccepted`, F-TR-13), are not run. |
| RS-03 | Passed (deterministic part, fake model or fake PayPal / loopback stub) | Not run (no credentials, PayPal hosts blocked, no spend ceiling) | LIVE-M1 (A4/Q3): the EXT-1 ambiguous images are not run against the real model. Degraded paths (timeout, invalid JSON, schema, budget, rate) are verified with the fake. |
| RS-04 | Passed (offline, no provider involved or fake/stub where one is) | Not applicable (no external service in scope) | None for the stated scope |
| RS-05 | Passed (deterministic part, fake model or fake PayPal / loopback stub) | Not run (no credentials, PayPal hosts blocked, no spend ceiling) | LIVE-M1 (A4/Q3): resistance of the REAL model to injection (the EXT-1 injection cases) is not run; offline, the structure (data line, fixed prompt, no tool, output shape without permissions) and the fake are verified. |
| RS-06 | Passed (offline, no provider involved or fake/stub where one is) | Not applicable (no external service in scope) | None for the stated scope |
| RS-07 | Passed (offline, no provider involved or fake/stub where one is) | Not applicable (no external service in scope) | None for the stated scope |
| RS-08 | Passed (offline, no provider involved or fake/stub where one is) | Not applicable (no external service in scope) | None for the stated scope |
| RS-09 | Passed (offline, no provider involved or fake/stub where one is) | Not applicable (no external service in scope) | None for the stated scope |
| RS-10 | Passed (offline, no provider involved or fake/stub where one is) | Not applicable (no external service in scope) | None for the stated scope |
| RS-11 | Passed (offline, no provider involved or fake/stub where one is) | Not applicable (no external service in scope) | None for the stated scope |
| RS-12 | Passed (offline, no provider involved or fake/stub where one is) | Not applicable (no external service in scope) | None for the stated scope |
| RS-13 | Passed (offline, no provider involved or fake/stub where one is) | Not applicable (no external service in scope) | None for the stated scope |
| RS-14 | Passed (offline, no provider involved or fake/stub where one is) | Not applicable (no external service in scope) | None for the stated scope |
| RS-15 | Passed (offline, no provider involved or fake/stub where one is) | Not applicable (no external service in scope) | None for the stated scope |
| RS-16 | Passed (offline, no provider involved or fake/stub where one is) | Not applicable (no external service in scope) | None for the stated scope |
| RS-17 | Passed (offline, no provider involved or fake/stub where one is) | Not applicable (no external service in scope) | None for the stated scope |
| RS-18 | Passed (deterministic part, fake model or fake PayPal / loopback stub) | Not run (no credentials, PayPal hosts blocked, no spend ceiling) | LIVE-P1 (A6/Q2), (A2): cancel and abandon against the real Sandbox are not run (`rs18-cancel-abandon.test.js` exists and refuses without its flag). |
| RS-19 | Passed (deterministic part, fake model or fake PayPal / loopback stub) | Not run (no credentials, PayPal hosts blocked, no spend ceiling) | LIVE-P1 (A6/Q2), (A2): the amount the real Sandbox receives and its refusal of tampering are not run; the fake and the loopback stub show the exact request body the adapter sends. |
| RS-20 | Passed (deterministic part, fake model or fake PayPal / loopback stub) | Not run (no credentials, PayPal hosts blocked, no spend ceiling) | LIVE-P1 (A6/Q2), (A2), OQ-D5; SEC-18: the double-capture argument's layers 4 and 5 (`PayPal-Request-Id` replay, `final_capture` refusing a second capture) rest on the fake's model of PayPal until the live run. The exactly-one-capture-per-order result holds against the fake. |
| RS-21 | Passed (deterministic part, fake model or fake PayPal / loopback stub) | Not run (no credentials, PayPal hosts blocked, no spend ceiling) | LIVE-P1 does NOT cover this (FU-52): authorization DENIED or PENDING is exercised by no live file; the fake's model is the only evidence (OQ-D5). |
| RS-22 | Passed (deterministic part, fake model or fake PayPal / loopback stub) | Not run (no credentials, PayPal hosts blocked, no spend ceiling) | LIVE-P1 does NOT cover this (FU-52): capture PENDING or DECLINED, refund PENDING or FAILED, a void after a capture and the EXPIRED read after a refused void are exercised by no live file; compensation rests on the fake's model of PayPal (SEC-18, OQ-D5). |
| RS-23 | Passed (deterministic part, fake model or fake PayPal / loopback stub) | Not run (no credentials, PayPal hosts blocked, no spend ceiling) | LIVE-P1 (A6/Q2), (A2), Q6 (a public webhook URL): real signed deliveries and the real event names (OQ-D5) are not run. |
| RS-24 | Passed (deterministic part, fake model or fake PayPal / loopback stub) | Not run (no credentials, PayPal hosts blocked, no spend ceiling) | LIVE-P1 (A6/Q2), (A2): real PayPal verification is not run. Cross-merchant signature rejection (FU-44) is not covered by LIVE-P1 either: the fake's signing string does not include the merchant key. |
| RS-25 | Passed against the simulated PayPal only | Not run; no live test file exists for it | OQ-D5, SEC-18: no live file covers a lost capture answer (LIVE-P1 does NOT; the fake's model is the only evidence): that the real Sandbox shows what the fake shows after a lost answer (the capture visible through a read of the authorization and the order) is not run. |
| RS-26 | Passed (deterministic part, fake model or fake PayPal / loopback stub) | Not run (no credentials, PayPal hosts blocked, no spend ceiling) | LIVE-P1 does NOT cover this (FU-52): `PayPal-Request-Id` retention across a process takeover is exercised by no live file. SEC-18: RS-26 on the Sandbox rests on the fake's model of PayPal. The process-level behaviour (kill, restart, takeover, one non-replayed capture per order) is verified with the fake; only Linux was run (SIGSTOP). |
| RS-27 | Passed (offline, no provider involved or fake/stub where one is) | Not applicable (no external service in scope) | None for the stated scope |
| RS-28 | Passed (offline, no provider involved or fake/stub where one is) | Not applicable (no external service in scope) | None for the stated scope |
| RS-29 | Passed (offline, no provider involved or fake/stub where one is) | Not applicable (no external service in scope) | None for the stated scope |
| RS-30 | Passed (offline, no provider involved or fake/stub where one is) | Not applicable (no external service in scope) | None for the stated scope |
| RS-31 | Passed (deterministic part, fake model or fake PayPal / loopback stub) | Not run (no credentials, PayPal hosts blocked, no spend ceiling) | LIVE-P1, LIVE-P2 (A6/Q2): RS-31(b), the hosted Sandbox approval page with a Sandbox buyer account and its screenshots, is not run. |
| RS-32 | Passed (deterministic part, fake model or fake PayPal / loopback stub) | Not run (no credentials, PayPal hosts blocked, no spend ceiling) | LIVE-P1, LIVE-P2 (A6/Q2): RS-32(b), the same replacement on the hosted Sandbox, is not run. |
| RS-33 | Passed (offline, no provider involved or fake/stub where one is) | Not applicable (no external service in scope) | None for the stated scope |
| RS-34 | Passed against the simulated PayPal only | Not run; no live test file exists for it | LIVE-P1 (A2, SEC-3): the Sandbox adapter's labels were shown against the loopback stub in test mode only; the same page against the real Sandbox host (no test-mode banner, the real single-credential notice) is not run. |
| RS-35 | Passed (offline, no provider involved or fake/stub where one is) | Not applicable (no external service in scope) | None for the stated scope |
| RS-36 | Passed (offline, no provider involved or fake/stub where one is) | Not applicable (no external service in scope) | None for the stated scope |
| RS-37 | Passed (offline, no provider involved or fake/stub where one is) | Not applicable (no external service in scope) | None for the stated scope |
| RS-38 | Passed (offline, no provider involved or fake/stub where one is) | Not applicable (no external service in scope) | None for the stated scope |
| RS-39 | Passed (offline, no provider involved or fake/stub where one is) | Not applicable (no external service in scope) | None for the stated scope |
| NFR1 | Passed (offline, no provider involved or fake/stub where one is) | Not applicable (no external service in scope) | None for the stated scope |
| NFR2 | Passed (offline, no provider involved or fake/stub where one is) | Not applicable (no external service in scope) | None for the stated scope |
| NFR3 | Passed (offline, no provider involved or fake/stub where one is) | Not applicable (no external service in scope) | None for the stated scope |
| NFR4 | Passed (offline, no provider involved or fake/stub where one is) | Not applicable (no external service in scope) | None for the stated scope |
| NFR5 | Passed (offline, no provider involved or fake/stub where one is) | Not applicable (no external service in scope) | None for the stated scope |
| NFR6 | Passed (deterministic part, fake model or fake PayPal / loopback stub) | Not run (no credentials, PayPal hosts blocked, no spend ceiling) | LIVE-M1 (A4/Q3): the real cost report is not run. The budget case runs with RS_MODEL_CUSTOMER_DAILY_SHARE=1 (F-TR-18): it shows the global daily budget refusing the third extract; with the default per-customer share a single customer is stopped earlier, which the unit tests of the gate show separately. |

**Totals:**
- 28 criteria pass offline with no external service in scope.
- 2 pass against the simulated PayPal only, and no live test exists for them (RS-25, RS-34).
- 15 have their deterministic part passing and their real-integration part **not run**.
- **Real integration: 0 run, 0 passed, 0 failed.**

## 6. Plan once the data is provided

The order follows cost and risk. Every run goes through `eccode evidence run`, so its exit code and log are recorded. Failures are reported as failures.

1. **Network and credentials check.** One OAuth token request to the Sandbox, which costs nothing. Then `node test/live/paypal/run-live-paypal.js` with `RS_LIVE_PAYPAL=1`, for RS-18, RS-19, RS-20 (duplicate capture), RS-23 and RS-24. A person approves each printed order link at PayPal.
2. **Model.** Only after the user states a ceiling:
   - `RS_LIVE_MODEL=1 RS_LIVE_MODEL_CEILING_USD=<ceiling> npm run test:live-model -- --dry-run`, then the real run;
   - covers RS-01, 02, 03, 05 and the NFR6 cost report;
   - records the actual cost reported per call.
3. **Return to the session (RS-31(b), RISK-16) and replacement (RS-32(b)).** The user runs runbook §6 on their own machine. The orchestrator records the result the user reports, as user-run evidence.
4. **Failure and refund.**
   - After the user reopens the verification gate: a rework adds the live failure test (Sandbox negative testing) and the live refund test.
   - Both reviewers re-check the rework, and then it runs as in step 1.
5. **Records.**
   - Update `docs/evidence-table.md` through that reviewed change. Each live row gets its own run id, and the simulated rows stay as they are.
   - Mark RISK-1, 2, 13 or 16 mitigated **only** where a live run covers it, with the run id. Anything not covered stays open for the user.
   - Re-submit and re-review verification, then `eccode deliver`.

## 7. Time, cost and user interventions so far

| Item | Value |
|---|---|
| Recorded agent time (project record) | 2,114 minutes over 148 runs, about 22.9 million recorded tokens, a lower bound because some runs carry no usage figure |
| Real-model spend for verification | USD 0, because no verification call was made |
| Real-model spend, incident | At most USD 1.10, actual unknown; the user's account usage is the only way to know |
| PayPal Sandbox calls | 0. Sandbox money is not real money either way |
| External verification work on 2026-10-12 | The clarifications, the reproductions, the rules attempt, the connectivity checks and this file. No project run started and no record event written |

**User interventions:**
- Raised `maxRuntimeMinutes` to 1200 (`4300fb9`).
- Raised `maxRuntimeMinutes` to 2400 and `maxReworks` to 4 (`d5e3695`, `1efcab5`).
- Raised `maxReworks` to 12 and `maxRuntimeMinutes` to 4800 (`88c6c4d`).
- On 2026-10-12, declined to accept the four risks and asked for real verification. This document is the first step of it.

**Still the user's:**
- the environment data in section 3;
- a model spend ceiling;
- the verification gate reopen, for the failure and refund tests;
- the RS-31(b) run on their own machine;
- the RISK-21 usage check.

## 8. What passed, what is unverified, what submission needs

- **Passed (offline):** the full offline suite on the final tree: 2,398 of 2,406 pass, 0 fail, and the 8 skips are explained in 1.1. The browser suite passes 28 of 28, as do the clean checkout and a run 30 days past the tests' pinned date.
- **Unverified:**
  - every real-model behaviour;
  - every PayPal Sandbox behaviour, including duplicate capture against PayPal itself, refunds, failures and the return to the session;
  - the hackathon rules against their primary source.
- **Needed for submission:**
  - the rules confirmed;
  - a real PayPal Sandbox run, which the rules quoted above make central;
  - the demo video, the repository and video links, and the user's "own decisions" line;
  - a public repository with its licence;
  - delivery, which needs the four high risks either closed by live evidence or accepted by the user.
- **ECCode.** Nothing here shows that ECCode outperforms other workflows. That verdict remains FAILED.
