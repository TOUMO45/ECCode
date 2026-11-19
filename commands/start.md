---
description: Start an ECCode delivery - take a product idea through architecture, independent reviews, design, phased implementation, verification and delivery with the ECCode agent team.
argument-hint: <product idea>
---

Deliver this idea with ECCode:

$ARGUMENTS

**CLI.** Use `eccode` if it is on PATH, else `node "${CLAUDE_PLUGIN_ROOT}/bin/eccode.js"`. Below it is written `eccode`. Once `start` has run, copy the commands exactly as it prints them: they already contain the right path. Do not read `eccode help`: `start` prints every command you need. If you cannot run the CLI at all, build the project directly to the brief, test it, and say in the report that ECCode's gates were not used. Never stop with nothing built.

**What the owner asks for outside the brief is remembered by the record, not by you.** Every requirement the owner states that the brief does not say (a changed number, an extra option, a rule for a part built later) goes on the `start` command as `--remember "<the owner's words>"`, one per requirement, the first time you see it; later, `eccode remember "<words>"`. `start` prints everything remembered in earlier sessions: build each part to that, not to the brief.

**Choose the path by size first. This is a rule, not a judgement call.**

## Small: one package, tool, script or service that one engineer builds in one sitting

No separate frontend and backend, no database migration plan, no deployment design. Do exactly this:

1. Run `eccode start "<the idea in one line>"`. If it answers "No test command detected", run the exact command it prints, with the test command the project will use (for example `--command "python3 -m unittest discover -s tests"`).
2. It prints seven numbered steps. **Do steps 1 to 4 yourself**, with the `--actor` each line names. You are the builder: do not dispatch another agent to build.
3. Dispatch **one** agent for the review: subagent `eccode:technical-reviewer`, given steps 5 and 6 copied word for word and nothing else to do. Wait for it. (No subagents on your host: do steps 5 and 6 yourself and say so in the report.)
4. Run `eccode status --brief`. If NEXT says `deliver`, run step 7. If NEXT says anything else, do exactly what it says (it prints the commands), then run `eccode status --brief` again.
5. Report what was built and paste the last passing check.

Do not load the `orchestrate` skill for small work, and do not ask the user anything: where the idea leaves something open, decide, and say what you decided in the report.

## Medium: several features one engineer builds over a day (a tool with storage and several commands, a small service)

Same path, in slices. A slice is one outcome a user could see working ("books can be added and listed"), through every layer it needs. Never slice by layer ("the database", "the CLI").

1. Read the brief and list 2 to 8 slices in build order: what everything else depends on first, the riskiest part early.
2. Run `eccode start "<the idea in one line>" --command "<test command>" --slice "<outcome 1>" --slice "<outcome 2>" ...`
3. It prints the steps for every slice. For each slice, in order: do the builder lines yourself, then dispatch one `eccode:technical-reviewer` with that slice's two reviewer lines copied word for word. Do not start a slice before the one before it is approved.
4. After the last slice run the `deliver` line, then report what was built and paste the last passing check.

If you lose your place, run `eccode status --brief` and do what NEXT says. Do not load the `orchestrate` skill, and do not ask the user anything: decide, and report what you decided.

## Anything larger (separate frontend and backend teams, migrations, deployment design)

Use the `orchestrate` skill. Initialize the project record, then follow the workflow. Show the user `eccode status --brief` after every gate decision.
