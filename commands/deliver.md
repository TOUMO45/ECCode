---
description: Run final verification checks and produce the ECCode verified final handoff (refused unless every gate is approved, reviewed files are unchanged, the working tree is committed, and no critical or high risk is open).
---

1. Run `eccode audit`. If it fails, stop and report the reasons.
2. Run `eccode deliver --actor delivery-lead`. It refuses an uncommitted working tree (the delivery pins the release commit; commit the reviewed work first), files changed since the last approved submission that no review pinned, and open critical/high risks (`release.blockRiskSeverities`): a risk is mitigated by its owner or accepted by the user (`eccode risk update --id R --status accepted --actor user`, run by the user, never on their behalf).
3. Present `.eccode/delivery/final-handoff.md` to the user in four groups: verified capabilities (with evidence ids), limitations, open risks and metrics.
