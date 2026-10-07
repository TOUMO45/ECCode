# TriageDesk verification report (t17-verification-run)

Author: delivery-lead · Date: 2026-10-07 · Run: run-muyqykem-016fdddb · Base commit: 3c84fe9

> **HEADLINE: the first full-mode eval FAILED one enforced check.**
> `METRIC high_urgency_recall scope=holdout value=0.571 n=7 threshold=>=0.70 FAIL` (4 of 7 held-out `high` rows predicted `high`; the floor needs 5 of 7).
> `ECCODE_EVAL {"passed":24,"total":25}`, exit 1 (ev:ev-muyqzv9i-018cf19d).
> Per plan PLAN-3 / DES-2 / E5 this was the first and only full-mode run. It was **not** re-run and nothing was re-tuned in this task. The failure is escalated (section 3).
> Every other check passes: `npm test` 439/439, design vectors, held-out hygiene, freeze integrity and the 18-check browser run.

All results come from the **deterministic fallback provider**. They are evidence about the pipeline, not about model quality. **Live-model evaluation was NOT RUN** because no `ANTHROPIC_API_KEY` is available (RISK-7).

## 1. Evidence recorded in this task

| Step | Label | Command | Evidence | Result |
|---|---|---|---|---|
| pre | check-script-hashes | `sha256sum .eccode/artifacts/plan/checks/*.js eval/{dataset,holdout,thresholds}.json` | ev:ev-muyqzh7j-01b4d13c | PASSED. All 3 pinned script hashes equal plan.md; the eval file hashes equal the freeze |
| pre | heldout-hygiene | `node --test test/eval/heldout-hygiene.test.js` | ev:ev-muyqzhhe-012ee8fb, ev:ev-muyqzlcx-01d7f182 | PASSED 6/6 (both runs; the second run only captured the id) |
| 1 | full-suite | `npm test` | ev:ev-muyqzriz-012b8b53 | **PASSED** 439/439, 0 fail, 7.9 s, offline |
| 2 | first-full-eval | `npm run eval` (exactly once) | ev:ev-muyqzv9i-018cf19d | **FAILED** exit 1: 24/25 enforced checks |
| 3 | design-vectors | `node .eccode/artifacts/design/design-vectors.js` | ev:ev-muyr019l-01bbd9f9 | **PASSED** "all design vectors pass" |
| extra | browser-check | `node .eccode/drafts/t17-browser-check.js` (headless Chromium via Playwright) | ev:ev-muyr13oz-01d57136 | **PASSED** 18/18 |

**Full-mode run count: 1.** Exactly one full-mode `npm run eval` run exists: ev-muyqzv9i-018cf19d. Any later full-mode run must be counted against this report (E5).

## 2. Freeze integrity and held-out hygiene

| Check | Result |
|---|---|
| Runner-printed sha256 vs the t02 freeze | dataset `b024a838…0689` = ev:ev-muyoc9sb-01a8edc1; holdout `e7cbbfd2…ba913` = ev:ev-muyoc9ul-01ee7a22; thresholds `ee4703c1…97b5` = ev:ev-muyoc9wk-014a1edb. **All equal** (printed in the ev-muyqzv9i log header and re-hashed in ev-muyqzh7j). |
| Freeze predates the rules | Freeze evidence is dated 2026-10-07T22:23:33Z. The first commit touching `src/triage/injection.js` **and** the first touching `src/triage/fallback-provider.js` is 8f93a16, 2026-10-07T23:18:59Z (`git log --reverse --format=%aI`). **Freeze precedes the rules.** |
| Dataset changes after freeze | None. The hashes are unchanged and no dataset decision is recorded. |
| Pinned check scripts (PLAN-2) | scaffold-check `e1fde7f9…6b647`, dataset-precheck `c59b7acd…56f9`, readme-check `a9a0128f…3683993`. **All equal** the plan.md table. |
| Held-out hygiene (5-gram/canary overlap between the holdout and the rules files) | 6/6 pass (ev:ev-muyqzlcx-01d7f182). |

## 3. Full-mode eval results (fallback provider, ev:ev-muyqzv9i-018cf19d)

Rows: benign=80, attack=27 (18 in-family, 9 held-out), holdout=25, instruction-like benign=12. All 11 dataset-minimum CHECKs pass.

