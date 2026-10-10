# Security review: phase C submission (phase:c-core-flow), version 1 (in progress)

Reviewer: security-reviewer. Run: run-mv2y8zz9-014fd931. Gate: `phase:c-core-flow`, submission `sub-mv2y7tlh-017e22c9` (recording reviewer: technical-reviewer).
Inputs: the submission's 139 artifacts, `.eccode/artifacts/phase-c/submission.md`, the design security draft `design-security-1.md` (SEC-1..20) and the phase B draft `phase-b-security-1.md` (SEC-B-1..9).

## Verdict

IN PROGRESS. First pass by code reading only: sessions, CSRF, throttle, RBAC hook, auth routes, request/plan/supplier/admin routes and reservations. No blocking issue found so far. Probes pending.

## Evidence

| ev id | what | result |
|---|---|---|
| (pending) | `npm test` phase C suite | running |

Memory: searches for "csrf", "session", "idor" and "throttle" returned no records; nothing assessed or relied on.

## Findings

(pending probes)

## Checked and held (code reading, to be confirmed by probes)

- Session ids: 256-bit random, sha256 at rest, pattern-checked before lookup; idle 60 min and absolute 12 h enforced in `resolve` (src/auth/sessions.js 45-56); disabled users' sessions removed.
- Rotation: signin and register destroy the incoming session and create a new one (src/routes/auth.js 50-54, 84, 117). A planted cookie value is never adopted (ids are server-generated).
- CSRF: Origin check before identification on state-changing routes; session token compared with timingSafeEqual; pre-login token HMAC with 2 h TTL.
- SEC-1: hard refusal keyed on (username_key, IP) and per IP; cross-IP pressure only delays (src/auth/throttle.js 42-63).
- SEC-4 / F-TR-1: fingerprint includes the concrete path; the reservation fallback compares plan_version_id.

## Not checked

(pending)
