# Phase d-extraction — submission

Author: delivery-lead. Gate: `phase:d-extraction`. Date: 2026-10-11.
- **Plan:** `.eccode/artifacts/plan/plan.json`, revision 2, approved.
- **Follow-ups:** `.eccode/artifacts/plan/followups.md`. This submission extends it with the section "Added after phase D":
  - the status of FU-2, FU-13, FU-16, FU-17, FU-18 and FU-20;
  - new items FU-21..FU-26;
  - the list of documented design deltas that TR-RW2-2 asks for.
- **Tree:** HEAD `461a5ac` for every run below. Its code is the same as `966e761` (rework-3); the later commits `b8e3489` and `461a5ac` change only `docs/build/state.md` and `.eccode/` records. My first `npm test` label says "HEAD b8e3489", but `461a5ac` (records only) had already been committed when that run started.
- **Artifacts:** the engine unions every completion's declared files into the phase artifacts.
- **Reviewers:** technical, plus security for uploads, model input isolation and the log scan (plan.md).

## Response to rev-mv35hyoj-01e0a18c (iteration 3, the last)

This is the third and last iteration the gate allows (`maxReviewIterations` 3). The review is `.eccode/reviews/drafts/phase-d-2.json` (TR-D-11..TR-D-17, and TR-D-3..TR-D-8 carried); the security draft is `.eccode/reviews/drafts/phase-d-security-2.md` (SEC-D-10..SEC-D-17). Where this section differs from the iteration-2 section or the first submission below, this section wins.

**Resets.** Three tasks were reset and completed again, in dependency order. d1 came first, and the engine held the d2 and d3 claims until it was done.
- **d1-ai-core** (ai-engineer), handoff **ho-mv35op30-016a6560**: TR-D-12 (= SEC-D-11), and the validator half of TR-D-14.
- **d2-ai-adapters-corpus** (ai-engineer), handoff **ho-mv35z5ux-01b0d55a**: TR-D-15 (= SEC-D-16) and SEC-D-17.
- **d3-extraction-service** (backend-engineer), handoff **ho-mv35zyof-011e9473**: TR-D-11 (= SEC-D-12) per `dec-mv35aank-0169ec16`, TR-D-13 (= SEC-D-10), TR-D-14, and TR-D-16 (= SEC-D-15) in `src/main.js`.

d4 and d5 are unchanged.

**Tree.** Every run below is on HEAD **`09749e9`**, a clean tree.
- The code diff from the iteration-2 tree, `git diff --stat a9d0507 HEAD -- src test public scripts package.json`, is 10 files, +596/−36.
- Those are exactly the 10 files declared in the three handoffs:
  - d1: `src/ai/schema.js`, `test/unit/ai/schema.test.js`;
  - d2: `src/ai/cli.js`, `test/unit/ai/cli.test.js`, `test/fixtures/extraction/cli-orphan-driver.mjs`;
  - d3: `src/services/extraction.js`, `src/main.js`, `test/api/extract.test.js`, `test/api/extract-image.test.js`, `test/api/uploads-retention.test.js`.

**Safety.** Every run of mine used `PATH=/usr/local/bin:/usr/bin:/bin`, which holds no `claude`. I never set `RS_LIVE_MODEL=1`, and no real model was called. The engineers report the same; d3's real-server tests give the server a PATH of the stub directory plus `/usr/bin:/bin` only, and d2's unit sandbox now has the stub directory alone (SEC-D-17).

### Delivery-lead runs on the final tree (`09749e9`)

| Run | Result | Evidence |
|---|---|---|
| `npm test` | exit 0. **1288 tests: 1280 pass, 0 fail, 8 skipped, 0 todo**, 146 suites.<br>`ECCODE_EVAL {"passed":200,"total":200}`.<br>NFR5: p95 53.7 ms (p50 1.9 ms) over 3165 API requests; suite 43.7 s.<br>The 8 skipped are the same 8 as in iterations 1 and 2: the 7 phase E contract rows (e6) and fake × `PROVIDER_BUSY`. | **ev:ev-mv364015-013062b3** |
| `npm run test:browser` | exit 0. **8 tests: 8 pass, 0 fail, 0 skipped.** | **ev:ev-mv364duc-01e596db** |
| d1 plan command, verbatim | exit 0. **154 tests: 154 pass, 0 fail.** Iteration 2 had 111. | **ev:ev-mv364qkw-01c54468** |
| d2 plan command, verbatim | exit 0. **112 tests: 112 pass, 0 fail**; `ECCODE_EVAL {"passed":200,"total":200}`. Iteration 2 had 107. | **ev:ev-mv3658zn-01b24346** |
| d3 plan command, verbatim | exit 0. **118 tests: 118 pass, 0 fail.** Iteration 2 had 111. | **ev:ev-mv365got-0149db19** |
| Artifact coverage (`phase-artifacts-check.mjs`, base `adf4a12`) | Runs after the submission, against it; see `handoff-3.json`. | after submission |

The three plan commands ran at the same time, as one batch of tool calls. All three were green under that load.

### Findings → resolution → change → tests → evidence

