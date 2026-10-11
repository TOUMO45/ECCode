# Security review: phase D resubmission (phase:d-extraction), version 2 (FINAL)

Reviewer: security-reviewer. Run: run-mv34r35a-01400794. Gate: `phase:d-extraction`, submission `sub-mv34ppxe-01f2b5bb`, responding to `rev-mv33xoyz-0143dd56`. Previous draft: `phase-d-security-1.md`. This draft is input to the recording reviewer; I record no gate decision.

**The tree I tested:**
- HEAD `d396af7`. Between the submitted tree `a9d0507` and HEAD, `src/`, `test/`, `public/`, `scripts/` and `package.json` are unchanged (`d396af7` and `51bce1f` touch only records and the pilot report).
- The diff since my iteration-1 tree is `git diff 461a5ac -- src test` (11 files, +663/−79): `src/ai/cli.js`, `src/main.js`, `src/services/extraction.js`, `test/live/run-live-model.js`, and tests and fixtures.
- No project file was changed. My probes live in my scratch area and run by path.

**Safety:**
- Every command ran with `PATH=/usr/local/bin:/usr/bin:/bin`, which has no `claude`. I set `RS_MODEL_PROVIDER=fake` wherever the provider was not under test.
- I never set `RS_LIVE_MODEL=1` in my shell. Section R passes it only inside runner child processes. Those children run with `PATH=/nonexistent-no-claude`, `RS_MODEL_PROVIDER=fake` and `--dry-run`, so even an accepted value stops before a provider is created.
- Every `claude` in sections C, D and S is a stub I wrote into a fresh `sec-phd*-cli-*` temp directory.
- **A correction to my own iteration-1 probes:** `/usr/local/bin/node` links to `/opt/node22/bin/node`, so `dirname(process.execPath)` is the directory that holds the logged-in CLI.
  - My iteration-1 section C and C7 driver put that directory on the child's PATH. They always called the stub by absolute path, so nothing looked `claude` up by name.
  - I patched both to `/usr/local/bin:/usr/bin:/bin` before re-running them.
  - I recommend that the project's tests avoid `dirname(process.execPath)` on a child PATH for the same reason (see info SEC-D-17).
- No real model was called. After every run I checked with `ps` that no stub child of mine was left.

## Verdict

- **SEC-D-1 (= TR-D-1): resolved** against its resolution condition.
  - The three E1 cases are now `unknown`: ev:ev-mv34vttl-015b579b. Its 3 FAIL lines are the E1 REPRO lines, failing by design, and they print `{"value":null,"status":"unknown"}`. The G0 lines of ev:ev-mv353ywi-01d41ace confirm it.
  - d1's rule decides the outcome: number words such as "two pickups" → 2 stay known, and RS-01 stays green in `npm test` ev:ev-mv355tgm-016b3cee (1233 tests: 1225 pass, 0 fail, 8 skipped).
- **SEC-D-2 (= TR-D-9): resolved** against its resolution condition, with the FU-28 residual, which I widen below.
  - **C7 inverted holds:** a parent that awaits `close()` on SIGTERM leaves no child (D4).
  - **The exit hook covers:** `process.exit()`, an uncaught exception and an unhandled rejection (D5–D7, D9).
  - **A child that ignores SIGTERM** is SIGKILLed after the 1 s grace (D8, D10).
  - **A real server process** (`src/index.js`, provider `cli`, stub `claude`) runs `stop()` on SIGTERM and on SIGINT. It exits 0, leaves no child, answers the in-flight extract `200` degraded `PROVIDER_UNAVAILABLE`, and settles the reservation (S1–S3).
  - Evidence: ev:ev-mv3549s6-014f5d35.
