---
description: Run final verification checks and produce the ECCode verified final handoff (refused unless every gate is approved and reviewed files are unchanged).
---

1. Run `eccode audit`. If it fails, stop and report the reasons.
2. Run `eccode deliver --actor delivery-lead`.
3. Present `.eccode/delivery/final-handoff.md` to the user in four groups: verified capabilities (with evidence ids), limitations, open risks and metrics.
