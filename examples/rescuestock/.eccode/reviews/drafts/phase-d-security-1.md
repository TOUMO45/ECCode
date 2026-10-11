# Security review: phase D submission (phase:d-extraction), version 1 (FINAL)

Reviewer: security-reviewer. Run: run-mv330tea-0177469c. Gate: `phase:d-extraction`, submission `sub-mv32yhz0-0170ea86` (recording reviewer: technical-reviewer; this draft is input to that review, I record no gate decision).

**Inputs:**
- `.eccode/artifacts/phase-d/submission.md` and `handoff.json`, with the nine handoffs they list;
- the spec's Security, AI / LLM Design (schema, prompt, isolation, adapters, gate), Customer routes, Retention and Observability sections;
- decisions dec-mv330std-0165d9be (FU-23), dec-mv330t0g-0175d52b (FU-24), dec-mv330t7a-017a2211 (FU-25), dec-mv31kbrz-012381a1 (FU-2) and dec-mv32c290-0182b807 (degraded form).

**The tree I tested:**
- Every check below was recorded with `--actor security-reviewer --gate phase:d-extraction`.
- `src/`, `test/`, `public/`, `scripts/` and `package.json` are byte-identical to the submitted `461a5ac`. Later commits (`2a68680`, `903dfcd`) touch only `.eccode/` records and `docs/build/state.md`.
- No project file was changed.

**The probes:**
- My probe scripts live in my scratch area and run by path.
- They run the app in-process on temp databases with scripted providers. My own stub `claude` binary and loopback stubs stand in for the providers.
- One unintended exception reached a real `claude` binary; see "Incident during this review".

## Verdict

**I would not block phase D.** I attacked every property phase D owns and they held:
- **Prompt isolation:**
  - forged and look-alike markers, U+2028/U+2029, C0, bidi, JSON break-outs and Arabic instructions all stay inside one escaped data line;
  - the delimiter ids are fresh on every call.
- **Strict schema:** no output can name a price, a supplier, a role, a plan version or a provenance outside `user_text/image/none`. Free-text questions, `__proto__` and over-long answers are refused.
- **Injection is data only:**
  - the `addressedToAssistant` flag only flags;
  - the confirmation boundary ignores client provenance;
  - hostile wording renders as text in Chromium.
- **Uploads:**
  - the owner check runs before the body;
  - magic bytes must equal the declared type;
  - the size cap holds at exactly 5 MiB, and 5 MiB + 1 gets 413;
  - names are random and files are 0600;
  - a polyglot is served as an inert image.
- **Deletion and retention:** tombstones and hard deletes work; retention does not follow planted symlinks.
- **Access control:**
  - all 4 phase D routes return 401, 403, 403 or 404 to anonymous, supplier, admin and another customer;
  - CSRF refuses all 12 combinations.
- **The gate:**
  - per-customer concurrency is 1;
  - every failure is degraded;
  - the timeout watchdog settles the reservation at the cap;
  - no provider body or key reaches responses, logs or the database.
- **The CLI adapter:**
  - the environment is built from an allow-list;
  - argv is pinned, and the buyer text goes only on stdin;
  - the cwd is a fresh temp directory;
  - stdout is capped at 8 MiB;
  - the process group is killed on timeout and abort;
  - concurrency is 2.
- **The Anthropic adapter:**
  - the host is pinned in both the adapter and the config;
  - a redirect is refused;
  - the key goes only in the `x-api-key` header.
- **The live runner** refuses every ceiling over 5.00 and every missing switch.

**Findings:**
- **No blocking or major finding.**
- **Two minor findings:**
  - **SEC-D-1:** a digit-free quote grounds any number.
  - **SEC-D-2:** an orphaned CLI child survives the death of its parent.
- **FU-23:** reproduced and **widened**. Plan-version ids are reused too, and image ids follow from the same cascade. It is minor; I do not ask for it to block this gate, provided the orchestrator's migration rework covers `plan_versions` and `images` as well as `rescue_requests`.
- **Seven info items.**

