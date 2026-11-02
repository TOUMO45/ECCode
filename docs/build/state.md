# State

**Date:** 2026-11-02. **Branch:** `claude/eloquent-cray-0g0y6v`.

**Works now:** detector v2 (endpoint-source join, bounded examples, two normalizers, equal-length side paths); the Mealie configuration with a generic population step and the six storage-size fields excluded; the runner with audit + archive; the sealing and freeze tools; the Round 1-lite freeze script. Full suite green in both configurations.

**Done since:** v2 freeze committed and pushed (`72d89a6`, 47 files), recorded in amendment 4 (`861358d`); the report tool (`15f16b8`); the key generated unseen (`/root/.cache/eccode/hb2-seeds.key`, mode 600, never read); the independent seeding agent launched with the committed brief at ~19:33Z (it writes the sealed set to `bench/suites/phase2-seeds-2/`).

**Next executable task:** when the agent's report arrives (counts per class only): commit the as-sealed set; copy it to a working directory and run `phase2-seed-validate.js --prune` from the v2 worktree (`ECCODE_SEED_DIR=<copy>`); commit the pruned set; if >= 24 unintended with >= 2 per class survive, run `scratchpad/measure.sh` (frozen-file check before and after, v2 then v1); `bench/pilot/hb2/report.js`; classify misses after the results are hashed; archive out of the container with hashes; commit aggregates only.

**Blocked / waiting for the owner:** the original sealed set (key never supplied; not searched for); the Round 1-lite budget (protocol section 7: cap $300, interim stop $120) — no paid benchmark run starts without it.

**Restart:** read `plan.md`; `git log` for the freeze commit; the Mealie checkout `/root/.cache/eccode/mealie-seed` must be clean (`git -C … status`); the Mealie venv has hypothesis; `NLTK_DATA=/root/.cache/eccode/nltk_data`; the v1 worktree is `…/scratchpad/frozen-hb` (recreate with `git worktree add --detach <dir> 4fbb80ed23ed58c059ba6bc99fb6318c61562257`); the Phase 3 fixture venv is `/root/.cache/eccode/phase3-venv`.
