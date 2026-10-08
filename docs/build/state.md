# State

**Branch:** `claude/brave-bardeen-6y5ng9` (not pushed yet). Toolkit frozen for the official evaluation at the commit in `eval/suite/frozen-toolkit.json`.

## Done and committed
- Engine: `run end` requires usage; learning switch; resume reconciliation (`eccode reconcile`); change profile and `/eccode:change`; `memory assess`; **rework path** (scoped, independently reviewed fixes after approval/delivery); **lessons enforced at the decision point** (retrieval at `task claim`, a recorded decision per lesson at completion); promotion scrubbing; Stop-hook completion gate for unattended runs; `bin/eccode` on PATH for plugin sessions; `eccode template`; `run start --agent`.
- 22 independently reproduced engine defects fixed (suite 62 → 126 tests, all passing).
- Evaluation suite: kit, 6 tune tasks, 6 sealed holdout tasks (independent author), predeclared targets, sandboxed harness, frozen hashes.
- R3 evidence: `docs/evidence/gate-challenge/` (complete run + escalation run).
- Install verification: `scripts/verify-install.js --live` passes in a clean config dir.

## Running now
- **Official evaluation:** `/srv/eccode-eval/official` (`pipeline.log`, `train.log`, `holdout.log`). Training (3 conditions × 6 tune tasks, with feedback) then holdout (3 conditions × 6 tasks × 3 repeats). Then run `node eval/harness/report.js --run /srv/eccode-eval/official --out eval/results`.

## Next actions (in order)
1. When the pipeline finishes: report, read the results honestly, record failures and tradeoffs. Do **not** tune the toolkit on holdout results; any change after this point is post-evaluation and must be disclosed as such.
2. Demo delivery (R1/R2/R4/R5): `node eval/demo/run-demo.js --toolkits /srv/eccode-eval/official/toolkits --out /srv/eccode-eval/demo --scope docs/build/demo-scope.md`. Start it only after the evaluation finishes (API load would distort trial timing).
3. R5 resume demo on a small task: `eval/harness/resume-demo.js`.
4. R6 evidence collection from the official run: lessons (training), retrieval and decisions (holdout C2), decoy dismissals; executed self-improvement + rollback demo (scratch project, adoption labelled as operator-simulated).
5. Acceptance report `docs/acceptance-report.md`; update README and `docs/final-report.md`; push the branch (no PR unless asked).

## Decisions
- D1: live AI in this environment goes through the Claude Code CLI (no API key).
- D2: R3 proven by the gate challenge with blind reviewers.
- D3: R7 targets frozen before tuning (commit `38e2ce8`); disclosures in `eval/suite/frozen-toolkit.json`.
- D4: rework path added (the original report's "no hotfix path" limitation) after the pilot showed the learning loop deadlocking on approved gates.
- D5: Stop hook added after the pilot showed unattended orchestrators skipping the workflow.

## Restart steps
1. `cd /home/user/ECCode && git log --oneline -10 && npm run check`
2. Read this file, `docs/build/plan.md`, `docs/build/evidence.md`.
3. Evaluation workspace: `/srv/eccode-eval/official`. Pilot data under `/srv/eccode-eval/pilot-*` and `/home/user/eval-work` (not part of results).
