# Security review: phase D submission (phase:d-extraction), version 1 (IN PROGRESS, interim)

Reviewer: security-reviewer. Run: run-mv330tea-0177469c. Gate: `phase:d-extraction`, submission `sub-mv32yhz0-0170ea86` (recording reviewer: technical-reviewer; this draft is input to that review, I record no gate decision).

**Status: interim.** Sections P, S, E, U, X and F of my probe are done and recorded. Still running: the CLI and Anthropic adapters against my own stubs, the slow-provider/30 s check, Chromium on the polyglot image and on hostile extraction wording, the live runner refusals and the RBAC/contract suites. The verdict below is provisional; wait for the version marked FINAL.

**Provisional verdict: no blocking finding so far.** One minor (SEC-D-1, numeric grounding gap) and info items. FU-23 reproduced; exposure is admin-timeline attribution only, not cross-customer disclosure; I do not ask for it to block this gate.

## Evidence so far

| ev id | what | result |
|---|---|---|
| ev:ev-mv338izg-017aea51 | `npm test` on the submitted tree | passed: 1208 pass, 0 fail, 8 skipped, 0 todo; NFR5 p95 56.4 ms |
| ev:ev-mv33e5qp-017ba56b | `sec-phd-probe.mjs` sections P S E U X F | passed: 114 PASS, 0 FAIL (REPRO lines reproduce SEC-D-1 and FU-23) |

## Findings so far

- **SEC-D-1 (minor): a quote without digits grounds any number.** `normaliseExtraction` (`src/services/extraction.js`) accepts a numeric value when `numbersIn(quote)` is empty (`written.size === 0 || written.has(value)`), and `extractRequest` calls `validateExtraction(answer.output)` without `context.text`, so d1's own `NUMBER_NOT_IN_INPUT` check never runs in production. Reproduced: cupQuantity 99999 quoted as "need cups", lidQuantity 777 as "lids for the weekend", maxPickups 5 as "at most two pickups" are all stored `known`, provenance `user_text`; d1's validator with the text refuses all three. Resolution: require `numbersIn(quote).has(value) || wordNumbersIn(quote).has(value)` for numeric user_text fields (or call `validateExtraction(output, {text})` per field), plus a test.
- **FU-23 (reproduced):** Y's first request and plan version get X's deleted ids; Y sees nothing of X; X gets 404; the admin timeline of Y's request lists X's audit events. Not a disclosure to customers. The orchestrator's migration rework before e4 is adequate.
- Info: an obeying model that quotes the injected sentence itself passes grounding (budget $99,999 from ti01-en); image-provenance numbers cannot be checked server-side; five self-registered accounts from one IP spend the whole daily budget (SEC-10 residual); extract has no per-request idempotency.
