# State

**Date:** 2026-11-03 (UTC). **Branch:** `claude/eloquent-cray-0g0y6v`.

**H-B2 is a new seed set written after v2 was frozen. The original sealed set remains unopened (key unavailable); the old 26 seeds are never cited as measured.**

**Done and verified:** detector v2 frozen (`72d89a6`) and registered before any seed existed; 41 unintended + 8 intended seeds written by an independent agent (integrity analysis: no read of detector, probe, config or tests; register row 179), validated 49/49 by the registered rule (none pruned), measured with v2 (primary) and v1 (comparison), frozen files matching before and after; results hashed before any seed was read (`ff247ff`); classification, attribution and the claim recorded (`23a0921`, register rows 180 and 181); result bundle sent to the owner (sha256 `598b63f1...`). Round 1-lite Amendment 1 registered and sent (not launched). Full suite: 563 tests, 0 failing with Python; 532, 0 failing without.

**Result:** v2 flagged 9 of 41 unintended seeds (22 percent, exact 95 percent 10.6 to 37.6); the H-B rule (90 percent) is NOT met; v1 flagged 0 of 41; 23 capability and 9 configuration misses (post-hoc, not re-tested); intended seeds 0 of 8 false positives but only 2 of 7 accepted showed their declared change. The set is spent as a blind set.

**Waiting for the owner:** (1) the Round 1-lite budget (<= $325 in total), not launched; (2) whether to register a detector v3 (UUID4 and other formats in the generator, non-code surfaces, chained probes, header capture, richer setup data) with a NEW seed set; the blockers are in register row 181.

**Not done, by rule:** no re-run with a changed configuration (that would be tuning after a result); the labels are judgments.

**Restart:** `scratchpad/triage.sh` for the state; the drivers `validate-chunked.sh`, `measure-all.sh` are idempotent; the key file `/root/.cache/eccode/hb2-seeds.key` is never read by the implementer.
