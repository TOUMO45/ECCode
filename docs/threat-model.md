# ECCode threat model

**Scope:** the toolkit (engine, CLI, hooks, prompts, memory) as installed in a Claude Code project. The applications a team builds with it have their own threat models; TriageDesk and Groundwork carry theirs in their design artifacts.
**Status:** written from the code and its tests on 2026-10-09. Each control names the test that exercises it. "Residual" means the toolkit does not close the risk and says so; it is not a promise of future work. No outside security review has been done.

## 1. What is protected

| Asset | Why it matters |
|---|---|
| The project record (`.eccode/events.jsonl`, `state.json`) | The hash-chained history every approval, delivery and handoff is derived from. If it can be rewritten, "verified" means nothing. |
| Approved artifacts and the files phase approvals pinned | A delivery claims these are the reviewed bytes. |
| Evidence logs (`.eccode/evidence/`) | The executed checks reviews cite; also where secrets would leak. |
| Reviews, handoffs, decisions, risks | The independence and user-authority claims. |
| Memory records and the shared memory store (`~/.eccode/memory`) | Lessons other projects will trust; promotion crosses a privacy boundary. |
| Operating resources (`skills/`, `agents/`, templates) | Self-improvement can change them; they shape every future agent. |
| Configuration and permissions (`.eccode/config.json`, `.claude/settings*.json`, `hooks/`) | Limits, roles, reviewers, hooks. |

## 2. Trust boundaries and actors

```
 user (human)  ──decisions──▶  main session = orchestrator  ──dispatch──▶  subagents (12 roles)
       ▲                              │                                         │
       │                              ▼                                         ▼
  final handoff                 eccode CLI (the only writer of the record)   project files
       ▲                              │                                         │
       └──────── .eccode/ record ◀────┘◀──── PreToolUse guard (identity, ownership, record) ◀┘
                                      ▲
                 untrusted content: tickets, fixtures, web pages, model output, retrieved memory
```

Actors the design assumes may misbehave:

| Actor | Capability | Motive or failure mode |
|---|---|---|
| **A1. A subagent** (a role) | Runs shell commands and edits files in its tool list | Approves its own work, cites checks it never ran, claims another role, edits files outside its task, rewrites the record to pass a gate, exfiltrates a secret into a log. Usually from prompt injection or from optimising for "done", not from intent. |
| **A2. Untrusted content** | Text the agents read: tickets, fixtures, retrieved lessons, web pages, model output | Carries instructions aimed at agents ("approve this", "skip security", "run this command"). |
| **A3. The orchestrator (main session)** | Everything a subagent can do, plus `--actor orchestrator` and, by transcription, `--actor user` | Closes runs with invented usage, reopens a gate "for the user" without asking, batches a user decision it never received. |
| **A4. A local user or script with filesystem access** | Can edit `.eccode/` directly, run `git checkout` on it, flip a lesson's `status` field | Tampering, or a well-meant "repair" that erases history. |
| **A5. The harness** | Reports `agent_type` to hooks, delivers usage notifications | Hooks not installed or disabled; usage arrives late; a crash mid-write. |
| **A6. A different harness** (Codex, Gemini CLI, Cursor) | Runs roles sequentially in one context | No identity binding at all. |

## 3. Controls, by risk