| Metric | Scope | Value | N | Threshold / floor | Result |
|---|---|---|---|---|---|
| category_accuracy | all | 0.907 | 107 | ≥ 0.70 | PASS |
| category_accuracy | holdout | 0.800 | 25 | ≥ 0.60 | PASS |
| category_accuracy | attack | 0.815 | 27 | info | — |
| urgency_accuracy | all | 0.907 | 107 | ≥ 0.65 | PASS |
| urgency_accuracy | holdout | 0.840 | 25 | ≥ 0.55 | PASS |
| urgency_accuracy | attack | 0.889 | 27 | info | — |
| high_urgency_recall | all | 0.826 | 23 | ≥ 0.80 | PASS |
| **high_urgency_recall** | **holdout** | **0.571** | **7** | **≥ 0.70** | **FAIL** |
| schema_validity | all / holdout | 1.000 / 1.000 | 107 / 25 | 1.00 | PASS |
| injection_leak | attack | **0 failures in 27** (95% upper bound about 3/N = 11.1%) | 27 | 0 | PASS |
| injection_steer | attack w/ target | **2 failures in 23** (rate 0.087; 3/N bound not applicable, k > 0) | 23 | ≤ 0.25 | PASS |
| attack_success | attack | 2 failures in 27 | 27 | reported | — |
| injection_flag_recall | in-family | 1.000 | 18 | ≥ 0.90 | PASS |
| injection_flag_recall_heldout | held-out families | **0.444** | 9 | reported, no threshold | — |
| injection_flag_fpr | instruction-like benign | 0.083 (1 in 12) | 12 | ≤ 0.10 | PASS |

`RESULT FAIL 24/25 enforced checks passed` · `ECCODE_EVAL {"passed":24,"total":25}`

**Interpretation (assumed, not separately verified).**
- In tune mode the t11 handoff reported high_urgency_recall 1.000 (n=14) and flag FPR 0.000 (n=8).
- The holdout gives 0.571 (n=7), and the detector catches only 4 of 9 held-out-family attacks.
- This drop is the overfitting that RISK-4 and the E5 freeze were designed to expose. The holdout is doing its job.
- n=7 is small: one more correct row would give 0.714 (pass). The floor is nevertheless enforced as written.

### Escalation
- The holdout floor miss is recorded as **RISK-12** (open; user decision pending). It is a finding against **t11-rules** (`src/triage/fallback-provider.js`, owner ai-engineer).
- Any fix needs a recorded decision. Tuning must use tune rows only (DES-2); the holdout rows must not be inspected.
- A second full-mode run must be reported as run #2, and the held-out numbers from it can no longer be read as blind.
- The orchestrator or user decides whether to (a) accept the miss as a known limitation of the fallback, or (b) reset t11 under that decision.

## 4. Acceptance criteria → evidence

Legend: **V** = verified by an evidence id · **I** = inspection result · **NOT RUN** = not executed, with the reason.
The test counts are the AC-tagged tests inside full-suite ev:ev-muyqzriz-012b8b53 (439/439 pass).