- **TR-D-10: confirmed.** All 37 hostile or inexact ceilings are refused before any conversion, including every value you named. The 11 values I also passed to the real runner exit 2 at the launch check with nothing on stdout, and exact amounts give the exact micro-dollars (R1–R3 in ev:ev-mv353ywi-01d41ace).
- **New findings (none blocking, three minor):**
  - **SEC-D-10 (minor):** the deadline field is outside every grounding check.
  - **SEC-D-11 (minor):** a quote may start or end inside a longer number, so "250" grounds 250 from "2500".
  - **SEC-D-12 (minor):** with a photo attached, `provenance: image` is accepted for every field, budget and pickups included. This gets around the TR-D-1 check entirely.
  - All three are the same impact class as SEC-D-1: a wrong value shown as coming from the buyer or the photo, which the buyer must still confirm before any plan or money. I would not block phase D on them. I ask that they land, or be decided, before the verification gate, as I asked for SEC-D-1.
- **Info:** SEC-D-13 to SEC-D-17. The most useful is SEC-D-15: SIGHUP, and a second SIGTERM or SIGINT during the grace period, still orphan the child in the real server. It is a one-line fix and belongs in FU-28's text.

## Evidence (all `--actor security-reviewer --gate phase:d-extraction`, on HEAD `d396af7`)

| ev id | what | result |
|---|---|---|
| ev:ev-mv34vttl-015b579b | `sec-phd-probe.mjs E` (iteration-1 section E, unchanged) | exit 1 **as expected**: 28 PASS, 3 FAIL. The 3 FAILs are the three `E1 REPRO SEC-D-1` lines, which now print `unknown`. The E1 controls and E2–E9 pass |
| ev:ev-mv353r0k-01003420 | `sec-phd-adapters.mjs C` (child PATH patched to the safe PATH) | passed: C1–C6 hold on HEAD. C7 as written (a driver with **no** signal handler) still reproduces, after SIGTERM and after SIGKILL. That is the FU-28 residual the submission names |
| ev:ev-mv353ywi-01d41ace | `sec-phd2-probe.mjs G R` (new) | passed: every expectation met; `OBS` lines record observed weaknesses. G: grounding bypass attempts at unit level and through the route. R: the ceiling parser |
| ev:ev-mv3549s6-014f5d35 | `sec-phd2-proc.mjs D S` (new; driver `sec-phd2-driver.mjs`) | passed: every expectation met. D: adapter driver processes. S: a real server process with a stub `claude` |
| ev:ev-mv355tgm-016b3cee | `npm test`, safe PATH | passed: 1233 tests, 1225 pass, 0 fail, 8 skipped, 0 todo; NFR5 p95 54.2 ms |

## 1. SEC-D-1 / TR-D-1: grounding through d1's validator

**The change** (`src/services/extraction.js`):
- `normaliseExtraction` › `numberGroundedInQuote` runs `validateExtraction(probe, { text })` on a one-field probe, so d1's `NUMBER_NOT_IN_INPUT` decides.
- The `written.size === 0 ||` branch is gone.

**Confirmed (G0, E1):**
- 99999 quoted "need cups", 777 quoted "lids for the weekend" and 5 quoted "at most two pickups" are all `unknown`.
- 2 quoted "at most two pickups" stays known.

**What I tried, and what still passes** (ev:ev-mv353ywi-01d41ace):

