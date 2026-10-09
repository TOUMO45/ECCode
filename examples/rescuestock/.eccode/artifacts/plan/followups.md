# Plan follow-ups (delivery-lead)

The approved `plan.json` (plan revision 2, submission `sub-mv1fa538-015d094f`) cannot change without a plan rework. Obligations found after its approval are recorded here as **additional acceptance criteria** for the named tasks.
- **Orchestrator:** passes the matching item to the implementer at dispatch.
- **Implementer:** answers it in the handoff, with the test name or the reason.
- **Phase reviewer:** checks it with the task's other criteria.

Each item names its source finding.

| # | Task | Additional acceptance criterion | Source |
|---|---|---|---|
| FU-1 | c2-requests-plans-view | `POST /api/requests/:id/plan` never lets a planner `PlannerLimitError` (code `PLANNER_LIMIT`) surface as an untyped 500. Map it to a catalogued error, either 422 `VALIDATION_FAILED` with `details.fields` naming the offending input, or a new named 503 code. A new code needs the orchestrator's agreement, because the error catalog is part of the approved design. Prove it with a test named `PB-3: …` that forces the limit with an absurd catalog. | rev-mv1hc5zg-01a3fc75 PB-3; b2 handoff ho-mv1gcn88-01fd3ee4 |
| FU-2 | d3-extraction-service | The upload route (`POST /api/requests/:id/image`) enforces the spec's 60 s upload deadline while streaming. Use `UPLOAD_REQUEST_TIMEOUT_MS` exported by `src/http/server.js`, or change the server's 30 s `requestTimeout` deliberately and say so. Prove it with a test named `PB-3: …` that uses a slow body and a shortened deadline, and asserts no file is left in `data/uploads/` or `.tmp/`. | PB-3; b1 handoff ho-mv1gazew-01706543 / ho-mv1hk3zz-01649535 |
| FU-3 | c5-frontend-dashboards, then g1-frontend-a11y-labels | Decide with the orchestrator whether offers the planner skips for capacity or cup-diameter mismatch appear under "What was rejected" (RS-35). The planner records them only in the trace as `SPEC_MISMATCH`, which is not in the Rejection code enum.<br>- **Default if no decision is recorded:** they are not shown as rejections. The trace view lists them as "Not a match for your cups (capacity or size)", rendered by template from the trace.<br>- **c5** records the decision in its handoff.<br>- **g1** verifies it in the six-answer page. | PB-3 |
| FU-4 (optional) | b2-domain, via a rework only if the orchestrator wants it; otherwise c6 | A test named `PB-3: seed constant equals test/fixtures/rs-fix-1.json` compares `scripts/seed.js`'s RS-FIX-1 constant with the fixture file. Both are checked only against the brief today. c6 may add it to its own files instead of reopening b2. | PB-3 |
| FU-5 | every later multi-process test task (c6, e6, f4) | Any test that starts several processes on a fresh database keeps the PB-1 regression in mind. If `database is locked` appears at open, it is a regression of `src/db/connection.js`, not test flakiness, and is reported as a finding. | PB-1 (rev-mv1hc5zg-01a3fc75); b1 rework ho-mv1hk3zz-01649535 |
| FU-6 | c1-auth-rbac | `src/auth/password.js` verifies the seed's hash format `scrypt$16384$8$1$<salt b64url>$<64-byte key b64url>`, and the dummy hash for unknown users uses the same parameters. Prove it with a test that signs in a seeded account. | b1 handoff (cross-task note 3 of the phase-B submission) |
| FU-7 | c2-requests-plans-view | The view service builds `deriveRescueStatus` input in the shape documented in the header of `src/domain/derive.js`: snake_case persisted rows, camelCase limits. | b2 handoff (cross-task note 7) |
