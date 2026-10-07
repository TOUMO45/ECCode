---
description: Dispatch the ECCode learning-debugger to investigate a bug or failure with reproduction, root cause, verified fix and a reviewed lesson.
argument-hint: <symptom or failing check>
---

Use the `debug-investigation` skill. Dispatch the `learning-debugger` agent with this problem:

$ARGUMENTS

Open a run (`eccode run start`) for the dispatch and close it afterwards. When the agent reports a lesson id, dispatch an independent reviewer (`technical-reviewer` or `security-reviewer`) to run `eccode memory review`. Report the lesson's final status and evidence ids.
