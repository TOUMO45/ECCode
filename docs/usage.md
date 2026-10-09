# Installation, Configuration, Usage and Troubleshooting

## Requirements
- Node.js ≥ 18.17 (tested on v22). No npm dependencies.
- Claude Code (tested with 2.1.293) for the agent team. The CLI works on its own for any harness.
- git. It is optional, but the toolkit uses it to check that a task's changed files fall inside its ownership.

## Install

### A. Claude Code plugin (recommended)
```bash
# inside Claude Code
/plugin marketplace add TOUMO45/ECCode          # or a local path: /plugin marketplace add ./ECCode
/plugin install eccode@eccode
```
Or from a shell: `claude plugin marketplace add <repo-or-path>`, then `claude plugin install eccode@eccode`.

This installs:
- 12 agents (`eccode:product-architect`, …);
- skills and commands (`/eccode:start`, `/eccode:change`, `/eccode:resume`, `/eccode:status`, `/eccode:investigate`, `/eccode:deliver`, `/eccode:improve`);
- the three hooks (resume brief, guard, completion gate for unattended runs).

Inside agent and skill text, the CLI is `node ${CLAUDE_PLUGIN_ROOT}/bin/eccode.js`.

### B. Project-local copy (no plugin system)
```bash
git clone https://github.com/TOUMO45/ECCode && cd your-project
node ../ECCode/bin/eccode.js install --target .        # add --no-hooks to skip settings.json changes
```
This copies the files into the project's `.claude/` directory:
- `agents/`
- `skills/eccode-*`
- `commands/eccode/`
- runtime → `.claude/eccode/`

It also **merges** three hook entries into `.claude/settings.json`. Existing settings and hooks are kept, and re-running the command is idempotent. The CLI is then `node .claude/eccode/bin/eccode.js`.

`--scope user` installs into `~/.claude` for every project.

### C. Other harnesses (Codex, Gemini CLI, Cursor, …)
```bash
node ECCode/bin/eccode.js export agents-md --out AGENTS.md
```
In these harnesses the roles run **sequentially in one context**, and you must tell the user so. The CLI still enforces every gate rule.

### Verify the installation
```bash
cd ECCode && npm run check     # static validation of agents/skills/commands/hooks + test suite
claude plugin validate . && claude plugin validate .claude-plugin/plugin.json --strict
```

## Configure (`<project>/.eccode/config.json`, created by `eccode init`)

| Key | Default | Meaning |
|---|---|---|
| `limits.maxConcurrency` | 2 | Tasks that can be claimed at the same time |
| `limits.maxActiveRuns` | 4 | Agent runs that can be open at the same time; `run start` refuses the next one (`RUN_LIMIT`) until one is closed or recovered |
| `limits.maxReviewIterations` | 3 | Rejections per gate before the gate escalates to the user |
| `limits.maxTaskRetries` | 2 | Failed attempts allowed per task after the first one, before escalation |
| `limits.maxReworks` | 3 | Reworks (scoped fixes for defects found after approval or delivery, `eccode rework open`) the orchestrator may open before the user must decide |
| `limits.maxRuntimeMinutes` | 480 | Total runtime of recorded agent runs (an interrupted run counts from its start to its recovery) |
| `limits.maxCostUsd` | 25 | Total spend recorded for agent runs, as reported at `run end`: accounting, not hard enforcement (see the limits table below) |
| `limits.reserveUsdPerRun` | null | Budget held back for every open run and for the next one before new work is allowed; `null` turns the reservation off |
| `limits.staleRunMinutes` | 60 | How long a run can stay open before it counts as interrupted |
| `pricing.usdPerMillionTokens` | null | Used to estimate cost when only token counts are reported |
| `review.requiredSections` | see file | Headings that must appear in architecture and design artifacts |
| `roles.<gate>.authors/reviewers` | see file | Who may submit and who may approve. You can add ECC language reviewers here |
| `memory.learning` | true | `false` turns learning off: no lesson retrieval or recording, no promotion, no self-improvement proposals. Project facts are still recorded, and rollback stays available. `ECCODE_LEARNING=on\|off` overrides it. |
| `memory.staleAfterDays` | 180 | Age after which a lesson must be revalidated |
| `memory.embedCommand` | null | Optional external embedder for semantic retrieval |
| `memory.sharedDir` | `~/.eccode/memory` | Shared lesson store. `ECCODE_SHARED_MEMORY` overrides it |
| `improvement.requireUserForAdoption` | true | Workflow changes need `--actor user` |
| `improvement.protectedPaths` | config, settings, record, hooks, engine | Paths self-improvement can never change. The built-in list is always applied; this key can only add to it |

