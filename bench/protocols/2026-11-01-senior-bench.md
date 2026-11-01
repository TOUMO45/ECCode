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
