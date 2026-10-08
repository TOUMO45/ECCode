---
description: Dispatch the ECCode learning-debugger to investigate a bug or failure with reproduction, root cause, verified fix and a reviewed lesson.
argument-hint: <symptom or failing check>
---

Use the `debug-investigation` skill. Dispatch the `learning-debugger` agent with this problem:

$ARGUMENTS

Open a run (`eccode run start`) for the dispatch and close it afterwards.

When the agent reports a lesson id, dispatch an independent reviewer (`technical-reviewer` or `security-reviewer`) to run `eccode memory review`.

If the reviewer verifies it and the lesson is not specific to this project's private details, have that reviewer (not the author) run `eccode memory promote <id>` so other projects can retrieve it. Promotion runs a privacy scan and refuses unsafe content. Skip every memory step when `eccode memory status` reports `learning: off`.

Report the lesson's final status, its shared id if promoted, and the evidence ids.
