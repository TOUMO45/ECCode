# Changelog

## 0.2.0 — 2026-10-09

This branch (`claude/funny-feynman-rt1io9`) starts from the full `claude/brave-bardeen-6y5ng9` build: the engine fixes for the 22 findings of the independent review (regression tests `#1`–`#22` in `tests/security-regressions.test.js` and `tests/hooks-install.test.js`), reworks, reconciliation, lesson decisions at the plan and the claim, the learning switch, the Stop hook, the evaluation suite, the Groundwork delivery and the acceptance report. On top of that, after a full re-read of the evidence (`docs/acceptance-report.md`, `docs/evidence/*/README.md`, the TriageDesk record and its verification review):

### Engine and CLI
- **Shipped records are replayed by the test suite.** `tests/records-replay.test.js` audits the TriageDesk, Groundwork, learning-cycle and toolkit records (hash chain, snapshot equals replay, approved artifacts unchanged) and checks the figures the reports cite (9 and 13 approved gates, 5 and 36 engine refusals, the operator's `gate.reopened` on `verification`). A reducer change can no longer drift from the published evidence.
- **Audit distinguishes pending re-review from unreviewed edits.** A file changed after approval whose current hash is already submitted to a later, not-yet-approved gate is reported as "Pending re-review" (a warning, exit 0) instead of a failure; delivery stays strict about both. This is the TriageDesk VER-2 situation, where the verification submission carried the final report versions and `eccode audit` said FAILED.
- **The final handoff lists every `--actor user` event** ("User decisions"), stating that they were entered on the user's behalf by whoever ran the CLI. The Groundwork delivery closed on operator interventions recorded as `--actor user`; the handoff now makes them visible instead of leaving them to the evidence README.
- **JSON inputs** (`--file`, `plan validate <file>`) resolve from the current directory, then the project root; a missing file is a `NOT_FOUND` refusal, not a stack trace.
- **`plan validate` warns** about ownership globs that point into `.eccode/` (other than `drafts/`): they never grant ownership, so a plan listing them is mistaken about what its tasks may write.

### Docs
- `docs/final-report.md` §6 records what this increment closed; `docs/usage.md` and `docs/architecture.md` describe the audit warning and the handoff section.

### Tests
- 144 (136 on the base branch, plus 5 record-replay tests and 3 delivery/CLI tests).

## 0.1.0 — 2026-10-07

Initial release: 12 agents, 7 skills, 6 commands, 2 hooks, zero-dependency engine with code-enforced review gates, event-sourced record, four-layer engineering memory and controlled self-improvement. TriageDesk demonstration delivered through every gate.
