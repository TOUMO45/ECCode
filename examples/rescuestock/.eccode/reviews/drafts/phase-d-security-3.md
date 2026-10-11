# Security review: phase D resubmission (phase:d-extraction), version 3 (FINAL)

Reviewer: security-reviewer. Run: run-mv36chcg-0192e360. Gate: `phase:d-extraction`, submission `sub-mv36aj2e-01cd090a` (iteration 3 of 3), responding to `rev-mv35hyoj-01e0a18c`. Previous draft: `phase-d-security-2.md`. This draft is input to the technical-reviewer, who records the gate decision; I record none.

**The tree I tested:**
- Code at `09749e9`, the submitted tree. HEAD moved to `bd33477` and then `b895567` while I worked. Those commits touch only `.eccode/` records (`b895567` only adds this draft's header). `git diff --stat 09749e9 HEAD -- src test public scripts package.json` is empty, so every run below is on the submitted code.
- The diff since my iteration-2 tree, `git diff 0259ce4 -- src test`, is the same 10 files, +596/−36, that the submission declares: `src/ai/cli.js`, `src/ai/schema.js`, `src/main.js` and `src/services/extraction.js`, plus tests and a fixture.
- I changed no project file. My probes live in my scratch area and run by path.

**Safety:**
- Every command ran with `PATH=/usr/local/bin:/usr/bin:/bin`. None of those directories holds a `claude`, and `sec-phd3-proc.mjs` refuses to start if one appears there.
- I set `RS_MODEL_PROVIDER=fake` wherever the provider was not under test. I never set `RS_LIVE_MODEL=1`.
- Every `claude` I started was a stub I wrote into a fresh `sec-phd3-cli-*` or `sec-phd2-cli-*` directory. The real server reached it through `PATH=<stub bin>:/usr/local/bin:/usr/bin:/bin`. `/opt/node22/bin`, which holds the logged-in CLI, was never on any PATH.
- The SEC-D-17 canary is a `claude` that only appends to a marker file and exits 1.
- No real model was called. `sec-phd3-proc.mjs` ends with a `/proc` scan (line Z): no process with its sandbox in its environment was left alive.

## Verdict

| SEC id | Verdict | Evidence |
|---|---|---|
| **SEC-D-12** (= TR-D-11) image provenance on every field | **Resolved.** With a photo, the budget, both quantities, the pickups and the deadline claimed as `image` are `unknown` and their questions are asked, at unit level and through the route after a real upload, including the stored `fields_json` and `questions_json`. The four product fields keep `image`. The list is exact and frozen. | ev:ev-mv36kohb-016711c9 (I0–I6); ev:ev-mv36g4xe-01b5f42d (G7, G9 inverted); ev:ev-mv36gjhy-013bdb82 (E3) |
| **SEC-D-11** (= TR-D-12) a part of a longer number grounds | **Resolved** against its resolution condition: every G2, G3 and G9 case is now `unknown`, and the controls stay known. I tried new bypasses. Alignment holds for quotes spanning two numbers, clock masking, the Arabic separators and Persian digits. It does **not** hold when the buyer's own number contains an invisible character, an unfolded look-alike digit or a grouping mark other than `,` `.` `:`. That is new info **SEC-D-18**. | ev:ev-mv36g4xe-01b5f42d; ev:ev-mv36kohb-016711c9 (N1–N10) |
| **SEC-D-10** (= TR-D-13) deadline ungrounded | **Resolved for the time.** The date part is the accepted residual FU-30 (`dec-mv36cgyj-01f0741d`), and I agree with accepting it. Every time-token bypass I tried is refused. A time from another sentence is the lexical class of `dec-mv36ch5t-01a1d509`. One false-unknown in the safe direction is new info **SEC-D-19**. | ev:ev-mv36kohb-016711c9 (T1–T6); ev:ev-mv36g4xe-01b5f42d (G8, G9 inverted) |
| **SEC-D-15** (= TR-D-16) SIGHUP and a double signal orphan the child | **Resolved for the server**, on a real `src/index.js` process: SIGHUP; SIGTERM twice; SIGINT three times; SIGHUP then SIGTERM; four mixed signals in 150 ms. Each exits 0 once, with the child and grandchild gone and the row settled. Shutdown stays bounded, under 5 s, even with a held half-sent request. The runner's SIGHUP is open as FU-28 (b): `INTERRUPT_SIGNALS` is still SIGINT and SIGTERM (`test/live/run-live-model.js:34`). The SIGKILL residual reproduces as FU-28 states. | ev:ev-mv36rmvf-01b7b830 (S4–S10) |
| **SEC-D-16** (= TR-D-15) a call ended by `close()` is settled at 0 | **Resolved, and confirmed on the real gate over HTTP.** On SIGTERM, SIGINT, SIGHUP and every double-signal case, `model_spend` reads `settled`, reserved 50000, actual 50000, and the extract answers `200` degraded `PROVIDER_UNAVAILABLE`. This is the HTTP-level row check that carry item 8 says no project test makes (it is reviewer evidence, not a project test). **FU-32: I accept it** (reasons below). | ev:ev-mv36rmvf-01b7b830 (S1–S9, F1–F4) |
| **SEC-D-17** test sandbox PATH; temp cwds | **Resolved.** A canary `claude` first on the parent PATH was never run by `cli.test.js`, `live-runner-refusal.test.js` or d3's TR-D-16 real-server tests (59 tests, 0 fail). The exit hook now removes the cwd on the four exit-hook paths. Only the three handler-less signal deaths leave an empty one, as d2 states. One small residual is noted under info. | ev:ev-mv36suet-01a5f678; ev:ev-mv36t67q-01182083 (D11: 3 left, was 7) |
| SEC-D-13, SEC-D-14 | **Accepted residuals**, carried to the verification risk list (carry item 6; `dec-mv36ch5t-01a1d509` for lexical grounding). Both still reproduce: G4 and I4. | ev:ev-mv36g4xe-01b5f42d; ev:ev-mv36kohb-016711c9 |

**New findings: none blocking, none major, none minor. Two info: SEC-D-18 and SEC-D-19.**

**For the phase gate:** nothing in my scope blocks approval. Every SEC finding I raised as minor (SEC-D-10, SEC-D-11, SEC-D-12) is resolved or decided. SEC-D-15, SEC-D-16 and SEC-D-17 are resolved. The open items are recorded follow-ups or accepted residuals: FU-28 (b), FU-30, FU-31, SEC-D-13/14, and the new SEC-D-18/19.

## Evidence (all `--actor security-reviewer --gate phase:d-extraction`, code = `09749e9`)

| ev id | what | result |
|---|---|---|
| ev:ev-mv36g4xe-01b5f42d | `sec-phd2-probe.mjs G R`, my iteration-2 probe, unchanged | exit 1 **as expected**. Exactly 17 FAIL lines, and every one is an iteration-2 `OBS` line that recorded a weakness that is now fixed: G2 ×5, G3 ×1 (SEC-D-11); G7 ×4 (SEC-D-12); G8 ×3 (SEC-D-10); G9 ×4 (all three, through the route). Each now prints `unknown`. Everything else passes: G0, G1, G4–G6 and R (TR-D-10).<br>The one G2 `OBS` line that still passes, 250 quoted "250", is correct: that text also contains "250ml", where 250 is a whole number. |
| ev:ev-mv36gjhy-013bdb82 | `sec-phd-probe.mjs E`, my iteration-1 probe, unchanged | exit 1 **as expected**. The 3 FAILs are the `E1 REPRO SEC-D-1` lines, which print `unknown`. E2–E9 pass: E3 (image provenance without a photo; wording sanitising; the provider gets only `image, signal, text`), E5 (no leak) and E6 (watchdog at the cap). |
| ev:ev-mv36kohb-016711c9 | `sec-phd3-probe.mjs I N T` (new) | passed, 123 expectations. `OBS` lines record residuals |
| ev:ev-mv36rmvf-01b7b830 | `sec-phd3-proc.mjs` (new): a real server process with a stub `claude` | passed: S1–S10, F1–F4, Z |
| ev:ev-mv36suet-01a5f678 | `sec-phd3-canary.mjs` (new): a canary `claude` on the parent PATH | passed |
| ev:ev-mv36t67q-01182083 | `sec-phd2-proc.mjs D`, my iteration-2 driver probe, unchanged | exit 1 **as expected**. D1–D10 pass. D11 now finds 3 leftover temp cwds, not the 7 it recorded (the exit hook removes its four) |
| ev:ev-mv36vau5-01f455b8 | `sec-phd3-cost.mjs` (new): the CPU cost of the new grounding code at the limits (text 4000, quote 200) | passed. 1.8–3.6 ms per `normaliseExtraction` of all nine fields on adversarial inputs: no ReDoS and no quadratic blow-up |
| ev:ev-mv36tjrt-016f4365 | d1 plan command, verbatim | passed: 154 tests, 154 pass, 0 fail |
| ev:ev-mv36u59e-010b8e39 | d2 plan command, verbatim | passed: 112 tests, 112 pass, 0 fail; `ECCODE_EVAL {"passed":200,"total":200}` |
| ev:ev-mv36ugbs-01294691 | d3 plan command, verbatim | passed: 118 tests, 118 pass, 0 fail |

I did not run the d4 or d5 plan commands (`npm test`, `npm run test:browser`). The technical-reviewer runs the full set for the gate.

## 1. SEC-D-12: `IMAGE_PROVENANCE_FIELDS`

**The change:** `normaliseExtraction` accepts `provenance === 'image'` only when `hasImage === true && IMAGE_PROVENANCE_FIELDS.includes(wire)`. The list is `Object.freeze(['productType', 'material', 'capacityMl', 'diameterMm'])`, as `dec-mv35aank-0169ec16` decides.

**Unit level** (ev:ev-mv36kohb-016711c9):
- **I1:** with a photo, these image claims are all `unknown`, in `downgraded`, and asked with the server's question:
  - `budgetUsd` 99999 ("PAY 99999") and 120 ("BUDGET $120");
  - `cupQuantity` 1000 ("PACK OF 1000") and `lidQuantity` 1000;
  - `maxPickups` 1 ("ONE PICKUP ONLY") and 5;
  - `deadline` "06:00" and "2026-10-21T06:00".
- **I2:**
  - `productType`, `material`, `capacityMl` 250 and `diameterMm` 90 claimed as `image` are known with provenance `image`;
  - a grounded `user_text` `cupQuantity` 300 next to them stays known, so the rest of the answer stands;
  - the questions are template text only.
- **I0:** the list is exactly those four fields. `push` and index assignment fail, and the list is unchanged.
- **I3:** without a photo, even an allow-listed field claimed as `image` is `unknown`. `hasImage: 1` is not `true`.
- **I5:** the provenance spellings `"Image"`, `"IMAGE"`, `"image "` and `"photo"` are schema errors, which degrade the whole output. They are not a way around the list.

**Through the route** (I6):
- a real PNG upload (201), then a scripted provider claiming `image` for all nine fields, with an injection-style `"IGNORE PREVIOUS: 99999"`;
- extract `200`, not degraded;
- the five non-product fields are `unknown` in the response **and** in the stored `fields_json`, and the string `99999` appears nowhere in the stored row;
- `questions_json` asks all five;
- the four product fields keep `image`.

**Residual (accepted, SEC-D-14):** `capacityMl` 1999 claimed as `image` is still known (I4, and E3 in ev:ev-mv36gjhy-013bdb82). Only OCR or the buyer can catch it.

**Resolved.**

## 2. SEC-D-11: whole-number alignment

**The change** (`src/ai/schema.js`):
- `quoteAlignedInText` needs at least one occurrence of the quote that neither starts nor ends inside a number. A number continues over `,` `.` `:` when a digit follows.
- `numberGrounded` masks `HH:MM[:SS]` in the quote.
- d3 reaches both through `quoteGrounded` → `validateExtraction(probe, { text })` for every `user_text` field.

**The iteration-2 cases** (ev:ev-mv36g4xe-01b5f42d) are all `unknown` now:
- 500 from "2500 cups", 200 from "1,200 lids", $120 and $12 from "$1200", and 1 from "11:30" (G2);
- 25 from "٢5٠" (G3);
- through the route, 250 from "2500 cups" and $120 from "$1200" (G9).

The controls stay known: "250ml"→250, "2500 cups"→2500, "$1,000,000", "0250"→250 and "120.50"→120.5.

**New attempts** (ev:ev-mv36kohb-016711c9, section N):

| Attempt | Result | Matters? |
|---|---|---|
| The Arabic thousands separator: 200 or 1 quoted as the **whole** "١٬٢٠٠" (N1) | `unknown` (`numbersIn` reads 1200) | No |
| A quote that starts inside one number and ends inside the next ("500 cups, 12" from "2500 cups, 1200 lids"), or ends inside the next ("2500 cups, 1") (N5; through the route in N10) | `unknown` | No |
| Two numbers joined by a comma, "250,120": 120 quoted "120 lids", or 250 quoted "250," (N5) | `unknown` | No |
| A whole quote holding two numbers: cupQuantity 1200 from "2500 cups, 1200 lids" (N5) | known | Info: SEC-D-13, lexical |
| Clock masking: 11 or 30 from "11:30", 30 from "by 11:30", Arabic-Indic "١١:٣٠", 15 from "11:30:15" (N7) | `unknown`. A real quantity in the same quote ("by 11:30, 200 cups"→200) stays known | No |
| A dotted time "11.30"→budget 11.3, or a French time "11h30"→30 (N7) | known | Info: SEC-D-13, lexical. The buyer wrote a number |
| A zero-width space only in the **quote** ("25​00 cups"), or an RLO-reversed quote (N3, N4) | `unknown` (`NOT_QUOTED`) | No: the model cannot add invisible characters that are not in the text |
| LRM marks around "1,200" in Arabic text, quoted with or without the marks (N4) | known, 1200 | No (control) |
| Fullwidth "２５００" whole (N2) | `unknown` (not folded) | No: safe direction |
| Persian "۲۵۰۰": 500 quoted "۵۰۰ cups" (N2) | `unknown` (folded, then aligned) | No |
| **An unfolded look-alike digit before ASCII digits:** "２500", "𝟐500", "२500" or "²500", with 500 quoted "500 cups" (N2) | **known** | **Info: SEC-D-18** |
| **An invisible character inside the buyer's number:** U+200B "2​500"→500 and →2 (the whole "2​500 cups" grounds 2 but not 2500); U+2060, U+00AD, U+FEFF inside "1200"→200; U+200F inside "١٢٠٠"→12; "1,‏200"→200 (N3, N4; through the route in N10) | **known** | **Info: SEC-D-18** |
| **Other grouping marks:** a space, NBSP or narrow NBSP in "1 200", the apostrophe in "1'200", the Arabic comma in "١،٢٠٠", each with 200 quoted "200 lids" (N6; through the route in N10) | **known** | **Info: SEC-D-18** |
| A dot used for grouping, "2.500 cups": neither 500 nor 2500 (N6) | `unknown` | No: safe direction |
| A table word inside a longer word ("fivefold"), or after the Arabic conjunction "وخمسة" (N8) | `unknown` | No: safe direction. d1's "known residual" for a word inside a longer word does not ground anything in these forms |

**Resolved.** In every SEC-D-18 case, the unusual character is in the **buyer's** text. The model, or an injection, chooses only the quote, and cannot place the character there.

## 3. SEC-D-10: `deadlineTimeInQuote`

**The change** (`src/services/extraction.js`):
- The deadline goes through d1's validator, so its quote must be in the text.
- The value's `HH:MM` must then match a clock token (`CLOCK_TOKEN`) or an hour with am/pm (`MERIDIEM_TOKEN`) found in the normalised text.
- That token must lie wholly inside an occurrence of the quote.

**Refused** (ev:ev-mv36kohb-016711c9, section T; each is `unknown`):
- **T1, longer digit runs:**
  - "by 111:30" for 11:30 and for 01:30;
  - "11:305";
  - "11:3" of "11:30", and "1:30" of "11:30";
  - "v2.11:30";
  - "1,11:30";
  - "11:30:15", which is not read at all (safe direction).
- **T3, am/pm forms:**
  - "3 pm" does not ground 03:00, and "11:30pm" does not ground 11:30;
  - "12 am" does not ground 12:00;
  - "13 pm" and "0 am" are not times, and "25 pm" does not ground 17:00;
  - "11 amazing lids" is not 11 am, and "5 apples" is not 5 am;
  - "11 p. m.", "noon" and "24:00" are not read (safe direction);
  - FU-31: "الساعة ٣ م" is not read (safe direction).
- **T4, the quote and the token:**
  - a quote with no time while the time sits in another sentence ("Deliver by Friday" with "17:00" elsewhere);
  - a quote that cuts the token ("by 11:3");
  - a quote next to the time but not containing it ("cups by");
  - a quote whose only occurrences are inside "by 11:305" and "by 111:30".
- **T5:** a date-time whose time differs from the quote.
- **T6, through the route:** 11:30 quoted "by 111:30" is stored `unknown` with the deadline question.

**Known, as intended:**
- "by 11:30", "3 pm" (no full stop after it), "11:30pm, thanks"→23:30, "11:30 P.M."→23:30, "12 am please"→00:00, "12 pm!"→12:00;
- the Arabic-Indic "قبل الساعة ١١:٣٠"→11:30;
- for a quote "by 11:30" that occurs twice, the aligned occurrence counts.

**Residuals, observed:**
- **T2, a time glued to letters, or a range:** "room11:30", and both ends of "11:30-12:00", ground. The time is the buyer's, so this is lexical (SEC-D-13).
- **T4/T6, the lexical class decided by `dec-mv36ch5t-01a1d509`:** 09:00 quoted "We open at 9:00", when the text's deadline is 17:00, is known through the route. So is 09:30 from "Call me 9:30".
- **T5, the date part (FU-30, accepted by `dec-mv36cgyj-01f0741d`):** "tomorrow by 11:30"→2026-10-21T11:30 is known. So are a **past** date, 2026-10-01T11:30 quoted "today by 11:30" (request day 2026-10-20), and a far one, 2099-12-31T11:30.
  - Impact: the buyer sees a wrong date on a "From your text" deadline and must confirm it. The planner reads only confirmed values. I agree with accepting it.
  - **Suggestion for FU-30, if it is taken up:** a range check needs no calendar. A `user_text` date before the request day, or more than a few weeks after it, would be `unknown`, which closes the past and far-future cases.
- **SEC-D-19:** "by 3 pm." at the end of a sentence, quoted "by 3 pm", is `unknown` (see info).

**Resolved for the time part.** The date part is the accepted residual.

## 4. SEC-D-15: signals on the real server

`src/main.js` now registers `for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, stop)`, and `stop()` returns early once `stopping` is set.

Every run below is a real `src/index.js` process with provider `cli` (confirmed from `/api/config`), a stub `claude`, and an extract in flight (ev:ev-mv36rmvf-01b7b830):

| Case | Result |
|---|---|
| S1 SIGTERM / S3 SIGINT | exit 0 in about 25 ms; child and grandchild gone; no `rs-cli-*` cwd left; no `extraction.close_failed` |
| S2 SIGTERM, a child that ignores SIGTERM | exit 0 after about 1023 ms (the 1 s grace, then SIGKILL); both gone |
| **S4 SIGHUP** (iteration 2: the server died and the child survived) | exit 0; both gone |
| **S5 SIGTERM, then SIGTERM 200 ms later**, stubborn child (iteration 2: the second signal killed the server and the child survived) | exit 0 after about 1023 ms; both gone |
| S6 SIGINT ×3 (Ctrl-C pressed three times) / S7 SIGHUP then SIGTERM / S8 SIGTERM, SIGHUP, SIGINT, SIGTERM within 150 ms | exit 0 once; both gone |
| **S9 bounded shutdown:** a client holding a half-sent request (Content-Length 100000, body not sent), a stubborn child, SIGTERM twice | exit 0 after 3023 ms: the 1 s grace, then `closeAllConnections` 2 s later (`src/http/server.js`). Swallowing repeated signals therefore cannot make a client-held shutdown hang |
| S10 SIGKILL (FU-28) | the child survives, and the row stays `reserved` for the startup sweep, as FU-28 states |

In every S1–S9 case, `model_spend` is `settled` at the cap (§5).

**Resolved for the server.**

**FU-28 (b), the runner's SIGHUP:** open, by code reading (`INTERRUPT_SIGNALS = [['SIGINT', 130], ['SIGTERM', 143]]`, `test/live/run-live-model.js:34`). D3 in ev:ev-mv36t67q-01182083 reproduces the class with a handler-less parent. Bound: one child per run × `--max-budget-usd 0.05`. Recording it as a follow-up is adequate; it is not a phase-D blocker.

## 5. SEC-D-16 and FU-32: the cap charge

**The change** (`src/ai/cli.js`):
- `terminate()` and the `close` handler of a terminated run reject `PROVIDER_UNAVAILABLE` with `usage: unknownAtCap()`.
- `fail()` attaches the same usage whenever `child` was set.
- A spawn `error` event, a call closed before spawn, or an abort before spawn carries no usage.

**On the real gate, over HTTP** (ev:ev-mv36rmvf-01b7b830):
- **S1–S9:** after every shutdown with a call in flight, `model_spend` is `[{"status":"settled","r":50000,"a":50000}]`. In iteration 2 it was `a: 0`.
- The extract answered `200` degraded `PROVIDER_UNAVAILABLE`.
- **SEC-D-16 is resolved.**

**FU-32** (the extension to the adapter's own kills):
- **F1, a hanging child ended by the timeout** (`RS_MODEL_TIMEOUT_MS=1500`; the adapter's timer and the service watchdog share this value): `200` degraded `PROVIDER_TIMEOUT`, child gone, settled at the cap.
- **F2, an output flood over 8 MiB:** `200` degraded `PROVIDER_BAD_OUTPUT`, child gone, settled at the cap. Before FU-32 this was refunded at 0.
- **F3 control, a normal answer:** settles at its reported cost, 1300, not the cap.
- **F4 control, a billed error** (`is_error`, `total_cost_usd` 0.002): settles at 2000.

**I accept FU-32**, for four reasons:
- The billing state of a killed, started child is unknown. The `--max-budget-usd` cap is the honest upper bound, and the service watchdog already charges it for the same event. Charging the cap removes an under-count. An under-count is the direction that matters for the spend limits; an over-count only makes the limits trip earlier.
- A call that never started a process is still not charged.
- F3 and F4 show that the reported cost still wins whenever a result event arrives.
- **A correction to FU-32's stated side effect** ("a buyer who cancels an extract mid-call is charged the cap"): no HTTP path aborts the provider call. In `callProvider` (`src/services/extraction.js:293–306`), the only `controller.abort()` is the watchdog's. The `req 'aborted'` listeners belong to the upload body reader. A client that disconnects therefore does not end the call, and its cost is whatever the call reports.
- The rule should be stated in the verification report as recorded: started and killed means the cap; not started means 0; reported means reported.

## 6. SEC-D-17: the test sandbox PATH and temp cwds

**Canary** (ev:ev-mv36suet-01a5f678): a `claude` that writes a marker and exits 1 was put **first on the parent PATH**. Under it these ran, under the net guard:
- `cli.test.js` and `live-runner-refusal.test.js`: 57 tests, 57 pass;
- d3's two TR-D-16 real-server tests: 2 pass.

No marker was written, so no test, driver or provider looked `claude` up on the parent PATH. This is consistent with the code:
- the `cli.test.js` sandbox is `PATH: bin`, and every provider gets `command: join(bin, 'claude')`;
- the orphan driver uses `command: join(binDir, 'claude')` with `PATH: binDir`;
- the two "missing binary" cases point at a non-existent `nowhere` directory.

**Temp cwds** (ev:ev-mv36t67q-01182083, D11): my iteration-2 driver probe now leaves **3** empty cwds, all from the three handler-less signal deaths (D1–D3), where no code can run. In iteration 2 it left 7. The exit-hook paths (`process.exit`, an uncaught exception, an unhandled rejection, and `exit` with a stubborn child) now remove theirs. The real-server runs left none (S1–S9).

**Resolved.**

**One residual (info, inside SEC-D-17):** d3's TR-D-16 tests give the server `PATH: <stub bin>:/usr/bin:/bin` (`test/api/uploads-retention.test.js:821`) and look `claude` up by name. They do not make the "no claude in /usr/bin or /bin" assertion that `live-runner-refusal.test.js:291` makes.
- This is safe as written: the stub is first, and it is written before the server starts.
- On a developer machine whose npm global prefix is `/usr`, `/usr/bin/claude` can exist, and only the stub's presence keeps it out of reach.
- **Suggestion:** copy the assertion from line 291. Non-blocking.

## 7. New surface in `git diff 0259ce4 -- src test`

- **`IMAGE_PROVENANCE_FIELDS`** is exported and frozen (I0). Nothing reads it from a request.
- **`quoteAlignedInText`, `CLOCK_TIME`, `CLOCK_TOKEN`, `MERIDIEM_TOKEN`, `timesInText`:**
  - each regex is linear: one bounded quantifier and fixed lookarounds;
  - the occurrence loops are bounded by text 4000 × quote 200;
  - measured on adversarial inputs at those limits: at most 3.6 ms for all nine fields (ev:ev-mv36vau5-01f455b8). **No exposure.**
- **`unknownAtCap()`:**
  - it carries only the model name, the cap and zero tokens;
  - it is attached to errors that the service already maps to fixed codes, and E5 shows no error content leaks into the response, logs or rows (ev:ev-mv36gjhy-013bdb82);
  - **No exposure.**
- **`rmSync(cwd)` in the exit hook:** `cwd` is the adapter's own `mkdtemp` result, stored in the `LIVE_CHILDREN` map. No external input reaches it. **No exposure.**
- **`process.on` instead of `once` in `main.js`:** this changes how repeated signals behave. S9 shows shutdown still completes in about 3 s with a client holding a connection. SIGKILL still works (S10). **No exposure.**
- **Tests and the fixture:** reviewed under SEC-D-17.

## Findings

### blocking

None.

### major

None.

### minor

None.

### info

**SEC-D-18: whole-number alignment sees only ASCII digits and `,` `.` `:`, so in some buyer-written forms a part of the buyer's number still grounds.**
- **Where:** `alignedAt` (`src/ai/schema.js`) treats as a boundary any character that is not an ASCII digit or one of `,` `.` `:`. `normalizeForCompare` folds only Arabic-Indic and Persian digits and the two Arabic separators, and keeps format characters (`\p{Cf}`).
- **Reproduction:** ev:ev-mv36kohb-016711c9, N2, N3, N4, N6, and through the route in N10. Each of these is stored known, provenance `user_text`:
  - 500 quoted "500 cups" when the buyer's text has "２500", "𝟐500", "२500", "²500" or "2​500";
  - 200 quoted "200 lids" when it has "1 200" (a space, NBSP or narrow NBSP), "1'200", "1⁠200", "1­200", "1﻿200", "1,‏200", or the Arabic comma form "١،٢٠٠";
  - 12 quoted "١٢" from "١٢‏٠٠".

  Through the route (N10), 500 from "2​500 cups" and 200 from "1 200 lids" are stored known.
- **Impact:**
  - The class is SEC-D-11's: a tenfold or larger understatement shown as "From your text".
  - The unusual character must already be in the **buyer's** text: a space-grouped number, or invisible marks from a copy-paste. An injected model chooses only the quote and cannot add it. A quote holding a character that is not in the text is `NOT_QUOTED` (N3, N4).
  - The buyer confirms every field before any plan.
  - Info, not minor: SEC-D-11's common forms ("2500", "1,200", "$1200") are fixed, and these forms need unusual buyer input.
- **Resolution (when the file is next touched, or as a verification-report risk):**
  - in `normalizeForCompare`, remove `\p{Cf}` from both sides;
  - in `alignedAt`, treat any `\p{Nd}` as a digit;
  - treat a single space, NBSP, NNBSP, `'` or `،` between a digit and exactly three digits as a number continuation;
  - add tests for "1 200 lids"→200 `unknown` and "2​500 cups"→500 `unknown`.
  - Owner: ai-engineer (`schema.js`).

**SEC-D-19: a deadline quoted without the full stop that ends its sentence is not grounded ("by 3 pm." quoted "by 3 pm"). Safe direction.**
- **Where:** `MERIDIEM_TOKEN` ends in `m\.?`, so in "by 3 pm." the token takes the full stop. `deadlineTimeInQuote` then requires `t.end <= at + quote.length`, and the quote "by 3 pm" stops one character short.
- **Reproduction:** ev:ev-mv36kohb-016711c9, T3:
  - "Need 200 cups by 3 pm." with the quote "by 3 pm" gives 15:00 `unknown`;
  - the same quote with "by 3 pm." is known;
  - "by 3 p.m. on Friday" quoted "by 3 p.m" is `unknown`.

  d3's test passes because its text is "cups by 3 pm please" (`test/api/extract.test.js:308`).
- **Impact:** usability only. A correct deadline is asked again instead of filled. There is no security impact.
- **Resolution:** require the token's digits and its `[ap]m` letters, not the trailing full stop, to lie inside the quote. Equivalently, compute `end` before the optional final `\.`.
  - Add the test: "cups by 3 pm." quoted "by 3 pm" → 15:00 known.
  - Owner: backend-engineer, with FU-30/FU-31 (the same rule, the same route).

**Carried, unchanged:**
- **SEC-D-13** (lexical grounding; `dec-mv36ch5t-01a1d509`): G4, N5, T2 and T4 still reproduce.
- **SEC-D-14** (capacity and diameter from the photo, no OCR): I4 still reproduces.
- **FU-28** (SIGKILL; a parent with no handler; (b) the runner's SIGHUP): S10, D1–D3.
- **FU-30 and FU-31:** T5, T3.

All are in carry items 6, 7 and 9 of `followups.md`. For FU-30, see the range-check suggestion in §3.

## Not checked

- **d3's mutants** (TR-D-11, TR-D-13, TR-D-14 and TR-D-16) and its red-first runs: these are not recorded entries, and I did not reproduce them, because my role does not edit the code under review. My probes test the behaviour directly instead: the equivalent cases (G2, G7, G8, G9, S4, S5) showed each weakness on the iteration-2 code (ev:ev-mv353ywi-01d41ace, ev:ev-mv3549s6-014f5d35), and the iteration-3 probes (I6, N10, T1, T6, S4–S8) pass on this code. I did not run my new probes against the old code.
- **The d4 and d5 plan commands** (`npm test`, `npm run test:browser`): not run by me. I ran d1, d2 and d3.
- **A real model, and the real `claude` binary:** whether Haiku follows injected wording (LIVE-M1), whether the real CLI ignores SIGTERM, and whether a killed call is billed. That decides how often the cap charge over-counts.
- **The live runner as a real process past the launch check** (it needs `RS_LIVE_MODEL=1`): its SIGHUP gap rests on code reading and my D3 driver.
- **The startup sweep after a SIGKILLed server:** not tested by me in this iteration (S10 stops at "reserved").
- **The Anthropic adapter on shutdown**, and **`docker stop`**: not probed.
- **A client disconnect during extract:** checked by code reading only (§5).
- **Memory:** not consulted. mem-sd-mv1audrd-013b7102 (guard root resolution) does not bear on these checks.

## Guard refusals during this review (verbatim)

1. **Writing this draft with `cd … && cat > .eccode/reviews/drafts/phase-d-security-3.md`:** "This command changes directory (cd/pushd/popd) and then writes the relative path ".eccode/reviews/drafts/phase-d-security-3.md", which the guard cannot bind to a file. Write it with a path relative to the project root in a command without cd, or use the Edit/Write tool so ownership can be checked."
   - Fair. I used the Write tool.
2. **Inline `node -e` with `writeFileSync` editing my scratch probe:** "Inline node code in this command calls a file-writing API (writeFileSync) and the guard cannot see which files it would change. Use the Edit/Write tool for file changes so ownership can be checked, or save the script under your draft area (.eccode/drafts/), run it from there and declare its outputs."
   - Fair: the target could not be seen. I used a patch script written with the Write tool and run by path (`sec-phd3-patch.cjs`).
3. **A shell loop running the three plan commands through `eccode evidence run … -- "$c"`:** "The guard cannot verify who this eccode command acts as: "$c" runs a command through a variable or substitution; call the eccode CLI directly so its --actor can be checked."
   - Fair: the `--actor` was literal, but the recorded command came through a variable. I ran each command directly.
4. **A read-only shell loop that ran `grep -c` over my evidence log (`.eccode/evidence/…log`), with no eccode command in it:** "The guard cannot verify who this eccode command acts as: "$s:" runs a command through a variable or substitution; call the eccode CLI directly so its --actor can be checked."
   - **Over-denial**, of the raw-text kind in the delivery-lead's process note 4. The `.eccode` path was probably read as an eccode command. I used the Grep tool instead.
