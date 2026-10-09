# RescueStock — Delivery Plan (revision 2)

Author: delivery-lead. Gate: plan. Date: 2026-10-09.
Sources: the approved brief `.eccode/artifacts/architecture/brief.md` (45 required criteria RS-01..RS-39, NFR1..NFR6) and the approved design `.eccode/artifacts/design/spec.md` (revision 3, submission `sub-mv1dvx7j-016948c6`, review `rev-mv1e1ohb-01183fe4`), with `revision-2-notes.md` and `revision-3-notes.md` of the design. Machine-readable plan: `plan.json` (6 phases, 28 tasks). This revision responds to review `rev-mv1eznmd-01d2f5fe`; the finding-to-change map is in `revision-2-notes.md` next to this file.

## Before phase B starts (F-PL-2)

**Phase B does not start until the budget decision is recorded.** The remaining work is likely to exceed the remaining runtime budget (see Risks to the schedule). The user chooses one of two options:
- raise `maxRuntimeMinutes` (a user `limits.raise` delegation);
- accept the descoping order stated below.

The orchestrator records that choice (`eccode decision add`, on the user's behalf) before the first implementer dispatch of phase B. Stopping mid-phase would leave half-built money paths, so this decision cannot wait.

## Phases and the criteria each proves

Every brief criterion is claimed by exactly one phase. Two checks confirm it: `.eccode/drafts/plan-coverage-check.mjs` and the reviewer's `.eccode/drafts/tr-plan-check.mjs`, both 45/45. A phase claims a criterion when its own tests prove it in full. Partial tests written earlier carry the same id in their names, and the verification gate re-proves all 45 on the final tree.

| Phase (gate) | Goal in one line | Criteria proved | Reviewers |
|---|---|---|---|
| `b-foundation` (B) | Skeleton, migrations 001–005, Node gate, config, seed RS-FIX-1, pure domain with planner + oracle and derivation, offline harness | RS-06, RS-07, RS-08, RS-09, RS-10, RS-11, NFR1, NFR4 | technical |
| `c-core-flow` (C) | Auth/CSRF/throttles/RBAC, requests, plans, approval, reservations, supplier confirmations and inventory, expiry pass, admin shells, three dashboards | RS-12, RS-14, RS-16, RS-28, RS-30, RS-33, RS-36 | technical + security (auth, input handling) |
| `d-extraction` (D) | Extraction with provenance (fake, CLI and API adapters), degraded path, model budget/rate, uploads, deletion, retention | RS-01, RS-02, RS-03, RS-05, RS-39, NFR6 ([D]/[B] parts) | technical + security (AI, uploads) |
| `e-payments` (E) | PayPal adapters, call protocol, create/return/cancel/abandon, void rule, execute claim and captures, reconciler, webhooks, payment UI | RS-04, RS-18, RS-19, RS-20, RS-21, RS-23, RS-24, RS-25, RS-27, RS-31(a) ([D]/[B] parts) | technical + security (money, auth) |
| `f-compensation` (F) | Supersession and re-plan queue, refusal, expiry voids, compensation with refunds, lease takeover, restart recovery, admin refund/forced reset | RS-13, RS-15, RS-17, RS-22, RS-26, RS-32(a), RS-37, RS-38 | technical + security (money) |
| `g-release` (G) | Accessibility, labels on both adapters, six answers, full secrets scan, live-suite refusal, performance, README/runbooks/submission drafts, evidence table, clean checkout | RS-29, RS-34, RS-35, NFR2, NFR3, NFR5 | technical + security (secrets, labels) |

## Phasing rationale

The orchestrator's working split is kept:
- B: data model and planner;
- C: auth, dashboards, reservations, confirmations and expiry;
- D: extraction;
- E: PayPal saga, webhooks and recovery;
- F: replanning, compensation and restart recovery;
- G: final verification.

Phase gates run strictly in order, so parallelism exists only inside a phase. Three adjustments follow from the design's dependencies:

1. **Foundation and domain share phase B.** W0 (foundation) and W1 (domain) do not depend on each other, so they run as two parallel tasks in one phase. Auth moves to C, as the orchestrator proposed; the design lists it under W0, but nothing in B needs a session.
2. **The expiry criterion RS-15 moves from C to F.** RS-15 requires two things that only exist after the payment flow (E) and the claim:
   - expiry voids every provider authorization;
   - an expiry pass after the execute claim changes nothing.

   So C builds the expiry pass and the void-rule steps for operations without an authorization, and F proves RS-15 in full. RS-04 moves to E for the same reason: half of it is `POST /api/orders/:id/paypal/create`.
3. **Criteria land where their whole proof first exists.**
   - RS-34 (labels on both adapters, [D]+[B]), NFR3 (both live runners) and NFR5 (p95 over the whole API suite, and the suite time) go to G.
   - RS-36 goes to C, because its endpoint half needs the request view.
   - RS-38 goes to F, because consume and restock rows exist only after the claim and compensation.

Within E, the void rule, the authorization paths (RS-21) and the lost-response recovery (RS-25) stay with the payment flow. Compensation after a capture, lease takeover and restart (RS-22, RS-26) go to F, following the saga's own split between steps 1–4 and steps 5–6.

## Verification commands fail before the work exists (F-PL-1)

On Node 22.22, `node --test` exits 0 in three cases (ev:ev-mv1f3hiv-01a9ae95, probe `.eccode/drafts/plan-r2-cmd-probe.mjs`):
- a glob that matches nothing (0 tests);
- a missing explicit file, **whenever any other pattern or file in the same command matches**;
- `npm test -- <new file>` and `npm run test:browser -- <new file>`, for the same reason.

So naming a new file in a command is not enough. Every task's command now starts with an existence guard, `ls <own files> >/dev/null && …`, before the test run.
- `ls` exits non-zero if any listed file is missing.
- The listed files are files that only this task creates first. They are not owned by any task in an earlier phase or in the task's dependency closure. `.eccode/drafts/plan-r2-guard-check.mjs` checks this: 28/28 pass.
- The test run after the guard executes those files. The guard lists test files that the command names explicitly or that the `npm test` / `test:browser` globs run, plus a few non-test outputs: fixtures, runbooks, the live runner, the evidence table.

Two further changes support this:
- The frontend tasks no longer share the `test/unit/frontend/**` glob. Each phase's frontend task creates its own unit file (`dashboards`, `extraction`, `payments`, `recovery`, `a11y-labels`) and lists the earlier files explicitly, so it can update them.
- The test-engineer tasks no longer own `test/browser/**`. Each owns its own journey files plus the shared `test/browser/helpers/**`.

The reviewer's check `.eccode/drafts/tr-plan-check.mjs` reports **0 pre-passing tasks** and 0 hard problems on this revision.

## Task overview (owner, own files in the guard, verification)

Every task has `verification.cwd = "."`, which is the project root `examples/rescuestock` as the engine binds it. All globs are relative to that root, and none names `.eccode/`, `.claude/` or hooks. Tasks that may run in parallel within a phase have disjoint globs (19 concurrent pairs checked). The shared wiring files (`src/app.js`, `src/main.js`, `src/routes/plans.js`, `package.json`) belong only to tasks that run one after another within a phase. `plan validate` reports no ownership warnings.

Shorthands used in the table:
- **G(files)** = `ls <files> >/dev/null &&`
- **NG** = `node --disable-warning=ExperimentalWarning --import ./test/helpers/net-guard.js --test`
- **FE** = `node --test test/scan/frontend.test.js "test/unit/frontend/**/*.test.js"`

The exact strings are in `plan.json`.

| Task | Owner | Verification (guard files → run) |
|---|---|---|
| b1-foundation-core | backend | G(test/unit/config/{hosts,secrets,node-version,limits}.test.js, test/unit/db/{migrate,triggers}.test.js, test/unit/http/headers.test.js, test/unit/seed/seed.test.js) → `node --disable-warning=ExperimentalWarning --test` over the config, db, http and seed globs |
| b2-domain | backend | G(test/unit/domain/{planner-fixture,planner-oracle.property,states,derive,money,time,compat,explain}.test.js, test/timing/planner-generator.test.js) → `node … --test` over the domain and timing globs |
| b4-env-readme | devops | G(.env.example, README.md, LICENSE, test/scan/env-example.test.js) → `node --test test/scan/env-example.test.js` |
| b3-test-harness | test | G(test/helpers/{net-guard,node-proc,server-proc,app-harness}.js, test/unit/helpers/net-guard.test.js, start-health and start-old-node tests, test/scan/package.test.js, test/api/health-config.test.js, scripts/report-p95.js, scripts/clean-checkout.sh) → `npm test && sh scripts/clean-checkout.sh` |
| c1-auth-rbac | backend | G(test/api/auth.test.js) → NG `test/api/auth.test.js "test/unit/auth/**/*.test.js"` |
| c2-requests-plans-view | backend | G(its 4 API tests) → NG the same 4 |
| c3-reservations-supplier-admin | backend | G(its 6 API tests) → NG the same 6 |
| c5-frontend-dashboards | frontend | G(test/scan/frontend.test.js, test/unit/frontend/{format,dashboards}.test.js) → FE |
| c6-reserve-concurrency-browser | test | G(rs14-two-process-reserve, rs14-db-busy, test/api/contracts.test.js, test/browser/journey-infeasible.test.js) → `npm test && npm run test:browser` |
| d1-ai-core | ai | G(test/unit/ai/{schema,prompt,fake,gate,rephrase}.test.js) → NG the same 5 |
| d2-ai-adapters-corpus | ai | G(test/unit/ai/{cli,anthropic,live-runner-refusal}.test.js, test/eval/extraction-fake.test.js, test/fixtures/extraction/manifest.json, test/live/run-live-model.js) → NG the 4 test files |
| d3-extraction-service | backend | G(its 7 API tests) → NG the same 7 |
| d4-frontend-extraction | frontend | G(test/unit/frontend/extraction.test.js) → FE |
| d5-extraction-contract-browser | test | G(test/unit/ai/provider-contract.test.js, test/scan/secrets.test.js, test/browser/degraded-extraction.test.js) → `npm test && npm run test:browser` |
| e0-paypal-stub-contract | test | G(test/unit/payments/provider-contract.js, test/unit/payments/paypal-stub.test.js) → NG `test/unit/payments/paypal-stub.test.js` |
| e1-payment-adapters | backend | G(test/unit/payments/{fake,sandbox,merchants,provider-contract}.test.js, test/api/fake-approval-headers.test.js) → NG `"test/unit/payments/**/*.test.js" test/api/fake-approval-headers.test.js` |
| e2-payment-flow | backend | G(paypal-create, paypal-cancel, amount-tampering, paypal-return-idempotent, authorization-denied API tests) → NG those 5 plus approve-guards and isolation (extended) |
| e3-webhooks | backend | G(test/api/webhooks.test.js) → NG the same |
| e4-saga-reconciler | backend | G(execute, lost-response, authorization-pending, void-rule-lost-authorize, reconciler API tests) → NG the same 5 |
| e5-frontend-payments | frontend | G(test/unit/frontend/payments.test.js) → FE |
| e6-execute-concurrency-browser | test | G(rs20-two-process-execute, test/browser/journey-happy.test.js, test/live/paypal/journey-sandbox.test.js) → `npm test && npm run test:browser` |
| f1-supersession-refusal-expiry | backend | G(supersession, supplier-refusal, replan-queue API tests) → NG those 3 plus reservation-expiry (extended) |
| f2-compensation-takeover-admin | backend | G(capture-compensation, void-capture-race, admin-reset, admin-refund-order, ledgers API tests) → NG the same 5 |
| f3-frontend-recovery | frontend | G(test/unit/frontend/recovery.test.js) → FE |
| f4-restart-takeover-browser | test | G(rs26-restart, lease-takeover, return-crash, test/browser/{refusal,journey-replacement}.test.js) → `npm test && npm run test:browser` |
| g1-frontend-a11y-labels | frontend | G(test/unit/frontend/a11y-labels.test.js) → FE |
| g2-docs-submission | devops | G(test/scan/docs.test.js, docs/runbooks/live-model.md, docs/runbooks/live-paypal.md) → `node --test test/scan/docs.test.js test/scan/env-example.test.js` |
| g3-final-scans-browser (absorbs former g4) | test | G(test/scan/{sql,live-refusal,evidence-table}.test.js, test/api/labelling.test.js, test/browser/{a11y-states,six-questions,labelling}.test.js, docs/evidence-table.md) → `npm test && npm run test:browser && sh scripts/clean-checkout.sh` |

Conventions for implementers:
- **Test names.** Every test that proves a brief criterion or a design finding starts its name with that id (`RS-06: …`, `NFR6: …`, `F-TR-17: …`, `SEC-2: …`, `ARCH-26: …`). Then `--test-name-pattern` selects it and the evidence table can cite it.
- **File names.** Use the test file names the guard lists exactly. The verification command fails if any of them is missing.
- **Running the command.** Run the declared command as one quoted argument, from the project root: `eccode evidence run --actor <role> --task <id> --label "<label>" -- '<command>'`.
  - Full-suite commands need `--timeout 1800`.
  - g3's command needs `--timeout 2400`.
- **Generated output.** `.gitignore` (b1) covers `data/`, `.env`, `reports/`, `test/.out/` and `test/browser/out/`, so runtime data and screenshots never count as task changes.
- **Contracts first.**
  - The HTTP contract is pinned by `test/fixtures/contracts/*.json`, owned by the frontend task of each phase. It is checked against the live API by `test/api/contracts.test.js`, created by c6 and extended by each test-engineer task.
  - The PaymentProvider contract suite and the paypal-stub are owned by test-engineer (e0), before the adapters (e1) are written.
  - The ExtractionProvider contract suite is owned by test-engineer (d5).

## Critical path

The design's critical path is W0 → W4 (reservations → saga → reconciler) → W6 integration → W5 journeys. In task terms (19 dispatches in a row):

b1 → b4 → b3 → c1 → c2 → c3 → c6 → d1 → d3 → d5 → e0 → e1 → e2 → e4 → e6 → f2 → f4 → g1 → g3

- Phase E has the longest chain (e0 → e1 → e2 → e4 → e6).
- The frontend task of each phase (c5, d4, e5, f3) has no dependency inside its phase, so it runs beside the backend chain in the second concurrency slot. So do b2, d2, e3 and f1.
- g2 runs beside g1.

## Concurrency boundary in phase F (F-PL-3)

f1 (supersession, refusal, expiry, re-plan queue) and f2 (compensation, takeover, admin) still run in parallel.
- **f1 changes no code** in `src/services/void-rule.js`, `reconciler.js`, `saga.js`, `calls.js`, `admin.js` or `src/routes/admin.js`. This is an acceptance criterion of f1.
- **What f1 relies on as built:**
  - the void rule, complete since e2;
  - the reconciler's expiry and re-plan-drain calls, wired by e4 to `reservations.js` and `supersession.js`, which f1 owns;
  - the admin faults, built in c3, which call `orders.js` and `supersession.js`, both owned by f1.
- **If f1's tests show that one of the f2-owned files must change,** f1 fails the task and names the defect. It does not work around it. The orchestrator then re-sequences f1 after f2.

## Risks to the schedule

- **Budget (RISK-11, high; F-PL-2).** The project limit is 480 minutes, and the review measured 177 already used.
  - The plan has 28 implementer dispatches and 6 phase reviews, each by one or two reviewers, with `maxConcurrency` 2.
  - The critical path is 19 dispatches in a row.
  - At 15–25 minutes per dispatch plus about 20 minutes of review per phase, that is roughly 400–580 minutes of wall time, against about 300 left.
  - Merging g4 into g3 saved one dispatch at no cost to the critical path. No other merge is available without mixing owners or serialising work that now runs in parallel (e3/e4, d2/d3, f1/f2). The reviewer reached the same conclusion.
  - I do not cut scope here: all 45 criteria are required, and the user has not traded any away.
  - **Descoping order offered to the user, if limits are not raised:** keep every money, isolation and data-integrity criterion; drop G1's visual polish beyond NFR2's checks first, then the submission drafts in g2. Any criterion left unproved is reported as such, never claimed.
  - The USD 25 spend limit has no recorded usage yet, so the spend shown is only a lower bound.
- **Live services unavailable here (RISK-1, RISK-2).** No phase waits on them. Every live-dependent task (d2, e1, e6) is verified by deterministic contract and fixture tests now. The live runs are the separate checks below.
- **Flaky multi-process and browser tests** (RS-14, RS-20, RS-26, lease-takeover, journeys). Short real timings (lease 1500 ms, interval 200 ms) on a shared host can be flaky. Each test-engineer task owns its harness and must report reruns honestly. A flaky pass is a finding, not a pass.
- **Rework on shared modules.** `void-rule.js`, `calls.js`, `reconciler.js` and `saga.js` are each touched in two phases (C/E and E/F). A finding in one of those files maps to the task that owns the file in the phase under review, and the mapping goes to the orchestrator.
- **Node 22.5 branch (Q9).** This host has only Node 22.22, plus /opt/node20 and /opt/node21 for the start-gate test. The 22.5 run is the user's.

## Live checks (not tasks; never reported as passed until run)

These need credentials, network access or paid model calls that this environment does not have. They are listed separately so that no phase waits on them and no evidence is fabricated. Until they run, the evidence table and the verification report mark the live part of each criterion **Unverified** with its blocker. Only variable names appear here.

| Check | Command | Criteria (live part) | Needs | Blocker until run |
|---|---|---|---|---|
| LIVE-M1 | `RS_LIVE_MODEL=1 npm run test:live-model` | RS-01, RS-02, RS-03, RS-05 [LM]; NFR6 cost report; F-TR-13 `schemaAccepted`; OQ-D4 | an authenticated Claude CLI (`haiku`) or `ANTHROPIC_API_KEY`; the user's approval of the USD 5 ceiling (`dec-mv16pz0g-01d5c4c2`) | A4/Q3 |
| LIVE-P1 | `RS_LIVE_PAYPAL=1 npm run test:live-paypal` | RS-18, RS-19, RS-20, RS-23, RS-24 [LP]; OQ-D5 facts; SEC-18 layers 4–5 | `RS_PAYPAL_DEFAULT_CLIENT_ID`, `RS_PAYPAL_DEFAULT_CLIENT_SECRET`, `RS_PAYPAL_DEFAULT_WEBHOOK_ID` (or `RS_PAYPAL_<A–E>_*`); network allow-list for `api-m.sandbox.paypal.com` and `www.sandbox.paypal.com`; a public webhook URL for live RS-23/24 (Q6) | A6/Q2 (single-credential rows labelled, A2) |
| LIVE-P2 | `test/live/paypal/journey-sandbox.test.js` (part of LIVE-P1, browser) | RS-31(b), RS-32(b): hosted Sandbox approval page with a Sandbox buyer account, screenshots | as LIVE-P1, plus a Sandbox buyer account | A6/Q2 |
| USER-Q9 | the deterministic suites on Node 22.5 with `--experimental-sqlite` | NFR1 22.5 branch, incl. RS-14, RS-20, RS-26 and lease-takeover | Node 22.5 | Q9 |

## Placement of the open minors and the findings dispositions

### F-TR-17: the register limit becomes an environment setting

`RS_REGISTER_PER_IP_PER_HOUR` defaults to 5. A value above 5 is refused at startup unless `RS_TEST_OFFLINE=1`.
- **b1** parses it. Its named test `test/unit/config/limits.test.js` (case `F-TR-17: …`, F-PL-4) asserts the default, the refusal of 6 outside test mode, and the acceptance of 1000 in test mode. The file is in b1's guard.
- **c1** enforces it. `auth.test.js` keeps the default and asserts that the 6th registration gets 429 `register_ip`.
- **b4 and g2** list it in `.env.example`; g2 also documents it in the README.
- **The browser and multi-process harnesses** (c6, then d5/e6/f4/g3) set it to 1000 under test mode, so every journey still registers its own fresh customer.

Shared pre-registered customers were rejected: one failed journey would hold the single live reservation and poison the next.

### F-TR-18: NFR6 evidence and the share pin

- **d3:** the NFR6 case in `model-budget-rate.test.js` pins `RS_MODEL_CUSTOMER_DAILY_SHARE=1` in its own environment and says so in its test name. The SEC-10 case runs with the production default of 0.2.
- **g3 (evidence table) and the verification report** both state the pin.
- `dec-mv1e2i5k-01a1bebb` already records that NFR6 is asserted with the share off.

### Design findings → tasks

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
| F-TR-9 RS-03/RS-36 traceability, derive inspection | phase C review ([I]); g3 |
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
| SEC-18 | g3 (evidence-table wording); LIVE-P1 |
| SEC-19 | b1 |
| ARCH-22 | e2 (hook); e4 (test) |
| ARCH-23 | e4 |
| ARCH-24 | b3 (node-proc) |
| ARCH-25 | c1 |
| ARCH-26 | f2; f4 (lease-takeover) |

## Memory consulted

I ran `eccode memory search --check-env` for these queries:
- "plan", "ownership", "verification cwd", "nested";
- "delivery plan phases task ownership verification", "planner", "reservation", "PayPal saga webhook", "playwright browser test", "node version", "sqlite migration", "csrf auth session", "model extraction provenance".

Each returned the same single record or nothing. That record, `mem-sd-mv1audrd-013b7102`, is a verified lesson: the tool-call guard must resolve nested project roots per target.
- It still matches every task through shared project words.
- I assessed it as **does-not-apply**, with evidence ev:ev-mv1eo87o-01c933d5. No task builds a hook or guard that maps writes to a record, and the guard governing this nested record is already the repaired version the lesson names.
- The reviewer judged the decision evidence-backed (ev:ev-mv1eya53-01fe0832).
- It is recorded in `plan.lessonDecisions` as not-applicable.

## Release checklist (draft, completed at the verification gate)

- [ ] Install from the README works on a clean copy: `scripts/clean-checkout.sh` (npm install from the registry only, npm test, npm start → `/api/health` 200). Last run: g3.
- [ ] `npm test` and `npm run test:browser` pass on the release commit, and the p95 and suite-time report passes (NFR5).
- [ ] Config and secrets are documented by name only (`.env.example`, README, runbooks), and the RS-29 scan is clean over assets, responses, logs, screenshots and submission files.
- [ ] Labels are shown: Simulated, PayPal Sandbox, Demo data, Test prices, test mode (RS-34).
- [ ] Rollback path: tag the release commit. Migrations are append-only, so there is no down-migration; rollback means redeploying the previous commit with its database backup (`VACUUM INTO`, README › Backups). Admin reset restores RS-FIX-1 for demos.
- [ ] Monitoring is in place:
  - JSON logs carry requestId;
  - `GET /api/admin/metrics` shows the reconciler's last tick, unresolved operations, provider latency and model spend;
  - `failed_needs_attention` statuses are visible;
  - forced reset lists stranded operations.
- [ ] Open risks: every critical or high risk is either mitigated with evidence from its phase (RISK-3/4/5/8/13/16 by E/F tests, RISK-6/9 by D/G scans) or reported to the orchestrator for the user's acceptance. RISK-1/2 stay open until LIVE-P1/LIVE-M1 run; the delivery-lead cannot accept them.
- [ ] The evidence table and the verification report:
  - mark LIVE-M1, LIVE-P1, LIVE-P2 and USER-Q9 as Unverified with their blockers;
  - state the NFR6 share pin (F-TR-18) and the SEC-18 wording.
- [ ] User-side items remain: the demo video showing PayPal's hosted Sandbox approval page, the Devpost submission and deadline check (Q5, Q7), and the Q10 daily budget.
