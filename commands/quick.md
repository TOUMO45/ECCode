---
description: Make one small change through the ECCode quick track - one command sets it up, the owning engineer implements and tests it, an independent reviewer approves it, and the record proves every step.
argument-hint: <the change to make>
---

You are the orchestrator for one quick change:

$ARGUMENTS

**CLI.** Use `eccode` if it is on PATH, else `node .claude/eccode/bin/eccode.js` (project install) or `node ${CLAUDE_PLUGIN_ROOT}/bin/eccode.js` (plugin). Below, `E` stands for that string. Give it to every agent you dispatch.

You coordinate; agents do the work. Never edit project files or act as another role yourself; the guard refuses it. When the engine refuses a step, send its exact message back to the agent that took the step.

If the owner reports that the guard refused a file outside the task's ownership, and the change really needs that file, correct the ownership instead of stopping. Release the task with `E task fail change --actor orchestrator --reason "<why>"`. Widen it with `E task rescope change --files "<globs>" --actor orchestrator --reason "<why>"`. Then dispatch the owner again; its new claim starts from the current files.

1. **Set up.** Run `E quick "<the change, one line>" --actor orchestrator`. Add `--owner frontend-engineer` for UI work, `--files <globs>` to narrow ownership, `--command "<cmd>"` when no test command is detected. The printed path is the plan.
2. **Implement.** Dispatch the owner subagent (usually `backend-engineer`) with the request, `E`, and step 1 of the printed path. It must:
   - claim `change`, make the change with a test, and run the exact verification command through `E evidence run`;
   - write `E handoff draft --task change --actor <owner> --out .eccode/drafts/handoff-change.json`, fill in its TODO fields, and complete the task;
   - submit the phase: `E gate submit phase:change --actor <owner>`.
3. **Review the change.** Dispatch `technical-reviewer` with `E` and the gate name only. Do not summarize the work for it. It reads the diff, runs the verification command itself through `E evidence run --gate phase:change`, and records `E gate review phase:change`. On `changes_requested`, re-dispatch the owner with the review id; its resubmission uses `--responds-to <reviewId>`.
4. **Verify.** Run `E gate start verification --actor orchestrator`. Dispatch `delivery-lead` to write `.eccode/artifacts/verification.md` and submit it: `E gate submit verification --actor delivery-lead --artifact .eccode/artifacts/verification.md`. Then dispatch `security-reviewer` to run the check again and review `verification`.
5. **Deliver.** Dispatch `delivery-lead`: `E deliver --actor delivery-lead`.
6. **Report.** Show the user `E status --brief` and the path of the final handoff. Claim only what the record shows.

**Cost.** Around every dispatch, open and close a run so the record carries what the change cost:
```
E run start --actor orchestrator --for <role> --task change      # or --gate <gate> for reviews; prints the run id
E run end <run id> --actor orchestrator --status ok --tokens <total tokens of the Agent result>
```
Write the run id literally (no `$RUN`: the guard cannot read shell expansion and would ask a human). `E metrics` reports tokens, cost, runs and wall time per track.
