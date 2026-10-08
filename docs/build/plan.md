# Plan

## Gap audit (2026-10-08, starting state `d2d0c24`)

| Req | Existing evidence | Gap |
|---|---|---|
| R1 | `npm run check` 51/51. Plugin was installed once into an isolated config (Claude Code 2.1.293). Limits exist in `lib/config.js`. | No recorded clean install **plus demo run** under this goal. The guard hook was never live in a real session. |
| R2 | TriageDesk record (`examples/triage-desk/.eccode`): 45 runs, 17 tasks, handoffs, reviews. | Handoffs record decisions and unresolved issues, but this needs checking per handoff. Execution was recorded only via `run` events: no raw session transcripts were kept. |
| R3 | Doc gates were rejected once each because of real defects. | No **intentional** incomplete design and no **intentional** defective code. No implementation-phase rejection is on record. |
| R4 | TriageDesk: UI, API, AI with fallback, 439 tests, evals. | **No database. No authentication or authorisation. The live AI path never ran.** The holdout floor was missed and SC2 amended (RISK-12). |
| R5 | Event-sourced store, `resume`, `recover`, tests. | `resume` does **not** reconcile the record with files or test results. No fresh-session resume has been demonstrated. |
| R6 | Lesson verified and reviewed. Reuse by a fresh *subagent* in another project. Rejection on **environment** grounds. Review-gate skill v1 adopted. | Reuse has not been shown in a fresh **session**. Rejection when **similar symptoms have a different cause** has not been shown. A rollback has never actually been executed. |
| R7 | — | **Nothing yet:** no suite, no targets, no baseline, no trials. |
| Bugs | Final report §6: `run end` accepts missing usage. There is no hotfix path for approved phases. | A fresh independent bug hunt is still needed. |

## Workstreams, in dependency order

1. **W1 – Toolkit fixes (TDD).**
   - W1a: `run end` requires usage, with an explicit `--no-usage` escape that is recorded.
   - W1b: a learning on/off switch (`ECCODE_LEARNING=off` or `memory.learning:false`) for the R7 C1 condition.
   - W1c: `eccode resume --reconcile` checks approved-artifact hashes, files changed by interrupted claims and git state, and re-runs the recorded checks (`--verify`). The result goes on the record as evidence.
   - W1d: independent bug hunt over `lib/` and `bin/`, then fixes with regression tests.
2. **W2 – Live model adapter.** A `claude-cli` provider that calls `claude -p` with no tools, a fixed system prompt and JSON output. It gives the demo app a real model path in this environment and is labelled as such. The direct API adapter stays.
3. **W6 – Evaluation suite (R7).** Define the tasks, conditions, metrics and **numerical targets**, and commit them (frozen and hashed) **before** any tuning. Build a harness that runs headless trials per condition with isolated config dirs, the same model, the same `--max-budget-usd` and timeouts. Pilot only on tune tasks. Tune the toolkit on tune tasks. Run the holdout once, with repeats.
4. **W3 – Demonstration app (R4, R2, R1, R5).**
   - A new idea is delivered by a **headless orchestrator session** with the plugin installed from the docs (guard hook live) through `/eccode:start`.
   - Scope is the R4 list.
   - Interrupt it mid-phase (SIGKILL), then resume in a **fresh session** with `/eccode:resume`, reconciling first (R5).
5. **W4 – Gate challenge (R3).** A scripted fixture project:
   - Deliberately incomplete design and deliberately defective code are submitted.
   - **Blind** reviewer sessions (fresh `claude -p`, reviewer role, not told about the defects) review them.
   - A rejection, correction and re-review must be recorded.
   - Engine refusals (self-approval, no evidence, stale artifact) are also exercised.
6. **W5 – Learning demos (R6).** These come out of W6 tasks run in fresh sessions:
   - A related-family holdout task gives reuse.
   - A decoy task (same symptom, different cause) gives rejection.
   - Plus one executed rollback of an adopted workflow change.
7. **FA – Acceptance package.** `docs/acceptance-report.md` marks each requirement Passed / Failed / Unverified with evidence links. Update the README and final report.

## Next executable task

See `state.md`.
