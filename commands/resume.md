---
description: Resume an interrupted ECCode delivery from the persistent project record (recovers interrupted runs and continues from the next action).
---

Use the `orchestrate` skill in resume mode:
1. Run `eccode resume` and show the brief to the user.
2. Run `eccode reconcile --verify --actor orchestrator`. It checks approved artifacts against their approved hashes, finds partial work left by interrupted claims, and re-runs the recorded checks. Resolve every BLOCKING item before new work.
3. If runs from a previous session are still open, run `eccode recover --all` and report which claims were released.
4. Continue from the reported NEXT action. Do not redo approved gates.
