# Request for an outside security review of ECCode

**What is being asked.** An independent human review of the ECCode engine's security claims. The toolkit's own threat model ([threat-model.md](threat-model.md)) and three agent-run reviews exist (an independent 22-finding review, a fresh-context red team, and the independent review bundle of 2026-10-09 whose nine findings are closed in 0.3.0, all with regression tests), but no person outside the project has reviewed it. This page is the handover so a reviewer can start without a briefing.

## Scope
- **In:** `lib/` (engine), `bin/eccode.js` (CLI), `scripts/hooks/guard.js` and `session-start.js` (Claude Code hooks), `schemas/`, the memory and self-improvement subsystems under `lib/memory/`. About 6,500 lines of dependency-free Node.js (0.3.0 adds `lib/authority.js`, the delegation channel, and the attestation index in `lib/memory/records.js`).
- **Out:** the example applications (`examples/`), the evaluation harness (`eval/`), the prompts (`agents/`, `skills/`) except where a prompt is the only control for a claim (the threat model marks those "prompt").

## The claims to attack (from the threat model, §3)
1. An agent cannot approve its own work, approve without evidence, approve stale bytes, or complete a task outside its ownership (R1–R5, R18).
2. The record (`.eccode/events.jsonl`, `state.json`, evidence, reviews) cannot be rewritten, rolled back or made to crash the audit without detection (R6, R20).
3. Approved files cannot change without a reviewed rework (R7, R17).
4. Secrets do not reach the record or shared memory (R9, R24).
5. Self-improvement cannot change permissions, hooks or the engine (R11, R23).
6. Identity binding through the PreToolUse guard: what a subagent can and cannot do with shell commands (R4, R22) — and its stated limits (§4 residual 1).
7. The human channel: `--actor user` only at a terminal, delegations bound to grantee, action, target, uses and expiry, spent before the action (R14, R26); and the release tree and risk policy (R30, R31).
8. The digests: `stateHash` in the chain, the shared-memory attestation index, the evidence-log and tree digests (R29, R32, R33), with the stated residual that they live in writable files (§4 residual 3).

## How to work
- `npm run check` runs the suite (233 tests) and replays every shipped record. The regression tests for prior findings are `tests/security-regressions.test.js` (#1–#22), `tests/redteam-regressions.test.js` (RT1–RT9) and `tests/review-F*.test.js` (the bundle's F1–F9); each names the weakness it closed. The bundle's probe scripts (`docs/evidence/review-bundle/probes/`) show the reviewer's method.
- The test helpers (`tests/helpers.js`) build a throwaway project in a few lines; the red team's method was to write one script per hypothesis with them and keep only the ones that reproduce. The same route is open to you.
- The guard can be driven directly: feed it a PreToolUse JSON payload on stdin (`tests/hooks-install.test.js` shows the shape) and read its decision.
- Known residuals, so you do not spend time rediscovering them: threat model §4 (identity is asserted; a snapshot rolled back with the log; git-ignored files invisible to accounting; pattern-based redaction).

## What to send back
Findings as reproduction scripts or exact steps, with the engine file and line, and a severity. Anything that reproduces becomes a numbered regression test and a threat-model row; the fix is reviewed by someone other than its author, through the toolkit's own gates where the toolkit is the project.

## Contact and status
Owner: the repository maintainer. Status: **not yet reviewed by an outside person**; this page is the request, not evidence that it happened.