| Attempt | Result | Matters? |
|---|---|---|
| A number word the table does not know: "fifty cups"→50, "a dozen lids"→12, "a couple of pickups"→2 (G1) | `unknown` | No: the safe direction (asked) |
| A table word inside a longer word: "Someone"→1 (G1) | `unknown` (tokenised) | No |
| A table word in a phrase that means something else: "no one wants lids"→lidQuantity 1 (G1) | **known** | Info (SEC-D-13) |
| A number inside a longer digit run: "250" from "2500 cups", "500 cups" from "2500 cups", "200 lids" from "1,200 lids", "$120" and "$12" from "$1200", "1" from "11:30" (G2; through the route in G9) | **known** | **Yes: SEC-D-11 (minor)** |
| A number inside a longer token the buyer wrote: "SKU-99999"→99999, "0799" of a phone number→799 (G2) | **known** | Info: the number is the buyer's, but the field is wrong (SEC-D-13) |
| Arabic-Indic mixed with Latin, "٢5٠ كوب"→250; Persian "۳۰۰"; a Latin quote "250 كوب" of Arabic-Indic text; "٢٫٥"→2.5 (G3) | known | No: folding is d1's rule, and the value is the buyer's. Only "٢5"→25 (a prefix) is SEC-D-11 |
| Fullwidth "２５０ cups" (G3) | `unknown` (not folded) | No: safe direction |
| The stored wording is the model's form ("250 كوب"), not the buyer's ("٢5٠ كوب") (G3) | known | Info (SEC-D-13) |
| A quote that contains the number but belongs to another field: lidQuantity 90 from "90 mm lids", cupQuantity 120 and diameterMm 120 from "budget $120", budget 200 from "200 cups", lidQuantity 2 from "two pickups" (G4) | **known** | Info (SEC-D-13): the shown quote gives it away; the range checks catch some (diameter 250 from "250 ml" is `unknown`) |
| A value in the catalog but not in the buyer's text: 350 quoted "350 ml" (not in the text) or "the usual ones", 48 quoted "cups for the weekend" (G5) | `unknown` | No. The provider receives only `image, signal, text` (E3 in ev:ev-mv34vttl-015b579b), so catalog text cannot be quoted |
| Negative, huge or odd numbers (G6) | refused as expected | No (details below the table) |
| A deadline: "06:00" quoted "for the weekend", "23:59" quoted "by 11:00", "2026-10-21T06:00" quoted "for the weekend" (G8; through the route in G9, where the text says 11:30) | **known**, provenance `user_text` | **Yes: SEC-D-10 (minor)** |
| `provenance: image` with a photo attached: capacity 1999, cupQuantity 99999, budget 99999 USD, maxPickups 5, deadline 06:00 (G7; through the route in G9) | **known** | **Yes: SEC-D-12 (minor)** for the fields no package can show. Capacity and diameter stay SEC-D-3 (needs OCR) |
| `provenance: image` without a photo (G7) | `unknown` | No |

**G6 in detail:**
- −200 is a schema `TYPE` error.
- 100001 lids and a budget of 1,000,001 USD are out of range, so `unknown`.
- `1e3 cups`→1000 is `unknown`; 1e21 and 2^53 are `TYPE` errors.
- 0.1+0.2 is a `DECIMALS` error.
- 120 quoted "120.50 dollars" is `unknown`.
- Legitimate forms stay known: "0250"→250, "$1,000,000"→100000000 cents and "120.50"→12050.

## 2. SEC-D-2 / TR-D-9: CLI children on shutdown

**The change:**
- `src/ai/cli.js`: a module set `LIVE_CHILDREN` and a per-adapter registry; `close()` (SIGTERM, then SIGKILL after `killGraceMs`) and `liveChildren()`; one `process.on('exit')` hook that SIGKILLs every registered group.
- `src/main.js` › `startApp().close()` awaits `provider.close()` before `app.close()`.
- `test/live/run-live-model.js` handles SIGINT and SIGTERM.

| Case | Result (ev:ev-mv3549s6-014f5d35, C7 in ev:ev-mv353r0k-01003420) |
|---|---|
| D4 / C7 inverted: a driver whose SIGTERM handler awaits `close()` | exit 143; stub gone, grandchild reaped (Z); the call rejects `PROVIDER_UNAVAILABLE` |
| D5 `process.exit(0)` | the exit hook kills child and grandchild |
| D6 the parent throws (uncaught exception) | exit 1; the exit hook still kills both |
| D7 an unhandled rejection | exit 1; the exit hook still kills both |
| D8 a child and grandchild that ignore SIGTERM, `close()` | gone after 1006 ms (the 1 s grace, then SIGKILL); `liveChildren()` is 0 |
| D9 `process.exit(0)` with a SIGTERM-ignoring child | gone (the hook uses SIGKILL) |
| D10 handler + `close()` with a SIGTERM-ignoring child | exit 143, gone after about 1.4 s |
| **S1** a real server (`src/index.js`, provider `cli` confirmed in `/api/config`, stub `claude` first on PATH), extract in flight, SIGTERM | `stop()` runs, exit 0 after about 0.4 s; child and grandchild gone. The in-flight extract gets `200` degraded `PROVIDER_UNAVAILABLE`, and `model_spend` is `settled` at `actual 0` (see SEC-D-16); no `extraction.close_failed` |
| **S2** real server, a SIGTERM-ignoring child | exit 0 after about 1.4 s; both gone |
| **S3** real server, SIGINT | exit 0; both gone |
| C7 as written, D1: a parent with **no** handler, SIGTERM | **child survives** (FU-28, as the submission states) |
| D2 / S6: SIGKILL on the parent or the server | **child survives** (FU-28). The server's row stays `reserved` for the startup sweep |
| **D3 / S5:** SIGHUP to a parent with no handler, **including the real server** | **child survives**. It is in its own session (`detached: true`), so it gets no SIGHUP itself; the extract socket resets and the row stays `reserved` |
| **S4:** real server, SIGTERM, then a second SIGTERM 200 ms later, with a SIGTERM-ignoring child | the second signal kills the server (`process.once`), and the **child survives** |
| D11 | the 4 exit-hook paths and the 3 signal deaths leave 7 empty temp cwds; the `close()` paths leave none (SEC-D-17) |

