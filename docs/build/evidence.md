# Evidence log

The requirement-to-evidence table is filled in as work completes. Status values: **Passed** (verified here), **Failed**, **Unverified**.

| Req | Status | Evidence |
|---|---|---|
| R1 | Passed | `docs/evidence/install/` |
| R2 | Passed | `examples/groundwork/.eccode`, `docs/evidence/groundwork/README.md` |
| R3 | Passed (judgement not guaranteed) | `docs/evidence/gate-challenge/` |
| R4a | Passed (application, independently verified) | `docs/evidence/groundwork/independent-verification/` |
| R4b | **Failed** (delivery gate escalated, audit failing) | `docs/evidence/groundwork/README.md` |
| R5 | Passed | `docs/evidence/resume-demo/`, `docs/evidence/groundwork/` |
| R6 | Passed within limits | `docs/evidence/learning-round1`, `learning-round2`, `debug-lesson`, `self-improvement` |
| R7 | **Failed** (E1 both rounds; E3 round 2; E4 round 1) | `eval/results/round1`, `eval/results/round2` |

Full table with reasoning: `docs/acceptance-report.md`.

## Check runs

| When | Check | Result |
|---|---|---|
| 2026-10-08 | `npm run check` (baseline) | 51/51 pass |
| 2026-10-08 | `claude -p "Reply with exactly: PONG"` (isolated config, `--plugin-dir`) | `PONG`, $0.036, SessionStart hook ok |
| 2026-10-09 | `npm run check` | 136/136 pass |
| 2026-10-09 | `scripts/verify-install.js --live` | all steps PASS (`docs/evidence/install/verify-install.txt`) |
