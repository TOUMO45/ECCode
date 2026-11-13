---
description: Start an ECCode delivery - take a product idea through architecture, independent reviews, design, phased implementation, verification and delivery with the ECCode agent team.
argument-hint: <product idea>
---

Deliver this idea with ECCode:

$ARGUMENTS

**CLI.** Use `eccode` if it is on PATH, else `node ${CLAUDE_PLUGIN_ROOT}/bin/eccode.js`. Below it is written `eccode`.

**Choose the path by size first. This is a rule, not a judgement call.**

## Small: one package, tool, script or service that one engineer builds in one sitting

No separate frontend and backend, no database migration plan, no deployment design. Do exactly this:

1. Run `eccode start "<the idea in one line>"`. If it answers "No test command detected", run the exact command it prints, with the test command the project will use (for example `--command "python3 -m unittest discover -s tests"`).
2. It prints seven numbered steps. Dispatch the owner it names (subagent `eccode:<owner>`, for example `eccode:backend-engineer`) with: where the brief is, and **its steps 1 to 4 copied word for word**. Wait for it to finish.
3. Dispatch `eccode:technical-reviewer` with **steps 5 and 6 copied word for word**. Wait for it to finish.
4. Run `eccode status --brief`. If NEXT says `deliver`, run step 7 yourself. If NEXT says anything else, do exactly what it says (it prints the commands), then run `eccode status --brief` again.
5. Report what was built and paste the last passing check.

If your host has no subagents, do every step yourself in order, using the `--actor` each line names.
Do not load the `orchestrate` skill for small work, and do not ask the user anything: where the idea leaves something open, decide, and say what you decided in the report.

## Anything larger

Use the `orchestrate` skill. Initialize the project record, then follow the workflow. Show the user `eccode status --brief` after every gate decision.
