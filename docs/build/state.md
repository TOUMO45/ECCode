# State

**Branch:** `claude/brave-bardeen-6y5ng9`. Final status: see [docs/acceptance-report.md](../acceptance-report.md) (not accepted: R7 failed).

## Done and committed
- Engine, skills, agents, hooks; 136 tests (`npm run check`).
- Evaluation: round 1 (toolkit v1, 12 tasks) and round 2 (toolkit v2, 6 new tasks) with results, analyses, sensitivity runs.
- Evidence: install, gate challenge (R3), interrupt/resume (R5), Groundwork delivery with independent verification (R4a), learning (rounds 1 and 2), debugging lesson, self-improvement and rollback.
- Toolkit defects found by this work and fixed with tests: lesson decisions at the plan, `/eccode:investigate` without a project, replaceable unreviewed submissions, reopen without waiving, audit of deletions by approved reworks.

## Follow-up branch `claude/funny-feynman-rt1io9` (2026-10-09)
- Starts from this branch's head. Groundwork rework-5 fixed the open cosmetic defect through the gates (second delivery). Engine: post-delivery reopen of verification, rework extend, nine red-team fixes (RT1–RT9). Adds: record-replay tests over all shipped records, audit "pending re-review" warnings, user decisions in the final handoff, JSON path resolution from the project root, plan-glob warnings. 155 tests. Hand-over packages for the items that need a person: `docs/sign-off.md`, `eval/suite/round3-protocol-DRAFT.md`, `docs/security-review-request.md`. See `CHANGELOG.md` and `docs/final-report.md` §5.

## Version 0.3.0 (2026-10-09, same branch)
- The independent review bundle was uploaded and read; its nine findings (F1–F9) are closed with 78 regression tests in `tests/review-F*.test.js` (233 tests in all). Stricter engine: criteria coverage, declared checks, release tree, human channel with delegations, release-risk policy, memory attestation, snapshot digests, run limits, portability. Mapping: `docs/evidence/review-bundle/README.md`. Windows unverified (CI reports). Groundwork's Windows fixture failures left for a rework the owner can order.

## Not done
- R7: the predeclared targets E1 (both rounds), E3 (round 2) and E4 (round 1) were not met.
- (Closed after the first version of this file: Groundwork was delivered, audit OK, with disclosed operator interventions.)

## Restart steps
1. `cd /home/user/ECCode && git log --oneline -15 && npm run check`
2. Read `docs/acceptance-report.md` and `docs/evidence/groundwork/README.md`.
3. Run directories (outside the repo, not preserved across sessions): `/srv/eccode-eval/{official,round2,demo,...}`. Everything needed to audit them is copied under `docs/evidence/` and `eval/results/`.
