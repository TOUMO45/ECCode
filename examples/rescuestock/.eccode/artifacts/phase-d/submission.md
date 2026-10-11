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
