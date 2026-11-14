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
2. It prints seven numbered steps. **Do steps 1 to 4 yourself**, with the `--actor` each line names. You are the builder: do not dispatch another agent to build.
3. Dispatch **one** agent for the review: subagent `eccode:technical-reviewer`, given steps 5 and 6 copied word for word and nothing else to do. Wait for it. (No subagents on your host: do steps 5 and 6 yourself and say so in the report.)
4. Run `eccode status --brief`. If NEXT says `deliver`, run step 7. If NEXT says anything else, do exactly what it says (it prints the commands), then run `eccode status --brief` again.
5. Report what was built and paste the last passing check.

Do not load the `orchestrate` skill for small work, and do not ask the user anything: where the idea leaves something open, decide, and say what you decided in the report.

## Anything larger

Use the `orchestrate` skill. Initialize the project record, then follow the workflow. Show the user `eccode status --brief` after every gate decision.