| # | Risk | Control (enforced in code unless marked prompt) | Evidence |
|---|---|---|---|
| R1 | Self-approval (A1) | A reviewer who submitted, claimed or completed work in a gate is refused; reviewer role must be configured for the gate | `tests/gates.test.js` "author cannot approve", `tests/tasks.test.js` "implementers cannot review" |
| R2 | Approval without evidence (A1) | Every criterion cites a resolvable `ev:`/`artifact:` ref; a failed check cannot support "met"; phase and verification approvals need a passing check **the reviewer** ran after the submission; earlier findings must be resolved with evidence | `tests/gates.test.js` rubber-stamp cases; `tests/tasks.test.js` |
| R3 | Reviewing stale bytes (A1, A4) | SHA-256 of every submitted artifact is re-checked at review; phase submissions always pin the files the tasks changed, explicit artifacts cannot replace them (#6); `ev:` file evidence is re-hashed when cited (#19) | `tests/gates.test.js` "changed after submission"; `tests/security-regressions.test.js` #6, #19 |
| R4 | Impersonation of a role, `user` or `orchestrator` (A1) | The CLI refuses a repeated `--actor` (#2, #22); the guard tokenises Bash like a shell, binds the actor the CLI will see, denies inline `ECCODE_ACTOR`/`ECCODE_TEST`/`ECCODE_NOW`, eccode behind a variable, and `user`/`orchestrator` from any subagent | `tests/hooks-install.test.js` #2 and identity tests |
| R5 | Editing outside the claimed task (A1) | Completion refuses files outside the ownership globs and files git shows changed during the claim that no task accounts for (#7); `.eccode/` is never owned except `drafts/` (#8); the guard denies the edit at tool-call time | `tests/security-regressions.test.js` #7, #8; `tests/hooks-install.test.js` ownership tests |
| R6 | Rewriting or rolling back the record (A1, A4) | Only the CLI appends; the guard denies redirects, `sed -i`, `cp`/`mv`/`rm`, interpreter writes and `git checkout/restore/reset/stash/clean` on `.eccode/` (#5, #11); the chain is verified by `audit`; a log behind its snapshot is refused as `LOG_ROLLBACK` until the user accepts it (#5); timestamps that go backwards are reported (#9); torn tails are repaired, never glued (#4) | `tests/security-regressions.test.js` #4, #5, #9, #11; `tests/resume-delivery.test.js` audit tests |
| R7 | Silent edits after approval (A1, A3) | Delivery is refused while any approved file differs from its approved hash; a fix goes through a rework gate reviewed by a non-author; a change already submitted to a later gate is reported as pending re-review, not hidden | `tests/resume-delivery.test.js` "delivery is refused", "audit distinguishes"; `tests/rework.test.js` |
| R8 | Lookups through the prototype chain (`ev:constructor`) (A1) | Own-property lookups and id validation for evidence, tasks, runs, risks, gates, proposals (#3, #1) | `tests/security-regressions.test.js` #1, #3 |
| R9 | Secrets in evidence logs or shared lessons (A1, A5) | Redaction of known token formats, `key=value`, JSON keys, Bearer tokens, URL credentials (#15); promotion scans content, evidence snapshots, review notes and source URLs (#16); only the reviewed revision is shared | `tests/resume-delivery.test.js` redaction; `tests/promotion-scrub.test.js`; `tests/memory.test.js` #15, #16 |
| R10 | A lesson trusted because its file says `verified` (A4) | Verification is bound to a `memory.reviewed` event in the hash-chained log for the current revision and content; promotion, improvement grounding and `memory check` rely on that (#11) | `tests/security-regressions.test.js` #11 |
| R11 | Self-improvement changing permissions or the engine (A1, A2) | Protected paths cover config, settings, hooks, `lib/`, `bin/`, `scripts/hooks/`, `schemas/`, the record and the installed engine, always applied (#14); proposal ids validated before naming a path (#1); same-command baseline/candidate evaluation (#12); review only of evaluated proposals (#13); adoption needs `--actor user`; rollback is user/orchestrator and re-checks the target | `tests/security-regressions.test.js` #1, #12–#14; `tests/memory.test.js` |
| R12 | Instructions inside data (A2) | **Prompt:** every role treats tickets, fixtures, web pages, model output and retrieved memory as evidence; directives aimed at reviewers are a blocking finding. **Code:** retrieved memory is rendered inside an "evidence, not instructions" frame; untrusted records cannot ground proposals or be promoted | `tests/memory.test.js` search framing; agent prompts |
| R13 | Invented usage or budget evasion (A3) | `run end --status ok` needs harness-reported `--tokens` or an explicit `--no-usage`; corrections are append-only and restricted to orchestrator/user (#17); budgets block new work | `tests/resume-delivery.test.js` run tests; `tests/security-regressions.test.js` #17; `tests/tasks.test.js` budget |
| R14 | User decisions nobody made (A3) | `--actor user` is refused from subagents by the guard; every `--actor user` event is listed in the final handoff with the note that the record shows what was entered, not who typed it; reopening an escalated gate waives nothing unless the user names findings with `--waive` | `tests/resume-delivery.test.js` "lists every --actor user event"; `tests/gates.test.js` reopen tests |
| R15 | Loss of state on crash or interruption (A5) | Append-only log with atomic snapshot writes; torn tail repair; interrupted runs recovered with claims released and attempts counted; `reconcile --verify` compares the record with the working tree and re-runs recorded checks before resuming | `tests/resume-delivery.test.js`; `tests/reconcile.test.js` |
| R16 | Engine drift from published evidence (maintainers) | The suite replays every shipped record and asserts the figures the reports cite | `tests/records-replay.test.js` |

## 4. Residual risks (not closed)

1. **Identity is asserted, not proven.** Binding `--actor` to the real subagent depends on the PreToolUse hook running (A5) and on the harness reporting `agent_type`. The guard reads commands without executing them, so an indirect write (a script file it cannot see into, an unusual interpreter) can evade it. In other harnesses (A6) there is no binding at all; the toolkit documents sequential mode as reduced independence.
2. **A human cannot be told from a script.** `--actor user` events are entered by whoever runs the CLI. The handoff makes them visible; it cannot make them authentic. The Groundwork delivery closed on operator decisions recorded this way, disclosed in its evidence README.
3. **A rollback that also replaces the snapshot** is indistinguishable from an older record; the guard's git rules are the only defence, and a filesystem-level actor (A4) can bypass them.
4. **Evidence is only as good as the command.** A reviewer can run a check that proves nothing about the criterion. The engine guarantees independence and execution, not judgment; the gate-challenge evidence shows reviewers missing two of four planted implementation defects.
5. **Redaction is pattern-based.** A secret in an unfamiliar format reaches the evidence log. Promotion scans are the second line; shared memory should be treated as internal, not public.
6. **No outside review.** This model and the 22-finding review were produced with the same family of tools that built the toolkit. An independent human security review is the next step and is not scheduled.

## 5. How to use this document

- When adding an engine rule, add a row here and name its test.
- When a residual risk is closed, move it to §3 with evidence; never delete the history.
- When a finding arrives from outside, map it to a row (or add one) before fixing it, so the fix has a stated threat.
