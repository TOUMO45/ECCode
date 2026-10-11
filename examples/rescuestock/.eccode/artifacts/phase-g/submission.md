# Phase g-release: submission

Author: delivery-lead. Gate: `phase:g-release`. Date: 2026-10-11. Run: `run-mv4eaokh-0147b5b9`. Iteration 1.

- **Plan:** `.eccode/artifacts/plan/plan.json`, phase `g-release` ("G: final verification, clean checkout, browser UX, labels and submission materials").
  - **Plan criteria:** RS-29, RS-34, RS-35, NFR2, NFR3, NFR5, the final-tree criterion (clean checkout and README), the evidence table, and the full regression.
- **Reviewers:** **technical + security.** Phase G touches:
  - the secrets scan (RS-29);
  - the honesty of every label (RS-34);
  - accessibility (NFR2);
  - the live-suite refusals (NFR3);
  - the SQL scan (T20);
  - the documents and submission drafts a judge reads.
- **Tree:** HEAD `f4f5f9b`, **clean** (`git status` empty before my runs). All my runs carry tree digest `7c898c91…`, the same digest as g3's final verification run (ev:ev-mv4e8gcg-0101a228).
- **Phase base:** `e348ead`, g1's claim base.
  - Diff `e348ead..f4f5f9b` over `src public test scripts docs README.md .env.example package.json package-lock.json`: 52 files, +5,106/−86.
  - 38 files are phase G's declarations. The rest are reworks 6 and 7, both approved separately (see "Artifact coverage").
- **Decisions during G:**
  - `dec-mv47vma5-01d0d177`: FU-50, completed voids of a closed plan are not listed.
  - `dec-mv48g2fj-018e0ca7`: the spec's single-credential sentence is canonical.
  - `dec-mv4eaw35-013b929e`: the lockfile's missing macOS entry is documented, not reworked.
  - Also used: `dec-mv46ovf2-017bf12d` as corrected by `dec-mv4740d4-015b3589` (FU-59, FU-54), and `dec-mv46ovt6-01a662af` (owners of the follow-ups outside G, which opened reworks 6 and 7).
- **Reworks during G:** both changed files outside phase G and were reviewed under their own gates.
  - **rework-6:** test-only, FU-33 and FU-46. Handoff `ho-mv47ltf3-01c9351a`; `phase:rework-6` approved.
  - **rework-7:** backend follow-ups FU-54, 55, 56, 57, 58 and 59, the canonical sentence, the lockfile and `.env.example`. Handoffs `ho-mv4aker9-014c05a3` and `ho-mv4b2qcu-01d596a2`; `phase:rework-7` approved.
- **Follow-ups:** `.eccode/artifacts/plan/followups.md` gains "Added after phase G" and is submitted with this file.
- **Safety and network:**
  - `RS_LIVE_MODEL` and `RS_LIVE_PAYPAL` were never set by me or, per the handoffs, by any engineer. No live suite was run, and no PayPal or model host was contacted.
  - The API, integration and browser runs used 127.0.0.1 only (net guard).
  - **One exception, part of the plan's own g3 command:** `scripts/clean-checkout.sh` runs `npm install` in an empty copy, which fetches packages from the npm registry through the environment's proxy.
  - Every full-suite run of mine held `flock /tmp/rescuestock-suite.lock` (`dec-mv43s14b-01addb18`). For g3's command the lock was held around the whole `eccode evidence run`.

## Nothing rests on a live run

**No live suite was run in this project, by anyone.** Every payment result comes from:
- the DB-backed fake adapter;
- or the Sandbox adapter talking to the loopback PayPal stub, which exists only under `RS_TEST_OFFLINE=1`.

Every extraction result comes from the fake model, recorded transcripts or loopback stubs.

**What stays Unverified:** every LIVE-M1, LIVE-P1 and LIVE-P2 item, the FU-52 list that no live file covers, the OQ-D5 facts, and USER-Q9 (Node 22.5). The evidence table marks each with its blocker. Its 28 `verified` rows rest only on offline suites.

## What the phase delivers