## Evidence

| ev id | what | result |
|---|---|---|
| ev:ev-mv338izg-017aea51 | `npm test` | passed: 1208 pass, 0 fail, 8 skipped, 0 todo (as in the submission); NFR5 p95 56.4 ms |
| ev:ev-mv33otm0-013ea25d | `npm run test:browser` | passed: 8/8 |
| ev:ev-mv33oi25-01b61f93 | the RBAC, CSRF, general-limit, isolation, auth, contracts, injection, uploads-retention, model-budget-rate, extract-degraded, confirm-provenance and rate-limit suites, plus the unit cli, anthropic, prompt, schema, gate, provider-contract and live-runner-refusal suites, and `secrets` and `frontend` scans, alone under the net guard | passed: 427 tests, 419 pass, 0 fail, 8 skipped (the 7 phase E contract rows and fake × BUSY) |
| ev:ev-mv33e5qp-017ba56b | `sec-phd-probe.mjs`, sections P, S, E, U, X and F | passed: 114 PASS, 0 FAIL. The REPRO lines reproduce SEC-D-1 and FU-23 |
| ev:ev-mv33mul3-01ddae55 | `sec-phd-adapters.mjs`, sections C, H, L and T (T takes about 35 s) | passed: 43 PASS, 0 FAIL. The REPRO line C7 reproduces SEC-D-2 |
| ev:ev-mv33nzz8-010dae0c | `sec-phd-browser.mjs` (Chromium from /opt/pw-browsers) | passed: 5 PASS, 0 FAIL |

**Probe coverage of ev:ev-mv33e5qp-017ba56b:**
- **P, prompt isolation:** 10 hostile texts, each checked for exactly one begin and one end marker, a 4-line block, no raw `<`, `>`, U+2028 or U+2029 in the data line, an exact JSON round trip and the fixed system prompt:
  - a forged end marker with a guessed id;
  - bare `<<<`/`>>>`;
  - U+2028/U+2029;
  - CR, VT, FF and NUL;
  - a JSON break-out;
  - an Arabic instruction;
  - a bidi override and zero-width characters;
  - fullwidth `＜＜＜` look-alike markers;
  - NEL;
  - a lone surrogate.

  Other checks: 2000 calls gave 2000 distinct ids; a text over 20000 characters and an SVG image type are refused.
- **S, schema:** 25 smuggling shapes are refused with the expected code, including:
  - top-level `price`, `supplierId`, `role`, `planVersionId` and `provenance`;
  - an extra field `unitPriceCents`;
  - `confirmed: true`;
  - provenance `manual`;
  - a free-text question;
  - 10 questions;
  - 201 code points of wording;
  - `1e21`, `-1` and `1.5` as quantities;
  - budget `12.345`;
  - deadlines `25:00` and `tomorrow`;
  - a class instance.

  Also refused: a `__proto__` key (`KEYS`, and nothing is polluted), a code-fenced answer, two concatenated objects and an answer over 64 KiB. Errors carry paths and codes only.
- **E, the service with scripted providers:**
  - E1: SEC-D-1.
  - E2: an obeying model on ti01-en.
  - E3: image provenance.
  - E4: forbidden keys become degraded `PROVIDER_BAD_OUTPUT`.
  - E5: six leak attempts: a key in an Error, a body as `cause`, a string usage, a TypeError, a negative cost and a non-numeric cost. The canary appears in neither the response, the log lines, `audit_events` nor `extractions`, and every `model_spend` row is settled.
  - E6: the timeout watchdog.
  - E7: concurrency.
  - E8: no idempotency.
  - E9: budget exhaustion.
- **U, uploads, deletion and retention:** U1 to U10, as listed under "Checked and held".
- **X, access control and CSRF:** the matrix and the CSRF combinations.
- **F, FU-23.**

