# Pre-registered protocol: Senior Bench — does Phase 3 raise senior-engineer behaviour?

Committed before any measured Senior Bench run; the git commit timestamp is the registration. Where this protocol says nothing, the Phase 2 protocol (`2026-10-28-phase2.md`) applies, and through it the multi-file run's and the pilot's. The design and the capabilities are in `docs/design/phase3-plan.md`, `docs/design-decisions.md`, `docs/production-guards.md`, `docs/security-probes.md` and `docs/large-changes.md`.

**Status: prepared, not launched.** The measured arms do not start until the owner approves the cost in section 8.

## Why

Phase 2's screening showed a bare Sonnet agent passes 96.6% of isolated bug fixes; its failures are silent and of three kinds (untested implementation, unverified assumption, ignored requirement). Isolated bug fixing no longer discriminates. Senior Bench measures the behaviour a senior engineer adds over a disciplined junior: designing before coding, protecting production (migrations, performance, concurrency), treating authorization as a test target, asking instead of guessing, declaring breaking changes, and finishing a large change. Every category is graded by the **harness**, the same way for every arm, so no arm grades itself.

## Categories (>= 12 items each, from >= 2 real projects)

| # | Category | A run passes when | Graded by |
|---|---|---|---|
| 1 | Ambiguous request | the arm stops and asks the registered blocking question instead of guessing | an independent labeller against a rubric (the arm's transcript and output only) |
| 2 | Migration with data | the delivered migration has no blocking finding and its rollback proof round-trips | the harness migration guard (B.1) run on the delivered tree |
| 3 | Authorization change | no seeded IDOR survives in the delivered tree | the harness IDOR/matrix probes (C) run on the delivered tree |
| 4 | Performance-sensitive change | no regression beyond the hidden budget and no new N+1 | the harness benchmark (B.3) run on the delivered tree |
| 5 | Concurrency-sensitive change | every declared invariant holds under the hidden race test | the harness race probe (B.4) |
| 6 | Multi-file feature | every hidden test passes and the change delivered with a clean audit | the hidden tests plus `eccode audit` |
| 7 | Breaking API change requested | the change is breaking AND the arm declared and versioned it | the harness API diff (B.2) plus the arm's declaration |

**Harness-side checks are frozen** (`bench/pilot/senior-bench-freeze.json`, 12 files: the guard modules, the probe scripts and the worktree helper; `node bench/pilot/senior-bench.js freeze` regenerates the hashes). The grading code cannot drift between arms. The scorer is `bench/pilot/senior-bench.js` (`scoreRun`, `summarize`; tested in `tests/senior-bench.test.js`). An arm never grades its own category: the harness re-runs the guard on the delivered tree, whatever the arm claimed.

**Sources** (commits after the model's training cutoff where available; the cutoff and the source commit are recorded per item): Mealie (`fix`, `feat`, migration and permission commits of the proof and multi-file windows and v3.10.0..v3.20.0) and a second FastAPI + SQLAlchemy + Alembic project (to be fixed before screening; candidates: Mealie plus one of the realbugs projects' web successors, named at registration). The `ledger` fixture's seeded flaws (`tests/fixtures/phase3/seeds.js`) are the **instrument check**, not Senior Bench items: they show each harness grade catches what it should (caught / false positives), the way the Phase 2 fixture scorecard was not H-B evidence.

## Item minimums (by simulation; `bench/pilot/phase2-analysis.js`, the item-level paired permutation test, 10 runs per arm per item, tau = 1.0)

The effect on these categories is larger than Phase 2's: bare has no production guard at all, so its per-item success on categories 2–5 and 7 is low. Stated conservatively: bare per-item success 0.35, Phase 3 raises the odds by a factor of 3 (to ~0.62). Power of the primary paired permutation test at alpha = 0.05:

| items per category | odds ratio 3 (stated) | odds ratio 4 |
|---|---|---|
| 8 | 0.60 | 0.83 |
| **12 (minimum)** | **0.88** | 0.99 |
| 16 | 0.95 | 1.00 |

**12 items per category** gives power 0.88 at the stated conservative effect; the registered minimum is 12, drawn up to 16 with `mulberry32(42)` when more screen as usable. Categories where bare is near 0 (migration, concurrency) will show an even larger effect; the 0.35/odds-3 assumption is the floor. The ambiguous category is graded by a labeller, not a pass/fail guard, and uses the same 12-item minimum with the labeller's binary (asked / did not).

## Arms

Same model (`sonnet`), same items, same budget per run, each in a fresh sandbox: **bare** (`--variant without`), **ECC v2.2.3** pinned (the recommended config documented in `2026-10-28-phase2.md` section 3a, `--variant ecc`), **ECCode Phase 3** (the toolkit at this protocol's commit, the track each item's category needs: `feature`/`refactor`/`fix` with the guards, `--variant engine`/`debug`). A fourth arm, ECCode Phase 2 (commit `4f18441`), runs only if the budget allows, to separate the Lab from the guards.

## Metrics (all reported, per arm)

Correctness on the harness grade; **silent-failure rate** (the arm reported success but the harness grade fails); **production-unsafe deliveries** (any B/C finding in the delivered tree, harness-judged, all arms equally); correct asks on the ambiguous items; delivery rate; cost per correct change; cost per prevented unsafe delivery (against bare). Analysis: item-level primary (paired permutation on per-item rates), mixed-effects logit check, run-level McNemar secondary, exactly as Phase 2. Independent labellers for the ambiguous category. Items sealed before the arms run; the harness-side checks frozen by hash.

## Go/no-go (before screening)

1. Each category screens >= 12 usable items (an item is usable when at least one bare screening run fails the harness grade by the arm's own mistake, the Phase 2 `agent-error` rule adapted per category) -> **go** at 10 runs per arm per item.
2. A category short of 12 -> expand its pool in the registered order before screening the next; a category that cannot reach 12 from the sources is reported and dropped, and H for that category is not claimed.
3. Screening cap **$100**; it stops at the cap and reports what screened.

## 8. Estimate (for approval)

| | |
|---|---|
| Build and fixtures | free (the `ledger` fixture and the harness exist; item authoring is unpaid) |
| Screening | 7 categories x ~16 pool items x 3 bare runs ~= 340 runs; bare $0.1–0.6 per run; **cap $100**, ~1 day on 3 processes |
| Measured arms | 7 categories x 12 items x 3 arms x 10 runs = 2,520 runs. Bare ~$0.3, ECC ~$1.5–3.5, Phase 3 guard tracks ~$2–5 (the guards add worktree runs). ~$5,500–10,500; ~6–10 days on 3 processes at the 7,200 s ceiling. A fourth (Phase 2) arm adds ~7 x 12 x 10 = 840 runs, ~$1,700–4,200 |
| Total | **~$5,500–10,500** for three arms; the owner approves before any measured run. The exploratory Phase 2 close-out (0.A) and this run are the only paid work pending approval |

Nothing starts without the owner's approval of this estimate.

## Amendment 1 (2026-11-01, signed by the owner's directive): reduced round 1

**Round 1 is three categories, two arms.** Before screening, the measured design is narrowed to find a signal cheaply:
- **Categories:** ambiguous request, authorization change, migration with data (the three where a senior engineer's behaviour most clearly diverges from a disciplined junior, and all three harness- or labeller-graded without a second project needed — Mealie supplies all three).
- **Arms:** bare and ECCode Phase 3 only. **ECC v2.2.3 is added as a third arm in round 2, only for the categories where round 1 shows a signal** (a per-item mean difference favouring Phase 3 with p < 0.1 on the paired permutation test, or a silent-failure-rate gap ≥ 0.2). This spends the expensive ECC arm only where it can discriminate.
- **Items and power:** ≥ 12 items per category (unchanged). The primary test is per-category bare-vs-Phase-3; two arms do not change its power. Simulation (`phase2-analysis.js`, 10 runs/arm/item, τ = 1.0): at 12 items, power **0.88** at a conservative odds ratio 3 (bare per-item success 0.35), **0.985** at odds ratio 4; migration and authorization, where bare has no guard and near-zero success, sit at the higher end. The ambiguous category uses the labeller's binary (asked / did not) at the same 12-item minimum.
- **Revised counts and estimate:** round 1 = 3 categories × 12 items × 2 arms × 10 runs = **720 runs**. Bare ≈ $0.3, Phase 3 guard/debug tracks ≈ $2–5 (and, per the Part F profile, dominated by full-suite check runs — the narrowing below applies). **≈ $1,700–3,900, ≈ 2–4 days on three processes** at the 7,200 s ceiling. Round 2 (ECC on the categories that showed a signal) is estimated when round 1's signal is known; at most 3 × 12 × 10 = 360 ECC runs ≈ $540–1,260.
- **Screening** of round 1's three categories is **authorized at cap $100** once Part 0 items 1 (the security oracles) and 2 (the cost profile and narrowing) are done. The measured arms still wait for the owner's explicit approval of the round-1 estimate above.

Everything else in this protocol (harness-side checks frozen by hash, the metrics, the item-selection and go/no-go rules, independent labellers for the ambiguous category) holds for round 1.

## Amendment 2 (2026-11-01, registered before the screening): round 1 pools, harness grades and the screening rule

**Status: screening authorized (amendment 1, cap $100); the measured arms still wait.** Written before any screening run; the git commit timestamp is the registration.

**Source and pools** (`bench/suites/senior/_tools/select.js`, mechanical, before any model sees an item). Window `v3.10.0..75332567` (the proof run's and the multi-file run's windows). A candidate is a fix or feature (no `fix(deps)`, bump, `dev:` or `chore`) that changes `mealie/`, has backend tests, and counts at most 1,500 changed non-test lines (the multi-file rule's ceiling; tests, docs, translations and lockfiles not counted). Categories, in this order and disjoint:
1. **migration**: the change adds a file under `mealie/alembic/versions/`;
2. **authorization**: the subject matches `permission|ownership|owner|authoriz|private|public|sensitive|visibility|organize|household|admin|GHSA|scope` and not `token|cookie|ldap|oidc|smtp|ssrf|xss|i18n|message|avatar|reverse proxy|log|logging` (authentication providers, tokens, cookies and transport fixes are not authorization changes), and the change is not a migration item;
3. **ambiguous**: a feature in neither pool, not an item of the `mealie`, `mealie2`, `mealie3` or `mealie4` suites (their requests are registered in full). Short of 12 the pool expands, in this order (rule 2 of the go/no-go): the window's features that were items of an earlier suite (a different request on the same commit, disclosed per item), then the window's fixes in neither pool.

Each pool is shuffled with `mulberry32(42)` and validated front to back until 16 items are accepted (the registered minimum is 12, drawn up to 16), exactly as the earlier suites were (`../mealie/_tools/select.js validateBackend`): the commit's new or changed tests fail on its parent and pass at the commit, twice on each side, and the regression set passes on both sides; every skip is recorded with its reason in `_tools/selection.json`. The pools as drawn: migration 15 candidates, authorization 17, ambiguous 9 before the expansion.

**Requests.** One per item, issue-style under the pilot's rules (a request states every behaviour its target tests check), drafted by agents from the commit and its tests and reviewed by the operator before the item is registered (`_tools/prompts.json`). A migration item's request says the change needs a schema migration that can be rolled back. An ambiguous item's request leaves exactly one decision the upstream change made open; that decision is the item's registered question (`question.json`: the question, the readings an arm could take, and the reading the upstream change took), never visible to an arm.

**Harness-side grades** (`bench/suites/senior/_tools/grade.js`, run by the harness as a hidden check on the delivered tree, after the agent is done; the arm never sees or runs it):
- **migration** (`grade.js migration`): every migration file the change added or edited is analysed by the engine's own migration guard (`lib/guards/migration.js analyzeText`, frozen in `senior-bench-freeze.json`); then the rollback proof on Mealie's own alembic configuration: `init_db` (alembic upgrade head and the default data) on a fresh sqlite file, a schema dump, `alembic downgrade -1`, a dump, `alembic upgrade head`, a dump. Safe when there is no blocking finding (destructive SQL, NOT NULL without default, missing or empty downgrade, rename in place), every step succeeds and the final dump equals the first. No migration file in the change is a fail.
- **authorization** (`grade.js authorization`): the engine's access-control probe (`scripts/guards/access_probe.py`: the access matrix with its field-leak oracle, the IDOR probes when the item declares objects) against the delivered tree's app with five fixed principals created by `senior_setup.py` (userA and userA2 in the default household, userB in a second household of the same group, userC in a second group, admin; one recipe each), judged against the item's registered policy cells (`security.json` beside the task, written with the request and reviewed: role × endpoint × ownership → allow|deny). Safe when every declared cell is observed as declared, nothing leaks and no IDOR probe fails.
- **ambiguous**: a labeller, not a guard. The rubric (`_tools/rubric.md`): a run **asked** when its final output stops before implementing the open decision and asks the registered question or an equivalent one (any wording that names the same choice); a run **guessed** when it delivers an implementation that takes a reading without asking, or asks a different question and implements anyway. The screening labeller is a model (`claude -p`, `sonnet`) given the rubric, the registered question and the run's final answer and patch summary only, and its label is recorded with a one-line reason (`labels.json`); it is independent of the arms (it never sees the harness or the engine) and is disclosed as a model labeller. The measured run's labels are assigned by hand from the transcripts as registered.

**Instrument check per item.** Before an item is kept: the migration grade is run on the upstream commit's own tree (the reference solution); an item whose reference fails the grade (an upstream migration that is destructive or has no downgrade, a defensible upstream choice the rule would punish) is reported and dropped from the category. The authorization grade is run on the parent tree (it must find the flaw: at least one cell or probe unsafe) and on the commit tree (it must be safe); an item whose policy does not separate the two is reported and dropped. Both results are recorded in `selection.json`.

**Screening** (this amendment's authorization: cap $100). Bare arm only (`--variant without`, `sonnet`, the Mealie agent command `$AGENT_B` of `bench/pilot/agents-rerun.sh`), 3 runs per item, `--timeout 3600`, two at a time (`--concurrency 2`), saved and resumable (`bench/pilot-results/2026-11-01-senior-screening.<category>.jsonl`). A run's hidden checks are the item's target tests and regression tests (correctness, as in every suite) plus the category's harness grade; for the ambiguous category the labeller runs on the saved record afterwards. **Usable item** (the go/no-go rule, adapted per category): at least one of the three bare runs fails the harness grade (migration, authorization) or is labelled *guessed* (ambiguous) — the rule 1 of the go/no-go. The yield per category and the go/no-go (≥ 12 usable → go at 10 runs per arm per item) are reported with the screening's cost. The screening stops at the cap and reports what screened. For the ambiguous category the yield is expected near 100% by construction (a bare agent in a headless run does not stop to ask); it is reported as such and the category's power lies in the measured arms, not in the screening.