| Task | Owner | Handoff | Engineer's runs (cited in the handoff) | Delivered |
|---|---|---|---|---|
| g1-frontend-a11y-labels | frontend-engineer | ho-mv48fejc-0156303e | **Red first:**<br>- ev:ev-mv483xim-01466fe6 (a11y-labels test);<br>- ev:ev-mv4873d8-01b922ce (3 scan tests).<br>**Plan command:** 242/242, ev:ev-mv48fb83-01ff31ba (and ev:ev-mv48aqi5-0119d43d).<br>**Chromium audit:** 360 ev:ev-mv489sxa-0120c3f9, 1280 ev:ev-mv48ajze-019f771b.<br>**Mutation:** the old stylesheet is found defective, ev:ev-mv48a8o1-0107475f (red as intended).<br>**Date-control focus screenshots:** ev:ev-mv48e6rt-01d60145.<br>**Locked runs:** browser 14/14 ev:ev-mv48bosl-014bf5a4; `npm test` 2307/2299/0 ev:ev-mv48e1xg-01cfcf2e. | **Two defects fixed:**<br>- the disabled-button contrast was 3.13:1;<br>- request links were under 44 px.<br>**Labels:** `labelsModel`, `adapterOf` and adapter badges; a provider line in the admin payment sections.<br>**FU-54:** the forced-reset intro is worded by adapter (it renders `planStatus`/`owedRefund` when present; rework-7 now sends them).<br>**FU-58:** `public/js/isolate.js`, so a refusal reason is wrapped in `<bdi dir=auto>`.<br>**Fixtures:** three label fixtures under `test/fixtures/contracts/labels/`.<br>**Tests:** `a11y-labels.test.js` (30 tests); scan tests for contrast, focus ring, the disabled look, 44 px links, isolation and FU-54. 15 files. |
| g2-docs-submission | devops-engineer | ho-mv48w355-01947d26 | **Plan command:** 25/25, ev:ev-mv48vz7n-016ccf0a (and ev:ev-mv48sogb-0153a00a).<br>**Locked `npm test`:** 2323/2315/0, ev:ev-mv48v120-01de419b.<br>`test:browser` not run by g2. | **README:** rewritten, problem first, with a one-command fake demo checked on 127.0.0.1.<br>**Runbooks:** `docs/runbooks/live-model.md`, `live-paypal.md`, `operations.md`.<br>**Submission drafts:** `docs/submission/checklist.md`, `project-description.md`, `demo-video-script.md`.<br>**`.env.example`:** extended.<br>**Docs scan:** `test/scan/docs.test.js` (16 tests, mutation-probed). 9 files. |
| g3-final-scans-browser | test-engineer | ho-mv4e9r0t-01a6813c | **Final tree, each run locked:**<br>- `npm test` ×3, each 2393/2385/0 fail/8 skipped: ev:ev-mv4dnlhv-0167b2b1, ev:ev-mv4dpxim-01093245, ev:ev-mv4ds3no-0151407a;<br>- browser 28/28, ev:ev-mv4dv7a8-0168c15d;<br>- secrets scan after the browser run 15/15, ev:ev-mv4dvgym-016f8416;<br>- multi-process files ×4 at concurrency 4, 25/25 each, ev:ev-mv4dzgo7-017ffe03;<br>- +30-day `npm test`, ev:ev-mv4dxpjf-01ff87f2, with the preload proven active, ev:ev-mv4dy7qb-017f57f9;<br>- **verification command**, ev:ev-mv4e8gcg-0101a228.<br>**Mutants, all red, diffs under `scratchpad/g3/<name>/mutant.diff`:**<br>- m-sql ev:ev-mv4d772a-0113a2e4;<br>- m-public ev:ev-mv4d79w3-011a9f8f;<br>- m-leak ev:ev-mv4d7cja-010e6cc5;<br>- m-refusal ev:ev-mv4d7f96-01900c43;<br>- m-labels-api ev:ev-mv4d7j26-01f4e39e;<br>- m-banner ev:ev-mv4dai8x-01be2775;<br>- m-contrast ev:ev-mv4dbmkw-01a366da;<br>- m-focus ev:ev-mv4dbyo0-0162cb51;<br>- m-prov ev:ev-mv4dc2h9-01f8bf41;<br>- m-bdi ev:ev-mv4ddhl0-0135a046;<br>- table mutants m-tbl-row ev:ev-mv4dkvtv-0186c75f, m-tbl-blocker ev:ev-mv4dl2da-014fee9b, m-tbl-id ev:ev-mv4dl2v6-01b303bd, m-tbl-log ev:ev-mv4dl3l9-012c6441. | **Scans:**<br>- `test/scan/sql.test.js` (T20, 4 tests; **deviation**, see Disclosures);<br>- `test/scan/live-refusal.test.js` (NFR3/FU-37, 15 tests);<br>- `test/scan/secrets.test.js` (RS-29 section).<br>**Labelling:** `test/api/labelling.test.js` (RS-34 [D], 13 tests); `test/browser/labelling.test.js` (RS-34 [B], 4 tests).<br>**Browser:** `test/browser/six-questions.test.js` (RS-35, 2 tests); `test/browser/a11y-states.test.js` (NFR2, 8 tests).<br>**Helpers:** `a11y-audit.js`, `keyboard.js`, `api-purchase.js`; `approval-roundtrip.js` gains options.<br>**Evidence table:** `docs/evidence-table.md` (45 rows) and `test/scan/evidence-table.test.js` (11 tests).<br>**Tool:** `test/helpers/shift-clock.mjs`.<br>14 files. |

