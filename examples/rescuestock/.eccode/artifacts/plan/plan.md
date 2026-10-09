# RescueStock — Delivery Plan

Author: delivery-lead. Gate: plan. Date: 2026-10-09.
Sources: the approved brief `.eccode/artifacts/architecture/brief.md` (45 required criteria RS-01..RS-39, NFR1..NFR6) and the approved design `.eccode/artifacts/design/spec.md` (revision 3, submission `sub-mv1dvx7j-016948c6`, review `rev-mv1e1ohb-01183fe4`), with `revision-2-notes.md` and `revision-3-notes.md`. Machine-readable plan: `plan.json` (6 phases, 29 tasks; `eccode plan validate` clean, ev:ev-mv1eoibn-01748662).

## Phases and the criteria each proves

Every brief criterion is claimed by exactly one phase (checked by `.eccode/drafts/plan-coverage-check.mjs`, ev:ev-mv1eoihx-0130f7c1). A phase claims a criterion when its own tests prove it in full. Partial tests written earlier carry the same id in their names, and the verification gate re-proves all 45 on the final tree.

| Phase (gate) | Goal in one line | Criteria proved | Reviewers |
|---|---|---|---|
| `b-foundation` (B) | Skeleton, migrations 001–005, Node gate, config, seed RS-FIX-1, pure domain with planner + oracle and derivation, offline harness | RS-06, RS-07, RS-08, RS-09, RS-10, RS-11, NFR1, NFR4 | technical |
| `c-core-flow` (C) | Auth/CSRF/throttles/RBAC, requests, plans, approval, reservations, supplier confirmations and inventory, expiry pass, admin shells, three dashboards | RS-12, RS-14, RS-16, RS-28, RS-30, RS-33, RS-36 | technical + security (auth, input handling) |
| `d-extraction` (D) | Extraction with provenance (fake, CLI and API adapters), degraded path, model budget/rate, uploads, deletion, retention | RS-01, RS-02, RS-03, RS-05, RS-39, NFR6 ([D]/[B] parts) | technical + security (AI, uploads) |
| `e-payments` (E) | PayPal adapters, call protocol, create/return/cancel/abandon, void rule, execute claim and captures, reconciler, webhooks, payment UI | RS-04, RS-18, RS-19, RS-20, RS-21, RS-23, RS-24, RS-25, RS-27, RS-31(a) ([D]/[B] parts) | technical + security (money, auth) |
| `f-compensation` (F) | Supersession and re-plan queue, refusal, expiry voids, compensation with refunds, lease takeover, restart recovery, admin refund/forced reset | RS-13, RS-15, RS-17, RS-22, RS-26, RS-32(a), RS-37, RS-38 | technical + security (money) |
| `g-release` (G) | Accessibility, labels on both adapters, six answers, full secrets scan, live-suite refusal, performance, README/runbooks/submission drafts, evidence table, clean checkout | RS-29, RS-34, RS-35, NFR2, NFR3, NFR5 | technical + security (secrets, labels) |

## Phasing rationale

The orchestrator's working split (B data model + planner; C auth, dashboards, reservations, confirmations, expiry; D extraction; E PayPal saga, webhooks, recovery; F replanning, compensation, restart recovery; G final verification) is kept. Phase gates run strictly in order, so parallelism exists only inside a phase. Three adjustments follow from the design's dependencies:

1. **Foundation and domain share phase B.** W0 (foundation) and W1 (domain) have no dependency on each other. Running them as two parallel tasks in one phase uses both concurrency slots from the start. Auth moves to C as the orchestrator proposed. The design lists auth under W0, but nothing in B needs a session.
2. **The expiry criterion RS-15 moves from C to F.** RS-15 requires that expiry voids every provider authorization and that an expiry pass after the execute claim changes nothing. Neither exists before the payment flow (E) and the claim. So C builds the expiry pass and the void-rule steps for operations without an authorization; F proves RS-15 in full. RS-04 moves to E for the same reason: half of it is `POST /api/orders/:id/paypal/create`.
3. **Some criteria land where their whole proof first exists.** RS-34 (labels on both adapters, [D]+[B]), NFR3 (both live runners) and NFR5 (p95 over the whole API suite and the suite time) go to G. RS-36 goes to C, because its endpoint half needs the request view. RS-38 goes to F, because consume and restock rows exist only after the claim and compensation.