Environment variables:
- `ECCODE_ROOT`: project root.
- `ECCODE_ACTOR`: default actor. The guard denies setting it inline in a command (`ECCODE_ACTOR=x eccode …`); pass `--actor`.
- `ECCODE_HOOKS=off`: disable the hooks.
- `ECCODE_SEQUENTIAL_ROLES=1`: allow the main session to act as roles. Use it only in disclosed sequential mode.
- `ECCODE_SHARED_MEMORY`: shared memory location.
- `ECCODE_LEARNING=on|off`: override `memory.learning`. Any other value is refused.
- `ECCODE_UNATTENDED=1`: the session has no human to answer questions (a headless `claude -p` run). The Stop hook then refuses to let a session started with `/eccode:start`, `/eccode:change` or `/eccode:resume` end before the delivery is complete or a user decision is pending, because an unattended orchestrator may otherwise judge the process too heavy for a small change and skip it. Interactive sessions are never blocked; at most 4 stops per session are blocked.
- `ECCODE_NOW`: pin the clock. Honoured only with `ECCODE_TEST=1` (test suites); otherwise ignored, because gate order rules compare timestamps.

### Limits: what the engine enforces and what it only accounts

Every limit is checked by the engine against the record when a command runs. What the record holds about spend and runtime is what the orchestrator reported after each run (`run end --tokens/--cost-usd`), so the dollar and minute limits are accounting of reported usage, not hard enforcement: the engine cannot meter tokens as they are consumed, hold a deadline, or stop a running agent. Only the host (Claude Code) can do that. A figure the engine was never given is recorded as unknown (`null`), never as `$0`, and `status`/`resume` then print `Budget: $X/$Y (N runs with unknown usage; spend is a lower bound)` (plus `$E of it estimated from tokens` when `pricing.usdPerMillionTokens` turned token counts into dollars) until `eccode run correct <runId> --tokens <n> --cost-usd <x> --reason <text> --actor orchestrator` fills the runs in.

| Limit | The engine enforces | Self-reported by the orchestrator | Only the host can enforce |
|---|---|---|---|
| `maxConcurrency` | `task claim` refuses when that many tasks are claimed (`CONCURRENCY_LIMIT`) | — | That no more agents run than tasks are claimed |
| `maxActiveRuns` | `run start` refuses when that many runs are open (`RUN_LIMIT`) | That every dispatch opens a run and every finished agent closes one | Cancelling an agent process that is still running |
| `maxReviewIterations` | `gate review` escalates the gate to the user after that many rejections | — | — |
| `maxTaskRetries` | `task claim` refuses a task whose attempts are used up and `task fail` escalates it to the user | — | — |
| `maxReworks` | `rework open` refuses past the cap unless `--actor user` (`REWORK_LIMIT`) | — | — |
| `maxRuntimeMinutes` | `run start`, `gate start`, `task claim` and `rework open` refuse once recorded runtime reaches the limit (`BUDGET_EXCEEDED`); minutes are counted when a run is closed, for an interrupted run from its start to its recovery | When runs are opened and closed | Deadlines: stopping an agent that is still running when the limit is reached |
| `maxCostUsd` | The same commands refuse once recorded spend reaches the limit; while any run has unknown usage the figure is a lower bound and the refusal says so | `--tokens`/`--cost-usd` at `run end` (from the harness usage report) and `run correct`; without `pricing.usdPerMillionTokens`, tokens alone leave the dollar figure unknown, not `$0` | Actual spend: the engine cannot meter tokens as they are consumed or stop a run part-way |
| `reserveUsdPerRun` | When set, the same commands refuse when recorded spend + (open runs + 1) × reserve would exceed `maxCostUsd`, so budget is held back for runs in flight | The reserve is the user's estimate of what one run costs | — |
| `staleRunMinutes` | `recover` closes runs open longer than this as interrupted (usage unknown, duration start → recovery) and releases their claims; `status` lists them | That a run reported as interrupted really stopped | Process cancellation |