| Finding | Resolution | Change | Tests (verbatim names) | Evidence |
|---|---|---|---|---|
| **TR-D-11** (major), merged with **SEC-D-12** (minor): with a photo attached, `provenance: image` was accepted for every field | **Fixed (d3 reset)** | `src/services/extraction.js` › `normaliseExtraction`:<br>- `provenance: image` is accepted only when `hasImage === true` **and** the field is in the exported, frozen `IMAGE_PROVENANCE_FIELDS = ['productType', 'material', 'capacityMl', 'diameterMm']`, as `dec-mv35aank-0169ec16` decides;<br>- an image claim for `cupQuantity`, `lidQuantity`, `maxPickups`, `deadline` or `budgetUsd` is downgraded to `unknown` with that field's template question, and the rest of the answer stands;<br>- the prompt wording is unchanged (the review does not require it). | `test/api/extract.test.js`: **`SEC-7: provenance image is accepted only for productType, material, capacityMl and diameterMm, whatever the photo (TR-D-11)`**. Unit level: the two quantities, the pickups, the deadline and the budget are unknown with their questions; the four product fields keep `image`; the list is pinned.<br>`test/api/extract-image.test.js`: **`SEC-7: through a real upload, a model claiming "image" for the budget, pickups, quantities and deadline is stored unknown with its questions; the product fields keep image (TR-D-11)`**. A real PNG upload through the route, with a stub provider, and the stored `fields_json` checked too.<br>`RS-02: a clear photo yields capacity and diameter with provenance image; the text keeps provenance user_text` stays green.<br>**Against the six conditions:**<br>(1) met;<br>(2) the route test above;<br>(3) RS-02 green, and EXT-1 fake 200/200 in my `npm test` and d2 runs;<br>(4) the mutant (the allow-list condition removed) turns exactly those two tests red, 30 pass and 2 fail, then restored. **Not a recorded evidence entry** (see process note 2);<br>(5) my runs above;<br>(6) d3 re-ran your P5 by path. Your own re-run is yours to make. | **Reviewer's P5, re-run by d3:** **ev:ev-mv35yyvp-019ac755**. With a photo, P5a and P5b show the budget, the pickups, `cupQuantity` and the deadline unknown. `capacityMl` 1999 with `image` stays known, which is the accepted SEC-D-3/SEC-D-14 residual.<br>d3 plan command: ev:ev-mv35wtzv-019b1a11 (118/118); d3 `npm test`: ev:ev-mv35y9yl-01935e86 (1288/1280/0/8); d3 browser: ev:ev-mv35ykbj-01748e81 (8/8).<br>Mine: **ev:ev-mv365got-0149db19**, **ev:ev-mv364015-013062b3**, **ev:ev-mv364duc-01e596db**.<br>Failing first: before the change 28 of 32 tests passed, and the two tests above plus the TR-D-13 pair were red. **No evidence id** for that run (process note 2). |
| **TR-D-12** (minor), merged with **SEC-D-11** (minor): a quote that starts or ends inside a longer number grounded a smaller value | **Fixed (d1 reset)**. d3 picks it up through `validateExtraction`, with no copy of the rule. | `src/ai/schema.js`:<br>- **`quoteAlignedInText` / `alignedAt`:** the quote needs at least one occurrence in the normalised text that neither starts nor ends inside a number. A number continues over `,` `.` `:` when a digit follows. Arabic-Indic digits and the Arabic thousands and decimal separators are folded first by the existing `normalizeForCompare`, so they behave the same way;<br>- **`numberGrounded`** masks clock times (`HH:MM[:SS]`) in the quote before it reads numbers, so "11:30" grounds neither 11 nor 30;<br>- the doc comment of `validateExtraction` states the rule. | `test/unit/ai/schema.test.js`, suite **`validateExtraction: a quote must align to whole numbers in the text (TR-D-12, SEC-D-11)`**:<br>- 18 `refused: …` cases, including:<br>  - `250 from "2500 cups" (prefix)`;<br>  - `200 lids from "1,200 lids" (after a thousands comma)`;<br>  - `200 lids from "1200 lids" (digit suffix)`;<br>  - `50 ml from "250 ml"`;<br>  - `1 from "11:30" (digit prefix)`;<br>  - `$12 from "$1200"`, `$120 from "$1200"`;<br>  - `25 from Arabic-Indic "٢٥٠" mixed with a Latin digit`;<br>  - `200 from Arabic-Indic "١٬٢٠٠" (Arabic thousands separator)`;<br>- 18 `accepted: …` cases, including `1,200 grounds 1200`, `250ml grounds 250 (a unit glued to the number)`, `$120.50 grounds 120.5`, `Arabic-Indic digits` ("٢٥٠ مل"→250), `Arabic thousands separator`, `an English number word`, `an Arabic number word`, and the duals;<br>- two edge tests.<br>Through the route: `test/api/extract.test.js` **`SEC-7: through the route, an invented deadline, a number cut out of a longer number and a quote that is not in the text are stored unknown (TR-D-13, TR-D-12, TR-D-14)`** (200 from "1,200"). | Failing first: **ev:ev-mv35lwdy-01f8cf33**, 18 of 71 red, exactly the 18 refused cases.<br>Mutants, all reverted:<br>- M1, alignment disabled: 16 red, **ev:ev-mv35mhaq-0186b5db**;<br>- M2, a separator followed by a digit before the quote ignored: 4 red, **ev:ev-mv35mmi1-01bb91e9**;<br>- M3, clock masking removed: 2 red, **ev:ev-mv35mtcw-016cdd03**.<br>d1 plan command: **ev:ev-mv35n0po-013c3a04** (154/154). d1 `npm test`: ev:ev-mv35nywb-01431134 (1276/1268/0/8, before d2 and d3 landed).<br>Mine: **ev:ev-mv364qkw-01c54468**, **ev:ev-mv364015-013062b3**. |
| **TR-D-13** (minor), merged with **SEC-D-10** (minor): a `user_text` deadline was never grounded | **Fixed for the time (d3 reset). The date part is not grounded**; see FU-30. | `src/services/extraction.js` › new **`deadlineTimeInQuote`**. It is d3's own rule, because d1's validator treats the deadline as a plain string:<br>- the value's time (`HH:MM`, alone or at the end of `YYYY-MM-DDTHH:MM`) must appear in the normalised text as a clock token `H:MM`/`HH:MM`, or as an hour with am/pm;<br>- the token must not be part of a longer digit run, clock or decimal (`111:30`, `11:305`);<br>- the token must lie inside an occurrence of the quote;<br>- the deadline also goes through d1's validator probe, so its quote must be in the text.<br>**Against the resolution wording:** "and its date part too when present" (TR-D-13; SEC-D-10 says the same) is **not met**. `2026-10-21T11:30` quoted "tomorrow by 11:30" stays known on the time alone. A relative date cannot be matched without a calendar. The buyer confirms the deadline. | `test/api/extract.test.js`: **`SEC-7: a user_text deadline is known only when its time is written in its quote, under whole-token alignment (TR-D-13)`**.<br>Unknown:<br>- the three P5c cases;<br>- a right time with a quote that lacks it;<br>- 11:3, 111:30, 11:305, and 1:30 inside 11:30.<br>Known: "by 11:30", the Arabic "قبل الساعة ١١:٣٠", "tomorrow by 11:30", "3 pm" and "12:15 a.m.".<br>Plus the route test in the TR-D-12 row.<br>An older d3 test accepted 09:30 quoted "by 11:00", which encoded the bug. It was corrected to quote 09:30. | d3: ev:ev-mv35wtzv-019b1a11, ev:ev-mv35y9yl-01935e86.<br>The reviewer's P5c, re-run by d3: **ev:ev-mv35yyvp-019ac755**. The three cases are unknown, and "by 11:30" is known.<br>Mutants (rule disabled: 2 red; the end-of-token lookahead removed: 1 red): **not recorded evidence entries** (process note 2).<br>Mine: **ev:ev-mv365got-0149db19**, **ev:ev-mv364015-013062b3**. |
| **TR-D-14** (minor): the mutant that removes d3's substring check survived | **Fixed (d3 reset; d1 added the validator tests)** | **d3:** the local `textNorm.includes(quote)` check is gone. `quoteGrounded` runs d1's `validateExtraction(probe, { text })` for **every** `user_text` field: numeric fields, `productType`, `material` and `deadline`. The presence check (`NOT_QUOTED`) and the whole-number alignment therefore have one source.<br>**d1:** the validator already checked `NOT_QUOTED` for every kind, because the substring test sits before the numeric branch. The missing piece was a test.<br>**Your M2 literal** (`textNorm.includes(quote)` removed) no longer exists as a separate line, because the single guard is now the validator call. The equivalent mutants are listed in the evidence column. | `test/unit/ai/schema.test.js`, suite **`validateExtraction: every user_text quote must be in the text, not only numeric ones (TR-D-14)`**:<br>- `${field}: a quote that is not in the text is NOT_QUOTED`, for productType, material and deadline;<br>- `the same non-numeric fields pass when the quote is in the text`;<br>- `a quote that differs only by case or by an injected word is NOT_QUOTED`.<br>These five passed before d1's change.<br>`test/api/extract.test.js`: **`SEC-7: a non-numeric user_text field whose quote is not in the request text is unknown and asked (TR-D-14)`**: material "plastic" quoted "plastic cups", productType "lids" quoted "lids only", a deadline quoted "by noon, 11:00", and empty and null quotes; the grounded forms stay known.<br>Plus the route test in the TR-D-12 row. | d3 mutants:<br>- `quoteGrounded` forced true: 6 red;<br>- the check applied to numbers only: 2 red, the TR-D-14 tests. This is the equivalent of your M2.<br>**Neither is a recorded evidence entry** (process note 2).<br>d3: ev:ev-mv35wtzv-019b1a11. d1: ev:ev-mv35n0po-013c3a04.<br>Mine: **ev:ev-mv365got-0149db19**, **ev:ev-mv364qkw-01c54468**. |
| **TR-D-15** (minor), merged with **SEC-D-16** (info): a call ended by `close()` was settled at 0, while a timeout is charged at the cap | **Fixed (d2 reset).** The review allowed a follow-up instead, but d2 was reset anyway. | `src/ai/cli.js`:<br>- `call()` builds `unknownAtCap()`. It has the full usage shape (model, `costUsd` = cap/1e6, integer `costMicroUsd` = `callCapMicroUsd`, 0 tokens, `latencyMs`), because the shared provider contract test requires that shape for any attached `err.usage`;<br>- `terminate()` (the `close()` path) and the `close` handler of a terminated run reject `PROVIDER_UNAVAILABLE` with `{ usage: unknownAtCap() }`;<br>- `fail()` attaches the same usage to timeout, abort during a run and the 8 MiB flood, **whenever a child had started**. See FU-32;<br>- a call that never started a process carries no usage, because nothing can have been billed. That covers a call closed before spawn, a spawn error, a missing binary and an early abort.<br>**The service needs no change:** `callProvider` rethrows the provider error unchanged, and `gate.run` refunds at `microUsdOfUsage(err.usage)`, which is the cap. | `test/unit/ai/cli.test.js`:<br>- **`TR-D-15: a call in flight when close() runs rejects PROVIDER_UNAVAILABLE carrying the per-call cap as its usage`** (cap 70000);<br>- **`TR-D-15: a child that ignores SIGTERM and is SIGKILLed after the grace period is also charged at the cap`**;<br>- **`TR-D-15: the ledger charges the cap for a call ended by close(); an unchanged call still settles at its reported usage`**. This one uses the real gate and SQLite: a normal call settles at 1300, a billed failure keeps 1300, and a hang ended by `close()` goes from reserved 50000 to settled 50000/50000;<br>- **`TR-D-15: a call that never started a process (closed before spawn, or an unavailable binary) is not charged`**;<br>- the existing timeout test now asserts the cap as well.<br>**Not written:** an HTTP-level row check (a hanging stub, the server closed, `model_spend.actual` = cap). It would go in d3's API files. d2 did not write it because those are d3's files, and d3 did not take it up. | Failing first: **ev:ev-mv35r9e5-01f5fecd** (`cli.test.js`: 38 tests, 34 pass, 4 fail).<br>Green: **ev:ev-mv35sbuc-019020e2** (38/38).<br>d2 plan command: **ev:ev-mv35x27x-01f78f22** (112/112). d2 `npm test`: ev:ev-mv35yihg-01cf262a (1288/1280/0/8).<br>d2's first `npm test` attempt, ev:ev-mv35tywg-01521d44, was red with 1 test in `provider-contract.test.js`, because the bare marker lacked the full usage shape. It was fixed by emitting the full shape.<br>Mine: **ev:ev-mv3658zn-01b24346**, **ev:ev-mv364015-013062b3**. |
| **TR-D-16** (info), merged with **SEC-D-15** (info): SIGHUP and a second signal during the grace period orphaned the child | **Fixed for the server (d3 reset). The live runner's SIGHUP is still open**; see FU-28 (b). | **`src/main.js`:** SIGINT, SIGTERM and SIGHUP are registered with `process.on` (not `once`), and `stop()` is idempotent: the `stopping` flag swallows repeats.<br>**`test/live/run-live-model.js`:** unchanged. `INTERRUPT_SIGNALS` is still SIGINT and SIGTERM. Its handlers already use `.on` with a memoised close, so a repeated signal is safe there; only SIGHUP is missing.<br>d2's handoff calls the runner "not d2's files". That is wrong: `plan.json` gives `test/live/run-live-model.js` to d2, and no later task owns it. | `test/api/uploads-retention.test.js`, suite **`TR-D-16: a real server process stops, and leaves no CLI child, on SIGHUP and on a second signal`**. The server is a real `src/index.js` with `RS_MODEL_PROVIDER=cli` and the stub `claude`; `/api/config` confirms the `cli` provider. The two tests:<br>- **`TR-D-16: SIGHUP (a closed terminal) runs stop(): the server exits 0 and the CLI child and its grandchild are gone`**;<br>- **`TR-D-16: a second signal during the grace period does not kill the server before stop() has killed a child that ignores SIGTERM`**. | Both tests failed first: the server died of SIGHUP or of the second SIGTERM.<br>Mutants: SIGHUP removed, 2 red; `process.once` restored, 1 red.<br>d3 ran the suite 6 times in a row, all green.<br>**None of these is a recorded evidence entry** (process note 2).<br>d3: ev:ev-mv35wtzv-019b1a11. Mine: **ev:ev-mv365got-0149db19**. |
| **TR-D-17** (info): SEC-D-13, SEC-D-14 and SEC-D-17 folded in | **SEC-D-13 and SEC-D-14 are carried** to the verification report's risk list (`followups.md`, carry item 6, extended). **SEC-D-17 is fixed (d2 reset)**, with two residuals. | **SEC-D-17:**<br>- the `cli.test.js` sandbox PATH is now the stub directory alone, with no `process.env.PATH` and no node directory;<br>- every sandbox provider, `cliVersion` and the orphan driver get `command:` as the absolute stub path;<br>- `cli-orphan-driver.mjs` runs with the stub directory alone on its PATH;<br>- `LIVE_CHILDREN` is a `Map` from child to cwd, and the synchronous exit hook `rmSync`s the cwd after the SIGKILL.<br>**Residuals:**<br>- the three signal deaths without a handler still leave an empty cwd, because no code can run;<br>- `live-runner-refusal.test.js` keeps its own `<stub dir>:/usr/bin:/bin`, with an assertion that no `claude` is there. SEC-D-17 named only `cli.test.js`. | **`SEC-D-17: the sandbox PATH is the stub directory alone and every provider gets the stub as an absolute command`**. The exit-hook test **`TR-D-9: process.exit() in the parent (what stop() does) kills the child through the exit hook`** now also asserts that no `rs-cli-*` directory remains. | ev:ev-mv35r9e5-01f5fecd (red first), ev:ev-mv35sbuc-019020e2; mine **ev:ev-mv3658zn-01b24346** |
| **TR-D-3** (minor): FU-23, ids reused after a hard delete | **Open, blocked on the user**, unchanged | No phase D change. `dec-mv341ap0-010209d2`: the engine refused rework-4 (`USER_AUTH_REQUIRED`, `limits.maxReworks=3`). The orchestrator asks the user to open the rework or delegate `rework.open`. **e4 is not dispatched until it is approved.** The `model_spend` statement is carry item 3. | none yet (`RS-39: …` comes with the rework) | `followups.md`; dec-mv341ap0-010209d2 |
| **TR-D-4** (minor) | As in iteration 2: the eleven deltas with the three caveats, carry item 1, resolved at the verification gate | — | — | `followups.md` |
| **TR-D-5** (info) | As in iteration 2: carry item 4; FU-26 re-records the transcript; LIVE-M1 stays Unverified | — | — | `followups.md` |
| **TR-D-6** (info) | As in iteration 2: carry item 5 and FU-26 (b). The review notes that SEC-7 scored on the stored row after `normaliseExtraction` matters more now, because TR-D-11..TR-D-13 act only after normalisation. | — | — | `followups.md` |
| **TR-D-7** (info) | As in iteration 2: the 408 NFR6 exception is carry item 2; the `RS_MODEL_TIMEOUT_MS` bound is FU-27 (e1, g2). The orchestrator includes FU-27's criterion in e1's dispatch. | — | — | `followups.md` |
| **TR-D-8** (info) | As in iteration 2: SEC-D-3..SEC-D-9 in carry item 6, FU-26 (a) and FU-29; FU-24 is `dec-mv330t0g-0175d52b`, and FU-25 is `dec-mv330t7a-017a2211` | — | — | `followups.md` |
| **SEC-D-10** (minor) | = TR-D-13 | — | — | — |
| **SEC-D-11** (minor) | = TR-D-12 | — | — | — |
| **SEC-D-12** (minor) | = TR-D-11 | — | — | — |
| **SEC-D-13** (info): grounding is lexical, not semantic | **Accepted; carry item 6.** The unit-token suggestion (ml/مل for capacity, mm/مم for diameter, a currency for the budget) is **not adopted, and no decision is recorded**; the orchestrator may record one. TR-D-12 removes the "part of a longer number" case. d1 lists the table word inside a longer word as unchanged. | — | — | ev:ev-mv353ywi-01d41ace (G4) |
| **SEC-D-14** (info): SEC-D-3 stands for capacity and diameter from the photo | **Accepted; carry item 6.** TR-D-11 keeps these two fields on the photo by decision. P5 shows `capacityMl` 1999 `image` still known. Only OCR or the buyer can check it. | — | — | ev:ev-mv35yyvp-019ac755 |
| **SEC-D-15** (info) | = TR-D-16 | — | — | — |
| **SEC-D-16** (info) | = TR-D-15 | — | — | — |
| **SEC-D-17** (info) | Fixed; see TR-D-17 | — | — | — |

