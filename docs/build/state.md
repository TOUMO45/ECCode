# State

**Date:** 2026-11-03 (UTC). **Branch:** `claude/eloquent-cray-0g0y6v`.

**H-B2 is a new seed set written after v2 was frozen. The original sealed set remains unopened (key unavailable); the old 26 seeds are never cited as measured.**

**Done:** detector v2 frozen (`72d89a6`, 47 files) and registered (amendment 4) before any seed existed; the independent agent sealed 41 unintended + 8 intended seeds (`a29b807`: sealedSha256 `18d2e8d8...`); its tool log analyzed (register row 179: no read of detector, probe, config or tests; three adjudicated items); the plaintext it left on disk deleted unread; Round 1-lite Amendment 1 registered and sent to the owner (not launched).

**In progress:** validation of the sealed set with the registered `--prune` rule, run in chunks of 4 because the container restarts every 20 to 45 minutes (`scratchpad/validate-chunked.sh`, verdicts in `scratchpad/validate-verdicts.tsv`). Idempotent: after a restart run it again.

**Next, in order:** (1) when validation is DONE: commit the pruned set; check the minimum (>= 24 unintended, >= 2 per class); (2) `scratchpad/measure-chunked.sh v2`, then `v1` (frozen-file check before and after is in the script); (3) `bench/pilot/hb2/report.js` with the per-seed records; (4) after the results are recorded and hashed: classify misses (capability or configuration) with `scratchpad/peek.js`; (5) archive out of the container with hashes; commit aggregates only; (6) report with the standing statement.

**Waiting for the owner:** the Round 1-lite budget (<= $325 in total), not launched.

**Restart:** `scratchpad/triage.sh <n>` prints the state and preserves the agent log; re-run the driver that was running. The key file is `/root/.cache/eccode/hb2-seeds.key` (never read by the implementer; passed as `ECCODE_SEED_KEY=$(cat file)` to one command at a time).