**Probe coverage of ev:ev-mv33mul3-01ddae55:**
- **C, the CLI adapter:**
  - C1: environment, argv, stdin and cwd.
  - C2: the timeout kills the group, including a grandchild.
  - C3: the abort signal.
  - C4: a 64 MiB flood.
  - C5: a third concurrent call is `PROVIDER_BUSY`.
  - C6: the error and prose modes carry no stderr or provider body.
  - C7: SEC-D-2.
- **H, the Anthropic adapter:**
  - H1, H2: host pinning in the adapter and in `config.js`; the key is redacted in config.
  - H3: headers and cost.
  - H4: a redirect.
  - H5: a 401 that echoes the key.
  - H6: a refusal.
  - H7: a server that never answers.
  - H8: a 5xx retry.
  - H9: a 48 MiB chunked body.
- **L, the live runner:** 12 refusal cases with no model reachable, `--dry-run`, and FU-21.
- **T:** FU-2 and the slow provider.

**Memory:** not consulted for this review. The submission's only lesson, mem-sd-mv1audrd-013b7102 (guard root resolution), does not bear on the security of this phase.

## Findings

### blocking

None.

### major

None.

### minor

**SEC-D-1: a quote without digits grounds any number, so the server-side grounding backstop (T9) is weaker than d1 built it.**
- **Where:** `src/services/extraction.js`.
  - `normaliseExtraction` accepts a numeric `user_text` value when `numbersIn(quote)` is empty: `ok = written.size === 0 || written.has(value)`.
  - `extractRequest` calls `validateExtraction(answer?.output)` without `context.text` (the comment reads "structure only"). So d1's own `numberGrounded` check (`src/ai/schema.js` › `validateExtraction`, which gives `NUMBER_NOT_IN_INPUT`) never runs in production.
- **Reproduction:** ev:ev-mv33e5qp-017ba56b E1. With the text "Hello, we need cups and lids for the weekend, 250 ml, 90 mm, by 11:00, budget $120, at most two pickups.", these are all stored `known` with provenance `user_text`:
  - `cupQuantity 99999` quoted as "need cups";
  - `lidQuantity 777` quoted as "lids for the weekend";
  - `maxPickups 5` quoted as "at most two pickups".

  d1's validator, given the same text, refuses all three with `NUMBER_NOT_IN_INPUT`. The controls work: a quote that is not a substring, or a quote whose digits do not include the value, is downgraded.
- **Impact:**
  - A real model that hallucinates, or that obeys injected text, can present an invented quantity, capacity, diameter, budget or pickup count as "from your text" next to a genuine-looking quote. The buyer sees "From your text" and is more likely to confirm it.
  - No money moves without the buyer's explicit plan approval, and the planner reads only confirmed values (SEC-8 held in E2). So the impact is wrong purchases proposed with false provenance, not unauthorised spend.
  - The fake never produces this, so RS-05 [D] does not cover it, and LIVE-M1 is unverified.
- **Resolution:**
  - For numeric `user_text` fields, require `numbersIn(quote).has(value) || wordNumbersIn(quote).has(value)`. Either export `numberGrounded` from `schema.js` and call it in `normaliseExtraction`, or call `validateExtraction(output, {text})` and downgrade per field.
  - A test shows that the three E1 cases become `unknown` with their questions, while RS-01 (Arabic dual "نقطتي" = 2, Arabic-Indic digits) stays green.
  - Owner: backend-engineer (d3 file) with ai-engineer (the export).
  - Must land before the verification gate. It is small, and it is the T9 "server-side grounding" mitigation the spec names.

**SEC-D-2: a detached CLI child outlives its parent process, so a server restart or a killed live run leaves a model call running unsupervised.**
- **Where:**
  - `src/ai/cli.js` › `runOnce`: `spawn(..., { detached: true })` puts the child in its own process group. Only the adapter's timer, the abort signal or the stdout cap kill it, and those die with the parent.
  - `src/main.js` › `main`: `stop()` closes the app and calls `process.exit(0)` without stopping in-flight provider calls.
  - `test/live/run-live-model.js`: no SIGINT or SIGTERM handling.