## Delivery-lead runs on the final tree (`f4f5f9b`, clean, digest `7c898c91…`)

| Run | Result | Evidence |
|---|---|---|
| g1 plan command, verbatim | **242 tests, 242 pass, 0 fail** | **ev:ev-mv4ec4yp-013d1312** |
| g2 plan command, verbatim | **27 tests, 27 pass, 0 fail.** g2 had 25; rework-7 later added two `env-example.test.js` tests. | **ev:ev-mv4ec5fs-0192cc1b** |
| g3 plan command, verbatim, with `--timeout 2400` and the whole `eccode evidence run` inside `flock /tmp/rescuestock-suite.lock` | exit 0, 336.8 s.<br>**`npm test`:** 2393 tests, 2385 pass, 0 fail, 8 skipped, 0 todo. ECCODE_EVAL 200/200. NFR5 p95 **57.5 ms** (p50 2.8 ms) over 7603 requests; suite 103.6 s.<br>**`npm run test:browser`:** **28/28**, 0 skipped.<br>**`scripts/clean-checkout.sh`:** `npm install` from the registry, then `npm test` in the empty copy (2393 tests, 2383 pass, 0 fail, **10 skipped**: the 8 above plus the cited-run check and the screenshot scan, which skip by design without the record and without screenshots), then `npm start` and GET `/api/health` 200. | **ev:ev-mv4ejk73-01c85373** |
| `flock … env CLOCK_SHIFT_DAYS=30 NODE_OPTIONS=--import=./test/helpers/shift-clock.mjs npm test` | exit 0. **2393 tests, 2385 pass, 0 fail, 8 skipped** (the same 8). p95 55.3 ms; suite 97.8 s. | **ev:ev-mv4elo6d-019de172** |
| g3's proof script under the same command form | `Date.now()` is **30.000 days ahead** in the process and in a child that inherits `NODE_OPTIONS`; a fresh file's mtime reads 30.000 days ahead; an explicit `utimes` round-trips | **ev:ev-mv4em5st-01bd0387** |
| `test/scan/secrets.test.js` alone, after my browser run | **15/15, 0 skipped.** The 48 screenshots written by my browser run were scanned. | **ev:ev-mv4emolt-0185de9a** |
| Artifact coverage after submitting | see "Artifact coverage" | recorded after submission |

- **No red result** in any of my runs, and no re-run was needed.
- **The two FU-33 / SEC-B-1 tests passed in every full run.** Rework-6 fixed the RS-39 retention test and re-timed SEC-B-1.
- **The skipped tests:**
  - **the same 8 in every `npm test`:** the fake model has no `busy` fault (1); the fake payment adapter has no wire or OAuth (7, which run and pass for the Sandbox adapter against the stub);
  - **2 more in the clean copy only:** the table's cited-run check and the screenshot scan, which skip by design there.
  - No skipped test is counted as passed.

## Criteria → tests → evidence

Counts are passing leaf tests whose names carry the id. They come from the `npm test` part (main tree) and the browser part of my g3 run, ev:ev-mv4ejk73-01c85373.

