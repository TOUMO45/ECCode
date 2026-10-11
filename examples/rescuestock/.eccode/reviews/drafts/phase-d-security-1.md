# Security review: phase D submission (phase:d-extraction), version 1 (IN PROGRESS)

Reviewer: security-reviewer. Run: run-mv330tea-0177469c. Gate: `phase:d-extraction`, submission `sub-mv32yhz0-0170ea86` (recording reviewer: technical-reviewer; this draft is input to that review, I record no gate decision).

**Status: in progress.** This version lists scope and planned checks only. No verdict yet. The technical reviewer should wait for the version marked FINAL.

## Scope

Inputs: `.eccode/artifacts/phase-d/submission.md`, `.eccode/artifacts/phase-d/handoff.json`, the nine handoffs it lists, the spec's security, AI design, extraction contract and observability sections, decisions dec-mv330std-0165d9be (FU-23), dec-mv330t0g-0175d52b (FU-24), dec-mv330t7a-017a2211 (FU-25), dec-mv31kbrz-012381a1 (FU-2), dec-mv32c290-0182b807 (degraded form).

## Planned checks (each recorded with `--actor security-reviewer --gate phase:d-extraction`)

1. Prompt injection and model-output trust: `src/ai/prompt.js` isolation, `src/ai/schema.js` strictness, `addressedToAssistant` only flags, model output cannot set provenance/ids/prices/supplier fields, grounding in `src/services/extraction.js`. EXT-1 fixtures plus my own adversarial inputs (AR/EN instructions, JSON-shaped text, marker forgery, oversize fields, unicode tricks).
2. Image upload and GET (d3): magic bytes vs declared MIME, size cap, names and 0600, traversal through ids, GET headers, access control per role, deletion tombstones, retention.
3. Gate (`src/ai/gate.js`): per-customer share, micro-dollar budgets, idempotency, degraded path per ProviderError, no leak of provider bodies or keys, FU-2 timeouts and reservations; coverage of d5's secrets scan.
4. CLI adapter (`src/ai/cli.js`) argv, env inheritance, limits, kill on timeout; Anthropic adapter key handling, host pinning, size limits.
5. Live runner refusals and ceiling (FU-21).
6. Access-control regressions: RBAC and contract suites; new routes × roles; CSRF on upload/extract; extract rate limits.
7. FU-23 id reuse after hard delete: reproduction and exposure.

## Evidence

(to be filled)

## Findings

(to be filled)
