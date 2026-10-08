---
description: Handle a change request or bug fix on an existing codebase with the ECCode team - reviewed plan with acceptance criteria from the request, owned tasks with evidence, independent phase review that re-runs checks, verified handoff.
argument-hint: <change request or bug report, or a path to a file that contains it>
---

Use the `orchestrate` skill in **change mode** (section 5b) for this request:

$ARGUMENTS

Initialize with `--profile change`, then follow plan → independent plan review → implementation → independent phase review → deliver. Show the user `eccode status --brief` after every gate decision.