| Criterion | Task(s) | Proving tests (abridged) | Leaf tests passing | Evidence | Real / fake / live |
|---|---|---|---|---|---|
| **RS-29** [D + I]: no client id or secret in assets, recorded responses, logs, screenshots or submission files; config redacts | g3, g2 | `secrets.test.js`:<br>- `RS-29: no file under public/ holds a canary, a client id, a secret or a secret-shaped value …`;<br>- `RS-29: the answers of a server that holds the canaries (config, session, requests, admin views, errors) never echo …`;<br>- `RS-29: every screenshot under test/browser/out is a PNG with a plain file name and no text chunk that holds a canary or a secret shape`;<br>- `RS-29: an invalid secret (too short, a placeholder, half a credential pair, a URL with a password) is refused by NAME …`.<br>`frontend.test.js` › `RS-29: no secret, client id, token or credential-shaped value is in public/`.<br>`docs.test.js` › `docs: no document contains a secret-looking value`. | 11 (plus 15/15 after the browser run) | ev:ev-mv4ejk73-01c85373, **ev:ev-mv4emolt-0185de9a** | Offline. **Limits:** shapes and canaries only; screenshots by name and text chunks, not pixels (Disclosures). |
| **RS-34** [D + B]: fake payloads `simulated: true` with badge and banner; Sandbox payloads `paypal-sandbox`/`sandbox: true` with "PayPal Sandbox — no real money"; demo data; test mode against the stub; config refuses other PayPal hosts | g3, g1 | **[D]** `labelling.test.js`:<br>- `RS-34: GET /api/config carries the exact label set for this adapter, the price notice and testMode (RS_TEST_OFFLINE=1)`;<br>- `RS-34: every payment object … carries provider, simulated and sandbox for this adapter, never the other adapter's`;<br>- the config refusals.<br>**[B]** `browser/labelling.test.js`: `RS-34: fake adapter at 360x800 / 1280x800` and `sandbox-stub adapter at 360x800 / 1280x800: banners on every route, payment badges, demo data and price notice, the provider's own approval page, the admin provider lines`.<br>**[D, g1]** `a11y-labels.test.js` banner and badge models. | 42 + 4 browser | ev:ev-mv4ejk73-01c85373 | **Fake-only** in the table: the Sandbox labels were shown against the loopback stub in test mode only. The real Sandbox page is LIVE-P1 (A2, SEC-3). |
| **RS-35** [B + I]: the request page answers all six questions from planner codes | g3, g1 | **[B]** `six-questions.test.js`: `RS-35: at 360x800` and `at 1280x800 requirements with provenance, decision trace, rejection codes with explanations, cents totals, offer next to commitment, compensation state …`.<br>**[D]** `a11y-labels.test.js` › `RS-35: the request page answers the six questions in the spec's order, with the status first and the actions last`. | 38 + 2 browser | ev:ev-mv4ejk73-01c85373 | Offline (fake planner data). |
| **NFR2** [B]: keyboard-only happy path at 360 and 1280 with the round trip; visible focus; labelled controls; text status; every state | g3, g1 | **[B]** `a11y-states.test.js`:<br>- `NFR2: at 360x800 / 1280x800 register, ask, type the details, approve, reserve, approve both payments and complete the purchase with the keyboard alone`;<br>- `… empty, loading, error with Retry, timeout, degraded extraction, expired reservation with Re-plan, refunding and needs-attention`;<br>- `… the admin forced-reset stranded list is audited and walkable (FU-51)`;<br>- `… the sentence "Supplier A refused the order: <reason>. No money was taken." keeps its order and the reason is a <bdi> unit`.<br>**[D]** `a11y-labels.test.js` › `NFR2: every control on every view the SPA builds has a label …`; frontend scan contrast and focus tests. | 40 + 8 browser | ev:ev-mv4ejk73-01c85373; g1 audits ev:ev-mv489sxa-0120c3f9, ev:ev-mv48ajze-019f771b | Offline, **Chromium only**. Focus on the native date control was shown by screenshot comparison (Disclosures). |
| **NFR3** [D + I]: four separate scripts; both live scripts refuse without their flag; live reports labelled | g3 | `live-refusal.test.js`:<br>- `NFR3: RS_LIVE_MODEL and RS_LIVE_PAYPAL are absent from this process …`;<br>- `NFR3: test/live/run-live-model.js without RS_LIVE_MODEL=1 exits 2 with the fixed message …`;<br>- `NFR3: test/live/paypal/<file> without RS_LIVE_PAYPAL=1 exits 2 …` for each of six files;<br>- `NFR3: the launcher (npm run test:live-paypal) refuses the same way …`;<br>- `NFR3: the flag alone is not enough …` (model and PayPal).<br>Plus the earlier phases' NFR3 tests (report labelling). | 47 | ev:ev-mv4ejk73-01c85373 | Offline; the refusals are proved **without** the flags. The labelling of live reports is shown by inspection of the runners and their unit tests; no live report exists. |
| **NFR5** [D]: planner under 1 s on RS-FIX-1 and on 200 generator catalogs; p95 under 300 ms; suite under 5 min | earlier phases; g3 checks | `planner-generator.test.js` › `NFR5: the planner solves RS-FIX-1 … in under 1 s`, `generator seeds 1-200 …`; `report-p95.test.js`; the `posttest` report | 19 | ev:ev-mv4ejk73-01c85373: **p95 57.5 ms, 103.6 s**; ev:ev-mv4elo6d-019de172: p95 55.3 ms | Offline. |
| **Final tree**: `clean-checkout.sh` passes (NFR1 re-check); README documents install, seed, start, tests, playwright install, demo accounts (SEC-5), retakes (F-TR-15), `RS_REGISTER_PER_IP_PER_HOUR` (F-TR-17), live runbooks, retention, labelling, Node floor and Q9, MIT | g3, g2 | **Clean checkout:** `npm install`, then `npm test` 2393/2383/0/10 skipped, then `npm start` with health 200. **README:** `docs.test.js`:<br>- `docs: the README names every npm script, the start line, the browser install line and the runbooks`;<br>- `docs: the README states the operator facts the plan requires (FU-9, FU-29, FU-25, FU-27, F-TR-15, F-TR-17, SEC-5)`;<br>- `docs: the documented defaults and bounds match the configuration loader`;<br>- `docs: the README and the drafts say plainly that the live integrations are not verified`.<br>Also `NFR4: README documents the clean-checkout steps, the Node floor, the licence and the labels`. | 16 docs, 21 NFR4, 56 NFR1 | **ev:ev-mv4ejk73-01c85373**, ev:ev-mv4ec5fs-0192cc1b | Offline. The 22.5 run is USER-Q9. |
| **Evidence table**: 45 criteria with suites, test names and ev ids; live rows Unverified with blocker; SEC-18 on RS-20/RS-26; A2; F-TR-18 on NFR6 | g3 | `evidence-table.test.js` (11): 45 ids exactly once; the status and suite vocabulary; ev id pattern; every named test in its file; blockers; the SEC-18/A2/F-TR-18/F-TR-9/Q9 wordings; FU-52 parity with the runbook; limits; **every cited run shows each named test ok and not skipped** (this check ran in the main tree; it is skipped only in the clean copy) | 11 | ev:ev-mv4ejk73-01c85373; my spot-check below | — |
| **Full regression**: `npm test` and `npm run test:browser` pass on the final tree | all | — | 2385/0 fail/8 skipped; 28/28 | **ev:ev-mv4ejk73-01c85373**, ev:ev-mv4elo6d-019de172 | — |

