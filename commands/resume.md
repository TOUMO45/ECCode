---
description: Resume an interrupted ECCode delivery from the persistent project record (recovers interrupted runs and continues from the next action).
---

Use the `orchestrate` skill in resume mode:
1. Run `eccode resume` and show the brief to the user.
2. If runs from a previous session are still open, run `eccode recover --all` and report which claims were released.
3. Continue from the reported NEXT action. Do not redo approved gates.
