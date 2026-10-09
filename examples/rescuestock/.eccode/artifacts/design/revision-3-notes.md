# Design revision 3: finding → section map

Responds to review `rev-mv1dqjhw-015d8dfe` (submission `sub-mv1dcqpr-016ee2c9`). This is a narrow revision. Sections refer to `.eccode/artifacts/design/spec.md` (final sha256 `ef35826fe647eaf105892debf7844e84b0d3bf04e5d6caa30f07767a0a316521`). The disposition table is the spec's "Findings disposition (revision 3)" section. Revision 2's map stays in `revision-2-notes.md`.

| Finding | Resolved in |
|---|---|
| F-TR-14 (blocking) | Interface Contracts › Fake approval listener: "Listener CSP" (one header, `approvalPageCsp(appOrigin)` = `default-src 'none'; style-src 'self'; form-action 'self' <appOrigin>; frame-ancestors 'none'; base-uri 'none'`; app CSP not inherited; the paypal-stub approval page uses the same value). Security › Security headers (exception). Testing Strategy › helpers (`paypal-stub.js`), Integration › `fake-approval-headers` ([D], pinned header), E2E › approval round-trip assertion ([B]). Criterion Traceability RS-31, RS-32, NFR2. |
| F-TR-15 (minor) | Testing Strategy › E2E › fresh database per file, fresh customer per journey, harness limits. Deployment › README › operator note for demo runs and retakes. Admin routes › Reset (clears `request_create` rate events). |
| F-TR-16 (info) | Open Questions › "Decisions requested" table: OQ-D6 and OQ-D7, both "decision requested" for the orchestrator to record. AI › Runtime controls › per-customer share: default 0.2, NFR6 test pins 1, separate per-customer case. Deployment env table and README. Findings disposition (revision 2) › SEC-10 row (revision 3 note). |

## Evidence (technical-designer, design gate)
| Evidence | What it shows |
|---|---|
| ev:ev-mv1dsh6c-019c5a8d | F-TR-14 fix in Playwright's Chromium 141. The fake listener page and the paypal-stub page, with the revised single CSP, send approve to `/api/paypal/return` and cancel to `/api/paypal/cancel`, both with the SameSite=Lax cookie. With the app CSP inherited as a second header, the submission is refused (negative control). |
| ev:ev-mv1dvind-01a94f78 | The same probe, reading both CSP strings from the **final** spec text (sha256 `ef35826f…`, printed in the log): passes. |
| ev:ev-mv1dv52l-01a0db95 | The same spec-bound probe on the penultimate text, which differs only in one sentence of the disposition table: passes. |
| ev:ev-mv1dvisb-014427ac | Technical reviewer's traceability check on the final spec: 45 ids, 0 problems, 0 tag warnings. |
| ev:ev-mv1dvixu-01944161 | Security reviewer's structural spec walk on the final spec: passes. |

Probe script: `.eccode/drafts/design-r3-formaction.mjs` (usage: `node design-r3-formaction.mjs <spec.md>`).
