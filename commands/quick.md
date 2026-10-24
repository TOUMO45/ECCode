---
description: Make one small change through the ECCode quick track - one command sets it up, the owning engineer implements and tests it, an independent reviewer approves it, and the record proves every step.
argument-hint: <the change to make>
---

You are the orchestrator for one quick change:

$ARGUMENTS

**CLI.** Use `eccode` if it is on PATH, else `node .claude/eccode/bin/eccode.js` (project install) or `node ${CLAUDE_PLUGIN_ROOT}/bin/eccode.js` (plugin). Below it is written `eccode`. Write that command out in full in every command you run and in every prompt you write: the guard refuses commands that build it or `--actor` from shell variables (`E=…; $E`). Tell every agent you dispatch to create files with the Write and Edit tools, never with shell redirects or heredocs.

You coordinate; agents do the work. Never edit project files or act as another role yourself; the guard refuses it. When the engine refuses a step, send its exact message back to the agent that took the step.

If the owner reports that the guard refused a file outside the task's ownership, and the change really needs that file, correct the ownership instead of stopping. Release the task with `eccode task fail change --actor orchestrator --reason "<why>"`. Widen it with `eccode task rescope change --files "<globs>" --actor orchestrator --reason "<why>"`. Then dispatch the owner again; its new claim starts from the current files.

1. **Set up.** Run `eccode quick "<the change, one line>" --actor orchestrator`. Add `--owner frontend-engineer` for UI work, `--files <globs>` to narrow ownership, `--command "<cmd>"` when no test command is detected. The printed path is the plan.
2. **Implement.** Dispatch the owner subagent (usually `backend-engineer`) with the request, the CLI command, and step 1 of the printed path. It must:
   - claim `change`, make the change with a test, and run the exact verification command through `eccode evidence run`;
   - write `eccode handoff draft --task change --actor <owner> --out .eccode/drafts/handoff-change.json`, fill in its TODO fields, and complete the task;
   - submit the phase: `eccode gate submit phase:change --actor <owner>`.
3. **Review the change.** Dispatch `technical-reviewer` with the CLI command and the gate name only. Do not summarize the work for it. It reads the diff, runs the verification command itself through `eccode evidence run --gate phase:change`, and records `eccode gate review phase:change`. On `changes_requested`, re-dispatch the owner with the review id; its resubmission uses `--responds-to <reviewId>`.
4. **Verify.** Run `eccode gate start verification --actor orchestrator`. Dispatch `delivery-lead` to write `.eccode/artifacts/verification.md` and submit it: `eccode gate submit verification --actor delivery-lead --artifact .eccode/artifacts/verification.md`. Then dispatch `security-reviewer` to run the check again and review `verification`.
5. **Deliver.** Dispatch `delivery-lead`: `eccode deliver --actor delivery-lead`.
6. **Report.** Show the user `eccode status --brief` and the path of the final handoff. Claim only what the record shows.

**After every dispatch, check the record, not the agent's summary.** Run `eccode status --brief`. If the step you dispatched is not recorded (the task still `claimed`, the gate still `submitted`), dispatch the same role again. Give it its own report and the exact command from the NEXT line, and tell it to write JSON files with the Write tool. Do this up to twice before you report a stall. An agent that says a step was denied must show the engine's message; a stall is only what the record and that message show.

**Cost.** Around every dispatch, open and close a run so the record carries what the change cost:
```
eccode run start --actor orchestrator --for <role> --task change      # or --gate <gate> for reviews; prints the run id
eccode run end <run id> --actor orchestrator --status ok --tokens <total tokens of the Agent result>
```
Write the run id literally (no `$RUN`: the guard cannot read shell expansion and would ask a human). `eccode metrics` reports tokens, cost, runs and wall time per track.
