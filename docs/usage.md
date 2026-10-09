# Installation, Configuration, Usage and Troubleshooting

## Requirements
- Node.js ≥ 18.17. No npm dependencies.
- Supported platforms: Linux and macOS with Node 18.17, 20 and 22, gated by CI (`npm run check` on every push). Windows with Node 22 runs in CI but does not gate merges until the suite has passed on the runner: the test fixtures no longer need `sh`, `grep`, `true` or `;`, test repos set `core.autocrlf=false`, and `.gitattributes` checks every text file out as LF, so a clone with `core.autocrlf=true` audits the shipped records like any other. A project's own checks (its runtime, browsers, services) may have further needs.
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
| `review.criteriaSections` | `{ architecture: ["Acceptance Criteria"] }` | Headings under which the brief lists the acceptance-criteria ids (`- AC1 …`, `\| AC1 \| … \|`) every architecture, design and verification approval must cover; `eccode gate show <gate>` lists them. A brief whose sections carry no ids (or lacks the headings) cannot be approved at architecture or verification; `{ architecture: [] }` (explicitly empty) turns that rule off deliberately. Design and verification read the brief at the bytes the architecture approval pinned (`APPROVED_ARTIFACT_CHANGED` when the file was edited since) |
| `roles.<gate>.authors/reviewers` | see file | Who may submit and who may approve. You can add ECC language reviewers here |
| `memory.learning` | true | `false` turns learning off: no lesson retrieval or recording, no promotion, no self-improvement proposals. Project facts are still recorded, and rollback stays available. `ECCODE_LEARNING=on\|off` overrides it. |
| `memory.staleAfterDays` | 180 | Age after which a lesson must be revalidated |
| `memory.embedCommand` | null | Optional external embedder for semantic retrieval |
| `memory.sharedDir` | `~/.eccode/memory` | Shared lesson store. `ECCODE_SHARED_MEMORY` overrides it |
| `improvement.requireUserForAdoption` | true | Workflow changes need the user (`--actor user` at a terminal, or a delegation for `improve.adopt`) |
| `improvement.protectedPaths` | config, settings, record, hooks, engine | Paths self-improvement can never change. The built-in list is always applied; this key can only add to it |
| `release.blockRiskSeverities` | `["critical", "high"]` | `deliver` is refused while a risk of these severities is `open`; `mitigated`, `accepted` (by the user, `--actor user`) and `closed` pass |
| `release.ignore` | `[]` | Globs the release-tree checks leave out (generated files no review covers). Every other file that changed since the first approved submission's commit must be reviewed before the verification gate is approved and before delivery |

Environment variables:
- `ECCODE_ROOT`: project root.
- `ECCODE_ACTOR`: default actor. The guard denies setting it inline in a command (`ECCODE_ACTOR=x eccode …`); pass `--actor`.
- `ECCODE_HOOKS=off`: disable the hooks.
- `ECCODE_SEQUENTIAL_ROLES=1`: allow the main session to act as roles. Use it only in disclosed sequential mode.
- `ECCODE_SHARED_MEMORY`: shared memory location.
- `ECCODE_LEARNING=on|off`: override `memory.learning`. Any other value is refused.
- `ECCODE_UNATTENDED=1`: the session has no human to answer questions (a headless `claude -p` run). The Stop hook then refuses to let a session started with `/eccode:start`, `/eccode:change` or `/eccode:resume` end before the delivery is complete or a user decision is pending, because an unattended orchestrator may otherwise judge the process too heavy for a small change and skip it. Interactive sessions are never blocked; at most 4 stops per session are blocked.
- `ECCODE_NOW`: pin the clock. Honoured only with `ECCODE_TEST=1` (test suites); otherwise ignored, because gate order rules compare timestamps.
- `ECCODE_TEST=1`: the test suite's switch. It pins the clock with `ECCODE_NOW` and lets `--actor user` run without a terminal. It must never be set in an agent's environment (the guard denies it inline); a session that has it cannot tell a person from a script.

### Limits: what the engine enforces and what it only accounts

