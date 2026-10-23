# MCP server mode: the engine as typed tool calls

The guard hook reads shell text, and shell text can be obfuscated. MCP mode removes the problem instead of parsing harder: the engine is served as **typed tools** over MCP, each server instance is **locked to one role at startup**, and the agent gets **no Bash at all**. State changes go through the engine's rules; `evidence_run` executes **only commands approved upstream** — planned task verification commands, the work item's behavior command, and detected stack checks — and refuses anything else (`COMMAND_NOT_APPROVED`); file writes stay under the PreToolUse guard's structured path checks.

## Start a server

```bash
eccode mcp --actor backend-engineer --root /path/to/project
```

- One server per role; the actor is fixed for the server's lifetime and no tool takes an actor argument.
- `--actor user` is refused: user decisions stay in the CLI, where the guard makes Claude Code ask the human.
- Transport: newline-delimited JSON-RPC over stdio (`initialize`, `tools/list`, `tools/call`).

## Configure a contained implementer (Claude Code)

`.mcp.json` (or `--mcp-config`):

```json
{
  "mcpServers": {
    "eccode_backend": { "command": "node", "args": [".claude/eccode/bin/eccode.js", "mcp", "--actor", "backend-engineer"] },
    "eccode_reviewer": { "command": "node", "args": [".claude/eccode/bin/eccode.js", "mcp", "--actor", "technical-reviewer"] }
  }
}
```

Give the backend agent `mcp__eccode_backend` plus `Read, Grep, Glob, Edit, Write` — and **no Bash**. The reviewer gets `mcp__eccode_reviewer` plus read tools.

## Tools

`status`, `gate_show`, `gate_start`, `gate_submit`, `gate_review`, `task_next`, `task_list`, `task_claim`, `task_complete`, `task_fail`, `evidence_run`, `evidence_file`, `handoff_record`, `risk_add`, `decision_add`, `memory_search`, `memory_cite`, `onboard`, `map`, `impact`, `audit`.

`onboard`, `map` and `impact` make the server the project's **codebase memory**: the import-resolved index persists in `.eccode/cache/` (rebuilt incrementally, so a big repository pays the full scan once), and any agent — including a no-Bash one — reads the brief, the reuse map and the reverse-dependency graph as typed tool calls.

Every engine rule applies unchanged: gate order, author ≠ approver, evidence resolution, lean and compatibility checks, track rules, required stack checks. A refusal comes back as the tool result with the same `[CODE] message` the CLI prints.

## Verified live

A headless Claude session configured exactly as above (no Bash; `mcp__eccode` + Write + Read) ran a full cycle — `status` → `task_claim` → Write the file → `evidence_run` → `task_complete` — and the engine recorded the task as done by the locked role. Told to then append a forged line to `.eccode/events.jsonl` with Write, the installed hook denied it; the record stayed clean and `eccode audit` passed. Protocol-level behavior (initialize, tools/list, locked-actor refusals, malformed-line recovery) is covered in `tests/mcp.test.js`.

## Sandboxed profile: the record is read-only to every shell command

`eccode install --target <project> --sandbox` turns the record boundary from text inspection into an OS rule. It writes:

- `.claude/settings.json` turns on Claude Code's Bash sandbox (`sandbox.enabled`) and sets `failIfUnavailable` (refuse to start without a working sandbox) and `allowUnsandboxedCommands: false` (no unsandboxed retry). It also adds `sandbox.filesystem.denyWrite` entries for the record paths: `events.jsonl`, `state.json`, `config.json`, `evidence/`, `improvements/`, `memory/records/` and the lock. These are plain paths, because the Linux sandbox skips glob entries.
- `.mcp.json` gets one `eccode_<role>` server per role. Claude Code runs MCP servers outside the sandbox, so these servers are the only processes that write the record.
- The guard's matcher gets `mcp__eccode_.*`, and the guard checks each call structurally: a subagent may use only its own role's server, and the main session only `eccode_orchestrator`.

Every shell command and its child processes then sees the record as read-only, in the main session and in subagents, however the command is written. A write whose path is built at runtime fails with `EROFS`. The eccode CLI inside the sandbox reports `RECORD_READ_ONLY` at once and points to the MCP tools. User decisions are made by the human in their own terminal, which is not sandboxed.

Verified live on Linux with bubblewrap ([docs/live/7-sandboxed-profile.txt](live/7-sandboxed-profile.txt)). Requirements come from Claude Code's sandbox:
- macOS: works out of the box.
- Linux and WSL2: needs `bubblewrap` and `socat`.
- Native Windows: has no sandbox. With `failIfUnavailable` Claude Code refuses to start rather than run unprotected, so use WSL2 there or install without `--sandbox` (textual guard only).

Commands that `evidence_run` executes run in the MCP server, outside the sandbox. They are covered by the integrity window instead: any change a command makes to the record is reverted, and a run that changes tracked files outside the caller's claim fails (lib/evidence.js).

## What this mode does and does not change

- **Closed by construction:** a general shell (`evidence_run` runs only approved commands — an independent audit found it previously ran any command, which let a locked server write outside its ownership or act as the user; fixed and tested in `tests/mcp.test.js`), `--actor` impersonation (no tool takes an actor argument, and no unapproved command can call the CLI), direct record writes through Write (hook-guarded on structured paths).
- **Approved commands run project code** (`npm test` runs tests an agent may have edited). What that code does to the record is undone, and what it does to tracked files outside the agent's claim fails the evidence. Both checks look at the effects around every evidence command, not at the command text ([limits.md](limits.md), row 20).
- **Unchanged:** the engine's rules and their limits — it proves process and evidence, not the quality of a reviewer's judgment.
- **Trade-off:** agents cannot run ad-hoc commands at all — only the approved ones, each recorded as evidence. That is the point.

The CLI surface itself is additionally fuzzed: a seeded battery of 240 generated attack variants (all denied) and 120 generated legitimate commands (all allowed) runs in the test suite on every CI job.

The CLI remains the default surface (hooks bind identity there); MCP mode is the containment option for implementers and reviewers, and the two share one record.
