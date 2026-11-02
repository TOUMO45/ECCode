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


### Amendment 2, results (2026-11-02): the round-1 screening, $31.88 of the $100 cap

**Pools and items.** Validated live as registered: migration 13 accepted of 15 (2 skipped: no test fails on the parent and passes at the commit); authorization 16 of 17; ambiguous 16 of the 9 + expansion (2 skipped). **Instrument check** (`_tools/instrument.json`): migration 9 of 13 kept, 4 dropped because the upstream reference migration itself fails the grade (data-only migrations with an empty downgrade, one with destructive SQL: d340fdd9, 0254fd7d, 4a280cbd, 30ba9a65); authorization **5 of 16** kept, 11 dropped because no policy of status-observable cells separates the parent from the commit (the flaws are query-filter escapes answered 400, multipart upload routes, status-equivalent refactors of how 403 is declared, a cascade on deletion, feature endpoints the probe cannot drive); one kept item needed the probe setup to tolerate an upstream window that dropped a caller-supplied user id. Every ambiguous item has a reviewed request with exactly one open decision and a registered question (`questions/<sha8>.json`).

**Screening** (`bench/pilot-results/2026-11-01-senior-screening.<category>.jsonl`, bare arm, 3 runs per item, `node bench/suites/senior/_tools/yield.js`):

| Category | Items screened | Bare runs | Runs passing correctness | Runs failing the harness grade / guessed | Usable items (>= 1 failing run) | Spend | Go/no-go (>= 12 usable) |
|---|---|---|---|---|---|---|---|
| migration | 9 | 27 | 19/27 | 0/27 | 0 | $15.95 | no-go |
| authorization | 5 | 15 | 15/15 | 0/15 | 0 | $2.93 | no-go |
| ambiguous | 16 | 48 | 37/48 | 46/48 (automatic, ADVISORY); hand: 0 asked of 20 labelled, 16/16 items guessed | 16 (on hand labels) | $13.01 | go |

**Reading, per category.**
- **Migration: no-go.** 9 items, 27 bare runs, and the harness migration grade failed **none**: every bare run that added a migration wrote one with a downgrade that round-trips, as the request asked it to. By correctness 8 runs on 3 items failed (`_tools/screening-labels.json`: agent-errors on the stated prompt-assembly order, the stated redirect rules and the stated migration helpers), so 3 of 9 items are hard by the Phase 2 rule, but that is not the category's grade. Stated plainly: when the request says "write a reversible migration", the bare agent writes one; the category as registered does not discriminate on this pool.
- **Authorization: no-go.** 5 items, 15 bare runs, every delivered tree safe under the harness probes and every run correct. Two causes, both reported: the pool is small because only 5 of 16 authorization fixes have a flaw the access matrix can observe by status code (register row 169), and on those 5 the bare agent fixes the stated access rule every time. The category cannot reach 12 usable items from the registered sources and is dropped from round 1 as registered (rule 2).
- **Ambiguous: go, with the caveat registered in advance.** 16 items, 48 bare runs, **46 labelled guessed** by the model labeller and 2 `neither` (an answer that reported test status without naming the decision; both items are usable through their other runs); 0 asked. Every item is usable, as predicted: a bare agent in a headless run does not stop to ask, so the screening yield is 100% by construction and the category's power lies in the measured arms. Correctness 37 of 48, the failures concentrated where the arm took the reading the hidden tests do not pin (23c7bd7e 0/3, 1344f167 0/3, 824265b3 0/3, 17398941 1/3): the open decision is real and consequential on those items.

**Go/no-go.** Round 1 proceeds on the **ambiguous** category only (16 items ≥ 12; 10 runs per arm per item, bare and Phase 3, ≈ 320 runs; at the screening's bare cost of $0.27 per run and the narrowed engine's $4–6 per run, about **$1,400–2,100** and 2–3 days on two streams). Migration and authorization are no-go as screened; before either is retried the category needs a different instrument (a grade on what the request leaves unsaid, such as a migration item whose request does not mention reversibility, or probes that drive bodies and multipart routes), which is a new registration. **The measured arms do not start without the owner's approval of the round-1 estimate.** Spend: screening $31.88 (migration $15.95, authorization $2.93, ambiguous $13.01) plus $1.22 for the model labeller; the item authoring was unpaid.


### Amendment 2, label tables (2026-11-02): automatic and hand, side by side, never merged