### Task criteria worth a reviewer's eye

- **g1 AC1:** 3 px focus with ≥ 3:1 contrast, text ≥ 4.5:1, 44 px targets, a single column at 360 px. Pinned by the scan tests and by g3's browser audit helper (computed contrast, real Tab focus, no horizontal scroll).
  - **Known exceptions, by design:** the Timeline and Total tables scroll inside a focusable region at 360 px, and the native date control is ringed by Chromium itself.
- **g2 AC3:** the video script requires PayPal's hosted Sandbox page (user-run) and labels everything simulated. Checked by `docs: the video script shows PayPal hosted Sandbox approval (user-run) and labels …`.
- **g3 AC8 (T20):** a deviation; see Disclosures.

## Evidence table check (`docs/evidence-table.md`)

- **Counts confirmed:** 45 rows (RS-01..RS-39, NFR1..NFR6), each once:
  - **28 `verified`**;
  - **2 `fake-only`** (RS-25, RS-34);
  - **15 `LIVE-DEPENDENT`** (RS-01, 02, 03, 05, 18, 19, 20, 21, 22, 23, 24, 26, 31, 32, NFR6).
- **How I checked it:** with my own script (`scratchpad/spotcheck2.mjs`, read-only), not g3's test. It applies the table's stated contract ("How to read a row"):
  - each `file :: title` must be text in that file;
  - at least one cited run's log must show a test containing that title as `ok`, not skipped and not todo;
  - every cited run must exist in the record, `passed`, exit 0.
  - For judgement, it prints the full matched name of each test.
- **Spot-check, eight rows opened in detail (26 named tests): all shown `ok` in the cited logs, and each match is the intended test.**

