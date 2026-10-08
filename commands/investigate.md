---
description: Dispatch the ECCode learning-debugger to investigate a bug or failure with reproduction, root cause, verified fix and a reviewed lesson.
argument-hint: <symptom or failing check>
---

Use the `debug-investigation` skill. Dispatch the `learning-debugger` agent with this problem:

$ARGUMENTS

**If the failing code was already approved or delivered** (its phase gate is approved, so its files are pinned), the fix goes through a rework, never around the gates:
1. Open it: `eccode rework open --actor orchestrator --reason "<failing check and symptom>" --files "<glob of the files to change>" --files "<glob of the tests>" --owner learning-debugger [--evidence ev:<failing reproduction>]`. The scope must be narrow (never `**`).
2. The debugger claims the rework task and reproduces the failure with a failing check (`--purpose reproduction`) first, then fixes it and re-runs the **same** check. It completes the task with a handoff and submits the gate `phase:rework-N`.
3. An independent `technical-reviewer` (plus `security-reviewer` for auth, input handling, money or AI) reviews the gate, re-running the checks. Blocking findings return to the owner.
4. Re-deliver with `eccode deliver --actor orchestrator`.
The reproduction and the passing re-run from step 2 are the fail-then-pass pair the lesson needs.

Open a run for the dispatch (`eccode run start --actor orchestrator --agent learning-debugger`) and close it afterwards with the agent's reported usage.

When the agent reports a lesson id, dispatch an independent reviewer (`technical-reviewer` or `security-reviewer`) to run `eccode memory review`.

If the reviewer verifies it and the lesson is not specific to this project's private details, have that reviewer (not the author) run `eccode memory promote <id>` so other projects can retrieve it. Promotion runs a privacy scan and refuses unsafe content. Skip every memory step when `eccode memory status` reports `learning: off`.

Report the lesson's final status, its shared id if promoted, and the evidence ids.
