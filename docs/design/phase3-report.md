# Phase 3 report

Written 2026-11-01. Branch `claude/eloquent-cray-0g0y6v`. Claims are sorted Verified / Reported / In flight / Pending, as the project's register requires. The full engine suite is **486 tests, 0 failing, 8 skipped** without the Python fixtures.

## 1. What was built, per part (events, gates, tools)

**Part A — design before code** (`lib/design.js`, `tests/design.test.js`). Events `design.alternatives`, `design.decision`, `design.adr` (content-hashed ADR), `design.spike.started/closed`, `design.amended`, `request.ambiguity`, `request.clarified` (user only), `request.assumption`. Gates: no task ownership on feature/refactor/greenfield without a decision over ≥2 alternatives with five tradeoffs each (`TRACK_RULE`); a decision locked once work starts (`DESIGN_LOCKED`); a spike never ships, by path or content hash (`INVALID_HANDOFF`/`DELIVERY_BLOCKED`); the verification review must cite the ADR (`REVIEW_REJECTED`); an interface the ADR does not declare blocks delivery; a blocking ambiguity stops planning (`AMBIGUITY_OPEN`) until the user clarifies or an assumption is recorded (surfaced in every handoff and the report). CLI `design`/`request`; MCP `design_*`/`request_*`.

**Part B — production guards** (`lib/guards/`, `scripts/guards/`). `guard.routing` (what the change needs, from `impact` and surfaces). B.1 migration (`migration.analysis` static Alembic analysis; `migration.rollback.proof` upgrade→downgrade→upgrade schema round-trip). B.2 `api.diff` (OpenAPI + Python signatures, breaking/additive/none). B.3 `perf.result` (two-worktree micro-benchmark with SQLAlchemy query counts for N+1). B.4 `race.result` (concurrent operations with SQL invariants). B.5 `release.plan` + `release.acknowledged`. `guard.waiver` (reviewer). Delivery and the last gate refuse a required guard not run on the current tree or a blocking finding unwaived. CLI `guard`; MCP `guard_*`.

**Part C — security as a capability** (`lib/security.js`, `scripts/guards/access_probe.py`). Executed `security.matrix.result`, `security.idor.result`, `security.authflow.result`, `security.input.result`, plus declared `security.policy`; against the project's own FastAPI app in a worktree with the network closed. Delivery refuses a change touching auth/routes/ownership without a matrix and IDOR result with zero unexplained failures; an unknown matrix cell needs a reviewed policy. CLI `security`; MCP `security_*`.

**Part D — large-change planning** (`lib/plan-budget.js`). `plan.contracts` (interfaces agreed before implementation), a per-task file/line budget (`task.budget.waived`), `plan.checkpoint` every N tasks (`CHECKPOINT_DUE`), a rescope that cites its contract and a blocking ambiguity when a contract changes twice; planned-vs-delivered in the report. CLI `plan contracts|checkpoint`, `task waive-budget`; MCP.

**Part E — observed standards** (`lib/standards.js`). `project.standards` from git history and config (commit style, naming, test layout, error handling, stated lint rules), recorded as project memory and shown at onboarding; observed, never enforced.

**Part F — risk-routed cost** (`bench/pilot/phase3-cost.js`). Cost per correct change per track with the targets (quick 1.5×, fix 4×, feature 8× bare).