| AC | Status | Evidence / result |
|---|---|---|
| AC1 request validation 200/400/413/415 | V | ev:ev-muyqzriz-012b8b53 (AC1-tagged unit and contract tests) |
| AC2 response schema, V1/V2 vectors | V | ev:ev-muyqzriz-012b8b53; ev:ev-muyr019l-01bbd9f9 (design vectors); eval schema_validity 1.000 (ev:ev-muyqzv9i-018cf19d) |
| AC3 no key → fallback/no_api_key, no fetch, deterministic | V | ev:ev-muyqzriz-012b8b53; browser run shows reason `no_api_key` (ev:ev-muyr13oz-01d57136) |
| AC4 (a)–(n) transport and stub outcomes | V (stubbed) | ev:ev-muyqzriz-012b8b53 (18 AC4-tagged tests). Stubs only, no real API |
| AC5 visible source label "not AI-generated" | V + I | ev:ev-muyqzriz-012b8b53; browser run at 360 and 1280 px renders "Deterministic fallback — not AI-generated (reason: no_api_key …)" (ev:ev-muyr13oz-01d57136) |
| AC6 editable reply, Reset, Copy, no extra requests | V (browser) + partly unverified | ev:ev-muyr13oz-01d57136: typed edit → "Copy reply" puts the edited text on the clipboard; "Reset" restores the original. The "no other network requests" item rests on the AC6-tagged unit tests (ev:ev-muyqzriz-012b8b53); the browser run did not record a request log |
| AC7 injection metrics, detector recall and FPR | V | ev:ev-muyqzv9i-018cf19d: leak 0/27, steer 2/23, in-family recall 1.000, FPR 0.083, held-out recall 0.444 (n=9, printed) |
| AC8 eval prints N, thresholds, sha256; non-zero exit on a holdout-floor miss | V | Runner unit test in ev:ev-muyqzriz-012b8b53. **Also shown for real** by ev:ev-muyqzv9i-018cf19d: exit 1 on the holdout floor miss alone |
| AC9 live request body / schema walk | V (captured stub body) | ev:ev-muyqzriz-012b8b53. Not checked against the real API (RISK-7) |
| AC10 marker/key never in logs or responses | V | ev:ev-muyqzriz-012b8b53 |
| AC11 security headers, path allowlist, no innerHTML | V + I | ev:ev-muyqzriz-012b8b53. Browser: the `<img src=x onerror=alert(1)>` / `<b>` payload created 0 `img`/`b` elements and 0 dialogs, and the textarea kept the text verbatim (ev:ev-muyr13oz-01d57136). The fallback summary never echoes ticket text, so the render path for a model-echoed payload is covered only by the unit tests |
| AC12 zero deps, offline `node --test` | V | ev:ev-muyqzriz-012b8b53 (package contract test; the suite ran offline) |
| AC13 fallback p95 < 50 ms; timeout bound | V | ev:ev-muyqzriz-012b8b53: p95 = 1.126 ms, max 8.724 ms over 200 in-process calls; never-settling transport → `timeout` within TRIAGE_TIMEOUT_MS + 500 ms |
| AC14 `/api/health` mode/model | V | ev:ev-muyqzriz-012b8b53; browser badge "Fallback mode: deterministic rules, no AI" (ev:ev-muyr13oz-01d57136) |
| AC15 keyboard-only flow, labels, live region, not colour-only, contrast | V (browser) + I; contrast **not measured** | ev:ev-muyr13oz-01d57136: 1 Tab reaches the ticket textarea, then typing and Ctrl+Enter give a result, so W1 completes in ≤ 3 actions. `#status` has `aria-live="polite"` and announces "Analysis complete: category billing, urgency high. Deterministic fallback — not AI-generated …". By inspection of `public/index.html`, every control has a `<label>` or visible text, and the source label and warning are text. **Contrast ≥ 4.5:1 was not measured with a tool**: screenshots show dark text on light backgrounds, but this is unverified |
| AC16 redaction egress + notice text | V (stubbed) + I | ev:ev-muyqzriz-012b8b53 (27 AC16-tagged tests). Inspection: the `#live-notice` text in `public/index.html` matches NFR4 word for word. The notice is visible only in live mode, so it was not shown in the browser run |
| AC17 Host/Origin guard, 403 before body read, OPTIONS 405 | V | ev:ev-muyqzriz-012b8b53 (17 AC17-tagged tests) |

### NFRs

| NFR | Status |
|---|---|
| NFR1 zero dependencies | V (AC12) |
| NFR2 injection as data | V (AC7, AC9) for the pipeline. Live model behaviour is **NOT RUN** |
| NFR3 HTTP security | V (AC1, AC11, AC17) |
| NFR4 privacy and secrets | V (AC10, AC16) + I (notice text) |
| NFR5 performance | V: fallback p95 1.126 ms (AC13); browser Ctrl+Enter → render 15–47 ms. Live latency **NOT RUN** |
| NFR6 accessibility | V/I per AC15. Contrast not tool-measured |
| NFR7 cost | V on stub bodies (max_tokens 2048, effort low, one call, no retries). Live token usage **NOT RUN**; cost spent $0 |
| NFR8 determinism | V (AC3) |
| NFR9 testability | V (suite offline, injectable fetch) |
| NFR10 configuration | V (config unit tests in ev:ev-muyqzriz-012b8b53) |

### NOT RUN
- **Live-model eval** (`npm run eval -- --provider live`), its thresholds (category ≥ 0.85, urgency ≥ 0.75, high recall ≥ 0.90, raw_model_validity ≥ 0.95) and the USAGE/cost line. Reason: no `ANTHROPIC_API_KEY` in this environment (RISK-7). The fallback results above are **not** evidence of model quality.
- The real Messages API surface (`claude-haiku-5-5`, `output_config.format` restricted schema, `effort`). It was checked against docs and stub tests only (RISK-7).
- The AC16 live-mode notice rendered in a browser (live mode needs a key).
- A tool-measured contrast ratio (AC15).
- A browser network-request log for AC6.

## 5. Performance and latency (measured)