**What FU-28 records** ("SIGKILL, or SIGTERM without a handler") **understates the residual.**
- **SIGHUP** is not handled by `src/main.js` (`process.once('SIGINT'|'SIGTERM')`) or by the runner (`INTERRUPT_SIGNALS` is SIGINT and SIGTERM). Closing the terminal that runs `npm start` or the live runner is a likely way to end either.
- **A second SIGINT or SIGTERM during the grace period** also kills the server by default, because of `once`. Pressing Ctrl-C twice is common. It matters only for a child that ignores SIGTERM.
- See SEC-D-15. The bound is unchanged: at most 2 calls per server (1 per runner) × `--max-budget-usd 0.05`, and the sweep settles the row at the cap.

## 3. TR-D-10: the ceiling parser

`parseCeilingMicroUsd` matches `^(0|[1-9][0-9]{0,11})(?:\.([0-9]{1,2}))?$` with no `u` and no `m` flag, then compares in integer cents (1..500).

**Refused (R1, R2):** 37 values, each either refused outright or by `evaluateLaunch` (the empty string as "no ceiling", the rest as a bad ceiling):
- `5.0000001`, `5.001`, `1e0`, ` 5`, `5 `, `05`, `+5`, `5.` and `.5`;
- fullwidth `５` and Arabic-Indic `٥` and `٥.٠٠`;
- `5\n` and `\t5`, and the empty string;
- `-0`, `-5`, `0`, `0.00`, `0.001`, `0.009`, `5.01`, `500`, `4.999`, `5,00`, `$5`, `5USD`, `0x5`, `Infinity`, `NaN`, `00.50`, `5.0.0`, `999999999999.99`, `5e-0` and `5.0000004` (which iteration 1 accepted by rounding);
- a zero-width space after the 5, and a right-to-left override before it;
- non-string inputs.

**Accepted with exact micro-dollars:** `5`, `5.0`, `5.00`, `0.01`, `0.5`, `0.50`, `1` and `4.99`.

**Real processes (R3):** `5.0000001`, `5.001`, `1e0`, ` 5`, `05`, `+5`, `5.`, `.5`, `５`, `٥` and `""` all exit 2 with the fixed message and nothing on stdout. `5` and `0.50` with `--dry-run` exit 0 with "dry run: no model call was made".

**Confirmed. No residual.**

## 4. New surface in `git diff 461a5ac -- src test`