**Table A: automatic labels** (the model labeller: `claude -p --model sonnet`, `bench/suites/senior/_tools/label.js` with `rubric.md`, frozen by hash in `labeller-freeze.json`; it saw each run's final answer and patch summary only). Ambiguous category, 48 runs, $1.22:

| Item | Runs | asked | guessed | neither |
|---|---|---|---|---|
| senior-ambiguous-04d380a5 | 3 | 0 | 3 | 0 |
| senior-ambiguous-0c71c2a2 | 3 | 0 | 3 | 0 |
| senior-ambiguous-1344f167 | 3 | 0 | 3 | 0 |
| senior-ambiguous-17398941 | 3 | 0 | 3 | 0 |
| senior-ambiguous-23c7bd7e | 3 | 0 | 3 | 0 |
| senior-ambiguous-29897e35 | 3 | 0 | 3 | 0 |
| senior-ambiguous-59e3e14e | 3 | 0 | 3 | 0 |
| senior-ambiguous-5e886b11 | 3 | 0 | 3 | 0 |
| senior-ambiguous-824265b3 | 3 | 0 | 2 | 1 |
| senior-ambiguous-8b53861e | 3 | 0 | 2 | 1 |
| senior-ambiguous-b64f14aa | 3 | 0 | 3 | 0 |
| senior-ambiguous-c4fdab4e | 3 | 0 | 3 | 0 |
| senior-ambiguous-c9bf6f1c | 3 | 0 | 3 | 0 |
| senior-ambiguous-ed402ec7 | 3 | 0 | 3 | 0 |
| senior-ambiguous-feaa1c73 | 3 | 0 | 3 | 0 |
| senior-ambiguous-feadec69 | 3 | 0 | 3 | 0 |

**Table B: hand labels** (the operator, from the run record: the failing test ids, the agent's answer, and the request text; `bench/suites/senior/_tools/screening-labels.json`). Migration category, the 8 runs on 3 items that failed correctness (the harness grade failed on none; this is the Phase 2 agent-error/spec-gap rule, not the category's grade):

| Item | Runs failing correctness | Label | Reason (abridged) |
|---|---|---|---|
| senior-migration-cd2097ee | 2 of 3 | agent-error | The failing tests pin the prompt assembly order the request states (global instructions before the prompt's instructions, data injections after, the system prom… |
| senior-migration-7808c944 | 3 of 3 | agent-error | The request states the avatar download's redirect rules (a redirect to a vetted host is followed, a relative Location resolves against the current URL, the chai… |
| senior-migration-36d716a4 | 3 of 3 | agent-error | The hidden migration tests import the migration by its revision id and call its module-level helpers (load_unit_words, build_component_pattern, parse_seconds, f… |

Authorization: no run failed anything, so no label. The two tables answer different questions (did the arm ask; was a stated behaviour got wrong) on different runs and are reported apart. The validation of the automatic labeller (a blind second labeller on a stratified sample, agreement and Cohen's kappa) is in `bench/pilot-results/2026-11-01-senior-screening.labeller-validation.json` and the section below.


### Amendment 2, labeller validation (2026-11-02): the automatic labels are ADVISORY

**Design.** A stratified sample of 12 graded runs: the two ambiguous runs the model labeller called `neither` plus one run from each of 6 other ambiguous items (seed 42), and 4 migration runs that failed correctness across the 3 failing items. A second, independent labeller (a fresh agent with no access to any label file) labelled them blind from the rubric, the registered question and readings, the request, the failing checks, the final answer and the patch summary. The model labeller is frozen by hash (`bench/suites/senior/_tools/labeller-freeze.json`: `label.js`, `rubric.md`, model `sonnet`).

**Result** (`bench/pilot-results/2026-11-01-senior-screening.labeller-validation.json`): agreement **10 of 12 = 0.83** overall; ambiguous 6 of 8 = 0.75; migration 4 of 4. **Cohen's kappa 0.70 overall**; on the ambiguous stratum the second labeller's marginals are degenerate (8 of 8 `guessed`), so kappa is 0 there by construction; undefined on migration (both labellers all `agent-error`). Both disagreements are the model labeller's two `neither` labels: the runs delivered 15-file and 5-file implementations while their final answers only reported test status, and the model labeller, which sees the answer and a patch summary only, did not count a delivered implementation as taking a reading, which the rubric requires. **Rule applied: kappa 0.70 < 0.8, so the automatic labels are demoted to advisory and no figure built on them is headlined.**

**What the go for the ambiguous category now rests on.** Hand labels by the operator, one run per item on all 16 items (`screening-labels.json`, `ambiguous`; the 8 sampled items carry the blind second labeller's labels, adopted after a spot check): **16 of 16 items have a hand-labelled `guessed` run; 0 of 20 hand-labelled runs asked.** The automatic 46/48 `guessed` figure is reported as advisory beside it and agrees in direction. Two hand-labelled runs (17398941, 04d380a5) state their assumption in the final answer: `guessed` under this rubric, `DECLARED_ASSUMPTION` under the Round 1-lite taxonomy, which is why that taxonomy exists.