- **Reproduction:** ev:ev-mv33mul3-01ddae55 C7, against my stub (`sec-phd-orphan-driver.mjs` runs one adapter call). After the parent gets SIGTERM, and again after SIGKILL, the stub child is still running (state `S`). I also hit this for real; see "Incident during this review".
- **Impact:**
  - Each orphaned call still bills, up to `--max-budget-usd` (0.05 by default): at most 2 per server process (CLI concurrency 2), plus one per killed live run.
  - A hanging CLI is never killed, so processes leak.
  - The server's accounting survives: the reservation row stays `reserved` and the startup sweep settles it at the cap after 2 × `RS_MODEL_TIMEOUT_MS`.
- **Resolution:**
  - `cli.js` tracks the process-group ids of active children and kills them (`process.kill(-pgid, 'SIGKILL')`) from a `process.on('exit')` hook. It also exposes a `close()` that `main.js` › `stop()` and the live runner (on SIGINT/SIGTERM) call.
  - A test is C7 inverted: after the parent's SIGTERM, the child is gone.
  - Owner: ai-engineer, before delivery.

### FU-23 (orchestrator item): reproduced, scope wider than recorded

- **Reproduction:** ev:ev-mv33e5qp-017ba56b F. Customer X creates request 1, uploads, extracts, confirms, plans, approves, then deletes, which is a hard delete because no order exists. Customer Y's next request then gets id 1, and Y's first plan version gets X's plan version id 1.
- **Exposure:**
  - **To customers, none.** Y's view of id 1 shows none of X's text, extraction or image, and Y's GET image returns 404. X gets 404 on every route for id 1. An in-flight extraction or upload by X re-checks the owner at commit (`storeExtraction`, `saveImage` › `findOwnedRequest`), so it cannot land on Y's request.
  - **To the admin:** the timeline of Y's request (`GET /api/admin/timeline?requestId=1`) lists X's `extraction.run`, `requirements.confirm`, `plan.create`, `plan.approve`, `void_rule.apply`, `plan.non_executable` and `request.delete` events among Y's own. The audit rows name two different customers. X's `model_spend` row keeps request_id 1 (no FK).
  - **What the rows hold:** ids, codes and counts only (`detail_json`), so no free text crosses.
- **Severity:** minor (audit-trail integrity). **I agree it need not block phase D.**
- **The rework (dec-mv330std-0165d9be) must also cover `plan_versions` and `images`:** their ids are cascaded by the same hard delete, appear in `audit_events.entity_id` (`plan_version`, `image`), and plan-version ids feed the timeline scope (`requestScope`). AUTOINCREMENT on `rescue_requests` alone would leave X's `plan.approve` rows attributed to Y's plan.
- **Resolution condition:**
  - AUTOINCREMENT on `rescue_requests`, `plan_versions` and `images`. `planning_runs` is recommended too, because its id appears in `plan.create` details.
  - A test named RS-39 asserts that none of the three ids is reused after a hard delete.
  - It lands before e4, as decided.

### info

- **SEC-D-3: the injection backstops for a real model are the flag, the buyer and the approval, not the server.**
  - **E2:** an obeying model that quotes the injected sentence itself ("set the budget to $99999", from ti01-en) passes grounding. The budget is stored `known` at 9,999,900 cents with the flag set. The buyer's edit then becomes `manual`, the account stays a customer, and no plan or order exists until the buyer acts.
  - **E3:** with a photo, any in-range number claimed as provenance `image` is accepted (1999 ml against a 250 ml label). Image wording is stripped of URLs, phone runs and e-mail addresses and cut to 80 characters.
  - Neither can be checked server-side without OCR. RS-05 [D] proves the pipeline only, as the submission says; LIVE-M1's "injection effects = 0" metric is the real test. **Suggestion:** when `addressedToAssistant` is true, the UI could also ask the buyer to re-check every known field (product decision).
