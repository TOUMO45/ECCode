# State

**Date:** 2026-11-03 (UTC). **Branch:** `claude/eloquent-cray-0g0y6v`.

**H-B2 is a new seed set written after v2 was frozen; it is spent as a blind set (the implementer read its descriptions); the original sealed set remains unopened (key unavailable); the old 26 seeds are never cited as measured. H-B3 is another new seed set, written after the v3 freeze.**

**H-B2 (done):** v2 flagged 9 of 41 unintended seeds (22 percent); the 90 percent rule not met; v1 0 of 41. Second blind labeller on 10 misses: 10 of 10 agree, kappa 1.0. Register rows 179 to 181.

**H-B3 (done, owner decisions of 2026-11-03):** detector v3 (generator G1 to G7, Mealie setup S1 to S4) built test first, noise floor 12 of 12 controls at zero unexplained plus a six-baseline-run census, frozen at `0323e0b` before any new seed or key existed; an independent agent sealed 57 unintended and 10 intended seeds (all shown to change the application, by its own statement); 67 of 67 validated; measured with v3 (primary) and v2 (comparison), results hashed and committed before any seed was read.

**Result:** v3 flagged **27 of 57** unintended seeds (47.4 percent, exact 95 percent 34.0 to 61.0): **the 50 percent threshold is NOT MET**, the 90 percent aspiration is not met; v2 flagged 15 of 57 (26.3 percent); paired 13 against 1, p = 0.0018. All 27 detections attributable. Intended seeds under v3: 7 accepted and observed, 1 accepted but unobserved, 1 false positive of 8 observed, 1 not verifiable. 30 misses: 24 capability, 6 configuration (post-hoc judgments, not re-tested; second labeller 9 of 10 agree, kappa 0.8). Register rows 182 to 185.

**Not done, by rule:** no re-run with a changed configuration (tuning after a result); Round 1-lite not launched (no paid run, meter $0).

**Waiting for the owner:** whether to register a detector v4 (the named, unfixed blockers in row 185: boundary values, omitted optional fields, form bodies and chaining, equal ids, header capture, non-code surfaces, dates relative to the run day) with a NEW seed set; the Round 1-lite budget decision stands as before.

**Restart:** the scratchpad holds the worktrees (`frozen-hb3` at `0323e0b`, `frozen-hb2`), the result files, the archives and the labels; the key `/root/.cache/eccode/hb3-seeds.key` was never read by the implementer (scripts expand it into the environment of the tool).
