# Greenfield-Senior S1: evidence

S1 is the G1 pipeline and contract freeze (`docs/design/greenfield-senior.md`, section 15; plan `docs/superpowers/plans/2026-11-04-greenfield-senior-s1.md`). Status words: **verified** (a command ran on the final tree and its output is quoted), **partial** (verified in part; the gap is named). Commands run from the repository root. Times are UTC, 2026-11-04.

## 1. Invariants

| Invariant | Status | Evidence |
|---|---|---|
| Frozen v3 set 48 of 48 before | verified | `ECCODE_FREEZE_FILE=bench/pilot/phase2-freeze-v3.json node bench/pilot/phase2-seeds.js check` printed `frozen: 48 files` at the start of G0 (00:2x) and before the first S1 edit |
| Frozen v3 set 48 of 48 after | verified | the same command printed `frozen: 48 files, implementation commit see-protocol, frozen at 2026-11-03T13:06:26.810Z`, exit 0, on the final tree |
| No frozen file edited | verified | `git diff --name-only 948a95b HEAD -- <the 48 files>` printed nothing |
| No frozen file requires `lib/greenfield` | verified | a scan of the 48 files for `require(...greenfield...)` found none |
| `scripts/guards/*.py` untouched | verified | no path under `scripts/guards/` appears in `git diff --name-only 948a95b HEAD` |
| `docs/limits.md` untouched (merge rule) | verified | `git diff --quiet 948a95b HEAD -- docs/limits.md` exit 0; also asserted by `tests/gf-docs.test.js` |
| No paid run | verified | no benchmark arm was launched; the benchmark meter is $0 (the session's own compute is reported in section 5) |
| Wording: "prevent" never bare | verified | `tests/gf-docs.test.js` scans the design doc, the limits file, the skill, the three agents, `bin/eccode-gf.js` and `lib/greenfield/**` |

## 2. Test-first: what "red" was at each task

Red logs are in the session scratchpad; the table says honestly what each red proved.

| Task | Red run (before the code) | What the red proves |
|---|---|---|
| T0 docs | 5 tests, 3 fail | per-test red (bare "prevent", no limits file, no section 14) |
| T1 jsonschema, T2 openapi, T3 events | 1 test each, 0 pass | the test file ran and the module did not exist (a load error, not a per-test red) |
| T4 stages, T5 flow, T6 audit, T7 amend | 1 test each, 0 pass | the same: module missing |
| T8 MCP, roles, hook | 11 tests, 10 fail | per-test red (the hook allowed an unknown role's write; no `gf_*` tools) |
| T9 CLI | 9 tests, 9 fail | per-test red |

For T1 to T7 the stronger evidence is the rule-removal battery (section 3), which shows each rule's tests depend on the rule.

## 3. Rule-removal battery (every rule's tests are not vacuous)

`scratchpad/drop-rule.js` (a preload, not in the repository) makes one rule id never be reported, by the bundle validators, by the audit and by rule refusals, while everything else behaves as shipped. `scratchpad/mutation-run.js` ran the relevant test files once per rule. Result: **26 rules, 26 whose removal fails at least one test, 0 untested.**

| Rule | Tests that fail when it is removed | Rule | Tests that fail |
|---|---|---|---|
| GF-PRD-1 | 6 | GF-CON-5 | 3 |
| GF-PRD-2 | 4 | GF-THR-1 | 6 |
| GF-PRD-3 | 4 | GF-WBS-1 | 6 |
| GF-ARC-1 | 5 | GF-WBS-2 | 3 |
| GF-CON-1 | 1 | GF-WBS-3 | 4 |
| GF-CON-2 | 4 | GF-ART-2 | 3 |
| GF-CON-3 | 5 | GF-ART-DRIFT | 1 |
| GF-CON-4 | 4 | GF-ART-1 | 4 |
| GF-EST-1 | 18 | GF-SEAL-1 | 4 |
| GF-INIT-1 | 3 | GF-ORD-1 | 1 |
| GF-FRZ-2 | 4 | GF-FRZ-5 | 10 |
| GF-MSG-1 | 10 | GF-MSG-2 | 3 |
| GF-AUD-1 | 1 | GF-AUD-2 | 2 |

The thinnest are one-test rules (GF-CON-1 here; its OpenAPI detail is also in `tests/gf-openapi.test.js`, which calls the validator directly and so is outside this battery, GF-ORD-1, GF-AUD-1, GF-ART-DRIFT). The battery removes a rule's reporting, not its effect on control flow, so for rules enforced inline in the wrappers (GF-SEAL-1, GF-ART-1, GF-INIT-1, GF-MSG, GF-FRZ-5) it shows the tests assert the rule id, not that the bad operation would then succeed. Those were also mutated by hand during the build, each by editing the check out and restoring it:

| Hand mutation | Tests that failed |
|---|---|
| GF-PRD-2 and the GF-THR-1 completeness check disabled | 5 rows |
| claim-before-seal and registration-before-approval guards disabled | 3 |
| audit: ordering, contract drift, registration invariants disabled | 2, then 2 more after a gap was closed |
| reviewer check, chain check, snapshot check, message byte limit disabled | 4 |
| `extendTools` wrapping removed; hook role entries and snapshot protection removed | 2 |
| CLI exit codes broken (audit exit 0, rule refusal exit 1) | 5 |

The audit mutation exposed one real gap in my tests: disabling the audit's GF-ART-1 invariant (an unregistered submission) failed nothing. Two tests were added (`bypass GF-ART-1`, two cases) and the mutation re-run failed them.

## 4. Suite

| | Tests | Pass | Fail | Skipped | Time |
|---|---|---|---|---|---|
| Baseline at `948a95b`, first run | 569 | 516 | 0 | 53 | 131 s |
| Baseline repeat (the Mealie mirror cache existed by then; four tests ran) | 569 | 520 | 0 | 49 | |
| After S1 (`npm run check`, which includes toolkit validation: 15 agents, 10 skills, 13 commands) | 883 | 834 | 0 | 49 | 137 s |

The 314 new tests are all in `tests/gf-*.test.js`: amend 35, audit 73, cli 10, docs 5, events 14, flow 71, jsonschema 9, mcp 11, openapi 20, stages 66. The skip census is unchanged from the repeat baseline: 35 need an interpreter with the FastAPI stack (`fastapi`, `httpx`, `hypothesis`, `coverage`, `pytest`, `sqlalchemy`, `alembic`), 15 need a Mealie checkout, mirror or opt-in variable, and 2 need `kotlinc` or `codebase-memory-mcp`. **S1 does not exercise the FastAPI guard and behavior paths**, and the baseline does not either; S2 creates the virtual environment first and records the skip count before and after.

## 5. Estimate versus actual (registered in `docs/design/greenfield-senior.md` section 10, before any build)

Registered labels: judgment ranges, factor-two uncertainty, no calibration claim.

| Item | Registered for S1 | Actual | Reading |
|---|---|---|---|
| Wall time, active | 8 to 14 h | **37 minutes to the last build commit** (S1 start 00:33:27Z, T9 commit 01:10:33Z), plus the verification gate; the final figure is in the closing line below | the estimate overstated wall time by more than a factor of ten; the unit was my judgment of effort, the work ran at tool speed |
| New production code | 1,600 to 2,400 LOC | **2,084** JavaScript lines (`lib/greenfield`, `bin/eccode-gf.js`); plus 1,084 lines of schema JSON, 137 of agent and skill markdown, and 16 insertions and 5 deletions in four existing unfrozen files | within range |
| New test code | 1,800 to 2,800 LOC | **1,697** test lines plus **518** fixture lines (2,215) | within range counting fixtures; below it counting tests alone |
| Tests | 60 to 90 | **314** | 3.5 times over: the table-driven rows (60 mutations, each run three ways) were not in my count; the registered unit was wrong |
| Tokens | 4 to 8 M | **not separable.** The harness reports usage cumulatively from the session's start (00:09Z, which includes G0): output 155,778 tokens, uncached input 172, cache reads 18,300,440, cache writes 743,276, at the harness-reported cost of $5.74. I did not snapshot it at the start of S1, so an S1-only figure does not exist | the registered unit was ambiguous (generated tokens or all processed tokens); read as output tokens the cumulative total is far below 4 M, read as all processed tokens it is far above 8 M. Neither reading scores the estimate. **Process fix from S2:** register the unit, and snapshot usage at the start and end of each slice |
| Delegated agents | none registered | independent reviewer: see section 6 | |
| Paid runs | $0 | $0 | the cost figure above is this session's own compute, not a benchmark arm |

Outcome predictions registered for S1: **P1** "at least one rule will be found to have a hole by its own bypass test before S1 exits (two to four expected)". Actual before the independent review: the 60 bypass rows found no hole in a rule; the mutation check found one untested audit invariant and a fixture bug of mine (a mutation reached `plan.json` through a shared array). By the registered definition (a rule with a hole) P1 is not confirmed at this point; the review's findings are in section 6. P2 and P3 concern S4.

## 6. Independent review

(filled in below)