Every limit is checked by the engine against the record when a command runs. What the record holds about spend and runtime is what the orchestrator reported after each run (`run end --tokens/--cost-usd`), so the dollar and minute limits are accounting of reported usage, not hard enforcement: the engine cannot meter tokens as they are consumed, hold a deadline, or stop a running agent. Only the host (Claude Code) can do that. A figure the engine was never given is recorded as unknown (`null`), never as `$0`, and `status`/`resume` then print `Budget: $X/$Y (N runs with unknown usage; spend is a lower bound)` (plus `$E of it estimated from tokens` when `pricing.usdPerMillionTokens` turned token counts into dollars) until `eccode run correct <runId> --tokens <n> --cost-usd <x> --reason <text> --actor orchestrator` fills the runs in.

| Limit | The engine enforces | Self-reported by the orchestrator | Only the host can enforce |
|---|---|---|---|
| `maxConcurrency` | `task claim` refuses when that many tasks are claimed (`CONCURRENCY_LIMIT`) | — | That no more agents run than tasks are claimed |
| `maxActiveRuns` | `run start` refuses when that many runs are open (`RUN_LIMIT`) | That every dispatch opens a run and every finished agent closes one | Cancelling an agent process that is still running |
| `maxReviewIterations` | `gate review` escalates the gate to the user after that many rejections | — | — |
| `maxTaskRetries` | `task claim` refuses a task whose attempts are used up and `task fail` escalates it to the user | — | — |
| `maxReworks` | `rework open` refuses past the cap unless the user opens it or delegates it (`USER_AUTH_REQUIRED`) | — | — |
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

**Release policy.** The delivery is a commit. Every gate submission records the commit and a digest of the working tree it was made on, and `eccode deliver` refuses while the working tree is dirty outside `.eccode/` (`uncommitted changes: … commit or revert them`), while any file git shows added, modified, deleted or renamed since the last approved submission's commit was not pinned by an approved review (`eccode audit` reports the same entries), or while a risk whose severity is in `release.blockRiskSeverities` is still open: mitigate it (`eccode risk update --id R --status mitigated --mitigation "…" --actor <role>`) or have the user accept it (`eccode risk update --id R --status accepted --actor user`, run by the user). A task cannot be claimed while files inside its ownership are already changed in the working tree (`DIRTY_OWNERSHIP`): commit or revert them first, so that every owned byte a phase reviews is either the base commit or a change the task declares. The final handoff states the release commit and lists accepted risks with who accepted them. Generated files that no review covers go in `release.ignore`.

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

Actor restrictions: `run correct`, `recover` and `improve rollback` need `--actor orchestrator` or `--actor user`; `rebuild --force` (accepting a rolled-back log) needs the user (next section).

## Who can act as the user

The engine reserves some decisions for the user: reopening an escalated gate or an approved verification gate (`gate reopen`), resetting an escalated task (`task reset`), a rework past `limits.maxReworks` (`rework open`), accepting a risk (`risk update --status accepted`), accepting a rolled-back log (`rebuild --force`), adopting a workflow change (`improve adopt`) and recording a decision as the user's (`decision add`). `--actor user` is only a string, so the CLI asks who is behind it. There are three ways a user acts, and the record shows which one:

| Way | How | What the record shows |
|---|---|---|
| **A person at a terminal** | The user runs the `--actor user` command themselves. The CLI prints what is about to be recorded (`About to record as the user: gate reopen architecture (resolution: …)`) and waits for `yes` typed on the TTY. Without a terminal (a pipe, a script, an agent's shell tool) the command is refused with `USER_AUTH_REQUIRED` and nothing is recorded. | The event's `actor` is `user`; no `onBehalfOf`. |
| **A bounded delegation** | The user grants, at a terminal, `eccode delegate grant --actor user --to orchestrator --action <action> [--target <id>] [--uses N] [--expires <minutes>] --reason "<what you decided>"` (defaults: 1 use, 240 minutes; at most 100 uses and 7 days). Actions: `gate.reopen`, `task.reset`, `rework.open`, `risk.accept`, `rebuild.force`, `improve.adopt`, `decision.record` (`limits.raise` is reserved for a later feature). A delegation without `--target` covers any target of its action; `rebuild.force` and `decision.record` take none. The agent then reruns the refused command with `--actor orchestrator --delegation <dlg-id>`. The use is spent first (`delegation.used`), then the action runs; a delegation that is exhausted, expired, revoked, granted to another role, or for another action or target is refused and spends nothing. `eccode delegate list` shows every delegation and its status; `eccode delegate revoke <id> --actor user --reason "…"` withdraws one. Delegations cannot be delegated. | `delegation.granted` by `user`; `delegation.used` by the agent; the action's event has the agent as `actor` and carries `onBehalfOf: "user"` and `delegation: "dlg-…"`. |
| **The test suite** | `ECCODE_TEST=1` lets `--actor user` run without a terminal so tests can drive the engine. It is never set in an agent's environment. | `actor: user`, indistinguishable from a person: that is why the switch is for the suite only. |

The orchestrator never runs `--actor user`. When the engine answers `USER_AUTH_REQUIRED`, the refusal names both ways forward (the exact command for the user to run in a terminal, and the `delegate grant` that would let the orchestrator act), and the orchestrator shows them to the user.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `[GATE_BLOCKED] … predecessor … not approved` | Gates run in order | Finish and approve the earlier gate |
| `[MISSING_SECTIONS]` | The architecture or design artifact lacks a required heading | Add the section. Change `review.requiredSections` only if the team agrees |
| `[REVIEW_REJECTED] … authored work` | The reviewer is an author or task owner of the gate | Dispatch a different reviewer role |
| `[REVIEW_REJECTED] … changed after submission` | The artifact was edited after it was submitted | The author resubmits, then it is reviewed again |
| `[REVIEW_REJECTED] … executed by the reviewer` | A phase or verification approval doesn't cite a check the reviewer ran | `eccode evidence run --actor <reviewer> …`, then cite the new `ev:` id |
| `[REVIEW_REJECTED] … does not cover the required criteria` | The approval lacks a criterion for an id the gate requires (the brief's acceptance criteria, `phase:<id>`, `task:<id>`) | `eccode gate show <gate>` lists them; add one criterion per id, met, with evidence citing the section that proves it. Duplicate ids and ids that look required but are not (`AC9`, `task:nope`) are refused too |
| `[REVIEW_REJECTED] … section(s) … list no criterion ids` / `… no heading … matches review.criteriaSections` | The brief lists its acceptance criteria without ids (or not under the configured heading), so no later approval would have to cover any of them; architecture and verification approvals are refused | The author lists each criterion as `- AC1: …` (or a `\| AC1 \| … \|` table row) under the heading and resubmits. To turn the rule off deliberately, set `review.criteriaSections.architecture` to `[]` |
| `[APPROVED_ARTIFACT_CHANGED]` | An approved document (the brief, the spec) was edited or deleted after its approval: `gate show`, a review of a later gate, and a later submission that lists it at other bytes are all refused, because design and verification derive the criteria they must cover from the approved brief | Restore the approved bytes from git (`git checkout -- <path>`; `git log -- <path>` finds the approved version). An approved document is never edited in place: a revision is a new artifact of a later submission, or a user decision |
| `[REVIEW_REJECTED] … the release tree holds changes no review covers, not pinned by submission …` | A verification approval was attempted while a file added, modified, deleted or renamed since the first approved submission's commit (by anyone with commit access, at any point of the delivery) is neither pinned by an approved review nor listed in this verification submission at its current content | List the file in the verification submission (resubmit with it), fix it through a rework, restore its reviewed content, or name a generated path in `release.ignore` |
| `[INVALID_HANDOFF] … ran in a different working directory than the task declares` | The cited run of the declared command was made with `--cwd <dir>` while the task declares another directory (the project root when `verification.cwd` is absent); the same command elsewhere is a different check | Run it again from the declared directory (`eccode evidence run … --cwd <declared cwd> -- <command>`, no `--cwd` for the project root) and cite the new id. A plan declares the directory with `verification.cwd` (relative, inside the project) |
| `[REVIEW_REJECTED] … anchor "#…" not found` | An `artifact:<path>#<anchor>` names a heading, JSON dot path or line the file does not have | Cite a heading of the Markdown file (its text or slug), a dot path that exists in the JSON (`phases.0.id`, `tasks.<id>`), or `L<n>` / `L<a>-L<b>` inside the file |
| `[REVIEW_REJECTED] … every verification command the phase's tasks declare` | A phase approval does not cite a reviewer run of each command the phase's tasks declare | Run each listed command with `eccode evidence run --actor <reviewer> …` after the submission and cite the ids |
| `[INVALID_HANDOFF] … declared verification command` | The handoff cites no passing run, by the task owner after the claim, of the command the task declares | Run that command (as declared, whitespace aside) with `eccode evidence run --actor <owner> --task <id> -- <command>` and cite it |
| `… ran on different bytes` / `… different source tree` | Files changed after the cited check ran (every command evidence pins the tree digest it ran on) | Run the check again after the last change (keep drafts under `.eccode/drafts/`, which the digest ignores) and cite the new id |
| `… log … was deleted or changed since it was recorded` | An evidence log under `.eccode/evidence/` is missing or no longer matches its recorded digest | Run the check again (`eccode evidence run`). `eccode reconcile` reports such logs as `evidence-tampered` blocking issues |
| `[RESPONSE_REQUIRED]` | Resubmitting after changes were requested | Add `--responds-to <reviewId>` |
| `[OWNERSHIP_CONFLICT]` / `[CONCURRENCY_LIMIT]` | Another active task overlaps, or the cap is reached | Wait, or re-plan the ownership globs |
| `[INVALID_HANDOFF] … outside task ownership` | Files were changed outside the task's globs | Revert them, or ask the orchestrator to re-plan |
| `[INVALID_HANDOFF] … unchanged since claim` | The listed files don't differ in git | List only the files that actually changed |
| `[INVALID_HANDOFF] … no task declares` | git shows files changed during the claim outside the task's ownership that no task accounts for | Revert them, or have the task that owns them declare them |
| `[LOG_ROLLBACK]` | `events.jsonl` is behind or different from `state.json` (e.g. restored from git) | Restore the newer log. If the user decides the shorter log is the truth: `eccode rebuild --force --actor user` |
| `[SNAPSHOT_DIVERGED]` | `state.json` differs from a replay of `events.jsonl` (edited, or written by another tool); nothing is built on it | `eccode audit` shows the difference; `eccode rebuild --actor orchestrator` rewrites it from the log (nothing is lost) |
| `[UNVERIFIED]` / `[UNGROUNDED]` | A lesson marked verified has no verifying review of its current revision in the event log | Review it again: `eccode memory review <id> --decision verify` |
| `[BUDGET_EXCEEDED]` | Recorded spend or runtime has reached the limit | Stop and ask the user. Raising limits needs their authorization |
| Gate shows `escalated` | Too many rejections | The user decides: `eccode gate reopen <gate> --actor user --resolution "…" [--waive all\|F1,F2]` in a terminal, or a delegation for `gate.reopen` (see "Who can act as the user"). Without `--waive` the findings stay open and the next approving review must resolve each with evidence; `--waive` records the ones the user accepts |
| `[USER_AUTH_REQUIRED] --actor user needs a person at a terminal` | `--actor user` was run without a TTY (a script, a pipe, an agent's shell tool) or the confirmation was not `yes` | The user runs the command in a terminal and types `yes`, or grants a delegation (`eccode delegate grant …`) and the orchestrator reruns the command with `--delegation <id>` |
| `[USER_AUTH_REQUIRED] … is reserved for the user` | An agent tried a reserved action without a delegation, or with one that does not cover it (exhausted, expired, revoked, another role, action or target) | The refusal names both commands: the user's own, or `eccode delegate grant …` followed by the command with `--delegation <id>`. `eccode delegate list` shows the delegations and their status |
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
| Guard denies a shell write (`>`, `tee`, `cp`, `sed -i`, …) | Shell writes get the same answer as the Edit tool for every role: reviewers and document authors write only their draft areas, implementers only their claim; a relative path after a `cd` cannot be bound | Write drafts under `.eccode/reviews/drafts/`, `.eccode/artifacts/` or `.eccode/drafts/`; write project files from a claimed task, with a path relative to the project root |
| Guard denies "Inline … code … calls a file-writing API" | A subagent ran `node -e`, `python -c`, a heredoc or a pipe into an interpreter that writes files; the guard cannot see which | Use the Edit/Write tool, or save the script under `.eccode/drafts/`, run it from there and declare its outputs |
| Guard denies `--actor user` | `--actor user` is reserved for a person at a terminal; no agent context (the main session included) may claim it | Ask the user to run the command themselves, or to grant a bounded delegation (`eccode delegate grant …`) and rerun with `--actor orchestrator --delegation <id>` |
| Guard denies a write outside the project "written only by the eccode CLI" | The target is another project's `.eccode/` record or the shared memory under `~/.eccode/memory/` | Use `eccode memory …` / `eccode improve …`; record files are never edited by hand, wherever they live |
| `eccode` not found | Plugin bin directory isn't on PATH | Use `node ${CLAUDE_PLUGIN_ROOT}/bin/eccode.js` or `node .claude/eccode/bin/eccode.js` |
| `[LESSON_NOT_VERIFIABLE]` | The lesson lacks a check that fails before the fix and passes after, or similar evidence | Record the reproduction and verification with the **same** command |
| `memory check` says `QUARANTINED`, `memory audit` exits 2, or `[SCOPE] … shared record and cannot be revised` | A shared record's promotion attestation no longer holds (its file was edited after promotion, its `attestations.jsonl` line is missing or the chain is broken, or it was promoted by an older engine), or someone tried to change a shared record in place | Never edit shared records by hand. Revise the lesson in the project it came from, have it verified and `eccode memory promote <id>` again: the new copy gets a new shared id and the old one is superseded. `eccode memory show <sharedId>` prints the reason |
| `[DIRTY_OWNERSHIP]` | Files inside the task's ownership were already changed before the claim (and no submission pins that content) | Commit or revert them (`git checkout -- <file>`, delete an untracked file), then claim again |
| `[DELIVERY_BLOCKED] … uncommitted changes` | The working tree is dirty outside `.eccode/`; the delivery pins the release tree | Commit (or revert) the reviewed work, then `eccode deliver` again |
| `[DELIVERY_BLOCKED] … added/modified/deleted/renamed after approval` | A file changed since the first approved submission's commit and no approved review pinned it | Have it reviewed (a rework, or the next gate's submission), restore it, or list a generated path in `release.ignore`. A staged rename (`git mv`) inside a task's ownership is a deletion plus an addition: the handoff declares both paths |
| `[DELIVERY_BLOCKED] RISK-… is open` | A risk of a severity in `release.blockRiskSeverities` has no disposition | Mitigate it (`eccode risk update --status mitigated --mitigation …`) or the user accepts it (`--status accepted --actor user`) |

## Releases and compatibility

- A release bumps `version` in `package.json`, `.claude-plugin/plugin.json` and `.claude-plugin/marketplace.json` together, adds a dated entry to `CHANGELOG.md`, and passes `npm run check` (static validation, the test suite, and a replay of every shipped record) plus `claude plugin validate .claude-plugin/plugin.json --strict`.
- CI (`.github/workflows/ci.yml`) runs `npm run check` on Ubuntu and macOS with Node 18.17, 20 and 22, runs the Groundwork example's deterministic suite on Node 22, and re-audits the shipped records. The Windows job (Node 22) is reported but does not gate merges until it has passed on the runner (see Requirements for what was fixed for it).
- The package: `package.json` `main` is `lib/index.js`, the engine API (`require('eccode')` gives `Store`, `init`, `openProject`, `gates`, `tasks`, `evidence`, `runs`, `delivery`, `reconcile`, `rework`, `Memory`, `loadConfig`, `version`). `npm run validate` checks that `main` and every `files` entry exist, that `.claude-plugin/plugin.json` and `marketplace.json` carry the package version, and that `npm pack --dry-run` ships `lib/index.js` and `bin/eccode.js` (skipped with a note when npm is not installed). `.gitattributes` keeps every text file LF on every platform; the review-bundle logs and evidence logs are committed byte for byte (`-text`) because manifests pin them.
- Upgrade and rollback are tested (`tests/review-F9.test.js`): the 0.1.0 release (commit `d2d0c243`) is installed into a project as a project-local copy, a record is written with it, the current toolkit is installed over it (`eccode install` replaces the runtime and each hook entry in place), `audit` and `status` still work, and after installing 0.1.0 again the record still audits. That holds because the newer engine wrote only event types 0.1.0 replays; the event types new since 0.1.0 are named in [architecture.md](architecture.md#record-compatibility), and a record that carries them stays on the engine that wrote it, or newer.
- Records written by older versions replay unchanged (see [architecture.md](architecture.md#record-compatibility)); run `eccode rebuild` after upgrading if `eccode audit` reports a divergent snapshot.
