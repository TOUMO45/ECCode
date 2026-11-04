# Agent compute ledger

Owner decision 6 (2026-11-03): record agent compute (tokens) per task. Figures are those the harness reported in each task's completion notice (`subagent_tokens`, `tool_uses`, `duration_ms`); a leg that ended in a container restart reported nothing, and a blank is a blank, not an estimate. The benchmark meter (`claude -p` runs with `--max-cost`) is separate and has spent **$0** in every task below. The main session's own tokens are not reported to it and are not in this ledger.

| Date | Task | Agent | Tokens | Tool uses | Wall time | Note |
|---|---|---|---|---|---|---|
| 2026-11-02 | Blind behaviour labeller A (48 bare screening runs, Round 1-lite relabel) | general-purpose | 127,793 | 10 | 117.6 s | completed in one leg |
| 2026-11-02 | Blind behaviour labeller B (same 48 runs, different shuffle) | general-purpose | 126,558 | 3 | 71.9 s | completed in one leg |
| 2026-11-02 to 03 | H-B2 independent seeding agent | general-purpose | 509,260 (last leg only) | 21 (last leg only); 231 over the whole log | 2,025.9 s (last leg only); 19:32Z to 23:24Z by the log | three container restarts, resumed twice; the earlier legs reported no usage |
| 2026-11-03 | Second blind labeller on 10 H-B2 misses (decision 4) | general-purpose | 96,974 | 3 | 151.5 s | completed in one leg; 10 of 10 labels agree, kappa 1.0 |
| 2026-11-03 | H-B3 independent seeding agent | general-purpose | 622,338 | 213 | 8,406.6 s (13:08Z to 15:28Z) | one leg, no container restart; 57 unintended and 10 intended seeds sealed |
| 2026-11-03 | Second blind labeller on 10 H-B3 misses (decision 4) | general-purpose | 98,811 | 3 | 146.7 s | completed in one leg; 9 of 10 labels agree, kappa 0.8 |
| 2026-11-04 | Greenfield-senior G0 recon: inventory of the production guards and security probes (read-only) | Explore | 216,229 | 58 | 195.2 s | completed in one leg; one claim (greenfield guard routing "requires only release") was incomplete and I corrected it from lib/guards/index.js and lib/worktree.js before use |
| 2026-11-04 | Greenfield-senior G0 recon: inventory of the behavior diff and the protocol / pre-registration practice (read-only) | Explore | 210,784 | 37 | 141.8 s | completed in one leg; the track restriction and base-commit claims were re-verified by me in lib/behavior.js before use |
| 2026-11-04 | Greenfield-senior S1 independent review: adversarial review of the built code, design and tests (read, run, reproduce; I found no change of its making in the repository) | general-purpose | 419,658 | 121 | 1,678.9 s | completed in one leg; 4 blocking, 8 major, 5 minor findings plus a list of tests that could not fail; every finding reproduced as a failing test by me before it was fixed (commit 723ac3e); details in `docs/build/gf-s1-evidence.md` section 6 |