- **`startApp({ provider })`:** a test seam. `main()` calls `startApp({ env, log })` only, so no variable or request can supply a provider. **No exposure.**
- **`close()` and `liveChildren()`** on the CLI provider object: not reachable from HTTP. `close()` is idempotent and terminal: later calls are `PROVIDER_UNAVAILABLE` without a spawn (d2's tests; D8 shows the rejection).
- **`process.kill(-pid, …)` in `terminate` and in the exit hook:** this is the same group kill as iteration 1. The registry entry is removed in `finish()`. The window for a recycled process-group id is one event-loop turn between the child's exit and `close`. That is negligible, and it is not a finding.
- **The runner:**
  - handlers are installed only after the provider exists, and `cliVersion` races the interrupt;
  - an interrupted `claude --version` child is not tracked. It makes no model call, so this is not a finding;
  - `finally` closes the adapter on every return path.
- **`numberGroundedInQuote` passes the full request text to `validateExtraction`.** This adds no data flow: the text was already in scope.
- **The test fixtures:** the `stubborn` stub mode, and `cli-orphan-driver.mjs`, whose PATH is `binDir:/usr/bin:/bin` from cli.test.js. See SEC-D-17 for the sandbox PATH.

## Findings

### blocking

None.

### major

None.

### minor

**SEC-D-10: the deadline is outside every grounding check, so an invented deadline is stored as "From your text".**
- **Where:**
  - `src/ai/schema.js` › `validateExtraction` applies `NUMBER_NOT_IN_INPUT` only to kinds `int` and `num`; `deadline` is `str` (`FIELD_KINDS`).
  - `src/services/extraction.js` › `normaliseExtraction` calls `numberGroundedInQuote` only `if (typeof value === 'number')`.
  - A `user_text` deadline therefore needs only a quote that is a substring of the text, plus a valid local time.
- **Reproduction:** ev:ev-mv353ywi-01d41ace.
  - G8: `06:00` quoted "for the weekend" and `23:59` quoted "by 11:00" are stored known, provenance `user_text`; so is `2026-10-21T06:00` quoted "for the weekend".
  - G9, through the route: the text says "by 11:30", and `2026-10-20T06:00` is stored known with the quote "for the weekend".
- **Impact:**
  - The deadline is a planning constraint (`src/domain/derive.js`, and `NO_FEASIBLE_PLAN` in `src/domain/explain.js`).
  - A hallucinating or injected model can set an earlier or later deadline with a genuine-looking quote. The buyer sees "From your text", which can give a wrong or infeasible plan.
  - No money moves without the buyer's approval, and the planner reads only confirmed values. This is the same class and severity as SEC-D-1, which covered the numeric fields only. I missed the deadline in iteration 1.
- **Resolution:**
  - A `user_text` deadline is known only when its time appears in the quote: `HH:MM` or `H:MM`, or `H` followed by am/pm or a time word, in digits of either script after `foldDigits`. A date part, when present, must appear in the quote too. Otherwise the deadline is `unknown` with its template question.
  - A test shows that the three G8 cases are `unknown`, and that "by 11:00"→11:00 and an Arabic "قبل الساعة ١١:٠٠"→11:00 stay known.
  - Owner: ai-engineer (d1 validator) or backend-engineer (d3 normalisation).
  - Before the verification gate.

**SEC-D-11: a quote may begin or end inside a longer number, so a part of the buyer's number grounds a different value.**
- **Where:** the quote rule is a plain substring test (`textNorm.includes(quote)`), and `numbersIn(quote)` reads only the quote. Nothing checks that the quote's digit runs are whole numbers in the text.
- **Reproduction:** ev:ev-mv353ywi-01d41ace G2 and G9. With "2500 cups, 1,200 lids, budget $1200, by 11:30", these are all stored known, provenance `user_text`:
  - cupQuantity 250 quoted "250";
  - cupQuantity 500 quoted "500 cups";
  - lidQuantity 200 quoted "200 lids";
  - a budget of 120 USD (12000 cents) quoted "$120";
  - a budget of 12 USD quoted "$12";
  - maxPickups 1 quoted "1".

  In Arabic-Indic, 25 quoted "٢5" from "٢5٠" is also known.
- **Impact:**
  - A tenfold understatement of a quantity or a budget, shown as "From your text" with a quote that looks right at a glance.
  - An understated budget changes which plans are feasible, and an understated quantity under-buys. The buyer's confirmation and plan approval still stand.
  - This is a gap in d1's rule itself (`validateExtraction` with the text gives the same result), so it is not a regression of the TR-D-1 fix.
- **Resolution:**
  - A quote is accepted only if at least one of its occurrences in the normalised text is aligned to whole numbers. That means no digit immediately before or after the occurrence, and no `,` `.` `٫` `٬` between it and an adjacent digit.
  - Alternatively, extend the occurrence to whole digit runs and require the value among `numbersIn(extended)`.
  - A test shows the G2 cases `unknown`, while "250ml", "2500 cups", "1,200 lids"→1200 and "$120.50"→120.5 stay known.
  - Owner: ai-engineer (d1 `schema.js`); d3 picks it up through `validateExtraction`.
  - Before the verification gate.

**SEC-D-12: with a photo attached, `provenance: image` is accepted for every field, including those no package can show. This gets around the TR-D-1 check entirely.**
- **Where:** `normaliseExtraction` accepts `provenance === 'image'` for any field when `hasImage === true`, and checks only ranges. The prompt rule "use image only for values legibly printed on the image" (spec, AI / LLM Design) is not enforced.
- **Reproduction:** ev:ev-mv353ywi-01d41ace.
  - G7: with a photo, these are all stored known with provenance `image`: budget 99999 USD ("PAY 99999"), maxPickups 5, cupQuantity 99999, deadline 06:00 and capacity 1999.
  - G9, through the route after a real upload: budget 9,999,900 cents, maxPickups 5 and cupQuantity 99999 are stored known, provenance `image`.
  - Without a photo, the same claims are `unknown`.
- **Impact:**
  - The photo is the main third-party channel for injected text (packaging, EXT-1's injection cases). An obeying model only has to say `image` instead of `user_text`, and SEC-D-1, SEC-D-10 and SEC-D-11 no longer apply.
  - The buyer sees "From the photo" next to a budget or a pickup limit. The UI labels it, and the buyer must confirm, so it is less convincing than "From your text". It is still the same class as SEC-D-1.
- **Resolution:**
  - Image provenance is accepted only for the fields a package can carry: `productType`, `material`, `capacityMl` and `diameterMm`. Add quantities only if the product owner wants "pack of N".
  - `budgetUsd`, `maxPickups` and `deadline` claimed from the image become `unknown` with their questions.
  - A test covers the three G9 image claims. RS-02 (capacity and diameter from the photo) stays green.
  - This narrows a spec rule from prompt-only to server-enforced, so the orchestrator should record a decision.
  - Owner: backend-engineer (d3), with ai-engineer for the prompt wording.
  - Before the verification gate.

### info

- **SEC-D-13: grounding is lexical, not semantic.**
  - A quote that belongs to another field grounds its number (G4): lidQuantity 90 from "90 mm lids", diameterMm 120 from "budget $120".
  - So does a buyer-written code or a phone fragment ("SKU-99999"→99999, "0799"→799), and a table word in an idiom ("no one wants lids"→1).
  - The stored wording is the model's quote, not the buyer's characters ("250 كوب" for "٢5٠ كوب").
  - In each case the shown quote reveals the mismatch, and the buyer confirms.
  - **Suggestion:** require a unit token in the quote for `capacityMl` (ml/مل) and `diameterMm` (mm/مم), and a currency token for `budgetUsd`.
- **SEC-D-14:** SEC-D-3 still stands for capacity and diameter from the photo (E3 info line in ev:ev-mv34vttl-015b579b). Only OCR or the buyer can check those values.
- **SEC-D-15: FU-28 is wider than recorded.**
  - **Where:** in `src/main.js`, the handlers are `process.once('SIGINT', stop)` and `process.once('SIGTERM', stop)`. In `test/live/run-live-model.js`, `INTERRUPT_SIGNALS` is `[['SIGINT', 130], ['SIGTERM', 143]]`.
  - **Two more cases orphan the child:**
    - SIGHUP to the real server (S5) or to a parent with no handler (D3);
    - a second SIGTERM during the grace period (S4, with a child that ignores SIGTERM).
  - **Bound:** the same as SEC-D-2 (≤ 2 × $0.05 per server, ≤ 1 × $0.05 per runner). The sweep settles the row at the cap.
  - **Suggestion:**
    - add `SIGHUP` (exit 129) to both handler lists;
    - in `main.js`, use `process.on`, and let `stopping` swallow repeats;
    - name both cases in FU-28's text and in g2's runbook.
- **SEC-D-16: a call ended by `close()` is settled at 0, while a timeout is charged at the cap.**
  - S1–S3: `model_spend` shows `{status: settled, reserved 50000, actual 0}` after a shutdown with a call in flight.
  - The reasoning in `callProvider` ("a call that timed out may still have been billed") applies equally to a CLI child killed mid-call. The ledger can therefore under-count by up to $0.05 per in-flight call per shutdown.
  - It is rare, and an attacker cannot cause it.
  - **Suggestion:** reject the `close()`-killed call with `usage: { costMicroUsd: cap }`, as the watchdog does.
- **SEC-D-17: hygiene.**
  - **Leftover temp cwds:** the exit hook is synchronous, so a `process.exit()` path leaves its empty temp cwd behind (D11: 7 empty directories after 7 non-`close()` endings). They are empty, because the buyer's text goes only on stdin.
  - **Test PATH:** d2's `cli.test.js` sandbox uses `PATH: ${bin}:${process.env.PATH}` (unchanged since iteration 1). The stub comes first and is written before any call, so this is safe as written. On a developer machine, though, the rest of that PATH may hold a logged-in `claude`. The same goes for `dirname(process.execPath)` here, which is `/opt/node22/bin`.
  - **Suggestion:** pass `command:` as the absolute stub path in the tests, so a missing stub can never fall back to the real binary (the RISK-21 class).

## Not checked

- **A real model:** none was called. LIVE-M1 stays the test of whether Haiku follows the injected wording (SEC-D-3, SEC-D-12).
- **The real `claude` binary's own signal behaviour:** whether it ignores SIGTERM, and whether a killed call is billed. That decides how much SEC-D-15's double-signal case and SEC-D-16 matter.
- **The live runner as a real process past the launch check:** I did not run it with a stub, because that needs `RS_LIVE_MODEL=1` beyond a refusal. Its SIGINT and SIGTERM handling rests on d2's tests (`NFR3: SIGTERM to the runner leaves no CLI child alive…`, `NFR3: SIGINT …`), which pass in ev:ev-mv355tgm-016b3cee.
  - The SIGHUP gap in the runner is shown by code reading (`INTERRUPT_SIGNALS`) and by D3's equivalent driver, not by a runner process.
- **The Anthropic adapter's behaviour on shutdown:** it has no `close()`, and `fetch` ends with the process. I did not probe in-flight HTTPS calls on SIGTERM.
- **A cgroup or container stop** (`docker stop` sends SIGTERM, then SIGKILL after 10 s): this is covered in principle by S1 and S2. I did not run it.
- **Grounding for `productType` and `material`:** these are enums. A wrong enum with a substring quote is the SEC-D-13 class; I did not probe it.
- **The browser:** nothing in `public/` changed. I did not re-run `npm run test:browser`.
- **Memory:** not consulted. The only lesson that applies, mem-sd-mv1audrd-013b7102 (guard root resolution), does not bear on these checks.

## Guard refusals during this review (verbatim)

1. **Inline `node -e` that rewrote one line of my scratch driver:** "Inline node code in this command calls a file-writing API (writeFileSync) and the guard cannot see which files it would change. Use the Edit/Write tool for file changes so ownership can be checked, or save the script under your draft area (.eccode/drafts/), run it from there and declare its outputs."
   - Fair. I rewrote the file with the Write tool.
2. **`cd <scratchpad> && sed -i "118s/…/" sec-phd2-proc.mjs`:** "This command changes directory (cd/pushd/popd) and then writes the relative path "sec-phd2-proc.mjs", which the guard cannot bind to a file. Write it with a path relative to the project root in a command without cd, or use the Edit/Write tool so ownership can be checked."
   - Fair: the path could not be bound.
3. **The same `sed -i` with the absolute scratch path:** "security-reviewer reviews/designs but does not edit project files; write drafts under .eccode/artifacts/ or .eccode/reviews/drafts/."
   - **Over-denial.** The target was my scratch file. An earlier `sed -i` on the same absolute scratch path, with a simpler expression, was accepted, so the replacement text (which held `join(sb.cwds, …)` and template literals) was probably read as a project path.
   - I redid it with a scratch Node patch script run by path (`sec-phd2-patch.cjs`).