**Part G — Senior Bench** (`bench/protocols/2026-11-01-senior-bench.md`, `bench/pilot/senior-bench.js`). 7 categories, harness-graded (the guards re-run on each arm's delivered tree, frozen by hash in `senior-bench-freeze.json`), ≥12 items/category (power 0.88 at a conservative odds ratio of 3), arms bare/ECC/Phase 3, all the brief's metrics, go/no-go, screening cap $100, measured-arm estimate ~$5,500–10,500. Registered, not launched.

Wiring: `STATE_VERSION` 6; new events reduced and their artifacts re-hashed by `audit`; record protection in the guard hook and sandbox profile; `lib/worktree.js` (the behavior diff's worktree pattern, exported for the guards).

## 2. Fixture scorecards (B and C) — IN FLIGHT

`tests/fixtures/phase3/ledger` is a FastAPI + SQLAlchemy + Alembic app (45 tests) with 31 seeded flaws (`seeds.js`). The guard scorecard (`tests/phase3-guards.test.js`, caught / false positives per part) is being built; the numbers go here and in `tests/fixtures/phase3/scorecard.md` when it lands.

## 3. Deviations from the brief (each pinned by a test)

See `docs/design/phase3-plan.md` §7. The load-bearing ones: H-B is measured from the `phase2-hb-freeze` worktree, not HEAD, because the freeze covers the whole engine and Phase 3 edits it (row 157); `lib/worktree.js` duplicates the frozen behavior-diff worktree code; the Part D task budget caps size with a waiver, reversing the architecture doc's "measure, never cap" (row 163); hot paths = the change's surfaces + impact dependents; OpenAPI/signature diff is FastAPI/Python only (row 160); design is enforced at claim on refactor (no design gate there); a headless blocking ambiguity is resolved by a recorded assumption; Part E is report-only.

## 4. Cost per track on the fixtures vs targets

From the realbugs batch (the only data with all tracks today): bare 1×; quick/engine **3.58× bare, over its 1.5× target**; fix/debug **3.49×, within its 4× target**. The quick figure is the full engine cost on realbugs; narrowing (skip the behavior diff on a no-surface quick change; skip perf when no route is reached) is proposed before the measured Senior Bench run. Reported, no gate (Part F). `node bench/pilot/phase3-cost.js <runs.jsonl>`.

## 5. Part 0 results

- **0.B** (tornado-15 label): an independent labeller, given only the request, patch, hidden-check output and rubric, labelled it `agent-error` with high confidence (the fix is correct but the run rewrote an existing log line the test expects). Hard items with it: 4; without: 3.
- **0.C** (Mealie H-B config and runner): built from a deterministic rule, frozen (33-file freeze), tagged `phase2-hb-freeze` (commit `4fbb80e`); the measurement runs from a worktree at that tag. Recorded before measurement: the frozen route detector never joins `APIRouter` prefixes, so most Mealie seeds will be `insufficient-coverage` under the frozen pipeline and H-B will not be met as frozen (row 158) — the honest result of the frozen detector, for the owner to decide after 0.D.
- **0.A** (exploratory three-arm, 4 hard items × 10 × 3): ECC calibrated at **$1.66/run** on mealie4-05 (10–34 min, rising), replacing the 4–8× assumption; the full run projects to ~$150 under the $300 cap and **is running** (bare and ECC from HEAD, the ECCode Phase 2 arm from the `phase2-hb-freeze` worktree since HEAD is now Phase 3). Records in `bench/pilot-results/2026-11-01-phase2-ha-exploratory.*.jsonl`. Pre-registered as underpowered (primary power 0.00 at 4 items); reported for its per-item failure-mode-prevention table and silent-failure rate, never for significance.
- **0.D** (seed validation and H-B): PENDING the seed key, which is not in this container; it runs when the owner sets `ECCODE_SEED_KEY`.

## 6. Senior Bench — awaiting approval

Registered (section 1, Part G). 7 categories, ≥12 items each (≥84 items from ≥2 projects), harness-graded and frozen, arms bare/ECC/Phase 3. The `ledger` fixture flaws are the instrument check (that each harness grade catches what it should), not items. The measured arms are **not started**; the estimate (~$5,500–10,500, three arms) awaits the owner's approval.

## 7. New limits rows

157 (the freeze covers the whole engine; H-B runs from a worktree), 158 (the frozen route detector misses prefixed routes), 159 (Part A checks presence not quality), 160 (guards FastAPI/SQLAlchemy/Alembic only), 161 (perf is wall-clock, race needs the declared invariant), 162 (security probes are targeted, not a scanner), 163 (the Part D budget, amending the architecture doc), 164 (Part E observed-only, no PR comments without a network API), 165 (Part F targets; quick over target on realbugs). Header: forty-five open.

## 8. Recommended next step

1. Set `ECCODE_SEED_KEY` in the environment so 0.D (seed validation then H-B from the frozen worktree) can run in a fresh session; expect H-B to report mostly `insufficient-coverage` under the frozen route detector (row 158), then decide whether to register a prefix-joining detector (a new freeze).
2. Let 0.A finish and read its failure-mode-prevention table (committed records).
3. Approve the Senior Bench screening ($100 cap) and then the measured arms, with the cost-per-track narrowing applied to the quick track first.