### `followups.md` in this iteration (section "Added after the phase D iteration-2 review")

- **FU-28 rewritten:**
  - the server now handles SIGINT, SIGTERM and SIGHUP, and a second signal during the grace period;
  - SIGKILL, and any parent with no handler, still orphan the child;
  - (b) the live runner's SIGHUP is open, owner ai-engineer with the FU-26 adapter change;
  - g2's runbook text is updated.
- **FU-30 (new):** the deadline's date part is not grounded.
- **FU-31 (new):** Arabic am/pm markers (ص, م) are not read.
- **FU-32 (new, for the reviewers' judgement):** d2 extended the cap charge to the adapter's own timeout, abort and flood kills of a started child.
- **Carry item 6** is extended with SEC-D-13 and SEC-D-14. There are two new carry items:
  - **item 8:** the ledger statements of TR-D-15/FU-32, and the HTTP-level row test that nobody wrote;
  - **item 9:** the deadline is grounded on its time only (FU-30, FU-31).

### Statements of earlier iterations that iteration 3 supersedes

- **Tree and runs:** HEAD `a9d0507` and its counts (1233/1225, d2 107/107, d3 111/111) are superseded by the runs above.
- **FU-28's text** ("SIGKILL, or SIGTERM without a handler") is replaced as listed above.
- **d3's handoff, remaining issue 5** ("TR-D-15 … not changed here") is stale. It was true of d3's files, but d2 fixed TR-D-15 in the same iteration.
- **d2's handoff, remaining issue 2** ("main.js and the runner, not d2's files") is half wrong: the runner is d2's file. See TR-D-16.
- **Artifact coverage and handoff index:** superseded by the coverage run after this submission (`handoff-3.json`). The new handoffs are d1 ho-mv35op30-016a6560 (2 files), d2 ho-mv35z5ux-01b0d55a (3 files) and d3 ho-mv35zyof-011e9473 (5 files). No file is new to the phase.

### Process notes, iteration 3

1. **A commit swept in work in progress again.** Commit `83d152b`, titled "d2 reset: …", says so itself: "d3 work in progress in this snapshot". This has no content effect: `09749e9` holds every file, and all my runs are on it. It is the same pattern as iterations 1 and 2.
2. **d3's failing-first runs and mutant runs are not recorded evidence entries.** This covers the TR-D-11, TR-D-13, TR-D-14 and TR-D-16 mutants and the red-before runs.
   - d3 applied each mutant with `sed` to the working file, ran the tests, and restored the file. It verified each restore with `cmp`.
   - Only the results are in d3's handoff. The reviewer can reproduce each from the one-line change named there.
   - By contrast, d1's failing-first run and three mutants (ev:ev-mv35lwdy-01f8cf33, ev:ev-mv35mhaq-0186b5db, ev:ev-mv35mmi1-01bb91e9, ev:ev-mv35mtcw-016cdd03) and d2's red-first run (ev:ev-mv35r9e5-01f5fecd) **are** recorded.
3. **d3's `npm test` p95 was 110.5 ms** (ev:ev-mv35y9yl-01935e86), with other runs on the machine at the time. Mine, alone, is 53.7 ms. Both are far under the 300 ms limit.
4. **One guard refusal in my session.** It hit a read-only shell loop that ran `node -e` on each handoff file through a shell variable. The text was: `The guard cannot verify who this eccode command acts as: "./.eccode/handoffs/$h.json" runs a command through a variable or substitution; call the eccode CLI directly so its --actor can be checked.` No eccode command was in the line, so this is an over-denial of the raw-text kind. I read each handoff with `cat` instead.
5. **Budget:** `eccode status` showed 866.15 of 1200 minutes before this submission.
6. **Last iteration.** If this review requests changes again, the gate has no further iteration. The orchestrator then takes it to the user.

### Lessons, iteration 3

My memory search ("phase resubmission extraction grounding image provenance deadline signal handling CLI adapter ledger cap", `--check-env`) returned only **mem-sd-mv1audrd-013b7102** (guard root resolution). It is **not-applicable**:
- this resubmission designs or changes no hook or guard;
- every write in the nested record was accepted;
- the one refusal above is a raw-text reading, which the lesson's "Not applicable when" list names.

All three reset handoffs record the same decision.

## Response to rev-mv33xoyz-0143dd56 (iteration 2)

**Reworks.** Two tasks were reset and completed again:
- **d3-extraction-service** (backend-engineer), handoff **ho-mv3461bp-018c0431**: TR-D-1 (= SEC-D-1), TR-D-2, and d3's share of TR-D-9: shutdown closes the provider.
- **d2-ai-adapters-corpus** (ai-engineer), handoff **ho-mv34d3dh-01f6abfa**: TR-D-9 (= SEC-D-2) in the CLI adapter and the live runner, and TR-D-10.

d1, d4 and d5 are unchanged. No other task's file changed.

**Tree.** Every run below is on HEAD **`a9d0507`**, a clean tree apart from the `.eccode/` record. The reworked files reached git in four commits, and two of them are named for something else (see "Process notes, iteration 2"). `a9d0507` holds all of them.

**Safety.** Every run below used `PATH=/usr/local/bin:/usr/bin:/bin`. Those directories hold `node` and `npm` as links but no `claude`; the logged-in CLI lives in `/opt/node22/bin`, which was not on that PATH. I checked that npm's script PATH adds only `node_modules/.bin` directories and npm's `node-gyp-bin` (none holds a `claude`).
- I never set `RS_LIVE_MODEL=1`.
- The suite itself sets it only inside child processes whose PATH holds a stub `claude` or none. Those are d2's refusal and signal tests, which refuse to run if `/usr/bin/claude` or `/bin/claude` exists.
- No real model was called.

### Delivery-lead runs on the final tree (`a9d0507`)

| Run | Result | Evidence |
|---|---|---|
| `npm test` | exit 0. **1233 tests: 1225 pass, 0 fail, 8 skipped, 0 todo**, 143 suites.<br>`ECCODE_EVAL {"passed":200,"total":200}`.<br>NFR5: p95 54.9 ms (p50 2.0 ms) over 3160 API calls; suite 44.1 s.<br>The 8 skipped are the same 8 as in iteration 1: the 7 phase E contract rows (e6) and fake × `PROVIDER_BUSY`. | **ev:ev-mv34i7fr-01c4a959** |
| `npm run test:browser` | exit 0. **8 tests: 8 pass, 0 fail, 0 skipped**: RS-03 degraded 3, FU-17 2, RS-33 3. | **ev:ev-mv34ihvv-010e5c58** |
| d2 plan command, verbatim | exit 0. **107 tests: 107 pass, 0 fail**; `ECCODE_EVAL {"passed":200,"total":200}`. Iteration 1 had 96. | **ev:ev-mv34j5ys-0171d99c** |
| d3 plan command, verbatim | exit 0. **111 tests: 111 pass, 0 fail**. Iteration 1 had 105. | **ev:ev-mv34jbd0-01bb5567** |
| Security probe `sec-phd-probe.mjs E`, re-run by path (read-only; in-process app on temp databases with `RS_TEST_OFFLINE=1` and scripted providers) | exit 1 **as expected**: 28 PASS, 3 FAIL.<br>The 3 FAILs are exactly the three `E1 REPRO SEC-D-1` lines. Each asserts the bug (the value stored `known`), and each now prints `{"value":null,"status":"unknown",…}` for 99999 as "need cups", 777 as "lids for the weekend" and 5 as "at most two pickups".<br>The `E1 control` lines and E2..E9 pass unchanged. | **ev:ev-mv34k8si-0187cfbd** |
| Artifact coverage (`phase-artifacts-check.mjs`, base `adf4a12`) | Runs after the submission, against it; see the hand-off to the reviewer. My pre-check against the iteration-1 submission showed one new declared file not in it, `test/fixtures/extraction/cli-orphan-driver.mjs` (d2 reset), which this submission adds. | after submission |

The engineers' own runs are cited per row below. A red run there is a failing-first or a mutation run.

### Findings → resolution → change → tests → evidence

| Finding | Resolution | Change | Tests (verbatim names) | Evidence |
|---|---|---|---|---|
| **TR-D-1** (major), merged with **SEC-D-1** (minor): a digit-free quote grounds any number | **Fixed (d3 reset)** | `src/services/extraction.js` › `normaliseExtraction`:<br>- the `written.size === 0 \|\|` branch is gone;<br>- a numeric `user_text` value must pass `numberGroundedInQuote(wire, field, text)`, which runs d1's `validateExtraction(probe, { text })` on a one-field probe (every other field unknown). So **d1's own `NUMBER_NOT_IN_INPUT` rule decides**: ASCII or Arabic-Indic digits, English and Arabic number words, the Arabic dual;<br>- a failure downgrades that one field to `unknown` with its template question, and the rest of the answer stands.<br>**Against condition (1):** d1's files are untouched and `numberGrounded` is not exported. It is reused through `validateExtraction`, not copied, which meets "rather than a second copy" without the export the reviewer suggested. | `test/api/extract.test.js`:<br>- **`SEC-7: a number the quote does not contain, as digits or as a number word, is unknown even when the quote has no digits (TR-D-1)`**: "cups"→777, "two pickups"→5 and "a cafe"→250 are unknown, with questions for exactly those fields. These stay known: "two pickups"→2, "نقطتي استلام"→2, "ثلاثة نقاط"→3, "كوبين"→2, "٢٥٠ كوب"→250, "250 cups", "1,200 cups"→1200, "Four pickups"→4, and the provenance stays `user_text`;<br>- **`SEC-7: a model-invented number with a digit-free quote is stored unknown with its question, through the route (TR-D-1)`**: the route and the stored `fields_json`;<br>- "٢٥٠ مل"→250, and a quote with an unrelated digit, stay covered by `SEC-7: a user_text value whose quote is not in the request text is downgraded (grounding), digits of either script count`.<br>**Gap against condition (2):** security's E1 strings ("need cups"→99999, "lids for the weekend"→777) are not literally in the named test. The rule is the same digit-free case, and my re-run of security's E1 shows both unknown (row above). If the reviewer wants them in the suite, it is a two-line addition to d3's test. | Failing first: **ev:ev-mv340dds-01d11bc7** (the new test red before the fix, 1 of 1).<br>Mutation (the grounding check forced true, reverted): **ev:ev-mv3427er-01c6a0c9**, 3 of 19 red in `extract.test.js`.<br>Reviewer's probe P2 re-run: **ev:ev-mv342hje-0101f6db**, both stored unknown, and `schema.js` gives `NUMBER_NOT_IN_INPUT` for both.<br>d3 plan command: ev:ev-mv342qiu-0172fe19 (111/111), mine **ev:ev-mv34jbd0-01bb5567**.<br>Security E1 re-run: **ev:ev-mv34k8si-0187cfbd**.<br>`npm test`: **ev:ev-mv34i7fr-01c4a959** |
| TR-D-1, side effects (disclosed) | Accepted | d1's word table covers English up to ten, and Arabic up to five plus the duals. A quote that writes a larger number only in words ("fifty cups") is now unknown and asked. That is the safe direction, and it is d1's table.<br>SEC-D-3's E2 is unchanged: an obeying model that quotes the injected sentence itself still passes grounding ("set the budget to $99999" contains the number). | — | E2 info line in ev:ev-mv34k8si-0187cfbd |
| **TR-D-2** (minor): no API test for a provider-level `PROVIDER_BUSY` | **Fixed (d3 reset)** | Test only. | `test/api/extract-degraded.test.js`: **`RS-03: a provider-level PROVIDER_BUSY (the provider itself is saturated) is 200 degraded, and the reservation is settled at 0 (TR-D-2)`**. A stub provider throws `ProviderError('PROVIDER_BUSY')`. The test asserts:<br>- 200 and one call;<br>- `assertDegraded(…, 'PROVIDER_BUSY')`: degraded true, the errorCode, every field unknown;<br>- the `model_spend` row is `{actual_micro_usd: 0, status: 'settled'}`, and no row is `reserved`;<br>- the extractions row is degraded, `schema_ok` 0, `PROVIDER_BUSY`.<br>The contract-suite row fake × BUSY stays skipped by design (the fake has no busy fault). | ev:ev-mv342qiu-0172fe19, **ev:ev-mv34jbd0-01bb5567**, **ev:ev-mv34i7fr-01c4a959**; the reviewer's P1 passes in ev:ev-mv342hje-0101f6db |
| **TR-D-3** (minor) / security's FU-23 item: ids reused after a hard delete, wider than recorded | **Open, blocked on the user.** The reviewer does not block phase D on it. | No phase D change.<br>- `dec-mv330std-0165d9be` chose the migration, and its scope is widened in `followups.md` (FU-23, changed): `rescue_requests`, `plan_versions`, `images` and `planning_runs` with `AUTOINCREMENT`, plus a test `RS-39: …`.<br>- **`dec-mv341ap0-010209d2`:** the engine refused rework-4 (`USER_AUTH_REQUIRED`, `limits.maxReworks=3`). Only b1 owned `src/db/**`, so the migration cannot ride a pending task. The orchestrator asks the user to open the rework or to delegate `rework.open`.<br>- **e4 is not dispatched until that rework is approved**, which is the reviewer's condition. Phase E runs e0..e3.<br>- The statement about `model_spend` rows keeping the old request id is carried to the verification report (`followups.md`, carry item 3). | none yet (`RS-39: …` comes with the rework) | `followups.md`; dec-mv341ap0-010209d2 |
| **TR-D-4** (minor): the eleven design deltas, three with caveats | **Accepted; carried to the verification report** (owner delivery-lead) | No code change. `followups.md` › "Carried to the verification report", item 1, records the three caveats:<br>- with the default 30 s `requestTimeout` the 60 s `UPLOAD_TIMEOUT` branch cannot fire in production;<br>- `capabilities.deleteRequest` is constant `true`, a route-availability flag;<br>- the EXT-1 images are English-only, a LIVE-M1 limitation for Arabic packaging.<br>The verification report lists all eleven deltas with the reviewer's judgements. | — | `followups.md` |
| **TR-D-5** (info): what the stub transcript and the loopback stub prove | **Accepted** | LIVE-M1 stays Unverified (user-blocked: RISK-2, Q3). FU-26 re-records the transcript from the real stream. Carry item 4. | — | `followups.md` |
| **TR-D-6** (info): ECCODE_EVAL 200/200 is an assertion count over the fake | **Accepted; added to FU-26 (b)** | The LIVE-M1 report gives the `metrics.js` values as the threshold result, and scores SEC-7 on the stored row after `normaliseExtraction`. Carry item 5. | — | `followups.md` |
| **TR-D-7** (info), merged with **SEC-D-8** (info): the timeout chain | **Accepted.**<br>- The 408 is carried to the verification report as an **NFR6 exception** (no envelope, no `requestId`).<br>- The clamp is **new follow-up FU-27**. | **FU-27:** owner **e1-payment-adapters** (it owns `src/config.js` in phase E). It narrows `RS_MODEL_TIMEOUT_MS` to 1..40000 with a test `TR-D-7: …`, and **g2** documents the bound. If e1 is not to touch it, the orchestrator records a decision and g2 documents the bound alone.<br>The CLI's immediate `PROVIDER_BUSY`, where T19 says "5 s wait", is carry item 2 (availability only). | — | `followups.md` (FU-27, carry item 2) |
| **TR-D-8** (info): SEC-D-3..SEC-D-9 folded; FU-24 and FU-25 agreed | See the SEC-D rows below. FU-24 is `dec-mv330t0g-0175d52b` (accepted). FU-25 is `dec-mv330t7a-017a2211` (e1 and g2). | — | — | — |
| **TR-D-9** (minor), merged with **SEC-D-2** (minor): an orphaned detached CLI child | **Fixed (d2 and d3 resets)**, with one residual (FU-28) | **`src/ai/cli.js` (d2):**<br>- every started child is registered, per adapter and in a module-level set;<br>- `close()` sends SIGTERM to each child's process group, then SIGKILL after `killGraceMs` (default 1000 ms, `CLI_KILL_GRACE_MS`). It rejects in-flight calls with `PROVIDER_UNAVAILABLE`, removes their temp cwd and resolves when all runs have settled. It is idempotent and terminal: later calls reject without spawning;<br>- `liveChildren()`;<br>- one process `exit` hook SIGKILLs every group still registered;<br>- timeout, abort and the 8 MiB cap keep the immediate group SIGKILL.<br>**`src/main.js` (d3):** `close()`, which `stop()` calls on SIGINT/SIGTERM, awaits `provider.close()` when it is a function. It does so after the retention stop and before `app.close()`, inside a try/catch that logs by code only. The `exit` hook backs up the following `process.exit(0)`.<br>**`test/live/run-live-model.js` (d2):** SIGINT/SIGTERM handlers close the adapter, print "interrupted", write no report and exit 130/143. A `finally` closes the adapter on every return path.<br>**Residual (FU-28):** a parent killed with SIGKILL, or one that gets SIGTERM without a handler, runs no hook. Its child is still orphaned, bounded by `--max-budget-usd 0.05`, and its row is settled by the sweep. Security's C7 driver has no handler, so C7 as written still reproduces this case by design. I did not re-run `sec-phd-adapters.mjs`, the script involved in RISK-21; the inverted C7 below is d2's own. | `test/unit/ai/cli.test.js`, suite `close() and the exit hook leave no CLI child behind (TR-D-9, SEC-D-2)`:<br>- `TR-D-9: close() kills an in-flight child and its whole process group, rejects the call and removes the cwd`;<br>- `TR-D-9: a child that ignores SIGTERM is SIGKILLed after the grace period`;<br>- `TR-D-9: after close() no process is started: calls are PROVIDER_UNAVAILABLE; close() is idempotent and works with nothing in flight`;<br>- `TR-D-9: close() only touches this adapter: a second adapter keeps its call`;<br>- `TR-D-9: process.exit() in the parent (what stop() does) kills the child through the exit hook`;<br>- `TR-D-9: no child stays registered after a normal call or a timeout`.<br>`test/api/uploads-retention.test.js`, suite `TR-D-9: shutdown closes the provider`:<br>- `TR-D-9: close() awaits provider.close() once, before the listener is closed`;<br>- `TR-D-9: a provider without close() (the fake, the API adapter) shuts down cleanly`;<br>- `TR-D-9: a provider.close() that throws is logged by code and never blocks the shutdown`.<br>`test/unit/ai/live-runner-refusal.test.js`:<br>- `TR-D-9: the adapter is closed once when the run ends normally; a provider without close() is fine`;<br>- `TR-D-9: SIGINT and SIGTERM close the adapter, exit non-zero (130, 143) and write no report`;<br>- **C7 inverted, as a real runner process with a stub `claude`:** `NFR3: SIGTERM to the runner leaves no CLI child alive, prints the plan first and exits 143` and `NFR3: SIGINT to the runner leaves no CLI child alive, prints the plan first and exits 130`.<br>**Not tested end to end:** a real server process with the real CLI (it needs the real binary). That path is the composition of the d3 and d2 tests above. | **Red before:**<br>- the six `cli.test.js` tests fail in d3's `npm test` before d2 landed: **ev:ev-mv3455zv-014b1953**, 6 fail, all six named above;<br>- d2 reports 3 red in the refusal file before its change, with **no separate evidence id**.<br>**After:** d2 plan command ev:ev-mv34amer-0143b344 (107/107) and `npm test` ev:ev-mv34bp0u-01821bb8 (1233/1225/0/8); mine **ev:ev-mv34j5ys-0171d99c** and **ev:ev-mv34i7fr-01c4a959** |
| **TR-D-10** (minor): the live runner silently rounded its ceiling (RISK-21) | **Fixed (d2 reset)** | `parseCeilingMicroUsd` checks the raw string with `^(0\|[1-9][0-9]{0,11})(?:\.([0-9]{1,2}))?$` (no trim, sign, exponent or leading zero) and compares in integer cents, 1..500, **before any conversion**. `toMicroUsd` is no longer used for the ceiling. A leading zero is refused by **`dec-mv34dqsr-0163a6d9`**.<br>Before its first call the runner prints the provider, the model, the per-call cap, the worst case and the ceiling, and then `cli: claude <version>`.<br>Signals: see TR-D-9.<br>**Left to the orchestrator:** record in RISK-21 what is known of the incident's spend. RISK-21 is open and has no mitigation text yet. | `test/unit/ai/live-runner-refusal.test.js`: **`NFR3: the ceiling is a decimal with at most two fraction digits, from 0.01 to 5.00, checked BEFORE any rounding (TR-D-10)`**:<br>- `evaluateLaunch` refuses **37** values, with the `badCeiling` message, including 5.0000001, 5.001, 4.999, 1e0, " 5", "05" and 005.00. d2's handoff and the orchestrator say 38; the array in the test holds 37;<br>- 6 of them are also refused through the real process: exit 2, the fixed message, empty stdout, no `claude` on PATH;<br>- 10 values are accepted in-process, among them 5, 5.0, 5.00, 0.50, 0.5 and 0.01, and 5, 5.00 and 0.50 also through the real process with `--dry-run`.<br>The CLI version line: `assert.match(out, /claude 2\.1\.296/, 'the CLI version is printed before the first call')` in the real-process signal test, with the stub's version. | ev:ev-mv34amer-0143b344, ev:ev-mv34bp0u-01821bb8; mine **ev:ev-mv34j5ys-0171d99c**, **ev:ev-mv34i7fr-01c4a959** |
| **SEC-D-1** (minor) | = TR-D-1 | — | — | — |
| **SEC-D-2** (minor) | = TR-D-9 | — | — | — |
| **SEC-D-3** (info): for a real model, the injection backstops are the flag, the buyer and the approval | **Accepted**; verification report risk list (carry item 6) | Security's suggestion (when `addressedToAssistant` is true, ask the buyer to re-check every known field) is a product decision. It is **not adopted in phase D, and no decision is recorded**; the orchestrator may record one. LIVE-M1's "injection effects = 0" metric is the real test. | — | ev:ev-mv34k8si-0187cfbd (E2, E3 info lines) |
| **SEC-D-4** (info): five self-registered accounts can spend the daily budget | **Follow-up FU-29** (g2 README: `RS_ALLOW_SIGNUP=0` or a smaller share for public deployments); carry item 6 | — | — | E9 info line in ev:ev-mv34k8si-0187cfbd |
| **SEC-D-5** (info): `anthropic.js` buffers a chunked body whole | **Follow-up FU-26 (a)** (ai-engineer, a streamed byte cap with the post-LIVE-M1 adapter change); carry item 6 | No later task owns `src/ai/anthropic.js`. | — | `followups.md` |
| **SEC-D-6** (info): extract has no per-request idempotency | **Accepted** (the spec asks for none; bounded by the rate limit, concurrency 1 and the share); carry item 6 | — | — | E8 info line in ev:ev-mv34k8si-0187cfbd |
| **SEC-D-7** (info): photos, EXIF included, are stored and forwarded byte for byte | **Follow-up FU-29** (g2's README privacy statement, T23); carry item 6 | — | — | `followups.md` |
| **SEC-D-8** (info) | = TR-D-7 (FU-27, carry item 2) | — | — | — |
| **SEC-D-9** (info): the secrets-scan gaps (responses, DB rows, `ANTHROPIC_API_KEY` in the separate-process run) | **Accepted for phase D.** Responses are in g3's RS-29 criterion (it scans recorded API responses). **DB rows and the key in a separate process are not named in g3's criterion**; I carry them to the verification report's risk list (carry item 6) as the reviewer recommends, and g3 may take them in its RS-29 extension. | — | — | `plan.json` g3 criteria; `followups.md` |

**FU-21** (g2) now carries d2's exact wording for `RS_LIVE_MODEL_CEILING_USD`; see `followups.md` › "Changed items".

**New follow-ups in `followups.md` (section "Added after the phase D review"):**
- **FU-27** (e1, g2): the `RS_MODEL_TIMEOUT_MS` bound.
- **FU-28** (g2 runbook, verification report): the SIGKILL orphan residual.
- **FU-29** (g2 README): SEC-D-4 and SEC-D-7.
- **FU-26** is extended with SEC-D-5 and TR-D-6.
- The list "Carried to the verification report" collects TR-D-3, TR-D-4, TR-D-5, TR-D-6, TR-D-7 and the SEC-D info items, with delivery-lead as owner.

### Statements of the first submission that iteration 2 supersedes

The rest of this document is the first submission's text. Where this section differs, this section wins:
- **Tree and runs:** HEAD `461a5ac`, `npm test` 1216/1208, d2 96/96 and d3 105/105 are superseded by the runs above.
- **"Remaining issues":**
  - **#1 (FU-23):** decided (`dec-mv330std-0165d9be`), widened, and blocked on the user (`dec-mv341ap0-010209d2`).
  - **#2 (FU-24):** accepted, `dec-mv330t0g-0175d52b`.
  - **#5 (FU-25):** decided, `dec-mv330t7a-017a2211`.
  - **#10:** still accepted, but d3's per-field grounding now applies d1's number rule (TR-D-1).
  - **#18 ("no mutation check for d3"):** d3 now has a mutation run, ev:ev-mv3427er-01c6a0c9.
- **"NFR3 (live-suite refusal, model half)":** now also proved by the TR-D-10 ceiling test and the signal tests above.
- **"Follow-ups", "Still open":** FU-23, FU-24 and FU-25 as above. FU-27..FU-29 are new.
- **"Artifact coverage" and "Handoff index":** superseded by the coverage run after this submission. The new handoffs are d2 ho-mv34d3dh-01f6abfa (6 files, 1 new: `test/fixtures/extraction/cli-orphan-driver.mjs`) and d3 ho-mv3461bp-018c0431 (5 files).

### Process notes, iteration 2

1. **Commits that swept in work in progress.** No content effect: the final tree `a9d0507` holds every file, and all runs above are on it. This is the same pattern as `7942bf2` in iteration 1, and a note for the pilot.
   - Commit `8622b43`, titled "Pilot report: …", carries d3's `src/main.js`, `test/api/extract.test.js`, `test/api/extract-degraded.test.js` and part of `src/services/extraction.js`, plus d2's `stub-claude.mjs` and `cli-orphan-driver.mjs`.
   - Commit `51a6933`, a record snapshot, carries `test/api/uploads-retention.test.js`.
   - Commit `ff09cbf`, titled "d3 reset", carries d2's `src/ai/cli.js` and `test/unit/ai/cli.test.js`.
2. **d3 completed while d2's change was missing.** Its `npm test` was red with exactly the six d2 tests (ev:ev-mv3455zv-014b1953). d2 landed next, and both `npm test` runs after it are green.
3. **One guard refusal in my session.** It hit a read-only `node -e` that printed risks from `.eccode/state.json` and ran `eccode memory search` on the same line. The text was: `The guard cannot verify who this eccode command acts as: "RISK-2$/.test" runs a command through a variable or substitution; call the eccode CLI directly so its --actor can be checked.` The `$/` of a JS regex was read as a substitution. I split the line and wrote the regex without `$`, so this is an over-denial of the raw-text kind.
4. **Budget:** `eccode status` showed 787.51 of 1200 minutes before this submission.

### Lessons, iteration 2

My memory search ("phase submission resubmission extraction grounding CLI adapter child process ceiling", `--check-env`) returned only **mem-sd-mv1audrd-013b7102** (guard root resolution). It is **not-applicable**: this resubmission designs or changes no hook or guard, every write in the nested record was accepted, and the one refusal above is a raw-text reading, which the lesson's "Not applicable when" list names. Both reset handoffs record the same decision.

## What the phase delivers

| Task | Owner | Handoffs | Engineer's runs | Delivered |
|---|---|---|---|---|
| d1-ai-core | ai-engineer | ho-mv30knyb-01ee912a | Plan command 111/111 ev:ev-mv30ik7o-0181d88a.<br>Mutation (budget boundary changed to `>=`) red as intended, 4 failures: ev:ev-mv30idlj-0141efc8.<br>`npm test` red, 1 failure outside d1 (d4 fixtures without a scenario): ev:ev-mv30jdb5-01a1c105. | - `src/ai/{provider,schema,prompt,fake,gate,rephrase}.js`.<br>- Wire schema, deep-frozen; strict validator with optional grounding.<br>- Prompt `x1` with random 16-hex markers and `safeJson`.<br>- Bilingual lexicon fake with an image map keyed by sha256 and the four faults.<br>- Gate in integer micro-dollars: rate check and insert in one `BEGIN IMMEDIATE`, concurrency 1, customer share 0.2, reserve, settle or refund.<br>- Rephrase guard. |
| d2-ai-adapters-corpus | ai-engineer | ho-mv3158kt-011b3953, then the reset ho-mv31n07e-01ec72ff | Plan command 96/96 ev:ev-mv312qia-01987160.<br>Mutation (argv without `--safe-mode`) red, 1 failure: ev:ev-mv312kjg-017910c5.<br>**Reset:** NFR1 package test red with the added script, ev:ev-mv31ky3k-01815561 (9/10), then 10/10 ev:ev-mv31l7v0-0124fa9d; plan command 96/96 ev:ev-mv31lb35-01ce4dc7. | - `src/ai/cli.js`: no shell, pinned argv, allow-listed env, temp cwd, 8 MiB cap, process-group kill, one attempt, concurrency 2 then `PROVIDER_BUSY`.<br>- `src/ai/anthropic.js`: json_schema output, refusal and max_tokens refused, `redirect: "error"`, one retry on 5xx/529, cost in micro-dollars from token counts.<br>- EXT-1 corpus: 16 text files with 5 AR/EN pairs and 3 injection cases, 6 rendered PNGs, a smoke case, `catalog-injection.json`.<br>- Fake-mode eval, ECCODE_EVAL 200/200.<br>- Live runner with refusals and `--dry-run`.<br>- `package.json`: net unchanged after the reset. |
| d3-extraction-service | backend-engineer | ho-mv31j0p2-01ac6416 | Plan command 105/105 ev:ev-mv31ivzh-019a339f and ev:ev-mv31gqq0-01e6737d (an earlier run, ev:ev-mv31coqm-01a249c6, had 103/103; the handoff text still says 103).<br>Failing first: the plan command before the test files existed, ev:ev-mv30yifv-0114ffa1.<br>**No mutation check was run** (handoff).<br>`npm test` red, 7 failures, all in other tasks' files: ev:ev-mv31etf6-01061b72. | - Routes: image upload and GET, extract, DELETE request.<br>- `services/extraction.js`: owner check first, magic bytes, streaming cap and deadline, `.tmp` then rename, mode 0600; gate first; provider call outside any transaction; timeout watchdog; normalisation (ranges, grounding, Arabic-Indic digits, image-wording stripping, non-USD budget).<br>- Delete: hard delete or tombstone, `PAYMENT_IN_PROGRESS`, void rule `REQUEST_DELETED`.<br>- `services/retention.js`: images at 7 d, orphan files, `rate_events` (FU-20), stale model reservations; started at startup and every hour.<br>- `main.js` adapter wiring with a labelled fallback.<br>- `view.js`: `addressedToAssistant`, `capabilities`. |
| d4-frontend-extraction | frontend-engineer | ho-mv30i4sf-01273270, then the reset ho-mv32b3pf-011eac5d | Plan command 134/134 ev:ev-mv30gof5-0101bc4f.<br>**Reset:** failing first ev:ev-mv327crh-010cb98f (2 failures), plan command 136/136 ev:ev-mv328qzg-01fac919, `npm test` 1216/1208/0 fail/8 skipped ev:ev-mv32a66o-0101b2f2, browser 8/8 ev:ev-mv32afme-017b35c4. | - New-request screen: labelled `dir=auto` textarea, optional photo with client type and size checks, the create → upload → extract states with Cancel and Retry.<br>- "What you need": badges, original wording, "Text read from the photo", template questions, degraded notice and manual form, AI-addressed notice, Simulated badge.<br>- FU-17 stacked table; SEC-C-4 URL guard; TR-C-4 capability-gated Delete; FU-13 fixtures.<br>- **Reset:** the stale notice is hidden once requirements exist; the frontend half of FU-16; `capabilities` added to three fixtures. |
| d5-extraction-contract-browser | test-engineer | ho-mv3249el-0180bc20, then the reset ho-mv32g80v-01649548 | Plan command PASSED ev:ev-mv3226jz-0198f037.<br>Failing first: contracts red with 5 failures, ev:ev-mv31rk2w-01e1c7c2.<br>FU-17 mutation red, 2 failures: ev:ev-mv320rxs-0129b775.<br>Contracts 45 pass / 7 skipped ev:ev-mv31t888-01a00447; provider contract 32 pass / 1 skipped ev:ev-mv31vlqf-010005f2.<br>**Reset:** pin mutation red, 5 failures, ev:ev-mv32czn1-016f50a4; plan command PASSED ev:ev-mv32ejv0-014af542. | - Shared ExtractionProvider contract suite over fake, CLI (stub binary) and Anthropic (loopback stub).<br>- Log secrets scan, in-process and in a separate server process, with negative controls.<br>- Contract scenarios for the six phase D routes and rows; FU-13 cleanup; `capabilities.deleteRequest` pinned by value.<br>- Degraded-extraction browser journey plus FU-17 rows at 360 and 1280 px. |

## Phase runs by the delivery-lead on the final tree

| Run | Result | Evidence |
|---|---|---|
| `npm test` | exit 0. **1216 tests: 1208 pass, 0 fail, 8 skipped, 0 todo.** 140 suites.<br>`ECCODE_EVAL {"passed":200,"total":200}`.<br>NFR5: p95 55.3 ms (p50 2.1 ms) over 3156 API calls; suite 41.2 s. | **ev:ev-mv32mnk9-01c4df6f** |
| `npm run test:browser` | exit 0, **8 tests: 8 pass, 0 fail, 0 skipped**. The three suites: RS-03 degraded (3 tests), FU-17 (2 tests), RS-33 infeasible (3 tests). | **ev:ev-mv32n2uv-012076da** |
| d1 plan command, verbatim | 111 tests, 111 pass, 0 fail | **ev:ev-mv32ncx6-013997eb** |
| d2 plan command, verbatim | 96 tests, 96 pass, 0 fail; `ECCODE_EVAL {"passed":200,"total":200}` | **ev:ev-mv32ng8q-01f4c19c** |
| d3 plan command, verbatim | 105 tests, 105 pass, 0 fail | **ev:ev-mv32nlru-01ed051e** |
| d4 plan command, verbatim | 136 tests, 136 pass, 0 fail | **ev:ev-mv32nmc3-01853ca1** |
| d5 plan command, verbatim (`ls … && npm test && npm run test:browser`) | exit 0.<br>`npm test` part: 1216 tests, 1208 pass, 0 fail, 8 skipped, 0 todo; ECCODE_EVAL 200/200; p95 53.0 ms.<br>Browser part: 8/8. | **ev:ev-mv32oqlt-01d0e3b4** |
| `test/unit/ai/provider-contract.test.js` alone, net guard | 33 tests: 32 pass, 0 fail, 1 skipped | **ev:ev-mv32t1ip-0121518e** |
| `test/api/contracts.test.js` alone, net guard | 52 tests: 45 pass, 0 fail, 7 skipped, 0 todo | **ev:ev-mv32t4g4-01a3f3cb** |
| `test/scan/secrets.test.js` alone, net guard | 6 tests: 6 pass, 0 fail | **ev:ev-mv32t6in-01fce1e0** |

- **No clean-checkout run.** Phase C's submission had no clean-checkout check, so I did not run one. `scripts/clean-checkout.sh` on the final tree is g3's criterion.
- **No red result.** Not one test failed in any of my runs. The engineers' runs listed as red are failing-first or mutation runs, and are cited as red.

## Criteria → task → tests → evidence

Counts are passing leaf tests in my `npm test` run (**ev:ev-mv32mnk9-01c4df6f**) whose names begin with the id. They include tests from earlier phases with the same prefix. The named tests are the phase D ones that carry the criterion.

| Criterion | Task(s) | Proving tests (file: name, abridged) | Evidence |
|---|---|---|---|
| **RS-01** [D] bilingual equivalence | d1 (fake), d3 (route), d2 (eval) | 29 `RS-01` tests:<br>- `test/api/extract.test.js`: `RS-01: the RS-FIX-1 request in English and in Arabic yields identical core fields, all from the text`; `RS-01: every original wording is an exact quote of the request text …`; `RS-01: a missing budget and deadline stay unknown with the server-template questions (never guessed)`.<br>- `test/eval/extraction-fake.test.js`: `RS-01: the RS-FIX-1 English and Arabic cases give equal core fields, equal to the fixture, with user_text provenance`, plus the negative control `RS-01: a model that returns different values for the Arabic wording fails pair equality`.<br>- `test/unit/ai/fake.test.js`. | ev:ev-mv32mnk9-01c4df6f, ev:ev-mv32nlru-01ed051e, ev:ev-mv32ng8q-01f4c19c |
| **RS-02** [D] image provenance | d1, d3, d2, d4 | 32 `RS-02` tests:<br>- `test/api/extract-image.test.js`: `RS-02: a clear photo yields capacity and diameter with provenance image; the text keeps provenance user_text`; `RS-02: a value stated in the text wins over the photo …`; `RS-02: replacing the photo replaces what the next extraction reads …`.<br>- Eval: `RS-02: the clear package images give capacity and diameter with provenance image`; `RS-02: every committed PNG is what scripts/make-corpus-images.js renders …`.<br>- Frontend: "From the photo" badge and "Text read from the photo". | same, plus ev:ev-mv32nmc3-01853ca1 |
| **RS-03** [D + B] ambiguous images and the degraded path | d1, d2, d3, d4, d5 | 78 `RS-03` tests pass and 1 is skipped (below). **Ambiguous images:**<br>- `extract-image.test.js`: `RS-03: an ambiguous photo gives unknown for the unreadable field, a clarification question, and no invented number`;<br>- eval: `RS-03: the ambiguous images give unknown for unreadable fields, at least one question, and no number absent from the image`, with the negative control `RS-03: a model that invents a diameter … is caught`.<br>**Degraded path (API):** `test/api/extract-degraded.test.js`:<br>- ``RS-03: fake_model:${fault} -> 200, degraded true, schemaOk false, ${errorCode}, every field unknown, the row is stored`` for timeout, invalid_json, schema_invalid and error;<br>- `RS-03: a budget refusal is 503 MODEL_BUDGET_EXHAUSTED with details {scope, degraded, extraction}; a degraded row is stored; no call`;<br>- `RS-03: the rate refusal stores a degraded row, carries Retry-After, and does not call the provider`;<br>- `RS-03: the concurrency refusal … 429 model_concurrency …`;<br>- `RS-03: the journey continues: manual confirmation of every field gives manual provenance and planning proceeds`;<br>- `RS-03: a provider that never answers ends at RS_MODEL_TIMEOUT_MS as PROVIDER_TIMEOUT, charged at the cap`.<br>**Degraded path (browser, my run):** `test/browser/degraded-extraction.test.js`:<br>- `RS-03: the harness forces the fake provider timeout through the admin fault switch`;<br>- `RS-03: at 360x800 fake_model:timeout shows the degraded notice and the manual form; confirming the fields gives provenance manual and a planning run`;<br>- the same at 1280x800.<br>**Provider contract:** ``RS-03: ${impl} maps … to PROVIDER_TIMEOUT / UNAVAILABLE / BAD_OUTPUT / BUSY`` over the fake, CLI and Anthropic. | ev:ev-mv32mnk9-01c4df6f, **ev:ev-mv32n2uv-012076da** (3/3 RS-03 browser), ev:ev-mv32nlru-01ed051e, ev:ev-mv32t1ip-0121518e |
| RS-04 | **Not claimed by this phase.** c2 proved the approve half in phase C; e-payments claims the paypal/create half | Supporting tests in this phase: `RS-04: a request without a budget leaves the budget unknown and asks for it` (eval), and the RS-01 case above (missing budget and deadline stay unknown with questions) | ev:ev-mv32mnk9-01c4df6f |
| **RS-05** [D] injection ends as data | d1, d3, d2 | 44 `RS-05` tests:<br>- `test/api/injection.test.js`: `RS-05: an English injection is flagged (addressedToAssistant) and changes no field, no plan, no role, no approval, no money`; `RS-05: an Arabic injection is flagged and changes nothing`; `RS-05: the confirm body cannot smuggle authority either …`; `RS-05: text inside the photo that addresses an AI sets addressedToAssistant and is never copied into a field`; **T10:** `RS-05: a product name planted in the database changes no plan, amount or explanation, renders only as a JSON string, and never reaches the model`.<br>- Rephrasing clause, **unit level only:** `test/unit/ai/rephrase.test.js`: `RS-05: output with a number absent from the trace is discarded and the template stands`; `RS-05: output with a supplier code absent from the trace is discarded`; `RS-05: an injection string returned by the model … is discarded; the control run equals the template`. Rephrasing is not wired into any route (FU-25).<br>- Eval: `RS-05: injected strings appear nowhere in the output …`, with the negative control `RS-05: a model that obeyed an injection … is caught`. | ev:ev-mv32mnk9-01c4df6f, ev:ev-mv32nlru-01ed051e, ev:ev-mv32ncx6-013997eb |
| **RS-39** [D] uploads, deletion, retention | d3 | 31 `RS-39` tests in `test/api/uploads-retention.test.js`:<br>- **Uploads:**<br>  - `RS-39: a body declared image/png but carrying other bytes is 415, and no file or row is written`;<br>  - `RS-39: at most 5 MB: exactly 5,242,880 bytes is accepted, one byte more is 413 …`;<br>  - `RS-39: PNG, JPEG and WebP are accepted; … random 128-bit name, mode 0600`;<br>  - `RS-39: customer Y uploading to customer X…` (404, nothing written);<br>  - `RS-39: the image is served back with the detected type, nosniff, CSP sandbox and no caching; a polyglot stays an image`.<br>- **Deletion:**<br>  - hard delete: `RS-39: no supplier order existed: a hard delete removes …`;<br>  - tombstone: `RS-39: a request with a reservation is tombstoned: the void rule ends it (REQUEST_DELETED) …`;<br>  - ``RS-39: 409 PAYMENT_IN_PROGRESS while a payment operation is ${status} …``;<br>  - `RS-39: with settled payments (captured) the request is tombstoned …`.<br>- **Retention:**<br>  - `RS-39: an image is kept at 6 days 23 hours, deleted at 7 days + 1 minute (row, file and an audit event)`;<br>  - `RS-39: startApp removes an expired image at startup and another one on the next tick`. | ev:ev-mv32mnk9-01c4df6f, ev:ev-mv32nlru-01ed051e |
| **Provenance** (FieldValue provenance, SEC-8) | d3, d4 | 13 `SEC-8` tests:<br>- `test/api/confirm-provenance.test.js`: `SEC-8: values equal to the extracted ones keep their provenance and original wording`; `SEC-8: an edited value becomes manual with no wording …`; `SEC-8: a provenance or wording sent by the client is ignored, wherever it is put`; `SEC-8: when the latest extraction is degraded, nothing is taken from an earlier one: every value is manual (RS-03)`.<br>- Image provenance is in the RS-02 row.<br>- Frontend badge text per provenance is in `test/unit/frontend/extraction.test.js`. | ev:ev-mv32mnk9-01c4df6f, ev:ev-mv32nlru-01ed051e |
| **RS-29** (log part only) | d5 | 2 `NFR6, RS-29` suites in `test/scan/secrets.test.js` (6 tests):<br>- `NFR6, RS-29: log lines of an in-process server run hold requestId and no secret`;<br>- `NFR6, RS-29: the log of a separate server process (stdout) holds requestId and no secret`;<br>- the scan's own negative control.<br>Earlier: 2 `RS-29` tests in `test/scan/frontend.test.js` (public assets).<br>**Not claimed in full:** responses, screenshots, submission files and PayPal payer data come with phase E and g3 (plan criterion "extended … in phase G"). | ev:ev-mv32t6in-01fce1e0 (6/6), ev:ev-mv32mnk9-01c4df6f |
| **NFR6** [D] | d1, d3, d5, d2 | 108 `NFR6` tests pass and 7 are skipped (the 7 phase E contract rows).<br>**`test/api/model-budget-rate.test.js`:**<br>- `NFR6: with a fake per-call cost cap of USD 0.10 and RS_MODEL_DAILY_BUDGET_USD=0.25 the third extract is refused with 503 MODEL_BUDGET_EXHAUSTED without invoking the provider and enters the degraded path (RS_MODEL_CUSTOMER_DAILY_SHARE=1)`. The F-TR-18 comment is at line 48; the share is pinned per `dec-mv1e2i5k-01a1bebb`.<br>- `NFR6: config inspection shows haiku as the default model …`.<br>- The boundaries `NFR6: boundary, budget 0.30 … allowed (300000 = 300000)` and `… 0.299999 … refused`.<br>- `NFR6: ten extracts are served, the 11th is 429 RATE_LIMITED extract_upload with Retry-After; an upload is refused too`.<br>- `SEC-10: with fake cost = cap = 0.05 and the defaults, the 5th call of one customer is refused with scope customer; another customer succeeds`.<br>**`requestId` and the log scan:** the contract rows (envelope `requestId`) and `secrets.test.js` (every log line carries `requestId`; `X-Request-Id` matches exactly one `http.request` line).<br>**Cost report:** the live runner's report fields and the stop before the ceiling, `NFR6: it stops BEFORE a call that could push the total past the ceiling …`. | ev:ev-mv32mnk9-01c4df6f, ev:ev-mv32nlru-01ed051e, ev:ev-mv32t6in-01fce1e0, ev:ev-mv32t4g4-01a3f3cb |
| **NFR1** (touched by d2's `package.json` edit and its revert) | d2 reset | `NFR1: package.json is exactly as the Deployment section specifies` passes (`test/unit/config/node-version.test.js`). In all, 54 `NFR1` tests pass. `package.json` is byte-identical to the phase start `adf4a12`. | ev:ev-mv32mnk9-01c4df6f; d2's red-then-green ev:ev-mv31ky3k-01815561 → ev:ev-mv31l7v0-0124fa9d |
| NFR3 (live-suite refusal, model half) | d2 | `test/unit/ai/live-runner-refusal.test.js`:<br>- `NFR3: without RS_LIVE_MODEL=1 the runner exits 2 with the fixed message and does nothing else`;<br>- `NFR3: the package script test:live-model reaches the same refusal through npm`;<br>- refusals under the net guard, under `RS_TEST_OFFLINE=1` and with the fake. | ev:ev-mv32ng8q-01f4c19c |
| NFR4 (env example) | d3 (config) | The env-example scan stays green, because `src/config.js` reads no new name. **Gap:** the live runner's new `RS_LIVE_MODEL_CEILING_USD` is not in `.env.example` (FU-21, g2). | ev:ev-mv32mnk9-01c4df6f |
| NFR5 | all | p95 55.3 ms over 3156 calls (phase C: 61.4 ms over 1612); suite 41.2 s | ev:ev-mv32mnk9-01c4df6f |

### The phase's own acceptance criteria (plan.json, `d-extraction`)

| # | Plan criterion | Status | Where |
|---|---|---|---|
| 1 | RS-01 [D] | met | table above |
| 2 | RS-02 [D] | met | table above |
| 3 | RS-03 [D + B] | met (fake and stubs; see REAL vs SIMULATED) | table above; browser 3/3 in ev:ev-mv32n2uv-012076da |
| 4 | RS-05 [D] | met for the pipeline. The rephrasing clause is met at unit level only (FU-25) | table above |
| 5 | RS-39 [D] | met | table above |
| 6 | NFR6 [D] | met, with the share pinned to 1 in the NFR6 case and stated in its name and comment (F-TR-18) | table above |
| 7 | Live-model parts not claimed; `npm run test:live-model` refuses with exit 2 | the refusal is met. **LIVE-M1 stays Unverified** | NFR3 row; next section |
| 8 | ExtractionProvider contract suite passes | met: 32 pass, 1 skipped (fake × `PROVIDER_BUSY`) | ev:ev-mv32t1ip-0121518e |
| 9 | `npm test` and `npm run test:browser` pass | met | ev:ev-mv32mnk9-01c4df6f, ev:ev-mv32n2uv-012076da, ev:ev-mv32oqlt-01d0e3b4 |

## What is REAL and what is SIMULATED

No real model was called in this phase, by any engineer or by me.

| Part | Status |
|---|---|
| Extraction results in every API, eval and browser test | **Simulated.** They come from d1's deterministic lexicon fake (`simulated: true`, labelled "Simulated" in the UI). It shows that the pipeline, the gate, normalisation, provenance and the degraded path work. **It says nothing about model quality.** |
| CLI adapter (`src/ai/cli.js`) | Tested against a **stub `claude` binary** that replays `cli-transcript.ndjson`. That transcript is a recorded **shape** written from the design's stream-json description, not a capture from the real CLI. |
| Anthropic adapter (`src/ai/anthropic.js`) | Tested against a **loopback HTTP stub** under the net guard. No key is read. |
| EXT-1 images | Synthetic 5×7 bitmap labels, rendered by a pure-Node script. A model that reads them well would not prove that it reads real packaging. |
| Budget, rate, concurrency and retention | Real code against real SQLite, with fake per-call costs and a pinned clock. |
| Upload, magic bytes, file modes, deletion | Real: files on disk, rows in SQLite. |
| Browser journeys | Real Chromium (/opt/pw-browsers) against the real server, with the fake provider forced to time out through the admin fault switch. |

**LIVE-M1 is NOT claimed. It stays Unverified.**
- **What it would cover:** the real-model run over EXT-1 for RS-01, RS-02, RS-03 and RS-05 [LM], the NFR6 cost report, and the F-TR-13 `schemaAccepted` check.
- **What blocks it:** the user's approval of the spend ceiling (Q3; the default is USD 5 per run in `dec-mv16pz0g-01d5c4c2`, not yet confirmed) and an authenticated Claude CLI login or an `ANTHROPIC_API_KEY`. Neither is available in this environment (RISK-2).
- **The command to give the user:** `RS_LIVE_MODEL=1 RS_LIVE_MODEL_CEILING_USD=5 npm run test:live-model`, with `-- --dry-run` first. The worst case is 22 calls × USD 0.05 = USD 1.10.
- **What stays unverified until then:**
  - the real CLI stdin and result shapes;
  - `--json-schema` acceptance of the wire schema;
  - whether `--max-budget-usd 0.05` is enough for an image call;
  - the API's `output_config.format`;
  - the Haiku 4.5 prices.
- **After the run** (FU-26): fold any shape difference into the adapters and re-record the transcript.

## Additive contract deltas against the approved spec (TR-RW2-2)

Listed in full in `followups.md` › "Documented design deltas from phase D", for the verification report:

**Additive contract changes:**
1. `Extraction.addressedToAssistant: boolean`, stored under the reserved `fields_json.__meta` key and hidden on read.
2. `RequestView.capabilities: {deleteRequest: boolean}`, always `true` today. It is pinned by value in four contract rows and by key in RS-34 (rework-2).
3. 400 `BAD_REQUEST` for a missing `Content-Length` on upload, and for an upload past its deadline (`details.reason: "UPLOAD_TIMEOUT"`, `Connection: close`). The catalog's 400 row names only "malformed path parameter or query".
4. Degraded refusal rows carry `errorCode` `PROVIDER_BUSY` (rate or concurrency) or `PROVIDER_UNAVAILABLE` (budget).
5. A new degraded row replaces a degraded row that is already the newest.
6. GET image adds `Content-Disposition: inline`.

**Other behaviour that differs from the spec text:**

7. The retention sweep also purges `rate_events` and, until e4, settles stale model reservations (the spec gives the latter to the reconciler).
8. The client time limits are 65 s for upload and 45 s for extract, against the spec's blanket 15 s.
9. The EXT-1 labels are `labels/*.txt` with a pure-Node renderer, instead of `labels/*.html` with a Chromium screenshot.
10. The live runner needs the new `RS_LIVE_MODEL_CEILING_USD`.
11. Internal micro-dollar configuration fields; no new variable in `src/config.js`.

## Follow-ups

**Closed in this phase:**
- **FU-13:** fixtures corrected, `KNOWN_FIXTURE_DEFECTS` removed, 0 todo.
- **FU-16:** closed with rework-3 (sub-mv32kio2-01649f99, awaiting review); frontend half by d4's reset.
- **FU-17:** d4's stacked table; d5's FU-17 browser rows at 360 and 1280 px, 2/2 in my run. g1 still verifies in its a11y pass.
- **FU-18:** the phase D routes now have real scenarios: image upload, GET image, extract, extract degraded, degraded view, delete.
- **FU-20:** closed by d3; test `SEC-C-3: the sweep purges rate rows older than 24 h … (FU-20)`.

**Partly met, accepted:**
- **FU-2:** the route's own 60 s deadline is enforced, but the effective cap is the server's 30 s. Accepted for version one by `dec-mv31kbrz-012381a1`.

**Still open, with owners:**

| Item | Owner | What |
|---|---|---|
| FU-18 (phase E half) | e6 | 7 skipped contract rows |
| FU-21 | g2 | `RS_LIVE_MODEL_CEILING_USD` in `.env.example`, the README line and the runbook |
| FU-22 | e4 | housekeeping purges: sessions, login failures, idempotency keys, webhook rows; one owner for stale model reservations |
| FU-23 | orchestrator | request id reuse after a hard delete: a migration-only rework or a decision |
| FU-24 | orchestrator | a refusal's degraded row becomes the newest extraction: a decision; I propose to accept it |
| FU-25 | orchestrator | rephrasing is not wired and `RS_EXPLAIN_REPHRASE` is inert: a decision; default, g2 documents it |
| FU-26 | ai-engineer | after LIVE-M1 (user-blocked) |
| TR-RW2-2 | delivery-lead | deltas above, carried into the verification report |
| FU-3, FU-9, FU-19 and the phase C carry-overs | as listed in `followups.md` | — |

## Skipped tests (8 in `npm test`, 0 todo): not hidden failures

| # | Test (verbatim) | Reason | Owner |
|---|---|---|---|
| 1 | `NFR6: contract plan-execute.json: POST /api/plans/:id/execute -> 202 (the caller won the claim)` | route not registered yet | e6 (FU-18) |
| 2 | `NFR6: contract plan-execute-replay.json: POST /api/plans/:id/execute -> 200 (already executing or executed)` | same | e6 |
| 3 | `NFR6: contract plan-abandon.json: POST /api/plans/:id/abandon -> 200` | same | e6 |
| 4 | `NFR6: contract order-paypal-create.json: POST /api/orders/:id/paypal/create -> 200` | same | e6 |
| 5 | `NFR6: contract order-receipt.json: POST /api/orders/:id/receipt -> 200` | same | e6 |
| 6 | `NFR6: contract supplier-order-ready.json: POST /api/supplier/orders/:id/ready -> 200` | a ready order needs an executed plan (execute not registered) | e6 |
| 7 | `NFR6: contract supplier-order-handover.json: POST /api/supplier/orders/:id/handover -> 200` | same | e6 |
| 8 | `RS-03: fake maps busy to PROVIDER_BUSY without echoing the provider body, the buyer text or a key` | The fake has no busy fault: `FAKE_FAULTS` is timeout, invalid_json, schema_invalid, error. `PROVIDER_BUSY` is covered for the CLI and Anthropic in the same suite, and as a gate refusal in `extract-degraded.test.js`. | none (by design) |

Compared with phase C: 10 skipped became 8, because 3 phase D rows went live and the fake × BUSY row is new. 6 todo became 0 (FU-13).

## Remaining issues the handoffs disclose, with my assessment

| # | Issue (source) | Assessment |
|---|---|---|
| 1 | **Request id reuse after a hard delete** (d3, reviewer note 1). `INTEGER PRIMARY KEY` without `AUTOINCREMENT`, so the highest id is reused, and the audit rows of the deleted request share it. | **Open, FU-23**: the orchestrator decides between a migration-only rework and acceptance. Limited reach: it applies only to the highest id and only to hard deletes, which happen only when no supplier order existed; audit rows hold ids and statuses. **No decision is recorded yet.** |
| 2 | **A budget or rate refusal becomes the newest extraction** (d3, reviewer note 2). The page shows the degraded notice and form even after an earlier success, and confirm then makes every value `manual`. | **Open, FU-24.** It follows the spec's text ("degraded row stored"). The customer can finish by hand, and since d4's reset the notice hides once requirements exist. I propose accepting it for version one, but **no decision is recorded**. The orchestrator records one, or the reviewer asks for a d3-file rework. |
| 3 | **FU-2 is partly met** (d3). | **Accepted**, `dec-mv31kbrz-012381a1`: an effective 30 s cap (1.4 Mbit/s is enough for 5 MB). The client waits 65 s, so a cut upload shows the error state with Retry. |
| 4 | **The degraded manual form stays open after confirmation** (d4 reset). | **Accepted for phase D**, `dec-mv32c290-0182b807`. The open form is the only way to correct hand-typed values. The stale notice is hidden. Reviewers may still ask for one rule (owner: frontend-engineer). |
| 5 | **Rephrasing is not wired into any route** (d3); `Explanation.rephrased` is never rendered (d4). | **Open, FU-25.** RS-05's rephrasing clause is proved at unit level only. `RS_EXPLAIN_REPHRASE=1` currently does nothing, although `.env.example` lists it. |
| 6 | **Stale model reservations are settled by the retention sweep, not the reconciler** (d3). The other "Other data" purges are not done. | **Open, FU-22, e4.** The behaviour is tested now: `NFR6: the sweep settles a model reservation that has been in flight for more than twice the model timeout …`. |
| 7 | **The CLI transcript is a shape, not a capture.** The LIVE-M1 unknowns (d2). | **Open, user-blocked** (LIVE-M1, RISK-2), then FU-26. |
| 8 | **The fake image map is keyed by the sha256 of the PNG bytes**; another zlib may change the bytes (d2). | **Accepted as is.** The eval compares pixels and keys separately, so any drift is reported, not hidden. Regenerate with `node scripts/make-corpus-images.js`. |
| 9 | **The CLI tests assume POSIX** (d2). | **Accepted.** The host is Linux, and Windows is not a target. g2 may note it. |
| 10 | **Adapters validate structure only; grounding is per field in d3** (d2). | **Accepted by design.** One ungrounded quote downgrades a field instead of voiding the whole extraction. Covered by `SEC-7: an ungrounded answer from a provider is stored with the field unknown, and the whole call still succeeds`. |
| 11 | **The fake lexicon's limits** (d1): bare hour, Arabic number words other than the dual, decimals in integer fields. Also, the rephrase guard counts an article "A"/"I" as a supplier code. | **Accepted.** They fail safe: the field stays unknown with a question, or the rephrased output is discarded. The fake is a test double. The rephrase residual (reordering, negation) is accepted in the spec. |
| 12 | **Uploads count toward 10 per 10 min even when later refused** for size or bytes (d3, note 3). | **Accepted.** The spec says "Uploads count too", and counting before the body is read bounds abuse. |
| 13 | **Upload progress is indeterminate** (d4). | **Accepted.** fetch has no upload progress, and the scan bans a second transport. File name, size and Cancel are shown. g1 may revisit it. |
| 14 | **Re-sending after an upload error creates a new draft request**, which counts toward the daily limit (d4). | **Open, minor.** A draft cannot be edited through the API. g1 or a UX pass; no owner assigned. |
| 15 | **Fixture value drifts** (d4): `reservationTtlMin` 30 and `supplier.name` "Demo Supplier X". | **Closed.** The fixtures now follow the live values, and the contract rows pass. |
| 16 | **The `capabilities.deleteRequest` pin is a strict equality** (d5 reset). If the value becomes status-dependent, each status needs its own fixture. | **Noted** for whoever changes `view.js`. |
| 17 | **The secrets scan has no PayPal payer data yet** (d5). | **By plan**: e-phase routes, then g3 extends RS-29. |
| 18 | **No mutation check for d3** (d3). Its failing-first run is only "test files missing". | **Disclosed for the reviewer.** The other four tasks each show a red run that bites. |
| 19 | **On a machine with `claude` on `PATH` and no `RS_TEST_OFFLINE`, `npm start` selects the CLI provider** (d3). | **Per the spec's provider default.** README and runbook wording is g2's (FU-21 covers the runbook). |
| 20 | **The README statement for T23/RS-39** (retention, deletion) (d3). | **g2**, already in its criteria ("retention statement"). |
| 21 | **The orchestrator's commit `7942bf2` swept in uncommitted edits of d5's reset and of rework-3** (both handoffs). | **No content effect.** Both engineers checked the committed files (no mutation left in them). Process note for the pilot. |

## New environment variables versus `.env.example`

- **`src/config.js` reads no new name in phase D.** d3 derived the three micro-dollar fields from the existing `RS_MODEL_CALL_CAP_USD`, `RS_MODEL_DAILY_BUDGET_USD` and `RS_FAKE_MODEL_COST_USD`. `.env.example` is untouched, and the env-example scan passes.
- **One new name: `RS_LIVE_MODEL_CEILING_USD`.** It is read by `test/live/run-live-model.js` (d2) and is required for a live run.
  - It is in neither `.env.example` nor the spec's Deployment table, and the scan cannot see it.
  - d2's handoff describes the variable but does not flag it as new.
  - **FU-21 (g2)** covers it.
- **How I checked:** every `RS_*` token in `src/`, `scripts/` and `test/live/` against `.env.example`. The other unmatched tokens are not variables: `RS_DATA_BEGIN`/`END` (prompt markers), `RS_FIX_1` and the `RS_PAYPAL_` prefix. `RS_KEEP_CLEAN_CHECKOUT` is an earlier phase's script switch.

## Guard over-denials reported during the phase (text only, for the pilot report)

| Who | Denied command (as reported) | Guard's reading | Over-denial? |
|---|---|---|---|
| d1 ai-engineer | an `evidence run` whose label contained a greater-than-or-equal sign | a redirect to the relative path `=` | yes; reworded label |
| d5 test-engineer | `sed` with script `178d` | a path outside the task's ownership | yes; redone with Edit |
| d5 test-engineer | a heredoc containing backticks | a substitution in an eccode command | yes (raw-text rule, documented residual); redone with Edit |
| d5 reset | a redirect to a shell-variable target | an unverifiable write target | not claimed as one: the engineer reports it only as "not a root-resolution problem" |
| rework-3 test-engineer | a shell redirect and an inline Python program writing scratch files | legitimate refusals, per the engineer | no |
| delivery-lead (this submission) | a read-only `for` loop with `n=$(grep … .eccode/evidence/<id>.log …)` that counted test results; **no eccode CLI in the line** | "a variable with a computed name is assigned in the same command line as the eccode CLI" | **yes**: the `.eccode` path in a plain `grep` was read as an eccode invocation. Redone with a scratch Node script. |
| delivery-lead | an `evidence run … -- "node … --test $f"` in a loop | "runs a command through a variable or substitution" | no: correct, since the guard cannot check a computed command. Redone with literal commands. |

d2, d3 and d4 reported no guard refusals. d4 ran the CLI with `--root`, because the shell's cwd resets between calls.

## Process notes

1. **d1 and d4 ran in parallel** from `adf4a12`; d4 has no dependencies. Then d2 and d3 ran in parallel from `80a2b11`.
2. **Every first completion was red on `npm test`, and each says so:**
   - d1: 1 failure, d4's fixtures without scenarios.
   - d2: 7 failures, including its own `package.json` line breaking NFR1.
   - d3: 7 failures (contract rows, c2's RS-34 key list, d2's line).
   - Fixes: **d2 was reset** (ho-mv31n07e-01ec72ff); **rework-2** fixed c2's RS-34 key list (approved, rev-mv32bt1y-019ab941); **d5** added the contract rows.
3. **d5's first completion found a stale degraded notice** in d4's code. **d4 was reset** (ho-mv32b3pf-011eac5d), which also removed the frontend FU-16 tolerance and added `capabilities` to three fixtures. **d5 was reset** to pin the boolean by value (ho-mv32g80v-01649548). **rework-3** removed the journey tolerance (FU-16).
4. **Orchestrator decisions in this phase:**
   - `dec-mv31kbrz-012381a1` (FU-2, 30 s);
   - `dec-mv32c290-0182b807` (degraded form stays open);
   - `dec-mv32cj1p-01fd33ad` (no security review for rework-2, closing TR-RW2-1).
5. **Budget:** `eccode status` showed 698.99 of 1200 minutes used before this submission.

## Lessons

Each phase D task, and each reset, recorded `mem-sd-mv1audrd-013b7102` (guard root resolution) as **not-applicable**, with a note. No task designs or changes a hook or guard. Every implementer's writes in the nested record were accepted, so there was no wrong-root denial; the denials above are raw-text readings, which the lesson's "Not applicable when" list names. The plan's assessment ev:ev-mv1eo87o-01c933d5 is the basis. My memory search for this submission returned only that record.

## Artifact coverage

**Before submitting**, I ran the phase-artifacts check logic with the declared set as the submission. The base is `adf4a12`, the claim base of d1 and d4.
- **Declared:** 112 files across all completions.
- **Changed since `adf4a12` under phase D ownership:** 111. The difference is `package.json`, which d2 declared and later reverted, so it is byte-identical to the base.
- **Changed but undeclared:** 0. **Outside the phase's ownership:** 0.
- **Informational changes since the base outside phase D ownership:** `test/api/requests-plans.test.js` (rework-2), `test/browser/journey-infeasible.test.js` (rework-3) and `docs/build/state.md` (orchestrator).

**After submitting**, I run `.eccode/drafts/phase-artifacts-check.mjs` against the real submission and record the result as evidence (see the hand-off to the reviewer).

## Handoff index

| Task | Handoffs (in order) | Files declared |
|---|---|---|
| d1-ai-core | ho-mv30knyb-01ee912a | 11 |
| d2-ai-adapters-corpus | ho-mv3158kt-011b3953, ho-mv31n07e-01ec72ff | 46 (union; `package.json` net unchanged) |
| d3-extraction-service | ho-mv31j0p2-01ac6416 | 15 |
| d4-frontend-extraction | ho-mv30i4sf-01273270, ho-mv32b3pf-011eac5d | 32 (union) |
| d5-extraction-contract-browser | ho-mv3249el-0180bc20, ho-mv32g80v-01649548 | 8 (union) |
| rework-2 (separate gate, approved) | ho-mv31o4rp-013055fc | 1 |
| rework-3 (separate gate, sub-mv32kio2-01649f99) | ho-mv32h04t-01f86c40 | 1 |
