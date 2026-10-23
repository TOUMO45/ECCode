# MCP server mode: the engine as typed tool calls

The guard hook reads shell text, and shell text can be obfuscated. MCP mode removes the problem instead of parsing harder: the engine is served as **typed tools** over MCP, each server instance is **locked to one role at startup**, and the agent gets **no Bash at all**. There is then no command line to disguise — state changes go through the engine's rules, commands run only through `evidence_run` (executed and recorded by the engine), and file writes stay under the PreToolUse guard's structured path checks.

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

`status`, `gate_show`, `gate_start`, `gate_submit`, `gate_review`, `task_next`, `task_list`, `task_claim`, `task_complete`, `task_fail`, `evidence_run`, `evidence_file`, `handoff_record`, `risk_add`, `decision_add`, `memory_search`, `memory_cite`, `map`, `impact`, `audit`.

Every engine rule applies unchanged: gate order, author ≠ approver, evidence resolution, lean and compatibility checks, track rules, required stack checks. A refusal comes back as the tool result with the same `[CODE] message` the CLI prints.

## Verified live

A headless Claude session configured exactly as above (no Bash; `mcp__eccode` + Write + Read) ran a full cycle — `status` → `task_claim` → Write the file → `evidence_run` → `task_complete` — and the engine recorded the task as done by the locked role. Told to then append a forged line to `.eccode/events.jsonl` with Write, the installed hook denied it; the record stayed clean and `eccode audit` passed. Protocol-level behavior (initialize, tools/list, locked-actor refusals, malformed-line recovery) is covered in `tests/mcp.test.js`.

## What this mode does and does not change

- **Closed by construction:** shell-command obfuscation (there is no shell), `--actor` impersonation (there is no actor argument), direct record writes (no shell; Write is hook-guarded on structured paths).
- **Unchanged:** the engine's rules and their limits — it proves process and evidence, not the quality of a reviewer's judgment.
- **Trade-off:** agents cannot run ad-hoc commands outside `evidence_run`. That is the point: on this surface, everything an agent executes is recorded evidence.

The CLI surface itself is additionally fuzzed: a seeded battery of 240 generated attack variants (all denied) and 120 generated legitimate commands (all allowed) runs in the test suite on every CI job.

The CLI remains the default surface (hooks bind identity there); MCP mode is the containment option for implementers and reviewers, and the two share one record.
