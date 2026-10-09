# State

**Branch:** `claude/brave-bardeen-6y5ng9`. Final status: see [docs/acceptance-report.md](../acceptance-report.md) (not accepted: R7 failed).

## Done and committed
- Engine, skills, agents, hooks; 136 tests (`npm run check`).
- Evaluation: round 1 (toolkit v1, 12 tasks) and round 2 (toolkit v2, 6 new tasks) with results, analyses, sensitivity runs.
- Evidence: install, gate challenge (R3), interrupt/resume (R5), Groundwork delivery with independent verification (R4a), learning (rounds 1 and 2), debugging lesson, self-improvement and rollback.
- Toolkit defects found by this work and fixed with tests: lesson decisions at the plan, `/eccode:investigate` without a project, replaceable unreviewed submissions, reopen without waiving, audit of deletions by approved reworks.

## Not done
- R7: the predeclared targets E1 (both rounds), E3 (round 2) and E4 (round 1) were not met.
- (Closed after the first version of this file: Groundwork was delivered, audit OK, with disclosed operator interventions.)

## Restart steps
1. `cd /home/user/ECCode && git log --oneline -15 && npm run check`
2. Read `docs/acceptance-report.md` and `docs/evidence/groundwork/README.md`.
3. Run directories (outside the repo, not preserved across sessions): `/srv/eccode-eval/{official,round2,demo,...}`. Everything needed to audit them is copied under `docs/evidence/` and `eval/results/`.
