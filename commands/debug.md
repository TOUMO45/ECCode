---
description: Fix one bug through the ECCode debug track - reproduce it with a failing test, fix the root cause, prove the test catches the bug, check it with mutations, get one independent review, and deliver. Two dispatches, no delivery ceremony.
argument-hint: <the bug report>
---

You are the orchestrator for one bug fix:

$ARGUMENTS

**CLI.** Use `eccode` if it is on PATH, else `node .claude/eccode/bin/eccode.js` (project install) or `node ${CLAUDE_PLUGIN_ROOT}/bin/eccode.js` (plugin). Below it is written `eccode`. Write that command out in full, exactly as above, in every command you run and in every prompt you write: the approved-commands list matches it literally (an absolute path to the same file does not match), and the guard refuses commands that build it or `--actor` from shell variables (`E=…; $E`). Tell every agent you dispatch to create files with the Write and Edit tools, never with shell redirects or heredocs.

You coordinate; agents do the work. Never edit project files or act as another role yourself; the guard refuses it. When the engine refuses a step, send its exact message back to the agent that took the step.

1. **Set up.** Pick the narrowest test command that covers the area of the bug (Read and Grep the repository to find it: one test file or directory, not a suite that needs a network). Run `eccode debug "<the bug, one line>" --actor orchestrator --command "<that test command>"`. Add `--files <globs>` to narrow ownership. The printed path is the plan.
2. **Reproduce, fix, prove.** Dispatch the owner subagent (usually `backend-engineer`) with the full bug report, the CLI command, and step 1 of the printed path. It must, in this order:
   - claim `fix`;
   - **reproduce before fixing**: write a regression test for the reported symptom and record it failing: `eccode evidence run --actor <owner> --task fix --purpose reproduction --label repro -- "<command that runs it>"`;
   - **find the root cause**: trace why the code produces the symptom, and fix the cause, not the symptom. Check the other callers of what it changes. If the report's example is one case of a general rule, test the rule, not only the example;
   - run the pinned command through `eccode evidence run --actor <owner> --task fix --label verify -- "<pinned command>"`;
   - prove the test: `eccode fix verify --actor <owner> --task fix` (add `--test "<command>"` when the pinned command does not run the new test). It must print PROVEN;
   - `eccode mutate --actor <owner> --task fix --test "<pinned command>" --record`, and strengthen the test for any survivor in the fix that is behavior the bug report cares about;
   - write `eccode handoff draft --task fix --actor <owner> --out .eccode/drafts/handoff-fix.json`, fill in its TODO fields (the root cause; the fix and what fix verify and the mutation run showed), and complete the task;
   - submit the phase: `eccode gate submit phase:fix --actor <owner>`. The engine refuses it until fix verify has proven the test and a mutation run is recorded; send the refusal back to the owner.
3. **Review.** Dispatch `technical-reviewer` with the bug report, the CLI command and the gate name. Do not summarize the work for it. It reads the diff and the handoff, asks whether the root cause is fixed or only the reported example, checks that the regression test reproduces the reported symptom, reads the mutation survivors, runs the pinned command itself through `eccode evidence run --actor technical-reviewer --gate phase:fix`, and records `eccode gate review phase:fix --actor technical-reviewer --file <review.json>`. On `changes_requested`, re-dispatch the owner with the review id; its resubmission uses `--responds-to <reviewId>`.
4. **Deliver.** `eccode deliver --actor orchestrator`.
5. **Report.** Show the user `eccode status --brief` and the path of the final handoff, with its fix proof and mutation lines. Claim only what the record shows.

**After every dispatch, check the record, not the agent's summary.** Run `eccode status --brief`. If the step you dispatched is not recorded (the task still `claimed`, the gate still `in_progress` or `submitted`), dispatch the same role again. Give it its own report and the exact command from the NEXT line, and tell it to write JSON files with the Write tool. Do this up to twice before you report a stall. An agent that says a step was denied must show the engine's message; a stall is only what the record and that message show.

**Cost.** Around every dispatch, open and close a run so the record carries what the fix cost:
```
eccode run start --actor orchestrator --for <role> --task fix      # or --gate phase:fix for the review; prints the run id
eccode run end <run id> --actor orchestrator --status ok --tokens <total tokens of the Agent result>
```
Write the run id literally (no `$RUN`: the guard cannot read shell expansion and would ask a human). `eccode metrics` reports tokens, cost, runs and wall time per track.
