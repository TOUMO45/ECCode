# State

**Date:** 2026-11-02. **Branch:** `claude/eloquent-cray-0g0y6v`.

**Works now:** detector v2 (endpoint-source join, bounded examples, two normalizers, equal-length side paths); the Mealie configuration with a generic population step and the six storage-size fields excluded; the runner with audit + archive; the sealing and freeze tools; the Round 1-lite freeze script. Full suite green in both configurations.

**Next executable task:** generate the v2 freeze (`node bench/pilot/hb2/freeze.js`), commit and push, record the freeze commit in protocol amendment 4; then key (never read), seeding agent, validation with `--prune`, measurement (v2 primary, v1 comparison), report.

**Blocked / waiting for the owner:** the original sealed set (key never supplied; not searched for); the Round 1-lite budget (protocol section 7: cap $300, interim stop $120) — no paid benchmark run starts without it.

**Restart:** read `plan.md`; `git log` for the freeze commit; the Mealie checkout `/root/.cache/eccode/mealie-seed` must be clean (`git -C … status`); the Mealie venv has hypothesis; `NLTK_DATA=/root/.cache/eccode/nltk_data`; the v1 worktree is `…/scratchpad/frozen-hb` (recreate with `git worktree add --detach <dir> 4fbb80ed23ed58c059ba6bc99fb6318c61562257`); the Phase 3 fixture venv is `/root/.cache/eccode/phase3-venv`.