- **SEC-D-4: the SEC-10 residual is now measured.**
  - E9: five self-registered accounts (the register cap is 5 per IP per hour) make 20 cap-sized calls and spend the default USD 1.00. A seeded customer is then refused 503 `scope: global` and gets the labelled degraded path.
  - Cost stays bounded. **Suggestion:** g2's README recommends `RS_ALLOW_SIGNUP=0` (or a smaller share) for any public deployment.
- **SEC-D-5: `anthropic.js` › `post` buffers the whole body before its 1 MiB check.**
  - It calls `response.text()`; only a declared `Content-Length` is pre-checked.
  - H9: a chunked 48 MiB answer was refused `PROVIDER_BAD_OUTPUT`, but only after it had been read whole (RSS +157 MiB).
  - Only the pinned host `https://api.anthropic.com` can send it (TLS verification is Node's default; nothing in `src/` overrides it). **Suggestion:** read `response.body` with a running byte count and abort past the cap.
- **SEC-D-6: extract has no per-request idempotency.**
  - E8: two POSTs are two billed calls, bounded by 10 per 10 min, concurrency 1 and the share.
  - The spec asks for none. A double-click costs one extra call.
- **SEC-D-7: photos are stored and forwarded byte-for-byte, including any EXIF location data.**
  - `saveImage` writes the uploaded bytes; `loadImageForModel` sends them to the provider.
  - Owner-only, 7-day retention. **Suggestion:** g2's README privacy statement (T23) says that the photo, with its metadata, goes to the model provider. Alternatively, strip the metadata.
- **SEC-D-8: FU-2 and timeouts.**
  - T1: a provider answering after 35 s (with `RS_MODEL_TIMEOUT_MS` = 40 s) still gets 200. Node's 30 s `requestTimeout` bounds receiving the request, not the handler. So one connection and the customer's single model slot are held for up to `RS_MODEL_TIMEOUT_MS`, which config allows up to 600000 ms. The default of 30000 is fine. **Suggestion:** cap the variable at 60000.
  - T2: a 1 KiB/s upload gets 408 at 30.95 s, the accepted 30 s effective deadline (dec-mv31kbrz-012381a1).
  - The CLI refuses a third concurrent call at once (`PROVIDER_BUSY`) rather than after the "5 s wait" in spec T19. This is availability only.
- **SEC-D-9: d5's secrets scan (`test/scan/secrets.test.js`), my judgement.** Coverage of the log channel is good:
  - canaries go in headers, bodies, display names, buyer text, provider bodies (fake, CLI stub and Anthropic stub), error causes and the admin password;
  - both an in-process server and a separate process (stdout and stderr) are scanned;
  - the key allow-list is checked;
  - there are negative controls.

  The gaps:
  - `ANTHROPIC_API_KEY` is never set in the separate-process run; the key is only handed to an adapter in-process. My H2 shows that a config error names the variable only.
  - Responses are checked only for the provider-body marker.
  - Database rows are not scanned. My E5 covers `audit_events` and `extractions`.

  The response and DB gaps are planned for g3 (RS-29 extension). The CLI child's stderr is `ignore`d, so it can never be logged.

## Checked and held

Probe sections refer to ev:ev-mv33e5qp-017ba56b (P, S, E, U, X, F), ev:ev-mv33mul3-01ddae55 (C, H, L, T) and ev:ev-mv33nzz8-010dae0c (B).

**T9, prompt isolation and model output (P, S, E):**
- The system prompt is a constant, and untrusted text goes in one `safeJson` line between `RS_DATA` markers with a random 16-hex id.
- No payload in P could produce a second marker or a raw `<` or `>`.
- Catalog text has no parameter in the prompt builder (T10).
- The model output has no field that can name money, roles, suppliers or plan versions. Any extra key degrades to `PROVIDER_BAD_OUTPUT` with every field unknown (E4).
- Questions are field names only, rendered from server templates (SEC-7).

**`addressedToAssistant`:**
- It is stored under `__meta` and only rendered as a notice.
- E2 shows no plan, order, requirements or role change.
- B1 shows the notice in Chromium.

**SEC-8:** on confirm, client provenance (inside `fields` and at the top level) is ignored, and an edited value becomes `manual` (E2).

**T11, d4 rendering:**
- In Chromium, these appear as literal text: a user_text wording `250 ml <img src=x onerror=…>`, and an image wording `<svg onload=…>90 MM <a href="javascript:…">`.
- No script ran; the page has 0 `<img>`, 0 `<svg>` and 0 `javascript:` links, and there was no CSP report or page error (B1).
- SEC-C-4 is resolved: `isAllowedUrl` now refuses `\`, C0/C1 controls and Unicode spaces (`public/js/format.js` › `hasUnsafeUrlChars`).

**T12/RS-39, uploads (U):**
- The owner check comes before the body: customer B posting 4 MiB to A's request gets 404, with no file, no row and no rate event (U1).
- **Type checks (U2):**
  - SVG, HTML and GIF declarations get 415;
  - a mismatch between declared and detected type (PNG/JPEG/GIF/HTML/RIFF-WAVE, or 7 of the 8 signature bytes) gets 415, with nothing in `uploads/` or `.tmp/`;
  - `IMAGE/PNG; charset=binary` is normalised.
- **Length (U3):**
  - chunked without a length gets 400;
  - `Content-Length` of 5 MiB + 1 gets 413 before the body is read;
  - a body longer than its declared length never yields an oversize file;
  - exactly 5,242,880 bytes gets 201.
- **Names and modes (U5):** 128-bit hex names; files 0600; `uploads` and `.tmp` 0700; `.tmp` empty after use; a replacement deletes the old file.
- **Traversal (U6):**
  - hostile ids (`..%2F`, `%00`, `0x1`, `01`, `1.0`, `-1`, `1e3`, 16 digits, `%20`, `;`) get 400 or 404;
  - `%31` decodes to the owner's own id, which is an alias, not a bypass;
  - paths are built only from the stored 32-hex name and the detected type (`imageFilePath`).

**GET image, and the `Content-Disposition: inline` judgement:**
- The response carries:
  - the detected type;
  - `nosniff`;
  - `Content-Security-Policy: sandbox`;
  - `private, no-store`;
  - `inline; filename="image"`;
  - no Set-Cookie and no `Access-Control-*` header (U4).
- Navigating Chromium directly to a PNG+HTML polyglot renders it as `image/png`. No script ran, no fetch was made and the title did not change (B2).
- **Inline is safe here:** only PNG, JPEG and WebP can be stored (no SVG); `nosniff` pins the type; and `sandbox` would neutralise scripts even if a browser rendered the bytes as a document.

**Deletion and retention:**
- **Hard delete:** the file is unlinked and GET image gets 404 (U7).
- **Tombstone:** `raw_text` is null, `deleted_at` is set, images and extractions are gone, no `originalWording` is left in requirements, the void rule ends the reservation, and every route gets 404 for the owner (U8).
- **Retention after 8 days:** the row, the file and an audit event are removed. A planted symlink named like an upload is not followed (the target is intact), and a non-matching name is untouched (U9).

**Rates:**
- Uploads and extracts share 10 per 10 min (U10).
- The general limit (FU-15) is wired: `src/auth/index.js` › `createGeneralLimiter`, and the general-limit suite is in ev:ev-mv33oi25-01b61f93.

**Access control (X):**
- **Default deny:** POST image, GET image, POST extract and DELETE request answer 401 to anonymous, 403 to a supplier, 403 to the admin and 404 to another customer. The 16 refused calls change no data row.
- **CSRF:** with no token, a wrong token, a foreign Origin or `Origin: null`, the three state-changing routes all get 403 (12/12).
- A `text/plain` extract body gets 415.
- The RBAC, isolation, auth and contract suites pass (ev:ev-mv33oi25-01b61f93).

**T16/NFR6, the gate (E, T):**
- Per-customer concurrency is 1: two parallel calls give one 200 and one 429 `model_concurrency` with a degraded row, and another customer gets 200 (E7, T1).
- The watchdog ends a provider that never answers and ignores its signal at `RS_MODEL_TIMEOUT_MS`. The signal is aborted, the row is settled at the cap, and the customer's next call is not blocked (E6).
- Every failure shape is degraded and every reservation is settled (E5).
- The budget, share and boundary tests pass in the suites.

**Secrets (E5, C6, H3, H5, H2):**
- Keys and provider bodies stay out of responses, logs, `audit_events`, `extractions` and error objects (message, `inspect` and JSON).
- The key is a redacted Secret in config.
- Config errors name the variable only.

**T25, the CLI adapter (C):**
- **Child environment:** exactly `CLAUDE_CONFIG_DIR, HOME, LANG, PATH, TMPDIR` from a parent environment that held:
  - `ANTHROPIC_API_KEY`, `ANTHROPIC_BASE_URL`;
  - `RS_ADMIN_PASSWORD`, PayPal secrets, `RS_FAKE_WEBHOOK_SECRET`;
  - `AWS_SECRET_ACCESS_KEY`, `GITHUB_TOKEN`;
  - `NODE_OPTIONS`, `LD_PRELOAD`;
  - `HTTPS_PROXY`, `CLAUDE_CODE_USE_BEDROCK`.
- `HOME` and `CLAUDE_CONFIG_DIR` pass through by design, for the CLI login; with `--tools ""` the model cannot read them.
- **Command line and input:** argv equals `buildArgv` (`--tools ""`, `--safe-mode`, `--setting-sources ""`, `--max-budget-usd 0.05`). The buyer text is on stdin only, so it never appears in `ps`.
- **Working directory:** fresh and empty, removed afterwards (C1).
- **Termination:**
  - timeout and abort SIGKILL the process group, and the grandchild is reaped (C2, C3);
  - 64 MiB on stdout gives `PROVIDER_BAD_OUTPUT` once 8 MiB is passed, and the child is killed (C4);
  - a third concurrent call is `PROVIDER_BUSY` (C5).

**T18, the Anthropic adapter and host pinning (H):**
- **URLs refused in the adapter:** look-alike hosts, userinfo, `http`, an explicit `:443`, a path, and loopback without the switch. With the switch, only exact `127.0.0.1` or `localhost` origins pass (H1).
- **Config:** refuses a loopback value without `RS_TEST_OFFLINE=1`, and refuses a look-alike host (H2).
- **Key handling:** the key goes only in `x-api-key`, never in the URL or body, with `anthropic-version` pinned (H3).
- **Failure handling:**
  - a 307 is refused and its target is never contacted (H4);
  - a 401 that echoes the key carries nothing (H5);
  - `stop_reason: refusal` gives `PROVIDER_BAD_OUTPUT` and keeps the usage (H6);
  - a server that never answers ends as `PROVIDER_TIMEOUT` (H7);
  - one 5xx retry (H8).

**NFR3, the live runner (L):** with no model reachable, it exits 2 for all of these:
- `RS_LIVE_MODEL` unset or `true`;
- no ceiling;
- ceilings 5.01, 5.0000005, `1e3`, -1, 0 and `Infinity`;
- `RS_TEST_OFFLINE=1`;
- the net guard.

`5.0000004` rounds to exactly 5.000000 and is accepted; that is correct rounding, not a bypass. `--dry-run` prints a worst case of $1.10 for 22 calls. FU-21 is confirmed open.

**FU-24, FU-25 and the degraded form (dec-mv32c290-0182b807):** I find these security-neutral:
- a refusal row is the customer's own;
- leaving rephrasing unwired removes a model call;
- the open form edits the customer's own values only.

## Not checked

- **A real model.** I made no deliberate call; the one accidental exposure is described below. Whether Haiku resists the EXT-1 injections, and the real CLI and API output shapes, stay with LIVE-M1.
- **SEC-D-2 through a real server process:** not reproduced end to end, because that needs the real `claude` binary for `cliVersion`. It follows from `main.js` › `stop()` and C7.
- **Multi-process gate races:** I relied on the gate's `BEGIN IMMEDIATE` and the suite. I did not run two server processes against one database.
- **WebP and JPEG polyglots in Chromium:** only PNG was tried.
- **Upload deadline:** I did not test past 60 s on a raised server timeout (FU-2 caps at 30 s).
- **Retention under concurrent sweeps** from two processes.
- **The d4 frontend beyond B1:** the new-request upload flow, client type and size checks, and Cancel/Retry were not probed for security. The browser suite passed (ev:ev-mv33otm0-013ea25d).
- **The rephrase guard** (FU-25, unwired): only its unit tests, run inside `npm test`.

## Incident during this review (disclosed for the record)

**What happened:**
- My first version of probe section L tested the ceiling `5.0000001`, expecting a refusal.
- It rounds to exactly 5.000000, so the runner accepted it. With my shell's PATH (a logged-in `claude` at `/opt/node22/bin/claude`) and the default provider `cli`, it started a real live run for up to 30 s before my `spawnSync` timeout killed it, at about 00:38:40 to 00:39:10 UTC.
- `/root/.claude` shows CLI start-up activity in that window: `policy-limits.json`, `remote-settings.json` and the model-catalog cache.
- I cannot tell whether any model call completed or was billed. Each call is capped at USD 0.05 by `--max-budget-usd`. The runner's own worst case is 22 × 0.05 = USD 1.10, and only the calls made in 30 s plus one in flight could have happened.
- No report file was written, and no `claude` child remained afterwards.

**What I changed:**
- That run is not cited as evidence.
- Section L now runs with `PATH=/nonexistent-no-claude` and `RS_MODEL_PROVIDER=fake`, so no case can reach a model.
- This is how SEC-D-2 was found.

**Also disclosed:** a `pkill -f "sleep 300"` in an early version of section C killed my own shell (exit 144), because the pattern matched the shell's command line. I removed it; process groups are killed precisely now.

## Guard refusals during this review (verbatim)

1. **Read-only `node -e` that printed records from `.eccode/state.json`, defining a JS `function`; no eccode CLI in the line:** "The guard cannot verify who this eccode command acts as: a shell function or alias is defined in the same command line, so the eccode invocation behind it cannot be bound; call the eccode CLI directly."
   - Over-denial: the JS `function` keyword inside a quoted program was read as a shell function. Redone with a scratch script run by path.
2. **`cd <scratch> && perl -pi … sec-phd-probe.mjs`:** "This command changes directory (cd/pushd/popd) and then writes the relative path "sec-phd-probe.mjs", which the guard cannot bind to a file. Write it with a path relative to the project root in a command without cd, or use the Edit/Write tool so ownership can be checked."
   - Fair: the guard cannot resolve the path.
3. **`perl -0pi -e "…" /tmp/…/scratchpad/sec-phd-probe.mjs`, twice (with a variable, then with the literal path):** "security-reviewer reviews/designs but does not edit project files; write drafts under .eccode/artifacts/ or .eccode/reviews/drafts/."
   - Over-denial: the target was my scratch file. An identical-shape `perl -pi` on the same literal path had been accepted minutes earlier, so the regex text itself was probably read as a project path. Redone with a scratch Node patch script run by path.