## Use

In Claude Code, `/eccode:start <idea>` makes the main session follow the `orchestrate` skill. It:
1. initializes `.eccode/`;
2. dispatches the architect, then an **independent** reviewer, then the designer and its reviewer;
3. has the delivery lead plan the work, followed by a plan review;
4. runs each implementation phase (claims → work → handoffs → phase review);
5. runs verification (independent re-execution) and `eccode deliver`.

`/eccode:change <request>` handles a bug fix or bounded change in an existing codebase using the `change` profile:
1. a reviewed plan whose acceptance criteria come from the request, with a failing reproduction first for defects;
2. owned tasks with evidence;
3. an independent phase review that re-runs the checks;
4. `eccode deliver`.

There are no architecture, design or verification gates in this profile.

`/eccode:status` shows where things stand. `/eccode:resume` continues after an interruption: it reconciles the record with the files and re-runs the recorded checks before any new work (`eccode reconcile --verify`). The SessionStart hook also injects the resume brief automatically.

Running the workflow by hand with the CLI (useful in any harness):
```bash
eccode init --name Shop --idea "…"
eccode gate start architecture --actor orchestrator
eccode gate submit architecture --actor product-architect --artifact .eccode/artifacts/architecture/brief.md
eccode evidence run --actor technical-reviewer --label "tests" -- npm test
eccode gate review architecture --actor architecture-reviewer --file review.json
eccode status --brief          # always shows the NEXT action
```
`eccode help` lists every command. Exit codes: `0` ok, `1` usage error (including a flag given twice, e.g. two `--actor`, and unexpected extra arguments: repeat `--artifact` for each file), `2` refused by a workflow rule. `memory check` returns `3` when a lesson doesn't apply.