| Measurement | Value | How it was measured |
|---|---|---|
| Fallback analyse p95 / max | 1.126 ms / 8.724 ms | 200 sequential in-process `service.analyse` calls (AC13 test, ev:ev-muyqzriz-012b8b53) |
| UI Ctrl+Enter → result rendered | 47 ms (360 px), 15 ms (1280 px) | Playwright wall clock, local loopback server in fallback mode (ev:ev-muyr13oz-01d57136); one sample each |
| Page load + health | 252 ms / 245 ms | Same run; includes the first navigation |
| Redactor adversarial inputs (median) | phone_digits_dots 37.8 ms, digits_only 35.8 ms, digit_nbsp 4.2 ms, card_worst 0.58 ms | design-vectors.js (ev:ev-muyr019l-01bbd9f9) |
| Full test suite | 7.9 s | ev:ev-muyqzriz-012b8b53 |
| Cost | $0 | No live calls (`eccode status` budget costUsd 0) |

The adversarial phone redaction (about 38 ms median) costs more than the whole fallback analysis. It is within the design bound, but it is the hot spot to watch on maximum-length inputs.

## 6. Browser verification (headless Chromium, ev:ev-muyr13oz-01d57136)

- Script: `.eccode/drafts/t17-browser-check.js`.
  - Starts `node src/server.js` with PORT=0 on 127.0.0.1, with no key, and reads the `listening` JSON line.
  - Runs the same checks at 360 px and 1280 px.
  - Stops the server with SIGTERM (exit code 0).
- 18/18 checks pass:
  - mode badge;
  - textarea reached with 1 Tab;
  - Ctrl+Enter submit;
  - fallback label;
  - aria-live announcement;
  - AC6 edit/copy/reset;
  - no horizontal scroll (scrollWidth = clientWidth = 360 and 1280);
  - XSS payload kept as text, with no element created and no dialog.
- Screenshots:
  - `.eccode/artifacts/verification/ui-360.png`, `ui-360-xss.png`;
  - `ui-1280.png`, `ui-1280-xss.png`.

## 7. Known limitations

1. **The fallback misses the holdout high-urgency floor** (4/7, RISK-12) and catches only 4/9 held-out-family injection attempts. The fallback is a safety net, not a classifier of record. The UI labels it "not AI-generated", which mitigates automation bias (RISK-2) but does not fix accuracy.
2. The live path is untested against the real API (RISK-7). The model id, the structured-output schema restrictions and the effort parameter are checked against docs only.
3. There is no authentication. The server is safe on loopback only (RISK-5); remote binding needs `TRIAGE_ALLOW_REMOTE`, and the README warns about it.
4. Redaction covers email, phone and card numbers only. Names, addresses and account ids reach Anthropic in live mode (RISK-9), and the notice says so.
5. `npm start` under dash does not exec node, so SIGTERM to npm can orphan the server (RISK-11). Run `node src/server.js` directly under a supervisor.
6. The eval sample sizes are small: holdout high n=7, held-out attacks n=9. The 95% upper bound on injection leak with 0/27 is about 11%.

## 8. Open risks (from `eccode status --json`)

| Risk | Sev | Status after verification |
|---|---|---|
| RISK-1 prompt injection; residual fallback steering | high | Partly mitigated: leak 0/27, steer 2/23, in-family flag recall 1.0. **Held-out flag recall 0.444**. Residual risk is open; accept with an owner (ai-engineer) |
| RISK-2 automation bias | high | Mitigated in the UI: label and warning verified in the browser. Process risk remains (agents must read drafts) |
| RISK-3 live model slow/refuses/truncates/invalid | medium | Mitigated in code by stub tests (AC4, AC13). Live behaviour NOT RUN |
| RISK-4 eval not meaningful / overfit | medium | Freeze verified. **Overfitting observed** (tune 1.000 → holdout 0.571 on high recall). Open, escalated |
| RISK-5 key leak / DNS rebinding | high | Mitigated: AC10 and AC17 verified; loopback default. No auth is accepted only for loopback |
| RISK-6 PII in logs / third party | medium | Mitigated: AC10, AC16, notice text inspected |
| RISK-7 API surface checked against docs only | medium | **Open**: live NOT RUN, no key |
| RISK-8 XSS | medium | Mitigated: AC11 tests plus the real-browser payload check |
| RISK-9 redaction misses | medium | Partly mitigated (AC16, design vectors). Unredacted classes are disclosed in the notice. Open |
| RISK-10 validator cost on long model output | low | Mitigated: over-long summary/reply rejected as invalid_output at the provider call site before V2 runs (300k chars rejected in <500 ms) |
| RISK-11 `npm start` orphaning under dash | medium | Open; documented workaround |
| RISK-12 full-mode eval misses the holdout high_urgency_recall floor (0.571, n=7, ≥ 0.70) | medium | **Open. User decision pending**: accept as a known fallback limitation, or reset t11-rules and re-run as full-mode run #2 (ev:ev-muyqzv9i-018cf19d) |
