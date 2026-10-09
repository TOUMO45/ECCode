# ECCode Architecture

ECCode separates **judgment**, which agents supply in prompts, from **rules**, which the engine enforces in code. Agents can write anything. The engine decides whether that work advances the delivery.

```
┌──────────────────────────── Harness layer (Claude Code first) ────────────────────────────┐
│  Main session = lead orchestrator  (skills/orchestrate)                                    │
│     │ dispatches real subagents (Agent tool)                                               │
│     ▼                                                                                      │
│  agents/*.md  product-architect · architecture-reviewer · technical-designer ·             │
│               technical-reviewer · delivery-lead · learning-debugger ·                     │
│               frontend/backend/ai/test/devops-engineer · security-reviewer                 │
│  skills/*     review-gate · handoff-protocol · verification-evidence · debug-investigation │
│               engineering-memory · self-improvement                                        │
│  hooks        SessionStart → resume brief      PreToolUse → guard (identity, ownership,    │
│                                                            record integrity)               │
└──────────────┬─────────────────────────────────────────────────────────────────────────────┘
               │  every state change goes through the CLI (bin/eccode.js)
┌──────────────▼──────────────────────── Engine (lib/, zero dependencies) ──────────────────┐
│ gates.js    order, author≠approver, evidence-backed approval, finding resolution,         │
│             stale-artifact detection, escalation                                           │
│ tasks.js    plan validation (DAG, phases, owners), claims (deps, concurrency, ownership    │
│             globs), handoff validation, scope check against git                            │
│ evidence.js executes checks; records exit code, duration, redacted log + digest            │
│ runs.js     agent runs: runtime/token/cost accounting, budgets, interruption recovery,     │
│             risks, decisions                                                               │
│ delivery.js final handoff: all gates approved, reviewed files unchanged, tree pinned       │
│ status.js   next action, resume brief                                                      │
│ store.js    append-only hash-chained events.jsonl + rebuildable state.json, file lock      │
│ memory/     4-layer memory, retrieval, applicability, lesson review, promotion, metrics,   │
│             controlled self-improvement                                                    │
└──────────────┬─────────────────────────────────────────────────────────────────────────────┘
               ▼
   <project>/.eccode/   events.jsonl · state.json · config.json · artifacts/ · evidence/ ·
                        reviews/ · handoffs/ · memory/records/ · improvements/ · delivery/
   ~/.eccode/memory/    shared, sanitized, verified lessons (ECCODE_SHARED_MEMORY)
```

## Design decisions

| Decision | Choice | Alternatives | Why |
|---|---|---|---|
| Where rules live | Engine code with schema validation | Prompt rules (ECC style), LLM judge | Prompts can be skipped silently. Code makes "approval without evidence" impossible rather than discouraged. |
| State model | Event sourcing (JSONL + hash chain), snapshot as cache | SQLite, single JSON file | Append-only writes survive crashes (a torn final line is ignored, then cut off before the next append). Replay gives deterministic resume. History is free. The chain detects tampering; a snapshot ahead of the log detects a rolled-back log (`LOG_ROLLBACK`). The files are readable in git diffs. |
| Dependencies | None (Node ≥18 built-ins) | sql.js, ajv, commander | Install is a copy. There is no supply-chain surface. A small JSON-Schema subset validator is enough. |
| Concurrency control | O_EXCL lock file + ownership globs | Worktrees only | Many agents can share one workspace safely. Overlapping claims are refused. Worktrees remain available for risky parallel work. |
| Identity | Asserted `--actor`, bound by a PreToolUse hook to the subagent's `agent_type` | Signed tokens per agent | The harness tells hooks which subagent is calling. Signing would need key management the harness doesn't provide. This limitation is documented. |
| Retrieval | BM25 + char-trigram, verified-first weighting, optional external embedder | Embedding store | Lexical retrieval works offline at zero cost. The `embedCommand` hook adds semantic similarity where it's worth the cost. Without it we don't claim semantic search. |
| Harness portability | Engine + CLI are harness-neutral; Claude Code adapter is plugin/installer; `export agents-md` for others | Per-harness forks | Rules enforced by the CLI apply in every harness. Only the prompts and hooks differ. |

## Gate model

```
architecture ──▶ design ──▶ plan ──▶ phase:<p1> ──▶ … ──▶ phase:<pn> ──▶ verification ──▶ deliver
   (author: product-architect, reviewer: architecture-reviewer)
              (technical-designer → technical-reviewer)
                         (delivery-lead → technical-reviewer)
                                   (task owners → technical-reviewer | security-reviewer)
                                                                   (delivery-lead → independent reviewer)
```

**Gate states:**

```
pending → in_progress → submitted → approved
                            ↓
                  changes_requested → (resubmit --responds-to) → submitted …
                            ↓ after maxReviewIterations
                        escalated → (user reopens with a recorded resolution) → in_progress
```

