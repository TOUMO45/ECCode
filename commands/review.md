---
description: Senior code review of a change (uncommitted changes, the last commit, a branch, a PR or files) - correct, safe, holds under load, tested, fast, lean - with a concrete failing case for every finding. Reports only.
argument-hint: [what to review]
---

Use the `senior-review` skill to review:

$ARGUMENTS

If nothing is named, review the uncommitted changes, or the last commit when there are none. Read the callers of every changed function, not only the diff. Produce the one-shot report and change no code.
