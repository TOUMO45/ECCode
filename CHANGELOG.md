# Changelog

## 0.2.0 — 2026-10-09

This branch (`claude/funny-feynman-rt1io9`) starts from the full `claude/brave-bardeen-6y5ng9` build: the engine fixes for the 22 findings of the independent review (regression tests `#1`–`#22` in `tests/security-regressions.test.js` and `tests/hooks-install.test.js`), reworks, reconciliation, lesson decisions at the plan and the claim, the learning switch, the Stop hook, the evaluation suite, the Groundwork delivery and the acceptance report. On top of that, after a full re-read of the evidence (`docs/acceptance-report.md`, `docs/evidence/*/README.md`, the TriageDesk record and its verification review):

### Engine and CLI
- **Nine findings of a fresh-context red team closed, each with a regression test** (`tests/redteam-regressions.test.js`, RT1–RT9; the repro scripts were kept and re-run before fixing): symlinks inside task ownership reached the record (RT1); undeclared changes inside ownership were never pinned (RT2); plan ids `rework-N` collided with engine reworks (RT3); audit and status crashed with a TypeError on a tampered log instead of reporting `CORRUPT_LOG` (RT4); repeated `**/` globs were exponential and could hang the guard (RT5); implementer shell writes (redirects, `tee`, `cp`, `sed -i`) ignored ownership and `.git/` metadata was writable (RT6); a plausible `**/*.json` glob owned `.claude/settings.json` (RT7); secrets in `--label`, `--note`, handoff and review JSON reached the record and the handoff (RT8); a blocking finding pre-marked resolved without evidence passed (RT9).
- **`eccode rework extend <id> --files … --reason …`** (orchestrator or user) widens a pending rework after its review shows the defect reaches another file. Found while running Groundwork's rework-5: the independent reviewer rejected it because the same defect exists on the published-postmortem page, outside the rework's scope, and no engine path could widen it.
- **Post-delivery reworks work in the full delivery profile.** `rework open` on a record whose verification gate is approved told the user to reopen verification, but `gate reopen` accepted only escalated gates, so a defect found after delivery could not be fixed through the gates (found while fixing Groundwork's open defect). The user may now reopen an approved `verification` gate (`previousApprovals` keeps the earlier approval; the gate returns to `in_progress`), open a rework past `maxReworks`, and verification is redone before the next delivery. Approved phases and documents still cannot be reopened. Test: `tests/rework.test.js` "delivery profile".
- **Shipped records are replayed by the test suite.** `tests/records-replay.test.js` audits the TriageDesk, Groundwork, learning-cycle and toolkit records (hash chain, snapshot equals replay, approved artifacts unchanged) and checks the figures the reports cite (9 and 13 approved gates, 5 and 36 engine refusals, the operator's `gate.reopened` on `verification`). A reducer change can no longer drift from the published evidence.
- **Audit distinguishes pending re-review from unreviewed edits.** A file changed after approval whose current hash is already submitted to a later, not-yet-approved gate is reported as "Pending re-review" (a warning, exit 0) instead of a failure; delivery stays strict about both. This is the TriageDesk VER-2 situation, where the verification submission carried the final report versions and `eccode audit` said FAILED.
- **The final handoff lists every `--actor user` event** ("User decisions"), stating that they were entered on the user's behalf by whoever ran the CLI. The Groundwork delivery closed on operator interventions recorded as `--actor user`; the handoff now makes them visible instead of leaving them to the evidence README.
- **JSON inputs** (`--file`, `plan validate <file>`) resolve from the current directory, then the project root; a missing file is a `NOT_FOUND` refusal, not a stack trace.
- **`plan validate` warns** about ownership globs that point into `.eccode/` (other than `drafts/`): they never grant ownership, so a plan listing them is mistaken about what its tasks may write.

### Groundwork example
- The cosmetic `null` defect left open at delivery was fixed by rework-5 through the gates (user reopened verification; implementer, technical-reviewer, delivery-lead and security-reviewer as separate subagents; rejected once for the same defect on the postmortem page, then approved, re-verified on 228 files, re-delivered as `final-handoff-2.md`). `.env.example` added; the browser journey scans every audited page for stray text. Record: 786 events, audit OK.

### Docs and process
- `docs/threat-model.md`: assets, attacker models, every control with its test, residual risks.
- `.github/workflows/ci.yml`: toolkit suite on Ubuntu and macOS (Node 18.17/20/22), Groundwork suite on Node 22, record re-audit; Windows experimental.
- `orchestrate` skill: choose between the full delivery and change mode before starting, with the evaluation's cost finding as the reason.
- `docs/architecture.md` "Record compatibility" and `docs/usage.md` "Releases and compatibility".
- `docs/final-report.md` §5 records what this increment closed and diagnoses Groundwork's cosmetic `null` (native `append` with a `null` child) without editing the delivered record.
- `orchestrate` skill §7: a missing review, check or handoff is the orchestrator's to dispatch; the user is asked only for `USER_AUTH_REQUIRED` actions and scope or compliance questions (the rule the round-2 E3 escalation violated).
- Three hand-over packages so that each open item closes with one reply: `docs/sign-off.md` (product-owner decisions with the exact `--actor user` commands), `eval/suite/round3-protocol-DRAFT.md` (a new, pre-registrable claim for a third evaluation round, not a rescue of R7) and `docs/security-review-request.md` (scope and method for an outside human review). `docs/review-bundle-task.md`: the brief for reading the review-evidence bundle on the machine that holds it (it was unreachable from the cloud session).

### Tests
- 155 (136 on the base branch, plus 5 record-replay tests, 3 delivery/CLI tests, 2 rework tests and 9 red-team regressions).

## 0.1.0 — 2026-10-07

Initial release: 12 agents, 7 skills, 6 commands, 2 hooks, zero-dependency engine with code-enforced review gates, event-sourced record, four-layer engineering memory and controlled self-improvement. TriageDesk demonstration delivered through every gate.