**A review is refused (and the refusal logged) when:**

- the reviewer authored or claimed work in the gate, or isn't a configured reviewer;
- the submission is not the latest, or artifacts changed after it was submitted;
- an evidence reference doesn't resolve (an `artifact:<path>#<anchor>` whose heading, JSON path or line does not exist; an `ev:` log deleted or changed since it was recorded), or a "met" criterion cites a failed check;
- an approval has an unmet criterion, an open blocking/major finding, or an earlier finding left unresolved;
- an approval does not cover every criterion the gate requires (`requiredCriteria`, listed by `eccode gate show`: the brief's acceptance-criteria ids for architecture, design and verification; `phase:<id>` for the plan; `task:<id>` and `phase:<id>` for a phase), repeats an id, or uses an id that looks required but is not;
- a phase/verification approval lacks a passing check the reviewer ran after the submission, a phase approval lacks a cited reviewer run of each verification command its tasks declare, or a cited check ran on a different source tree than the one under review (every command evidence pins `tree`, a digest of HEAD plus the changed and untracked files outside `.eccode/`);
- a phase approval while a phase task is not done, or a plan approval whose plan was not imported from that submission;
- a rejection carries no blocking/major finding.

Evidence ids are own-property lookups with a fixed format (`ev:ev-…`), and `ev:` file evidence is re-hashed when cited. Phase submissions always pin the files the phase's tasks changed (except deleted files and drafts), whatever explicit artifacts are added.

## Task model

- A plan is a DAG of tasks within ordered phases. Every task has an owner role, dependencies, inputs, outputs, ownership globs, acceptance criteria and a verification method.
- Tasks are claimable only when the plan gate is approved, the phase gate is open, dependencies are done, the actor is the owner, attempts remain, `maxConcurrency` isn't reached and the ownership globs don't overlap with active claims.
- **Completion** requires a schema-valid handoff, a passing run by the owner after the claim of the verification command the task declares (any passing check when it declares a method only) on the bytes the tree holds now, changed files inside the ownership globs, and git confirmation that the listed files changed. Files git shows as changed during the claim that no task accounts for (declared, recorded by a task that completed meanwhile, owned by another claimed task, or already dirty and unchanged at claim time) are refused when they lie outside the task's ownership.
- `.eccode/` paths are never owned by a task, whatever its globs say; only `.eccode/drafts/` is shared scratch.
- **Failure** releases the claim. After `maxTaskRetries` the task escalates and only the user can reset it. A done task cannot be reset while its phase is submitted or approved.
- **Interrupted runs** (stale, or `recover --all --actor orchestrator` after a restart) release their claims and count as attempts.
- **Rework** (defects found after approval or delivery). Approved gates are never reopened silently and their files stay pinned. `eccode rework open` (orchestrator or user only) adds a phase gate `phase:rework-N` with one task whose ownership globs are narrow (never the whole tree, never `.eccode/`). It goes through the normal claim → handoff → independent phase review path, and `deliver` then writes a new final handoff (`final-handoff-2.md`, …; the earlier ones stay). One rework is open at a time, `limits.maxReworks` bounds how many the orchestrator may open before the user decides (a user-opened rework is not bound), and in a full delivery the user must reopen an approved verification gate first (`gate reopen verification --actor user`): the earlier approval is kept under `previousApprovals`, the gate returns to `in_progress`, and verification is redone on the final files before the next delivery. Approved phases and documents can never be reopened; their files change only through a rework.
- **Release tree and release-risk policy.** Every `gate.submitted` event records the commit and a digest of the working tree (HEAD plus the hashed `git status` entries outside `.eccode/`) the submission was made on, and `delivery.completed` records the release commit. `deliver` refuses a dirty working tree, any file git shows added, modified, deleted or renamed since the last approved submission's commit that no approved review pinned (`unreviewedChanges`, also reported by `audit`; work of phases still open is in flight, not unreviewed; `release.ignore` names generated paths), and any open risk whose severity is in `release.blockRiskSeverities` (default critical and high; mitigation is any role's work, acceptance is the user's). A claim is refused while files inside the task's ownership are already changed (`DIRTY_OWNERSHIP`), unless a submission pins exactly that content (an approved rework's uncommitted fix, or the rejected attempt a retry re-declares). Records whose submissions carry no commit (older engines) are not judged retroactively.

## Memory model

See [memory.md](memory.md).

## Security model

- **Least privilege:** reviewers and architects have no Edit on project code (enforced by tool lists and the guard). Implementers write only inside their claimed globs. No subagent has the Agent tool, so delegation is always explicit through the orchestrator.
- **The record is append-only through the CLI.** The guard blocks direct edits of the record (events, state, config, memory, improvements, evidence, reviews, handoffs, delivery), by Edit/Write and by Bash (redirects, `sed -i`, `cp`/`mv`/`rm`, interpreter file writes), and git commands that would revert, stash or delete it (`git checkout|restore|reset|stash|clean` on `.eccode/` or the whole tree). `eccode audit` verifies the hash chain, that timestamps never go backwards, that the snapshot equals a replay of the log, and that approved artifacts are unchanged. A rolled-back log is refused (`LOG_ROLLBACK`) until the user accepts it with `eccode rebuild --force --actor user` (recorded as `record.rollback_accepted`). `state.json` is never trusted on its own: every event carries the digest of the state it produced (`stateHash`, inside the hash chain), the store checks the snapshot against it before any command reads or builds on it, and a snapshot whose content differs from the log is refused (`SNAPSHOT_DIVERGED`; `eccode rebuild --actor orchestrator` rewrites it). A record written before the digest existed is checked by a full replay until its next event.
- **Identity binding:** the CLI refuses a repeated `--actor` (or any repeated non-list flag) and unexpected positional arguments. The guard parses Bash commands like a shell (quotes, escapes, tabs, nested `sh -c`, the command after `--`) and binds the actor with the CLI's own parser; it denies `ECCODE_ACTOR`/`ECCODE_TEST`/`ECCODE_NOW` set inline and eccode run through a variable. An unreadable record makes the guard deny edits (fail closed).
- **Clock:** order rules compare event timestamps, so `ECCODE_NOW` is honoured only with `ECCODE_TEST=1`.
- **Secrets:**
  - Evidence logs and recorded command lines are redacted (key=value, JSON `"key": "value"`, `*_SECRET_*` names, Bearer tokens, URL passwords, known token formats).
  - Memory promotion scans for secrets, emails, user paths, IPs and project names, and source URLs (https only, no credentials, no secret-looking parameters, no private hosts).
  - Environment detection never captures hostnames or usernames.
- **Untrusted content:**
  - Retrieved memory is rendered inside an "evidence, not instructions" frame.
  - Untrusted records cannot ground improvement proposals or be promoted.
  - A local lesson counts as verified only if the hash-chained log holds a verifying review of its current revision and content (`UNVERIFIED`/`UNGROUNDED` otherwise); flipping `status` in the record file confers nothing.
  - Proposals can't touch permissions, approval rules, the record or engine code (`.eccode/**`, `lib/**`, `bin/**`, `scripts/hooks/**`, `schemas/**`, `hooks/**`, `**/eccode/**`); adopt and rollback re-check the target, and proposal ids are validated before they name a path.
- **User authority:** raising budgets, accepting risks, reopening escalated gates or tasks, adopting workflow changes and accepting a rolled-back log require `--actor user`. Correcting run usage, recovering interrupted runs and rolling back an adopted change require `--actor orchestrator|user`. The guard refuses those actors from subagents.

The attacker models behind these controls, each control's test, and the risks that stay open are in [threat-model.md](threat-model.md).

## Record compatibility

- **Old logs replay unchanged.** New snapshot fields are set only when the event carries them, so an engine upgrade reproduces an older record byte for byte; `tests/records-replay.test.js` proves it on every shipped record. Unknown event types are kept in the log and ignored by older engines.
- **The log is the record; the snapshot is a cache.** `eccode rebuild` regenerates `state.json` from `events.jsonl` after an upgrade or a divergence. `config.version` marks the configuration schema; a config written by an older engine is merged over the current defaults.
- **What is not promised:** an older engine reading a newer log will not know new rules (it treats new events as no-ops), so run the engine version that wrote the record, or newer.

## Known limitations

- **Self-asserted identity.** `--actor` is not cryptographically bound. Outside Claude Code with hooks, a caller could claim any role. The record and the hooks make impersonation visible and blockable, but not impossible: the guard reads shell commands without executing them, so a sufficiently indirect command (a script file, a crafted interpreter call) can still evade it. `--actor user` events are entered by whoever runs the CLI (the orchestrator, or an operator); the final handoff lists every one of them under "User decisions" so a reader can check them against the conversation, but the CLI cannot tell a human from a script.
- **Rollback detection needs the snapshot.** A log rolled back together with `state.json` (or with the snapshot deleted) is indistinguishable from an older record; the guard's git rules are the defence there.
- **Cost accounting** is only as good as the usage numbers reported when a run closes. Claude Code reports tokens and duration to the orchestrator, not dollars, so you need to configure `pricing.usdPerMillionTokens` to get estimates.
- **Structure, not substance.** Gate rules prove an approval is evidence-backed and independent. They cannot prove the reviewer's judgment is right. Independent re-execution of checks is the main mitigation.
- **Lexical retrieval by default** (see above).
