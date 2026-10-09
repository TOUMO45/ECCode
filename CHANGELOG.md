# Changelog

## 0.2.0 — 2026-10-09

Driven by a full re-read of the TriageDesk delivery evidence (`docs/final-report.md` §5–§6, the verification review VER-1/VER-2, RISK-10/RISK-11 and the provisional run-accounting lesson). Every engine change ships with a test; the three shipped records are replayed by the suite.

### Engine
- **Hotfix tasks.** `eccode task hotfix --file <task.json> --for <approved gate> --reason <text> [--phase hotfix-n]` schedules a scoped fix to files an approved gate covers. The engine opens `phase:hotfix-<n>` right after the last approved gate (always before `verification`); the fix is claimed, handed off with a passing check and independently re-reviewed, and its approved hashes supersede the earlier approval at delivery. Refused by the engine: wrong actor, non-approved target, globs that cover the record, overlap with an active claim, after verification approval, after delivery. New event `task.hotfix_added`; new template `templates/hotfix.json`.
- **Run usage is reported, never estimated.** `run end --status ok` requires `--tokens <n>` (`USAGE_REQUIRED`) unless `--no-usage` states that the harness reported none; non-numeric token values are refused. The event records `usageReported`.
- **Audit distinguishes pending re-review from unreviewed edits.** A file changed after approval whose current hash is already submitted to a later, not-yet-approved gate is reported as "pending re-review" (warning, exit 0) instead of a failure. Delivery remains strict.
- **Plan validation protects the record.** Ownership globs that could match `.eccode/` events, state, config, evidence, reviews, handoffs or memory are refused; artifacts under `.eccode/artifacts/` may still be owned.
- **Final handoff** lists hotfixes (what they fixed, where they were re-approved) and every `--actor user` event, stating that these were entered by the orchestrator on the user's behalf.
- **CLI.** JSON inputs resolve from the current directory, then the project root; a missing file is a `NOT_FOUND` refusal, not a stack trace. Duplicate artifact paths are deduplicated after normalisation. `evidence run` help lists `--cwd` and `--timeout`.

### Prompts and docs
- `orchestrate`: wait for the usage block before closing a run, never batch `run end`, commit at gate approvals, hotfix procedure, new failure-handling rows.
- `delivery-lead`, `technical-reviewer`: how to schedule and how to review a hotfix.
- README, `docs/usage.md`, `docs/architecture.md`: the new commands, rules, troubleshooting rows and limitations. `docs/final-report.md` §7 maps each closed gap to its test.

### Tests
- `tests/hotfix.test.js` (4), `tests/records-replay.test.js` (4), three new cases in `tests/resume-delivery.test.js`. Suite: 62 tests.

## 0.1.0 — 2026-10-07

Initial release: 12 agents, 7 skills, 6 commands, 2 hooks, zero-dependency engine with code-enforced review gates, event-sourced record, four-layer engineering memory and controlled self-improvement. TriageDesk demonstration delivered through every gate.
