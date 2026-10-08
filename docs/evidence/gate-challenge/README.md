# Gate challenge evidence (requirement R3)

`eval/gate-challenge/run.js` drives a real ECCode delivery in which an **incomplete design** and a **defective implementation** are deliberately submitted. Reviews and corrections are performed by fresh, real Claude Code sessions in the ECCode roles (`--agent eccode:<role>`), in the sandbox of `eval/harness/sandbox.sh`. Reviewers get no hint about the planted defects. The ground truth is in `eval/gate-challenge/ground-truth.json` and is never visible to a session.

## run5-complete (the reference run, ECCode commit 7ac6ecd)

| Gate | Rejected before approval | Reviewers (fresh session each) |
|---|---|---|
| architecture | 1 | architecture-reviewer: changes_requested → approve |
| design | 1 | technical-reviewer: changes_requested → approve |
| plan | 1 | technical-reviewer: changes_requested → approve |
| phase:core | 1 | security-reviewer: changes_requested → approve |

- Corrections: three document revisions by fresh `product-architect`, `technical-designer` and `delivery-lead` sessions, and one implementation fix by a fresh `backend-engineer` session that claimed the reset task, added regression tests and resubmitted with `--responds-to`.
- **Engine probes, all refused:** a gate started before its predecessor was approved; a design missing required sections (`MISSING_SECTIONS`); the design author approving their own design; an approval without evidence; a task claimed before its phase gate started.
- Cost $1.37 over 12 sessions. `project-record/` is the complete, hash-chained record (53 events; `eccode audit` passes: copy it to a directory as `.eccode` to re-check). Session transcripts are in `sessions/`.

### Were the planted defects found? (manual reading, not the keyword heuristic in `summary.json`)
| Planted defect | Named in the first rejection? |
|---|---|
| DG1 design: Security section is "TBD" | yes (blocking) |
| DG2 design contradicts the brief (any user can fetch any note) | yes (blocking) |
| DG3 design: manual-only testing against an automated-test criterion | yes (major) |
| DG4 design: no status codes / error contract / limits | yes (blocking) |
| IM1 implementation: IDOR on `GET /notes/:id` | **yes (blocking), with a live probe as evidence** |
| IM3 implementation: stack trace in 500 body for malformed JSON | **yes (blocking), with a live probe as evidence** |
| IM2 implementation: no title/body validation | **partly**: an unbounded body was noted as `info`; missing field validation was not named |
| IM4 implementation: tests do not cover isolation or validation | **no** |

So the design review caught 4/4 and the implementation review caught the 2 security-critical defects (2/4 fully). The `detection` block in `summary.json` uses a keyword heuristic and over-credits IM2 and IM4: ignore it in favour of this table.

## run4-escalation
Same fixture with the default limit `maxReviewIterations: 3`: the strict architecture reviewer requested changes three times, and the gate **escalated to the user** (`status: escalated`), as the engine's iteration limit prescribes. Kept as evidence of the escalation rule; run 5 uses `maxReviewIterations: 5` (a documented per-project setting).

## Driver history (honest notes)
Runs 1–3 stopped early on driver bugs (a fixture brief that lacked a delete criterion, which the blind reviewer correctly flagged; a plan author restructuring the plan; `--root` placed after the command separator). Each was fixed in the driver, not by loosening any gate.
