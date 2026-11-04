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
| Wording: the enforcement claim never appears without its audit half | verified | `tests/gf-docs.test.js` scans the design doc, the limits file, the skill, the three agents, `bin/eccode-gf.js` and `lib/greenfield/**` |

## 2. Test-first: what "red" was at each task

Red logs are in the session scratchpad; the table says honestly what each red proved.

| Task | Red run (before the code) | What the red proves |
|---|---|---|
| T0 docs | 5 tests, 3 fail | per-test red (a one-sided enforcement claim, no limits file, no section 14) |
| T1 jsonschema, T2 openapi, T3 events | 1 test each, 0 pass | the test file ran and the module did not exist (a load error, not a per-test red) |
| T4 stages, T5 flow, T6 audit, T7 amend | 1 test each, 0 pass | the same: module missing |
| T8 MCP, roles, hook | 11 tests, 10 fail | per-test red (the hook allowed an unknown role's write; no `gf_*` tools) |
| T9 CLI | 9 tests, 9 fail | per-test red |
| Review fixes B1 to B4, M1 to M8, m1, m3 | each finding was reproduced as a test that failed on the unfixed tree before the fix: 24 audit-forged cases, 13 review cases, new mutation rows and new openapi, stages, flow and audit rows | per-test red, written from the reviewer's reproductions |

For T1 to T7 the stronger evidence is the rule-removal battery (section 3), which shows each rule's tests depend on the rule.

## 3. Rule-removal battery (every rule's tests are not vacuous)

`scratchpad/drop-rule.js` (a preload, not in the repository) makes one rule id never be reported, by the bundle validators, by the audit and by rule refusals, while everything else behaves as shipped. `scratchpad/mutation-run.js` ran **all 12 `tests/gf-*.test.js` files (382 tests)** once per rule. It ran twice: before the independent review (per-rule file subsets, 314 tests) and again on the final tree after the review fixes (the whole gf set for every rule, so a rule may be caught by a file that was not obviously its own). The table is the final run, 3 min 40 s. Result: **26 rules, 26 whose removal fails at least two tests, 0 untested.** (The first run had four rules whose removal failed a single test: GF-CON-1, GF-ORD-1, GF-AUD-1 and GF-ART-DRIFT; none is that thin now.)

| Rule | Tests that fail when it is removed | Rule | Tests that fail |
|---|---|---|---|
| GF-PRD-1 | 16 | GF-CON-5 | 9 |
| GF-PRD-2 | 14 | GF-THR-1 | 19 |
| GF-PRD-3 | 16 | GF-WBS-1 | 22 |
| GF-ARC-1 | 15 | GF-WBS-2 | 9 |
| GF-CON-1 | 13 | GF-WBS-3 | 12 |
| GF-CON-2 | 12 | GF-ART-2 | 18 |
| GF-CON-3 | 21 | GF-ART-DRIFT | 2 |
| GF-CON-4 | 12 | GF-ART-1 | 5 |
| GF-EST-1 | 21 | GF-SEAL-1 | 10 |
| GF-INIT-1 | 3 | GF-ORD-1 | 2 |
| GF-FRZ-2 | 5 | GF-FRZ-5 | 18 |
| GF-MSG-1 | 12 | GF-MSG-2 | 4 |
| GF-AUD-1 | 2 | GF-AUD-2 | 3 |

The thinnest are GF-ART-DRIFT, GF-ORD-1 and GF-AUD-1 (two tests each). The battery removes a rule's reporting, not its effect on control flow, so for rules enforced inline in the wrappers (GF-SEAL-1, GF-ART-1, GF-INIT-1, GF-MSG, GF-FRZ-5) it shows the tests assert the rule id, not that the bad operation would then succeed. Those were also mutated by hand during the build (before the review), each by editing the check out and restoring it:

| Hand mutation | Tests that failed |
|---|---|
| GF-PRD-2 and the GF-THR-1 completeness check disabled | 5 rows |
| claim-before-seal and registration-before-approval guards disabled | 3 |
| audit: ordering, contract drift, registration invariants disabled | 2, then 2 more after a gap was closed |
| reviewer check, chain check, snapshot check, message byte limit disabled | 4 |
| `extendTools` wrapping removed; hook role entries and snapshot protection removed | 2 |
| CLI exit codes broken (audit exit 0, rule refusal exit 1) | 5 |

I did **not** repeat these hand mutations on the final tree; the battery above is the only mutation run on it. The review (section 6) found several tests that could not fail among the inline checks; those were fixed by `tests/gf-audit-forged.test.js` and `tests/gf-review.test.js`, and the battery above covers their reporting.

The first audit mutation exposed one real gap in my tests: disabling the audit's GF-ART-1 invariant (an unregistered submission) failed nothing. Two tests were added (`bypass GF-ART-1`, two cases) and the mutation re-run failed them.

## 4. Suite

| | Tests | Pass | Fail | Skipped | Time |
|---|---|---|---|---|---|
| Baseline at `948a95b`, first run | 569 | 516 | 0 | 53 | 131 s |
| Baseline repeat (the Mealie mirror cache existed by then; four tests ran) | 569 | 520 | 0 | 49 | |
| After S1 build, before the review (`npm run check`) | 883 | 834 | 0 | 49 | 137 s |
| **Final tree** (`npm run check`, includes toolkit validation: 15 agents, 10 skills, 13 commands, hooks wired) | **951** | **902** | **0** | **49** | **126 s** |

The 382 new tests are all in `tests/gf-*.test.js`: amend 35, audit 83, audit-forged 24, cli 10, docs 5, events 14, flow 81, jsonschema 9, mcp 11, openapi 21, review 13, stages 76 (the 12 files sum to 382, and 951 minus the 569 baseline is 382). The whole gf set runs in about 12 s. The skip census is unchanged from the repeat baseline: 35 need an interpreter with the FastAPI stack (`fastapi`, `httpx`, `hypothesis`, `coverage`, `pytest`, `sqlalchemy`, `alembic`), 15 need a Mealie checkout, mirror or opt-in variable, and 2 need `kotlinc` or `codebase-memory-mcp`. **S1 does not exercise the FastAPI guard and behavior paths**, and the baseline does not either; S2 creates the virtual environment first and records the skip count before and after.

**Test-environment incident (not a product defect).** Late in the build the sandbox's commit-signing supervisor started failing with "Too many open files" / "signing failed": it leaked one socket per signed commit, and the test suite creates throwaway git repositories with commits. The suites were run with signing disabled for those temporary repositories only, through environment-level git configuration (`GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=commit.gpgsign GIT_CONFIG_VALUE_0=false`), which changes nothing in the repository or its commits. The supervisor was cleared by a worker restart. **Every commit of this branch is signed**; signing was never bypassed for a real commit. `npm run check` on a machine whose signing works needs no override.

## 5. Estimate versus actual (registered in `docs/design/greenfield-senior.md` section 10, before any build)

Registered labels: judgment ranges, factor-two uncertainty, no calibration claim.

| Item | Registered for S1 | Actual | Reading |
|---|---|---|---|
| Wall time, active | 8 to 14 h | **37 minutes to the last build commit** (S1 start 00:33:27Z, T9 commit 01:10:33Z). **1 h 22 min to the commit of the review fixes and documentation** (01:55:19Z), of which about 28 minutes was waiting for the independent reviewer; verification and this file add about 15 minutes more | the estimate overstated wall time by 5.9 to 10 times at the 1 h 22 min line and by 13 to 23 times at the 37-minute line; the unit was my judgment of effort, the work ran at tool speed. Wall time is not effort or quality: the independent review found 4 blocking and 8 major defects in a tree I had reported as green |
| New production code | 1,600 to 2,400 LOC | **2,309** JavaScript lines (`lib/greenfield`, `bin/eccode-gf.js`; 2,084 at the end of the build, +225 from the review fixes); plus 1,084 lines of schema JSON, 139 of agent and skill markdown, and 19 insertions and 8 deletions in four existing unfrozen files (`lib/mcp.js`, `package.json`, `scripts/hooks/guard.js`, `scripts/validate-toolkit.js`) | within range, at the top |
| New test code | 1,800 to 2,800 LOC | **2,197** test lines plus **534** fixture lines (2,731) | within range, with or without fixtures |
| Tests | 60 to 90 | **382** | 4.2 times over: the table-driven rows (70 mutation rows, each run three ways, plus the review's reproductions) were not in my count; the registered unit was wrong |
| Tokens | 4 to 8 M | **not separable.** The harness reports usage cumulatively from the session's start (00:09Z, which includes G0). The last cumulative figures I recorded, at 01:17Z, before the review and its fixes: output 155,778 tokens, uncached input 172, cache reads 18,300,440, cache writes 743,276, at the harness-reported cost of $5.74. I did not snapshot usage at the start or at the end of S1, so neither an S1-only figure nor a final one exists | the registered unit was ambiguous (generated tokens or all processed tokens); read as output tokens the cumulative total is far below 4 M, read as all processed tokens it is far above 8 M. Neither reading scores the estimate. **Process fix from S2:** register the unit, and snapshot usage at the start and end of each slice |
| Delegated agents | none registered | one independent reviewer, **419,658 tokens, 121 tool uses, 1,678.9 s** as the harness reported them (also in `docs/build/compute-ledger.md`); section 6 | I do not know whether the harness's cumulative figure includes the subagent's tokens |
| Paid runs | $0 | $0 | the cost figure above is this session's own compute, not a benchmark arm |

Outcome predictions registered for S1: **P1** "at least one rule will be found to have a hole by its own bypass test before S1 exits (two to four expected)". Result: **not confirmed by my own bypass tests, confirmed by the independent review.** Before the review, the 60 bypass rows found no hole in a rule; the first mutation check found one untested audit invariant and a fixture bug of mine (a mutation reached `plan.json` through a shared array). The independent review then found holes in rules that my bypass rows said were closed: GF-CON-1 (an OpenAPI hiding operations behind a path-item `$ref`, `security: [{}]` counted as secured, empty schemas), the plan-source rule (the frozen plan gate reads the first `.json`, not `plan.json`), GF-ART (a stage artifact matched by file name), GF-THR-1 (design gate approvable without the security reviewer), GF-PRD-3 (an assumption entry citing another question's assumption). That is at least five rules with a hole (GF-CON-1, GF-WBS-1, GF-ART-2, GF-THR-1, GF-PRD-3), above the two to four expected, but found by a reviewer and not by the process the prediction named. The lesson I take for S2: my bypass tests were written from my own model of the attacker, so they shared the blind spots of the code; an independent attacker per slice is part of the method, not an extra. P2 and P3 concern S4.

## 6. Independent review

**Who and how.** One fresh general-purpose agent, given the code, the design, the plan, the constraints and an instruction to break the work, not my conclusions. 419,658 tokens, 121 tool uses, 1,678.9 s as the harness reported them. The reproductions I wrote from its findings are in the session scratchpad (not in the repository). Every finding below was reproduced as a failing test on the unfixed tree before the fix (the red), then fixed (the green); the code fixes are commit `723ac3e`, the documentation corrections `aa6a7b1`.

**Findings and dispositions** (the same table as `docs/design/greenfield-senior.md` section 15.1; severities are the reviewer's):

| Finding | Severity | Disposition |
|---|---|---|
| B1 the frozen plan gate imports its tasks from the first `.json` artifact, not from `plan.json` | blocking | fixed: `plan.json` must be listed first (GF-WBS-1); the audit compares the engine's tasks with `plan.json` |
| B2 stage artifacts matched by file name let an unvalidated file into the seal | blocking | fixed: each name belongs to one gate (GF-ART-2); the seal reads hashes gate by gate |
| B3 an OpenAPI could hide operations, count `security: [{}]` as secured, or use empty schemas | blocking | fixed (GF-CON-1) |
| B4 `{rel, abs}` entries read any file through the MCP tools | blocking | fixed: strings only; nothing about a probed file appears in a message |
| M1 the hook did not treat `eccode-gf` as the eccode CLI | major | fixed, with a parity test |
| M2 PRD and ADR rules judged against the live design state | major | fixed: each gate is judged against the record at its approval |
| M3 a PRD assumption entry could cite any assumption | major | fixed: its own question's only |
| M4 a failed seal could not be retried | major | fixed: `eccode-gf seal`, `gf_seal` |
| M5 an orphan submission left the audit dirty | major | fixed: only approved submissions need registrations |
| M6 the design gate could be approved without the security reviewer | major | fixed (GF-THR-1), at start and in the audit |
| M7 audit gaps (estimate, message bytes and replies, classification, duplicate requests, unsealed contract files) | major | fixed |
| M8 validators and the audit crashed on malformed input | major | fixed: type guards, a guarded validator wrapper, an audit that never throws; a 400-case seeded fuzz |
| m1 symlinked parent directory, non-regular file | minor | fixed |
| m3 the matrix allowed anonymous on a non-public operation | minor | fixed: anonymous follows `x-gf-public` |
| m5 documentation claims the code does not back | minor | corrected (see below) |
| m2 ReDoS latent in a user `pattern`; unknown formats ignored; unsupported keywords reported only on visited nodes | minor | **named, not fixed**: L-GF-6 (S1 evaluates no user pattern) |
| m4 the three group role names are now reserved by the hook in every ECCode project | minor | **named, not fixed**: L-GF-18 |
| tests that could not fail (audit chain checks, in-lock seal and amendment checks, `amendedProblems`, non-GF fallthrough, ...) | | fixed: `tests/gf-audit-forged.test.js` (24 cases) and `tests/gf-review.test.js` (13); the battery in section 3 was re-run on the final tree |

**What the review corrected in my claims.** Three statements in my own documents were stronger than the code: that a contract edit after the seal is *refused* (it is *detected* by the audit, and refused only by the hook and the wrappers on the managed path; section 9 and L-GF-6 now say so); that the hash chain binds an event to the actor who wrote it (it does not: the log asserts the actor and does not bind it, L-GF-17); and which slice builds the runtime that consumes the contract (S3, run from S4: L-GF-14). In all three the code was right and the wording was wrong, and they were corrected in the wording.

**Four defects in my own fix tests, found while fixing.** Four of the new review tests were wrong, not the code (a message regex; `assume` needs a reading of at least 10 characters; the M5 resubmission model; a "forged seal audits clean" case that failed because projects on the frozen path have no registrations, now narrowed to the seal, estimate and ordering rules). They were corrected before the green run. I did not re-run the corrected versions against the unfixed tree, so for those four the red is the original failure, which was caused by the test, not by the missing fix; the battery in section 3 is the check that they depend on their rules.

**Residual risk I can name.** (1) The reviewer was one agent with one pass; a second independent pass on the final tree has not been done. (2) The hand mutations in section 3 were not repeated after the fixes. (3) Enforcement is prevention on the managed (MCP) path plus guaranteed detection by log-replay audit in all profiles (L-GF-1): a person or agent that uses the plain `eccode` CLI is outside the prevention layer and is caught by `eccode-gf audit`, not stopped. (4) No FastAPI path ran (35 skips).

## 7. Verification on the final tree (commands run from the repository root, 2026-11-04, after commit `aa6a7b1`)

| Check | Result |
|---|---|
| `ECCODE_FREEZE_FILE=bench/pilot/phase2-freeze-v3.json node bench/pilot/phase2-seeds.js check` | `frozen: 48 files, implementation commit see-protocol, frozen at 2026-11-03T13:06:26.810Z`, exit 0 |
| frozen files changed since `948a95b` (`git diff --name-only 948a95b HEAD -- <the 48>`) | none |
| frozen files that require `lib/greenfield` | none |
| `git diff --quiet 948a95b HEAD -- docs/limits.md` | exit 0 (untouched) |
| paths under `scripts/guards/` changed since `948a95b` | 0 |
| `npm run check` (signing disabled for temp repos only) | 951 tests, 902 pass, 0 fail, 49 skipped, 126 s; toolkit validation passed: 15 agents, 10 skills, 13 commands, hooks wired |
| rule-removal battery | 26 of 26 rules fail at least two tests when removed |
| paid benchmark runs | none; meter $0 |
