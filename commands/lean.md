---
description: Make one change the lean senior way, outside a full delivery - map its reach, reuse before writing, take the smallest complete change, never cut safety, and leave a test or a stated reason.
argument-hint: <change to make>
---

Use the `lean-change` skill for this change:

$ARGUMENTS

Before writing, run `eccode map --path <area you will touch>` and grep for existing helpers. If this project has an ECCode delivery in progress (`.eccode/events.jsonl` exists), don't edit around it: tell the user the change belongs in the delivery as a task, because edits to approved files fail `eccode audit`. End with one or two lines: what you deliberately did not build, and anything you could not verify.