| Row | Status | Named tests → where shown (full name abridged) |
|---|---|---|
| RS-12 | verified | `approve-guards :: RS-12: approving with the current hash and total is 200` → ev:ev-mv4dnlhv-0167b2b1 ("… approvalsNeeded is the supplier count, and the status is RESERVE next"); `planner-fixture :: RS-12: planner half - cups or lids below the requirement are never feasible` → same run |
| RS-22 | LIVE-DEPENDENT | `capture-compensation :: RS-22: the second capture is declined` and `execute :: RS-22: the second capture is declined` → ev:ev-mv4dnlhv-0167b2b1, 2 matching `ok` lines. **Caveat:** a TAP log carries no file name, so it cannot show which line belongs to which file. |
| RS-26 | LIVE-DEPENDENT | `RS-26: killed with the first capture applied …`, `ARCH-26 variant A …`, `ARCH-26 variant B …`, `F-TR-3 (a): restart …` → ok in ev:ev-mv4dnlhv-0167b2b1 and 4 times each in ev:ev-mv4dzgo7-017ffe03 (four rounds) |
| RS-29 | verified | four `secrets.test.js` tests → ok in ev:ev-mv4dnlhv-0167b2b1 and ev:ev-mv4dvgym-016f8416 (after the browser run); `frontend.test.js :: RS-29: no secret …` → ev:ev-mv4dnlhv-0167b2b1 |
| RS-34 | fake-only | two `api/labelling` tests → ev:ev-mv4dnlhv-0167b2b1 (2 each: fake and stub); `browser/labelling :: banners on every route …` → ev:ev-mv4dv7a8-0168c15d (4: two adapters × two widths); `a11y-labels :: RS-34: the label fixtures …` → ev:ev-mv4dnlhv-0167b2b1 |
| RS-35 | verified | `six-questions :: requirements with provenance …` → ev:ev-mv4dv7a8-0168c15d (360 and 1280); `a11y-labels :: RS-35: the request page answers the six questions …` → ev:ev-mv4dnlhv-0167b2b1 |
| NFR2 | verified | four `a11y-states` tests → ev:ev-mv4dv7a8-0168c15d (2 each: 360 and 1280); `a11y-labels :: NFR2: every control … has a label` → ev:ev-mv4dnlhv-0167b2b1. **Note:** the row is tagged `B` only but also cites a `D` unit test. |
| NFR5 | verified | `planner-generator :: NFR5: the planner solves RS-FIX-1 …`, `report-p95 :: NFR5: percentile is nearest-rank` → ev:ev-mv4dnlhv-0167b2b1 |

- **All 45 rows, same check: 100 named tests, 0 problems.** Every cited run exists, passed and exited 0.
- **The cited runs carry tree digest `4b4001aa…`, not the final `7c898c91…`:** they were made before the table's last edit (g3 discloses that only the table changed afterwards). The final-bytes run is the verification run, mine and g3's.
- **On RS-36:** the row is `verified` with suites `D I`. Its `I` part (F-TR-9) is **not** a fresh inspection; see Disclosures.

## Disclosures for the reviewers

1. **T20 deviation (SQL scan).**
   - The spec asks that a scan forbid template literals in `db.prepare(` calls. About thirty correct call sites build SQL from constants and `?` placeholder lists with template literals, so the literal ban would fail correct code.
   - What `test/scan/sql.test.js` does instead: a per-file allow-list of interpolations, each with a reason. A stale-entry check means an unused entry fails. The route and HTTP layers are scanned with an **empty** list, and any new interpolation fails.
   - Mutant m-sql is red (ev:ev-mv4d772a-0113a2e4).
   - **The reviewer accepts or rejects this deviation.**
