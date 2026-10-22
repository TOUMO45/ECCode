---
description: Senior audit of a whole repository or a path - ranked findings (bugs, security, load, missing tests, speed, what to delete, merge or split), each with a concrete failing case. Reports only.
argument-hint: [path]
---

Use the `senior-review` skill in audit mode for: $ARGUMENTS (the whole repository when nothing is named).

Start with `eccode map` to see what exists, and `eccode debt` for shortcuts that are already declared. Go deep where mistakes cost most, and say which parts you did not read. Produce the one-shot report with at most 20 findings, and change no code.