Within E, the void rule, the authorization paths (RS-21) and the lost-response recovery (RS-25) stay with the payment flow. Compensation after a capture, lease takeover and restart (RS-22, RS-26) go to F. This follows the saga's own split between steps 1–4 and steps 5–6.

## Task overview (owner, ownership, verification)

Every task has `verification.cwd = "."`, which is the project root `examples/rescuestock` as the engine binds it. All globs are relative to that root, and none names `.eccode/`, `.claude/` or hooks. Tasks that may run in parallel within a phase have disjoint globs. Shared wiring files (`src/app.js`, `src/main.js`, `src/routes/plans.js`, `package.json`) belong to tasks that are serialized by dependencies inside their phase. `plan validate` reports no ownership warnings. NG below stands for `node --disable-warning=ExperimentalWarning --import ./test/helpers/net-guard.js --test`.

| Task | Owner | Ownership (summary) | Verification command |
|---|---|---|---|
| b1-foundation-core | backend | package.json, .gitignore, scripts/check-node.cjs, scripts/seed.js, src/{index,main,app,config,log,clock}.js, src/db/**, src/http/**, src/routes/**, test/unit/{config,db,http,seed}/** | `node --disable-warning=ExperimentalWarning --test "test/unit/config/**/*.test.js" "test/unit/db/**/*.test.js" "test/unit/http/**/*.test.js" "test/unit/seed/**/*.test.js"` |
| b2-domain | backend | src/domain/**, test/unit/domain/**, test/timing/**, test/fixtures/rs-fix-1.json | `node --disable-warning=ExperimentalWarning --test "test/unit/domain/**/*.test.js" "test/timing/**/*.test.js"` |
| b4-env-readme | devops | .env.example, README.md, LICENSE, test/scan/env-example.test.js | `node --test test/scan/env-example.test.js` |
| b3-test-harness | test | test/helpers/**, test/unit/helpers/**, start-health and start-old-node tests, test/scan/package.test.js, test/api/health-config.test.js, scripts/{report-p95.js,reset-test-out.js,clean-checkout.sh} | `npm test && sh scripts/clean-checkout.sh` |
| c1-auth-rbac | backend | src/auth/**, src/routes/auth.js, src/services/{users,audit}.js, src/main.js, src/app.js, test/api/auth.test.js, test/unit/auth/** | NG `test/api/auth.test.js "test/unit/auth/**/*.test.js"` |
| c2-requests-plans-view | backend | src/services/{requests,plans,view}.js, src/routes/{requests,plans}.js, src/app.js, 4 API tests | NG `test/api/approve-guards.test.js test/api/requests-plans.test.js test/api/rescue-status.test.js test/api/schema-no-rescue-status.test.js` |
| c3-reservations-supplier-admin | backend | src/services/{reservations,ledger,orders,supersession,void-rule,admin}.js, src/routes/{plans,supplier,admin}.js, src/app.js, 6 API tests | NG `test/api/reserve-idempotency.test.js test/api/abuse-limits.test.js test/api/isolation.test.js test/api/supplier-orders.test.js test/api/reservation-expiry.test.js test/api/admin-basic.test.js` |
| c5-frontend-dashboards | frontend | public/**, test/fixtures/contracts/**, test/unit/frontend/**, test/scan/frontend.test.js | `node --test test/scan/frontend.test.js "test/unit/frontend/**/*.test.js"` |
| c6-reserve-concurrency-browser | test | test/helpers/**, rs14 integration tests, test/api/contracts.test.js, test/browser/** | `npm test && npm run test:browser` |
| d1-ai-core | ai | src/ai/{provider,schema,prompt,fake,gate,rephrase}.js + their unit tests | NG `test/unit/ai/schema.test.js test/unit/ai/prompt.test.js test/unit/ai/fake.test.js test/unit/ai/gate.test.js test/unit/ai/rephrase.test.js` |
| d2-ai-adapters-corpus | ai | src/ai/{cli,anthropic}.js, their tests, live-runner refusal test, test/fixtures/extraction/**, scripts/make-corpus-images.js, test/eval/**, test/live/run-live-model.js, package.json | NG `test/unit/ai/cli.test.js test/unit/ai/anthropic.test.js test/unit/ai/live-runner-refusal.test.js test/eval/extraction-fake.test.js` |
| d3-extraction-service | backend | src/services/{extraction,retention,requests,view}.js, src/routes/requests.js, src/{main,app,config}.js, 7 API tests | NG `test/api/extract.test.js test/api/extract-image.test.js test/api/extract-degraded.test.js test/api/injection.test.js test/api/confirm-provenance.test.js test/api/uploads-retention.test.js test/api/model-budget-rate.test.js` |
| d4-frontend-extraction | frontend | public/**, test/fixtures/contracts/**, test/unit/frontend/**, test/scan/frontend.test.js | `node --test test/scan/frontend.test.js "test/unit/frontend/**/*.test.js"` |
| d5-extraction-contract-browser | test | test/helpers/**, test/unit/ai/provider-contract.test.js, test/scan/secrets.test.js, test/api/contracts.test.js, test/browser/** | `npm test && npm run test:browser` |
| e0-paypal-stub-contract | test | test/helpers/{paypal-stub,webhook-signer}.js, test/unit/payments/provider-contract.js, test/unit/payments/paypal-stub.test.js | NG `test/unit/payments/paypal-stub.test.js` |
| e1-payment-adapters | backend | src/payments/**, src/config.js, test/unit/payments/{fake,sandbox,merchants,provider-contract}.test.js, test/api/fake-approval-headers.test.js | NG `"test/unit/payments/**/*.test.js" test/api/fake-approval-headers.test.js` |
| e2-payment-flow | backend | src/services/{calls,payments,void-rule,orders,view}.js, src/routes/{paypal,orders,plans}.js, src/app.js, 7 API tests | NG `test/api/approve-guards.test.js test/api/paypal-create.test.js test/api/paypal-cancel.test.js test/api/amount-tampering.test.js test/api/paypal-return-idempotent.test.js test/api/authorization-denied.test.js test/api/isolation.test.js` |
| e3-webhooks | backend | src/services/webhooks.js, src/routes/webhooks.js, test/api/webhooks.test.js | NG `test/api/webhooks.test.js` |
| e4-saga-reconciler | backend | src/services/{saga,reconciler}.js, src/routes/plans.js, src/{main,app}.js, 5 API tests | NG `test/api/execute.test.js test/api/lost-response.test.js test/api/authorization-pending.test.js test/api/void-rule-lost-authorize.test.js test/api/reconciler.test.js` |
| e5-frontend-payments | frontend | public/**, test/fixtures/contracts/**, test/unit/frontend/**, test/scan/frontend.test.js | `node --test test/scan/frontend.test.js "test/unit/frontend/**/*.test.js"` |
| e6-execute-concurrency-browser | test | test/helpers/**, rs20 integration test, test/api/contracts.test.js, test/browser/**, test/live/paypal/**, package.json | `npm test && npm run test:browser` |
| f1-supersession-refusal-expiry | backend | src/services/{supersession,orders,reservations,plans}.js, src/routes/supplier.js, 4 API tests | NG `test/api/supersession.test.js test/api/supplier-refusal.test.js test/api/reservation-expiry.test.js test/api/replan-queue.test.js` |
| f2-compensation-takeover-admin | backend | src/services/{saga,reconciler,calls,void-rule,admin}.js, src/routes/admin.js, 5 API tests | NG `test/api/capture-compensation.test.js test/api/void-capture-race.test.js test/api/admin-reset.test.js test/api/admin-refund-order.test.js test/api/ledgers.test.js` |
| f3-frontend-recovery | frontend | public/**, test/fixtures/contracts/**, test/unit/frontend/**, test/scan/frontend.test.js | `node --test test/scan/frontend.test.js "test/unit/frontend/**/*.test.js"` |
| f4-restart-takeover-browser | test | test/helpers/**, rs26-restart, lease-takeover, return-crash tests, test/api/contracts.test.js, test/browser/** | `npm test && npm run test:browser` |
| g1-frontend-a11y-labels | frontend | public/**, test/fixtures/contracts/**, test/unit/frontend/**, test/scan/frontend.test.js | `node --test test/scan/frontend.test.js "test/unit/frontend/**/*.test.js"` |
| g2-docs-submission | devops | README.md, .env.example, LICENSE, docs/runbooks/**, docs/submission/**, test/scan/docs.test.js | `node --test test/scan/docs.test.js test/scan/env-example.test.js` |
| g3-final-scans-browser | test | test/helpers/**, test/scan/{secrets,sql,live-refusal}.test.js, test/api/{labelling,contracts}.test.js, test/browser/**, scripts/report-p95.js | `npm test && npm run test:browser` |
| g4-evidence-table | test | docs/evidence-table.md, test/scan/evidence-table.test.js | `node --test test/scan/evidence-table.test.js && sh scripts/clean-checkout.sh` |

Conventions for implementers:
- Every test that proves a brief criterion or a design finding starts its name with that id (`RS-06: …`, `NFR6: …`, `F-TR-1: …`, `SEC-2: …`, `ARCH-26: …`), so `--test-name-pattern` selects it and the evidence table can cite it.
- Run the declared command as one quoted argument, from the project root: `eccode evidence run --actor <role> --task <id> --label "<label>" -- '<command>'`. Commands that run the whole suite need `--timeout 1200`.
- Contracts first. The HTTP contract is pinned by `test/fixtures/contracts/*.json` (owned by the frontend task of each phase) and checked against the live API by `test/api/contracts.test.js` (owned by the test-engineer task of each phase). The PaymentProvider contract suite and the paypal-stub are owned by test-engineer (e0) before the adapters (e1) are written. The ExtractionProvider contract suite is owned by test-engineer (d5).

## Critical path

The design's critical path is W0 → W4 (reservations → saga → reconciler) → W6 integration → W5 journeys. In phase terms:

b1 → b4 → b3 → c1 → c2 → c3 → c6 → d1 → d3 → d5 → e0 → e1 → e2 → e4 → e6 → f2 → f4 → g1 → g3 → g4

Phase E has the longest chain (e0 → e1 → e2 → e4 → e6). The frontend task of each phase (c5, d4, e5, f3) has no dependency inside its phase, so it runs beside the backend chain in the second concurrency slot. So do b2, d2, e3 and f1.

## Risks to the schedule

- **Budget (RISK-11, high).** The project limit is 480 minutes, and 157 were recorded before this plan. The plan has 29 implementer dispatches and 6 phase reviews, each by one or two reviewers, with `maxConcurrency` 2. The critical path is 20 serial dispatches. At an optimistic 15–25 minutes per dispatch plus about 20 minutes of review per phase, the remaining work is roughly 400–600 minutes of wall time. **This is likely to exceed the remaining ~320 minutes.** I do not cut scope here, because all 45 criteria are required and the user has not traded any away. The orchestrator should put the choice to the user before phase C ends: raise `maxRuntimeMinutes` (a user `limits.raise` delegation), or accept a descoping order. A safe descoping order keeps every money and isolation criterion and drops polish first: G1's visual polish beyond NFR2's checks, then the submission drafts. The USD 25 spend limit currently has no recorded usage, so it is a lower bound.
- **Live services unavailable here (RISK-1, RISK-2).** The plan never waits on them: every live-dependent task (d2, e1, e6) is verified by deterministic contract and fixture tests now. The live runs are the separate checks below.
- **Multi-process and browser flakiness (RS-14, RS-20, RS-26, lease-takeover, journeys).** Short real timings (lease 1500 ms, interval 200 ms) on a shared host can be flaky. Each test-engineer task owns its harness and must report reruns honestly. A flaky pass is a finding, not a pass.
- **Rework on shared modules.** void-rule.js, calls.js, reconciler.js and saga.js are each touched in two phases (C/E and E/F). A finding in F that lands in an E-owned file reopens only the F task that owns that file in F; the mapping goes to the orchestrator.
- **Node 22.5 branch (Q9).** Only Node 22.22 is on this host, plus /opt/node20 and /opt/node21 for the start-gate test. The 22.5 run is the user's.

## Live checks (not tasks; never reported as passed until run)

These need credentials, network access or paid model calls that this environment does not have. They are listed separately so that no phase waits on them and no evidence is fabricated. Until they run, the evidence table and the verification report mark the live part of each criterion **Unverified** with its blocker. Only variable names appear here.

| Check | Command | Criteria (live part) | Needs | Blocker until run |
|---|---|---|---|---|
| LIVE-M1 | `RS_LIVE_MODEL=1 npm run test:live-model` | RS-01, RS-02, RS-03, RS-05 [LM]; NFR6 cost report; F-TR-13 `schemaAccepted`; OQ-D4 | an authenticated Claude CLI (`haiku`) or `ANTHROPIC_API_KEY`; the user's approval of the USD 5 ceiling (`dec-mv16pz0g-01d5c4c2`) | A4/Q3 |
| LIVE-P1 | `RS_LIVE_PAYPAL=1 npm run test:live-paypal` | RS-18, RS-19, RS-20, RS-23, RS-24 [LP]; OQ-D5 facts; SEC-18 layers 4–5 | `RS_PAYPAL_DEFAULT_CLIENT_ID`, `RS_PAYPAL_DEFAULT_CLIENT_SECRET`, `RS_PAYPAL_DEFAULT_WEBHOOK_ID` (or `RS_PAYPAL_<A–E>_*`); network allow-list for `api-m.sandbox.paypal.com` and `www.sandbox.paypal.com`; a public webhook URL for live RS-23/24 (Q6) | A6/Q2 (single-credential rows labelled, A2) |
| LIVE-P2 | `test/live/paypal/journey-sandbox.test.js` (part of LIVE-P1, browser) | RS-31(b), RS-32(b): hosted Sandbox approval page with a Sandbox buyer account, screenshots | as LIVE-P1, plus a Sandbox buyer account | A6/Q2 |
| USER-Q9 | the deterministic suites on Node 22.5 with `--experimental-sqlite` | NFR1 22.5 branch, incl. RS-14, RS-20, RS-26 and lease-takeover | Node 22.5 | Q9 |

## Placement of the open minors and the findings dispositions

- **F-TR-17 (register limit vs a fresh customer per journey): the register limit becomes an environment setting.** `RS_REGISTER_PER_IP_PER_HOUR` defaults to 5, and a value above 5 is refused at startup unless `RS_TEST_OFFLINE=1`. Config parsing is in b1. Enforcement is in c1, whose `auth.test.js` keeps the default and asserts that the 6th registration gets 429 `register_ip`. The variable is listed in `.env.example` by b4 and g2 and in the README by g2. The browser and multi-process harnesses (c6, then d5/e6/f4/g3) set it to 1000 under test mode, so every journey still registers its own fresh customer. Shared pre-registered customers were rejected: one failed journey would hold the single live reservation and poison the next journey.
- **F-TR-18 (NFR6 evidence and the share pin).** In d3, the `model-budget-rate.test.js` NFR6 case pins `RS_MODEL_CUSTOMER_DAILY_SHARE=1` in its own environment and says so in its test name. The SEC-10 case runs with the production default of 0.2. The evidence table (g4) and the verification report state the pin. `dec-mv1e2i5k-01a1bebb` already records that NFR6 is asserted with the share off.
- **Design findings → tasks:**

| Finding | Task(s) |
|---|---|
| F-TR-1 (= SEC-4) reserve idempotency scope | c3 |
| F-TR-2 derivation rows 4a/14, totality; re-plan queue | b2; f1 |
| F-TR-3 sender table, crash after return commit | e2, e4; f4 (return-crash) |
| F-TR-4 flag-free Node gate | b1; b3 (start-old-node) |
| F-TR-5 derivation rows 5a, 7–9 | b2 |
| F-TR-6 capture lands after void intent | e1 (fault); f2 |
| F-TR-7 pause without send; no epoch growth while pending | e4; f2 |
| F-TR-8 exact provider-call totals in RS-20 | e6 |
| F-TR-9 RS-03/RS-36 traceability, derive inspection | c (phase review, [I]); g4 |
| F-TR-10 atomic rate check | d1 |
| F-TR-11 cancelled presentation | e2; e5 |
| F-TR-12 micro-dollars | d1; d3 (boundaries) |
| F-TR-13 `schemaAccepted` | d2; LIVE-M1 |
| F-TR-14 listener CSP and approval round-trip | b1 (`approvalPageCsp`); e0 (stub); e1 (listener, header test); e6, f4, g3 (browser round-trip) |
| F-TR-15 fresh database per browser file; reset clears request_create; operator note | c6; c3; g2 |
| F-TR-16 OQ-D6/OQ-D7 decisions | recorded (`dec-mv1e2i2t-0113385a`, `dec-mv1e2i5k-01a1bebb`); d1 default 0.2 |
| F-TR-17, F-TR-18 | above |
| SEC-1, SEC-9, SEC-20 | c1 |
| SEC-2 | c2 (requests per day), c3 (live-reservation cap) |
| SEC-3 | b1 (config hosts); e1 (approval host); g1, g3 (test-mode banner, labelling) |
| SEC-5 | b1 (placeholder refusal, lengths, seed passwords); c1 (admin password); e1 (fake webhook key in meta); g2 (README) |
| SEC-6 | e3 (limit, pre-checks); e4 (purge of invalid/unverified rows) |
| SEC-7 | d1 (questions enum); d3 (image wording); d2 (EXT-1 assertion); d4 (label) |
| SEC-8 | d3 |
| SEC-10 | d1; d3 (per-customer case) |
| SEC-11 | c3 (audit on faults); f2 (forced reset) |
| SEC-12 | e1 |
| SEC-13 | b1 (app Host check); c1 (asserted); e1 (listener) |
| SEC-14 | b1 (umask, data/ 0700); d3 (uploads 0600) |
| SEC-15 | d2 |
| SEC-16 | e3 |
| SEC-17 | d1 (rephrase input); d3 (T10 DB-fixture injection) |
| SEC-18 | g4 (evidence-table wording); LIVE-P1 |
| SEC-19 | b1 |
| ARCH-22 | e2 (hook); e4 (test) |
| ARCH-23 | e4 |
| ARCH-24 | b3 (node-proc) |
| ARCH-25 | c1 |
| ARCH-26 | f2; f4 (lease-takeover) |

## Memory consulted

I ran `eccode memory search --check-env` for "plan", "ownership", "verification cwd", "nested", "delivery plan phases task ownership verification", "planner", "reservation", "PayPal saga webhook", "playwright browser test", "node version", "sqlite migration", "csrf auth session" and "model extraction provenance". All of them returned one record or none. The one verified record, `mem-sd-mv1audrd-013b7102` (the tool-call guard must resolve nested project roots per target), matches every task through shared project words (preview: ev:ev-mv1eoirt-0194a8ce). I assessed it as **does-not-apply** with evidence ev:ev-mv1eo87o-01c933d5. No task builds a hook or guard that maps writes to a record. The guard that governs this nested record is already the repaired version the lesson names. Its decision is recorded in `plan.lessonDecisions` as not-applicable. Operationally, every glob is relative to `examples/rescuestock` and no glob reaches `.eccode/`, `.claude/` or hooks.

## Release checklist (draft, completed at the verification gate)

- [ ] Install from the README works on a clean copy: `scripts/clean-checkout.sh` (npm install from the registry only, npm test, npm start → `/api/health` 200), last run g4.
- [ ] `npm test` and `npm run test:browser` pass on the release commit; the p95 and suite-time report passes (NFR5).
- [ ] Config and secrets are documented by name only: `.env.example`, README and runbooks; the RS-29 scan is clean over assets, responses, logs, screenshots and submission files.
- [ ] Labels: Simulated, PayPal Sandbox, Demo data, Test prices, test mode (RS-34).
- [ ] Rollback path: tag the release commit. The app holds no migration-down path (migrations are append-only), so rollback is redeploying the previous commit with its database backup (`VACUUM INTO`, README › Backups). Admin reset restores RS-FIX-1 for demos.
- [ ] Monitoring: JSON logs with requestId; `GET /api/admin/metrics` (reconciler last tick, unresolved operations, provider latency, model spend); `failed_needs_attention` statuses and stranded-operation lists from forced reset.
- [ ] Open risks: every critical or high risk mitigated with evidence from its phase (RISK-3/4/5/8/13/16 by E/F tests, RISK-6/9 by D/G scans), or reported to the orchestrator for the user's acceptance. RISK-1/2 stay open until LIVE-P1/LIVE-M1 run; the delivery-lead cannot accept them.
- [ ] The evidence table and the verification report mark LIVE-M1, LIVE-P1, LIVE-P2 and USER-Q9 as Unverified with their blockers, and state the NFR6 share pin (F-TR-18) and the SEC-18 wording.
- [ ] User-side items: the demo video showing PayPal's hosted Sandbox approval page, the Devpost submission and deadline check (Q5, Q7), and the Q10 daily budget.
