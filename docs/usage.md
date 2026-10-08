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
- the two hooks.

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

It also **merges** two hook entries into `.claude/settings.json`. Existing settings and hooks are kept, and re-running the command is idempotent. The CLI is then `node .claude/eccode/bin/eccode.js`.

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
| `limits.maxReviewIterations` | 3 | Rejections per gate before the gate escalates to the user |
| `limits.maxTaskRetries` | 2 | Failed attempts allowed per task after the first one, before escalation |
| `limits.maxRuntimeMinutes` | 480 | Total runtime of recorded agent runs |
| `limits.maxCostUsd` | 25 | Total spend recorded for agent runs |
| `limits.staleRunMinutes` | 60 | How long a run can stay open before it counts as interrupted |
| `pricing.usdPerMillionTokens` | null | Used to estimate cost when only token counts are reported |
| `review.requiredSections` | see file | Headings that must appear in architecture and design artifacts |
| `roles.<gate>.authors/reviewers` | see file | Who may submit and who may approve. You can add ECC language reviewers here |
| `memory.learning` | true | `false` turns learning off: no lesson retrieval or recording, no promotion, no self-improvement proposals. Project facts are still recorded, and rollback stays available. `ECCODE_LEARNING=on\|off` overrides it. |
| `memory.staleAfterDays` | 180 | Age after which a lesson must be revalidated |
| `memory.embedCommand` | null | Optional external embedder for semantic retrieval |
| `memory.sharedDir` | `~/.eccode/memory` | Shared lesson store. `ECCODE_SHARED_MEMORY` overrides it |
| `improvement.requireUserForAdoption` | true | Workflow changes need `--actor user` |
| `improvement.protectedPaths` | config, settings, hooks, engine | Paths self-improvement can never change |

Environment variables:
- `ECCODE_ROOT`: project root.
- `ECCODE_ACTOR`: default actor.
- `ECCODE_HOOKS=off`: disable the hooks.
- `ECCODE_SEQUENTIAL_ROLES=1`: allow the main session to act as roles. Use it only in disclosed sequential mode.
- `ECCODE_SHARED_MEMORY`: shared memory location.
- `ECCODE_LEARNING=on|off`: override `memory.learning`. Any other value is refused.
- `ECCODE_NOW`: pin the clock (for tests).

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
`eccode help` lists every command. Exit codes: `0` ok, `1` usage error, `2` refused by a workflow rule. `memory check` returns `3` when a lesson doesn't apply.

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
| `[BUDGET_EXCEEDED]` | Recorded spend or runtime has reached the limit | Stop and ask the user. Raising limits needs their authorization |
| Gate shows `escalated` | Too many rejections | The user decides: `eccode gate reopen <gate> --actor user --resolution "…"` |
| Open runs after a crash | The previous session died | `eccode recover --all --actor orchestrator` |
| `Audit FAILED` | The event log was edited or an approved file changed | Restore from git. Changes to approved files need a new review |
| Guard denies an edit | Wrong role or file, or no claim | Follow the reason text. `ECCODE_HOOKS=off` disables hooks for debugging only |
| `eccode` not found | Plugin bin directory isn't on PATH | Use `node ${CLAUDE_PLUGIN_ROOT}/bin/eccode.js` or `node .claude/eccode/bin/eccode.js` |
| `[LESSON_NOT_VERIFIABLE]` | The lesson lacks a check that fails before the fix and passes after, or similar evidence | Record the reproduction and verification with the **same** command |