2. **RS-36 has no fresh inspection of `domain/derive.js`.** The phase B review (`rev-mv1hc5zg-01a3fc75`) inspected revision 2. The rows added later (4a, 5a, 12, the row 2 clauses) are pinned only by tests. The table says so, but still marks the row `verified`.
3. **Focus on the native date-time control** was shown by comparing screenshots of the focused and unfocused control (ev:ev-mv48e6rt-01d60145, and g3's browser test). The control has no app focus ring and no `:focus-visible` style on its host, and Chromium draws its own ring. This is weaker than a style assertion, cannot show which part is highlighted, and covers Chromium only.
4. **The secrets scan matches shapes and canaries.**
   - A secret of an unknown shape would pass the pattern part.
   - Screenshots are scanned by **file name and PNG text chunks, not pixels**, so a secret rendered into an image would not be found.
   - It did scan the 48 screenshots of my browser run (ev:ev-mv4emolt-0185de9a).
5. **The table cites runs made before its last prose edit** (digest `4b4001aa…`). The final bytes are covered by g3's and my verification runs, whose in-tree cited-run check passed. That check is skipped in the clean copy.
6. **Clock-shift blind spots.** The +30-day run proves nothing about these:
   - Chromium;
   - SQLite (the app uses no SQL clock);
   - `FileHandle.stat`;
   - string times passed to `utimes`;
   - `Intl.DateTimeFormat` without a date;
   - `Date()` called without `new`, which throws loudly;
   - children spawned with a minimal environment (live-refusal checks, the seed runner, start-old-node).
7. **g2's limits:**
   - **Hackathon facts are unverified.** Every one in `docs/submission/*` (dates, 3-minute limit, YouTube, judging criteria, repository rules) is marked unverified with a re-check line. The Devpost connector needs the user to sign in again, so nobody checked them against the official page.
   - **The user must still edit the "own decisions" line:** `docs/submission/project-description.md` L42 carries "[Edit this to say exactly which decisions I actually made myself.]". The repository and video URLs are placeholders, and the checklist boxes are unticked on purpose.
   - **The PayPal Sandbox dashboard steps** and the seven webhook event names in `docs/runbooks/live-paypal.md` were written from general knowledge, not checked against PayPal.
   - Also unverified: the live-model dry-run behaviour, macOS and Windows, and switching `RS_PAYMENT_PROVIDER` with unfinished payments.
   - g2 did not run `test:browser`. Its README sentence about the browser journeys is now backed by my 28/28.
8. **The lockfile gap** (`dec-mv4eaw35-013b929e`, TR-R7-3 / SEC-R7-I2).
   - `package-lock.json` has no `node_modules/fsevents` entry: an optional, darwin-only dependency of Playwright. A macOS `npm install` fetches it without an integrity pin.
   - A regenerated lock with exactly that one extra block is at `scratchpad/g3-lock/package-lock.json` (sha256 `d870b67d…dd62`).
   - **The decision says the README limits state it, but the README does not mention it.** Only `docs/evidence-table.md` › Limits does. The README sentence is a release-checklist item (FU-60).
9. **FU-55 and FU-57 are narrower than asked** (rework-7, approved):
   - **FU-55:** a denied audit row is written for `refund_order` 404 and 422 only. A 422 on the other fault kinds still writes none.
   - **FU-57:** `reconciler.unresolved` counts `refund_failed` operations, but not reservations with an escalation.
   - Both go into the verification report as the narrower reading.
10. **Other limits:**
    - Chromium only (Playwright 1.56.1), Linux only, Node 22.22 only. No other browser, screen reader or touch device was used.
    - The Timeline and Total tables scroll inside a focusable region at 360 px.
    - A Sandbox adapter **without** test mode was never rendered in a browser, because there is no live PayPal.

## Remaining issues from the handoffs, with my assessment

| # | Issue (source) | Assessment |
|---|---|---|
| 1 | FU-54(a) backend fields `planStatus`/`owedRefund` (g1 1) | **Resolved by rework-7:** `src/services/admin.js` L228 sends both. g1's renderer already handles them (unit-tested). |
| 2 | Single-credential sentence mismatch (g1 2, g2 4) | **Resolved:** `dec-mv48g2fj-018e0ca7`, and rework-7 changed `src/config.js` L376 to the spec's sentence. |
| 3 | Admin forced-reset text and `<bdi>` isolation not rendered in a browser (g1 3) | **Resolved by g3:** `a11y-states.test.js` renders the forced-reset text per adapter and the RLM/zero-width reason in Chromium (28/28). A Sandbox adapter without test mode remains unrendered. |
| 4 | Tables scroll in a region at 360 px; the date control's own ring (g1 4, 5) | **Accepted by design;** disclosed (item 3). |
| 5 | Audit script in scratch only (g1 6) | **Disclosed.** Its results are recorded evidence; g3's committed `a11y-audit.js` now covers the same checks in the suite. |
| 6 | Live-only variables in `.env.example`; FU-21 (g2 1) | **Resolved by rework-7 round 2:** `.env.example` lists them as commented entries, and `env-example.test.js` accepts that. `RS_PAYPAL_WEBHOOK_ALGOS` stays an environment fallback (`dec-mv3abkv0-011839e9`). |
| 7 | `package-lock.json` (g2 2, g3 9) | **Rework-7 created the lock.** The fsevents gap is decided (`dec-mv4eaw35-013b929e`). The README line is missing (FU-60). |
| 8 | Refunded-order handover rule stated as pending in the README (g2 3) | **Resolved:** rework-7 implemented the per-order rule (`orders.js` L50–57) and rewrote README L243 as delivered. |
| 9 | Spec wording delta `dec-mv44nzj5-01fbc177` (ARCH-26 (2), saga step 6: "intent (queued or started)" → "started") (g2 5) | **Verification report** (design delta). The approved spec is pinned and not edited. |
| 10 | FU-44 cross-merchant signatures; the FU-52 list (g2 6) | **Done as documentation:** the runbook and the table list them identically (the table test pins parity). Verification report. |
| 11 | Unverified statements in docs (g2 7, g3 10) | **Disclosed** (item 7). |
| 12 | The "own decisions" edit marker; URL placeholders (g2 8) | **The user's.** Release checklist. |
| 13 | NOT VERIFIED live items, OQ-D5, USER-Q9 (g3 1) | **Open, user-blocked.** No live suite was run. |
| 14 | RS-36 inspection (g3 2) | **Disclosed** (item 2). An inspection of the final `derive.js` would close it: a person's task, or g-phase reviewer time. |
| 15 | Chromium/Linux/Node 22.22 only (g3 3) | **Disclosed.** |
| 16 | T20, the date control, the secrets scan's shapes, the table's run timing, the clock-shift blind spots (g3 4–8) | **Disclosed** (items 1, 3–6). |

**Risks the phase touches (status changes are the orchestrator's):**
- **RISK-9** (secrets leak): offline evidence in RS-29 and the docs scan.
- **RISK-14** (Playwright download on clean clones): the clean checkout ran `npm install` only, not `npx playwright install`. The README documents that step.
- **RISK-10** (unverified hackathon facts): **still open**, see item 7.
- **RISK-1, RISK-2, RISK-13 and RISK-18** depend on the live run.

## Process notes

1. **Order of work:**
   - Rework-6 ran first (test-only).
   - Then g1, then g2.
   - Rework-7 (backend) ran in two rounds, between g2 and g3.
   - Then g3, on the tree holding both reworks.
2. **Tooling used for the runs:**
   - Per the coordinator, g3's command ran with the lock held **around** `eccode evidence run`, and the command was passed as one argument.
   - The +30-day run used `env CLOCK_SHIFT_DAYS=30 NODE_OPTIONS=--import=./test/helpers/shift-clock.mjs` as an argument of `env`. The guard accepted this; it refuses an inline `NODE_OPTIONS=` prefix.
3. **Guard refusals in this submission:** one, a read-only reshaping of my spot-check script through inline `node -e … writeFileSync`. It was refused because the guard cannot see which files an inline writer changes. I wrote the script with the Write tool instead. This is the documented over-denial family, not a wrong root.
4. **Budget:** see `eccode status` (orchestrator).

## Lessons

- **My search:** `accessibility labelling secrets scan evidence table release docs clean checkout clock shift`, `--check-env`. It returned only `mem-sd-mv1audrd-013b7102` (guard root resolution in nested projects).
- **The engineers' decisions:** all three G tasks recorded it **not-applicable** with notes. I agree: none designs a hook, guard or root discovery, and the refusals they and I met are raw-text readings, which the lesson's "Not applicable when" list names.

## Artifact coverage

**Before submitting** (my scratch set check, same logic as `.eccode/drafts/phase-artifacts-check.mjs`, base `e348ead`):
- **Declared:** 38 files (g1 15, g2 9, g3 14). No file is declared twice, and none is declared but unchanged or outside ownership.
- **Changed since `e348ead` under phase G ownership:** 40. **Two are undeclared by G:**
  - `test/api/contracts.test.js` (g3's glob);
  - `test/fixtures/contracts/recovery/admin-reset-forced-stranded.json` (g1's glob).
  - Both were changed by **rework-7** (handoff `ho-mv4b2qcu-01d596a2`, approved). **I list both explicitly as artifacts**, so the reviewers see their final state and the coverage check has nothing unsubmitted.
- **Also touched by both a G task and rework-7:** `README.md` and `.env.example` (g2), `test/unit/frontend/recovery.test.js` and `test/fixtures/contracts/labels/config-sandbox-single-credential.json` (g1). The engine pins their final state through the G declarations.
- **Changed outside phase G ownership (informational, reworks 6 and 7):** `package.json`, `package-lock.json`, `src/config.js`, `src/services/admin.js`, `src/services/orders.js`, `src/services/retention.js`, `test/api/admin-basic.test.js`, `test/api/admin-reset.test.js`, `test/api/followups-g-rework.test.js`, `test/api/uploads-retention.test.js`, `test/scan/env-example.test.js`, `test/timing/planner-sec-b1.test.js`. `src/routes/admin.js` is in rework-7's scope but unchanged.
- **After submitting**, I run `.eccode/drafts/phase-artifacts-check.mjs` and record it.

## Handoff index

| Task | Handoffs | Files declared |
|---|---|---|
| g1-frontend-a11y-labels | ho-mv48fejc-0156303e | 15 |
| g2-docs-submission | ho-mv48w355-01947d26 | 9 |
| g3-final-scans-browser | ho-mv4e9r0t-01a6813c | 14 |
| rework-6 (separate gate, approved) | ho-mv47ltf3-01c9351a | 2 |
| rework-7 (separate gate, approved) | ho-mv4aker9-014c05a3, ho-mv4b2qcu-01d596a2 | 18 (distinct) |
