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
│ delivery.js final handoff, refused unless all gates approved and reviewed files unchanged  │
│ lean.js     claim baseline + completion checks (declared dependencies and shortcuts, test  │
│             or reason), per-task line stats, reuse map, deferred-shortcut ledger           │
│ compat.js   public-surface baseline (exports, routes, migrations); undeclared breaking     │
│             changes refused; refactor track refuses them outright                          │
│ codebase.js import-resolved index (8 languages), onboarding brief, impact analysis         │
│ works.js    work items and tracks; fix needs a reproduction pair, refactor a behavior      │
│             command green before and after                                                 │
│ stack.js    stack detection, runnable checks, user-adopted required checks, secrets scan   │
│ bench.js    paired with/without-skill benchmark with hidden checks measured by the harness │
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
| State model | Event sourcing (JSONL + hash chain), snapshot as cache | SQLite, single JSON file | Append-only writes survive crashes (a torn final line is ignored). Replay gives deterministic resume. History is free. The chain detects tampering. The files are readable in git diffs. |
| Dependencies | None (Node ≥18 built-ins) | sql.js, ajv, commander | Install is a copy. There is no supply-chain surface. A small JSON-Schema subset validator is enough. |
| Concurrency control | O_EXCL lock file + ownership globs | Worktrees only | Many agents can share one workspace safely. Overlapping claims are refused. Worktrees remain available for risky parallel work. |
| Identity | Asserted `--actor`, bound by a PreToolUse hook to the subagent's `agent_type` | Signed tokens per agent | The harness tells hooks which subagent is calling. Signing would need key management the harness doesn't provide. This limitation is documented. |
| Retrieval | BM25 + char-trigram, verified-first weighting, optional external embedder | Embedding store | Lexical retrieval works offline at zero cost. The `ECCODE_EMBED_COMMAND` embedder (user environment only, never the project config) adds semantic similarity where it's worth the cost. Without it we don't claim semantic search. |
| Lean discipline | Prompt guidance (`lean-change`) plus engine checks on what can be checked: declared new dependencies, declared `shortcut:` markers, a test or a stated reason | Prompt-only (Ponytail), diff-size budgets | Undeclared dependencies and hidden debt become visible to the independent reviewer. Diff budgets would refuse correct-but-large changes, so ECCode measures lines instead of capping them. |
| Harness portability | Engine + CLI are harness-neutral; Claude Code adapter is plugin/installer; `export agents-md` for others | Per-harness forks | Rules enforced by the CLI apply in every harness. Only the prompts and hooks differ. |

## Work items and tracks

One record, many deliveries. `project.initialized` opens work item `w1`; after `deliver`, `work.started` archives it and opens the next with its own git base and a track that sets the document gates: `greenfield` (architecture → design → plan), `feature` (design → plan), `refactor`/`fix` (plan), `quick` (an auto-imported one-task plan). Implementation phases and verification apply to every track. `fix` adds the reproduction-pair rule, `refactor` the behavior-command rule and a ban on breaking changes. A snapshot schema change bumps `STATE_VERSION`: an older `state.json` is treated as a stale cache (replayed, not trusted, never reported as tampering).

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
- an evidence reference doesn't resolve, or a "met" criterion cites a failed check;
- an approval has an unmet criterion, an open blocking/major finding, or an earlier finding left unresolved;
- a phase/verification approval lacks a passing check the reviewer ran after the submission;
- a rejection carries no blocking/major finding.

## Task model

- A plan is a DAG of tasks within ordered phases. Every task has an owner role, dependencies, inputs, outputs, ownership globs, acceptance criteria and a verification method.
- Tasks are claimable only when the plan gate is approved, the phase gate is open, dependencies are done, the actor is the owner, attempts remain, `maxConcurrency` isn't reached and the ownership globs don't overlap with active claims.
- **Completion** requires a schema-valid handoff, at least one passing check run after the claim, changed files inside the ownership globs, and git confirmation that the listed files changed.
- **Failure** releases the claim. After `maxTaskRetries` the task escalates and only the user can reset it.
- **Interrupted runs** (stale, or `recover --all` after a restart) release their claims and count as attempts.

## Memory model

See [memory.md](memory.md).

## Security model

- **Least privilege:** reviewers and architects have no Edit on project code (enforced by tool lists and the guard). Implementers write only inside their claimed globs. No subagent has the Agent tool, so delegation is always explicit through the orchestrator.
- **The record is append-only through the CLI.** The guard blocks direct edits. `eccode audit` verifies the hash chain and that approved artifacts are unchanged.
- **Secrets:**
  - Evidence logs and recorded command lines are redacted.
  - Memory promotion scans for secrets, emails, user paths, IPs and project names.
  - Environment detection never captures hostnames or usernames.
- **Untrusted content:**
  - Retrieved memory is rendered inside an "evidence, not instructions" frame.
  - Untrusted records cannot ground improvement proposals or be promoted.
  - Proposals can't touch permissions, approval rules or engine code.
- **User authority:** raising budgets, accepting risks, reopening escalated gates or tasks, and adopting workflow changes all require `--actor user`. The guard refuses that actor from subagents. From the main session it makes Claude Code ask the human to confirm the command. `ECCODE_ACTOR` never supplies `user`, and a flag given twice is refused, so the hook and the CLI always agree on the actor.
- **Only reviewed code ships:** `init` records the git base commit and pins files already dirty at that point. The verification submission, and then `deliver`, refuse any file changed since then that no approved submission covers.
- **Planned checks:** a task's completion must cite a passing run of the verification command its approved plan pinned; any other command does not stand in for it.
- **Repository config cannot run commands:** the memory embedder comes only from `ECCODE_EMBED_COMMAND`, never from `.eccode/config.json`.

## Known limitations

- **Self-asserted identity.** `--actor` is not cryptographically bound. Within one OS user, no local secret could be hidden from an agent that has a shell. Outside Claude Code with hooks, a caller could claim any role. With hooks, the guard binds `--actor` to the running subagent and blocks record writes, but it reads shell text: deliberately obfuscated commands (quoting tricks, variables, scripts written to disk first) can get past it.
- **The hash chain is tamper-evident, not tamper-proof.** Someone with write access can recompute the whole chain. `eccode audit --against <ref>` detects any rewrite of history committed at `<ref>`. Comparing against a protected remote branch in CI moves that check outside the agents' reach. Moving the engine behind an MCP server (structured calls instead of shell text) is the planned structural fix.
- **Cost accounting** is only as good as the usage numbers reported when a run closes. Claude Code reports tokens and duration to the orchestrator, not dollars, so you need to configure `pricing.usdPerMillionTokens` to get estimates.
- **Structure, not substance.** Gate rules prove an approval is evidence-backed and independent. They cannot prove the reviewer's judgment is right. Independent re-execution of checks is the main mitigation.
- **Lexical retrieval by default** (see above).