Actor restrictions: `run correct`, `recover` and `improve rollback` need `--actor orchestrator` or `--actor user`; `rebuild --force` (accepting a rolled-back log) needs `--actor user`.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `[GATE_BLOCKED] … predecessor … not approved` | Gates run in order | Finish and approve the earlier gate |
| `[MISSING_SECTIONS]` | The architecture or design artifact lacks a required heading | Add the section. Change `review.requiredSections` only if the team agrees |
| `[REVIEW_REJECTED] … authored work` | The reviewer is an author or task owner of the gate | Dispatch a different reviewer role |
| `[REVIEW_REJECTED] … changed after submission` | The artifact was edited after it was submitted | The author resubmits, then it is reviewed again |
| `[REVIEW_REJECTED] … executed by the reviewer` | A phase or verification approval doesn't cite a check the reviewer ran | `eccode evidence run --actor <reviewer> …`, then cite the new `ev:` id |
| `[RESPONSE_REQUIRED]` | Resubmitting after changes were requested | Add `--responds-to <reviewId>` |
| `[OWNERSHIP_CONFLICT]` / `[CONCURRENCY_LIMIT]` | Another active task overlaps, or the cap is reached | Wait, or re-plan the ownership globs |
| `[INVALID_HANDOFF] … outside task ownership` | Files were changed outside the task's globs | Revert them, or ask the orchestrator to re-plan |
| `[INVALID_HANDOFF] … unchanged since claim` | The listed files don't differ in git | List only the files that actually changed |
| `[INVALID_HANDOFF] … no task declares` | git shows files changed during the claim outside the task's ownership that no task accounts for | Revert them, or have the task that owns them declare them |
| `[LOG_ROLLBACK]` | `events.jsonl` is behind or different from `state.json` (e.g. restored from git) | Restore the newer log. If the user decides the shorter log is the truth: `eccode rebuild --force --actor user` |
| `[UNVERIFIED]` / `[UNGROUNDED]` | A lesson marked verified has no verifying review of its current revision in the event log | Review it again: `eccode memory review <id> --decision verify` |
| `[BUDGET_EXCEEDED]` | Recorded spend or runtime has reached the limit | Stop and ask the user. Raising limits needs their authorization |
| Gate shows `escalated` | Too many rejections | The user decides: `eccode gate reopen <gate> --actor user --resolution "…" [--waive all\|F1,F2]`. Without `--waive` the findings stay open and the next approving review must resolve each with evidence; `--waive` records the ones the user accepts |
| `[INVALID_TRANSITION] … submissions require in_progress or changes_requested` | The gate already has a review, or is approved or escalated | An **unreviewed** submission can be replaced by its submitter (just submit again after correcting the file); after a review, respond to it with `--responds-to` |
| `[PLAN_LESSONS]` | The plan matches verified lessons it does not answer for | Add `lessonDecisions` to the plan: `incorporated` (lesson id in the task's `inputs` and the rule as an acceptance criterion) or `not-applicable` (an assessment, or a note naming the condition that does not hold) |
| `[REVIEW_REJECTED] … criterion with id "lessons"` | The submission records lesson decisions and the review does not judge them | Read each lesson (`eccode memory show <id>`), then add a `lessons` criterion with evidence; request changes if a decision is wrong. `eccode gate show <gate>` lists the decisions |
| Open runs after a crash | The previous session died | `eccode recover --all --actor orchestrator` |
| `Audit FAILED` | The event log was edited or rolled back, timestamps go backwards, or an approved file changed | Restore from git. Changes to approved files need a new review (a rework, or a later gate's submission). Files listed under "Pending re-review" are already submitted to a later gate and are not failures |
| A rework's review finds the same defect in a file outside its scope | The scope was too narrow | `eccode task reset <rework-id> --actor orchestrator --reason "<finding>"`, then `eccode rework extend <rework-id> --actor orchestrator --files <glob> --reason "<finding>"`, redispatch the owner, resubmit with `--responds-to` |
| `[INVALID_HANDOFF] … inside your ownership that the handoff does not declare` | A file in the task's globs changed but the handoff omits it | Declare every changed file (each is reviewed and pinned), or revert it |
| `[INVALID_HANDOFF] … is a symbolic link` | The handoff lists a symlink, or one sits inside the ownership | Replace it with the file itself; links can point at the record or outside the project |
| `[CORRUPT_LOG] … cannot be replayed` | An event in `events.jsonl` was edited or written by another tool | Restore the log from git; `eccode audit` names the event |
| `[USER_AUTH_REQUIRED] The verification gate is approved and would be invalidated by a rework` | A defect was found after verification (or delivery) in a full delivery | The user reopens it: `eccode gate reopen verification --actor user --resolution "<why>"`, then `eccode rework open …`; verification is redone before the next `deliver` |
| `[INVALID_TRANSITION] Gate … is approved; approved work changes through a rework` | An attempt to reopen an approved phase or document gate | Open a rework for the files instead; only `verification` can be reopened after approval |
| `[NOT_FOUND] File not found` | A `--file` or `plan validate` path does not exist from the current directory or the project root | Pass a path relative to either, or an absolute path |
| `plan validate` warns "never grants ownership" | A task's ownership glob points into `.eccode/` | Tasks own project files only; artifacts are submitted to gates, and `.eccode/drafts/` is the shared scratch area |
| Guard denies an edit | Wrong role or file, no claim, or an unreadable record | Follow the reason text. `ECCODE_HOOKS=off` disables hooks for debugging only |
| Guard denies a `git` command | `checkout`/`restore`/`reset`/`stash`/`clean` on `.eccode/` or the whole tree would roll back the record | Restore project files by path (`git checkout -- src/x.js`) |
| `eccode` not found | Plugin bin directory isn't on PATH | Use `node ${CLAUDE_PLUGIN_ROOT}/bin/eccode.js` or `node .claude/eccode/bin/eccode.js` |
| `[LESSON_NOT_VERIFIABLE]` | The lesson lacks a check that fails before the fix and passes after, or similar evidence | Record the reproduction and verification with the **same** command |

## Releases and compatibility

- A release bumps `version` in `package.json`, `.claude-plugin/plugin.json` and `.claude-plugin/marketplace.json` together, adds a dated entry to `CHANGELOG.md`, and passes `npm run check` (static validation, the test suite, and a replay of every shipped record) plus `claude plugin validate .claude-plugin/plugin.json --strict`.
- CI (`.github/workflows/ci.yml`) runs `npm run check` on Ubuntu and macOS with Node 18.17, 20 and 22, runs the Groundwork example's deterministic suite on Node 22, and re-audits the shipped records. The Windows job is reported but does not gate merges yet.
- Records written by older versions replay unchanged (see [architecture.md](architecture.md#record-compatibility)); run `eccode rebuild` after upgrading if `eccode audit` reports a divergent snapshot.
