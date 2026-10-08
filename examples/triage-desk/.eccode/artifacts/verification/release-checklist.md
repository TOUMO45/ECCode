# TriageDesk release checklist (draft, t17)

Status key: [x] verified (evidence cited) · [ ] open / needs a decision · [~] partly verified

## Blocking decision
- [x] **Resolved by user decision.** The full-mode eval failed 1 of 25 checks (RISK-12): holdout high_urgency_recall is 0.571 (n=7) against a floor of 0.70 (ev:ev-muyqzv9i-018cf19d). The user chose option (a):
  - (a) accept it as a known fallback limitation, with a recorded decision — **chosen** (dec-muz4ocip-016d36bd);
  - ~~(b) reset t11-rules under a recorded decision~~ — not taken.

## User decision on RISK-12 (2026-10-08)
- [x] dec-muz4ocip-016d36bd (by user), "RISK-12 accepted; SC2 amended for this release": "Accept the fallback holdout high-urgency recall miss (0.571, n=7, floor 0.70) as a known limitation; amend SC2/AC8 for this release". RISK-12 status: `accepted`.
- [x] The SC2/AC8 holdout floor is amended **for this release only**.
- [x] Results are unchanged: `ECCODE_EVAL {"passed":24,"total":25}`, holdout high_urgency_recall 0.571 (n=7). Nothing was re-run or re-tuned; full-mode run count is still 1.
- [ ] Live-model evals remain **NOT RUN** (RISK-7).
- [x] dec-muz4ocl7-01aaa32d (by user), "Confirm orchestrator defaults Q1/Q4/Q7": Q1 default model claude-haiku-5-5 (env-overridable), Q4 redaction of emails, Luhn-valid cards and phones before live calls, and Q7 zero runtime npm dependencies are confirmed.

## Install from docs
- [x] Node ≥ 22. There are no dependencies and no `npm install` is needed (README §Install).
- [x] `npm test` passes offline: 439/439 (ev:ev-muyqzriz-012b8b53).
- [x] `node src/server.js` starts, logs `listening` and serves the UI. It was driven in headless Chromium at 360 and 1280 px (ev:ev-muyr13oz-01d57136).
- [x] README commands checked by t16 (readme-check hash pinned and re-verified in ev:ev-muyqzh7j-01b4d13c).

## Configuration and secrets
- [x] `.env.example` documents these settings:
  - `ANTHROPIC_API_KEY` (optional);
  - `ANTHROPIC_MODEL` (default `claude-haiku-5-5`);
  - `HOST` (default 127.0.0.1);
  - `PORT` (3000);
  - `TRIAGE_TIMEOUT_MS` (20000);
  - `TRIAGE_MAX_TOKENS` (2048);
  - `TRIAGE_ALLOW_REMOTE` (commented out).
- [x] The key is read from the environment only. It never appears in responses or logs (AC10, ev:ev-muyqzriz-012b8b53).
- [ ] Live mode has not been exercised with a real key (RISK-7). Run `npm run eval -- --provider live` once a key is available and record its USAGE line for cost.

## Rollback
- [x] Fallback-only mode: unset `ANTHROPIC_API_KEY` and restart. Nothing is transmitted.
- [x] Code rollback: `git revert` (or check out the previous commit) and restart. There is no state and no migration.

## Monitoring
- [x] Logs are metadata-only JSON lines (`listening`, `warning`, per-request length/source/fallbackReason/latency/status/redaction counts). No ticket text is logged (AC10).
- [x] `GET /api/health` reports `{status, mode, model}` (AC14).
- [ ] The live eval USAGE line (token cost) is NOT RUN.
- [ ] Watch the fallbackReason rates (`timeout`, `model_error`, `invalid_output`, `truncated`) after the live launch. If `truncated` appears, raise `TRIAGE_MAX_TOKENS`.

## Evaluation
- [x] The full-mode `ECCODE_EVAL {"passed":24,"total":25}` is recorded. **Full-mode run count = 1.**
- [x] Freeze integrity: the sha256 values of dataset, holdout and thresholds equal the t02 evidence (ev-muyoc9sb, ev-muyoc9ul, ev-muyoc9wk). The freeze (22:23:33Z) predates the first rules commit (8f93a16, 23:18:59Z).
- [x] Held-out hygiene passes (ev:ev-muyqzlcx-01d7f182). The pinned check-script hashes match (ev:ev-muyqzh7j-01b4d13c).
- [ ] Live thresholds are unverified (NOT RUN). Fallback results are not evidence of model quality.

## Inspection items
- [x] AC6 edit/copy/reset was checked in a real browser (ev:ev-muyr13oz-01d57136).
- [~] AC15:
  - keyboard-only flow (1 Tab + type + Ctrl+Enter), labels, aria-live and text (not colour-only) labels are verified;
  - **contrast ≥ 4.5:1 is not tool-measured**.
- [~] AC16: the notice text matches NFR4 by inspection; it was not rendered (it needs live mode).
- [x] 360 px reflow: no horizontal scroll. Screenshots: `ui-360.png`, `ui-1280.png`, `ui-360-xss.png`, `ui-1280-xss.png`.

## Open risks (each needs an owner's accept/mitigate sign-off)
- [ ] RISK-1 (high) injection: held-out flag recall 0.444, steer 2/23. Residual risk; owner ai-engineer.
- [~] RISK-2 (high) automation bias: the UI label and warning are verified; the process risk remains.
- [~] RISK-3 (medium) live failures: stub-tested only.
- [ ] RISK-4 (medium) overfitting observed (tune 1.000 vs holdout 0.571 high recall). Escalated.
- [x] RISK-5 (high) key leak / DNS rebinding: Host/Origin guard verified (AC17). **Loopback only; no auth.**
- [x] RISK-6 (medium) PII: logs are metadata-only; redaction is verified on stubs and disclosed in the notice.
- [ ] RISK-7 (medium) API surface checked against docs only. Needs a live run.
- [x] RISK-8 (medium) XSS: unit tests plus the real-browser payload check.
- [~] RISK-9 (medium) redaction misses: names, addresses and account ids are not redacted (disclosed).
- [x] RISK-10 (low) validator cost on long model output: mitigated by the length gate at the provider call site.
- [ ] RISK-11 (medium) `npm start` under dash can orphan the server. Run `node src/server.js` under a supervisor.
- [x] RISK-12 (medium, owner ai-engineer) full-mode eval misses the holdout high_urgency_recall floor (0.571, n=7, floor 0.70; ev:ev-muyqzv9i-018cf19d). **Accepted by user** (dec-muz4ocip-016d36bd); SC2/AC8 floor amended for this release only (see User decision on RISK-12).
