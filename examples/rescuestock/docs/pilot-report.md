# ECCode pilot report: RescueStock (in progress)

**Purpose.** Record how ECCode 0.3.0 performed while delivering RescueStock, with enough detail to judge the toolkit without trusting agent summaries. The record of truth is `examples/rescuestock/.eccode/events.jsonl` (hash-chained); this page is derived from it plus the orchestrator's notes. RescueStock is a case study its developers know; nothing here is a benchmark result and nothing here revises the failed requirement-7 verdict in `docs/acceptance-report.md`.

## Versions
| Component | Version |
|---|---|
| ECCode toolkit | 0.3.0 at `5da8913` (+ guard repair `cde0b84` on `eccode/win32-guard-paths`, merged only after independent review; the pilot version is frozen in `docs/build/state.md` when the readiness gate passes) |
| Host | Claude Code cloud session, Linux 6.18, Node 22.22.0 |
| Orchestrator model | the session's model (`claude-fable-5-1` configured) |
| Role agents | `general-purpose` subagents given the ECCode role prompts (`agents/<role>.md`) and the CLI string with `--actor <role>`; the PreToolUse guard is **not installed** in this harness, so identity binding and ownership are enforced by the engine's rules at record time, not at tool-call time (disclosed deviation D1) |

## Dispatch log (one row per `run start`/`run end`)
| Run | Role | Gate/task | Outcome | Tokens | Notes |
|---|---|---|---|---|---|
| run-mv15q6zy | product-architect | architecture | brief submitted `sub-mv15wpmr-015f7530`; 45 required criteria; RISK-1..12; handoff recorded | 115,409 | one memory search (empty store) |
| run-mv15ybi7 | architecture-reviewer (generic `general-purpose` agent type) | architecture | **failed**: draft review written (changes_requested, ARCH-1..18, 45/45 coverage) but `gate review` refused by the now-active guard: identity mismatch `other:general-purpose` vs `architecture-reviewer`. The agent did not work around the control | 167,200 | the guard did its job; the dispatch was wrong, not the engine |
| run-mv16bo0q | architecture-reviewer (ECCode agent type) | architecture | `rev-mv16o544-0127ccbf` changes_requested: 7 major (ARCH-1..6, 19), 12 minor, 3 info; 45/45 coverage; 5 recorded evidence runs (fixture brute force, two-process SQLite race, node:sqlite flags, text checks, cookie/regex checks) | 143,737 | the guard denied its Write to the nested project's `.eccode/reviews/drafts/` (nested-root defect); the review was recorded from a scratch path, which the engine accepts. Every finding of the failed first attempt was re-verified and upheld |
| run-mv1aok2v | product-architect (resubmission on 0.3.1) | architecture | revision 2 placed and submitted `sub-mv1awqkf-017ea892` (responds to rev-mv16o544); 45 ids confirmed; the agent re-checked the preserved revision and made three documented changes (RS-32 vs the stock-depletion fault, the void rule for an in-flight authorize, NFR1 pass condition for either Node floor); handoff recorded. **Guard refused nothing** | 145,724 | first dispatch after the toolkit checkpoint; the nested-root repair works in practice |
| run-mv1ay9m5 | architecture-reviewer (re-review) | architecture | **approved** `rev-mv1bcexb-01d7960e`: 45/45 required criteria + 11 checklist criteria; ARCH-1..21 confirmed resolved with locations; 5 new minors (ARCH-22..26: unknown-authorize void, RS-20 wording, Node 22.5 child flag, authentication contract, saga lease fencing) carried to design; 5 recorded checks incl. the reviewer's own planner solver (one-bundle inventory is the only one of 27 that satisfies RS-06/09/10/11) | 179,120 | review findings were all substantive; the guard's inline-program rule forced the reviewer to run its checks as files under drafts (friction noted) |
| run-mv1bdkwx | technical-designer | design | (pending) | | |
| run-mv16pz5f | product-architect (revision) | architecture | **failed to place**: full revision written (addresses every finding; 45 ids preserved; RISK-13..18 recorded; 2 evidence runs) but every write under `.eccode/artifacts/` denied by the same nested-root defect; files preserved under `docs/evidence/verification-0.3.0/pilot-blocked-nested-root/`. The agent asked the orchestrator to copy them in; refused (the orchestrator does not place a role's artifacts). Resumes after the guard repair is reviewed and installed | 228,734 | **toolkit repair triggered by the pilot** (guard nested root); repaired on `eccode/guard-repairs` with a regression test, under independent review |

## Review findings and their validity
(filled per gate)

## Defects caught before integration / escaped review
(filled per phase)

## Human interventions
| When | What | Why |
|---|---|---|
| 2026-10-09 16:14 | Installed the ECCode hooks at user scope, then could not remove them (permission classifier); asked the user to run `echo '{}' > ~/.claude/settings.json` or approve the edit | Needed to decide whether the guard can run in this harness: it can, but identity binding needs ECCode agent types the harness does not offer |
| 2026-10-09 | `eccode init` without `--root` wrote a `decision.add` into the **toolkit's** record instead of the project's; the uncommitted record files were restored from git before anything else was recorded | Orchestrator error: the CLI walks up to the nearest `.eccode/`. Lesson candidate for the orchestrate skill: always pass `--root` for a project nested in a repository that has its own record |

## Learning cycle (real bug, not seeded)
| Step | What happened | Record |
|---|---|---|
| 1. Capture | The guard judged the nested project by the outer repository's record: the reviewer could not write `examples/rescuestock/.eccode/reviews/drafts/`, the architect could not write `.eccode/artifacts/` (two dispatches failed) | pilot runs run-mv16bo0q, run-mv16pz5f |
| 2. Reproduce | Check script `.eccode/drafts/nested-root-check.js` (toolkit record): exit 1 with the pre-repair guard (commit a088c6a), reproducing the exact denial text | toolkit `ev-mv1aqo8u-01378a06` (purpose reproduction) |
| 3. Investigate and research | Cause: root resolved from `CLAUDE_PROJECT_DIR` and lexically; three pattern-based attempts rejected by independent review (planted record, record alias, two-turn chained alias) before the real-path restructure | `docs/evidence/verification-0.3.0/guard-repairs-review/REVIEW.md` (five rounds) |
| 4. Repair and verify | Toolkit 0.3.1; the same check exits 0; guard suites 30/30 | `ev-mv1aqrh5-0115da0c`, `ev-mv1ar25z-01bc1bdf` |
| 5. Independent review of the repair | Approved at 1fcda26 after five rounds | REVIEW.md |
| 6. Lesson | Recorded by `learning-debugger` as `mem-d-mv1audrd-013b7102` (debugging layer, provisional); **rejected** by `technical-reviewer` on first review: a false symptom, an over-broad exclusion, incomplete failed attempts (the analysis itself confirmed with the reviewer's own two runs `ev-mv1awbyi-01602693`, `ev-mv1awc9p-01af8d8c`); revised to rev 2 (new evidence pinning the guard's sha256: `ev-mv1b0cid-0189968e` fails, `ev-mv1b0exx-018a8c87` passes) and **verified**; promotion then **refused by the privacy scan** (`PRIVATE_DATA`: file URLs, absolute paths); rev 3 replaced the sources with commit-pinned GitHub URLs, was re-verified, and the orchestrator promoted it as `mem-sd-mv1audrd-013b7102` (shared store audit: chain intact) | toolkit record; `~/.eccode/memory/records/mem-sd-mv1audrd-013b7102.json` |
| 7. Retrieve in a fresh session on a related task | A fresh `learning-debugger` context, asked to establish whether the guard lets every example project's roles write their own draft areas, searched memory first, retrieved both the project lesson and the shared copy with verdict `applies`, tested the claim with a 720-expectation probe over triage-desk, groundwork and rescuestock (all pass), recorded `memory assess --verdict applies` for both and cited them (toolkit events seq 41–44) | toolkit `ev-mv1bc7rx-011a2185` |
| 8. Reject on a superficially similar, different-cause task | pending: a reviewer denied for writing outside its draft area in the correct project (same message, different cause) | — |

Toolkit observations from the cycle (not lessons): the tree digest excludes `.eccode/`, so two evidence runs that differ only in a file under `.eccode/drafts/` carry the same digest and the log must pin the file (the check now prints the guard's sha256); a heredoc whose text names a record path after a redirect is refused even when it writes a draft (the Write tool is the documented route).

## Deviations from the pure workflow
- D1 Guard not active in this harness for the first two dispatches (product-architect, architecture-reviewer). At 16:14 the orchestrator installed the hooks at user scope (`eccode install --scope user`) to remove this deviation; the guard became active immediately (it denied the orchestrator's own `--actor user` probe). Consequence discovered next: this harness exposes only generic subagent types (`general-purpose`, …), so the guard reads every role agent as `other:general-purpose` and denies its `--actor <role>` commands as an identity mismatch, and the main session cannot act as a role either (sequential mode needs `ECCODE_SEQUENTIAL_ROLES=1` in the hook's environment). Reverting the settings file was refused by the session's permission classifier (self-modification), so the hooks stay until the user removes them. Role dispatches were paused at that point; nothing was bypassed. **Resolved at 16:40:** the same user-scope install had registered the twelve ECCode agent definitions (`~/.claude/agents/`), and the harness picked them up as subagent types, so from the third dispatch on every role runs as its own agent type with the guard active and identity bound. D1 therefore applies to runs 1–2 only. The guard also denied the orchestrator's own documentation edit made through an inline Python heredoc whose text mentioned the CLI ("runs a command through a variable or substitution"), a false positive worth a lesson: the guard reads any word containing "eccode" as a possible invocation.
- D2 Reviewers and authors are separate agent contexts, but the same orchestrator wrote every dispatch prompt.
