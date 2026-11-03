# State

**Date:** 2026-11-03 (UTC). **Branch:** `claude/eloquent-cray-0g0y6v`.

**H-B2 is a new seed set written after v2 was frozen; it is spent as a blind set (the implementer read its descriptions); the original sealed set remains unopened (key unavailable); the old 26 seeds are never cited as measured. H-B3 is another new seed set, written after the v3 freeze.**

**H-B2 (done):** v2 flagged 9 of 41 unintended seeds (22 percent, exact 95 percent 10.6 to 37.6); the 90 percent rule NOT met; v1 flagged 0 of 41; 23 capability and 9 configuration misses (post-hoc, not re-tested); intended seeds 0 of 8 false positives but only 2 of 7 accepted showed their declared change. Register rows 179 to 181.

**H-B3 (owner decisions of 2026-11-03), in progress:**
- Done and verified: design and pre-registration committed before any code (`8d89155`); detector v3 generator (G1 to G7) and Mealie setup (S1 to S4: same ids on every fresh setup, five roles, richer dataset, canonical association order, single-candidate random route), tests red then green; the report (four intended outcomes, 50 and 90 percent thresholds), the H-B3 sealing tool (4 per class, 6 to 10 intended, every seed shown), the log analyzer generalised; noise floor 12 of 12 controls with 0 unexplained differences plus a six-baseline-run census; reach checks (exploratory); **v3 frozen at `0323e0b63109b3ee917e9c1eb6bccf7863d27bb4`** (48 files; v1 33 of 33 and v2 47 of 47 still match) and pushed before the key existed; new key generated (never displayed to the implementer) and a copy sent to the owner as a file; seeding brief committed (sha256 `68432df0...`); full suite 596 tests, 588 pass, 0 fail, 8 skipped.
- Running: the independent H-B3 seeding agent (launched 13:08Z); a second blind labeller on 10 H-B2 misses (decision 4).
- Next: integrity analysis of the seeding agent's log, validation (`scratchpad/h3-validate-chunked.sh`), measurement (`h3-measure-all.sh`: v3 primary, v2 comparison), results hashed and committed before any seed is read, classification, second labeller on about ten H-B3 misses, report.
- Round 1-lite: NOT launched (no paid run); benchmark meter $0.

**Restart:** `scratchpad/h3-triage.sh <n>` for the state and a preserved, analyzed copy of the seeding agent's log; the drivers `h3-validate-chunked.sh` and `h3-measure-all.sh` are idempotent; the key file `/root/.cache/eccode/hb3-seeds.key` is never read by the implementer (the scripts expand it into the environment of the tool, which prints nothing of it).
