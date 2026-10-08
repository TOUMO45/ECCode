# Evidence log

The requirement-to-evidence table is filled in as work completes. Status values: **Passed** (verified here), **Failed**, **Unverified**.

| Req | Status | Evidence |
|---|---|---|
| R1 | Unverified | — |
| R2 | Unverified | Prior: `examples/triage-desk/.eccode` (v1 demo) |
| R3 | Unverified | — |
| R4 | Failed (no DB, no access control, live AI unverified) | `examples/triage-desk/README.md` |
| R5 | Unverified | — |
| R6 | Unverified (parts 2 and 3 missing) | `docs/final-report.md` §3 |
| R7 | Unverified | — |

## Check runs

| When | Check | Result |
|---|---|---|
| 2026-10-08 | `npm run check` (baseline) | 51/51 pass |
| 2026-10-08 | `claude -p "Reply with exactly: PONG"` (isolated config, `--plugin-dir`) | `PONG`, $0.036, SessionStart hook ok |
