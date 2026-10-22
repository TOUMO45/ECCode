---
description: Index the codebase and brief yourself like a senior engineer joining the team - modules, entry points, hot spots, most-depended files - before changing anything.
---

Run `eccode onboard` and read the brief (it is also saved under `.eccode/cache/onboard.md` in ECCode projects). Summarize for the user: what the codebase is, its biggest modules, where the entry points are, which files are hot spots, and which files have the most dependents (the dangerous ones to change). Before any change to a most-depended file, run `eccode impact <file>` and report what it reaches. Change nothing.
