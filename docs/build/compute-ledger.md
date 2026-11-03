# Agent compute ledger

Owner decision 6 (2026-11-03): record agent compute (tokens) per task. Figures are those the harness reported in each task's completion notice (`subagent_tokens`, `tool_uses`, `duration_ms`); a leg that ended in a container restart reported nothing, and a blank is a blank, not an estimate. The benchmark meter (`claude -p` runs with `--max-cost`) is separate and has spent **$0** in every task below. The main session's own tokens are not reported to it and are not in this ledger.

| Date | Task | Agent | Tokens | Tool uses | Wall time | Note |
|---|---|---|---|---|---|---|
| 2026-11-02 | Blind behaviour labeller A (48 bare screening runs, Round 1-lite relabel) | general-purpose | 127,793 | 10 | 117.6 s | completed in one leg |
| 2026-11-02 | Blind behaviour labeller B (same 48 runs, different shuffle) | general-purpose | 126,558 | 3 | 71.9 s | completed in one leg |
| 2026-11-02 to 03 | H-B2 independent seeding agent | general-purpose | 509,260 (last leg only) | 21 (last leg only); 231 over the whole log | 2,025.9 s (last leg only); 19:32Z to 23:24Z by the log | three container restarts, resumed twice; the earlier legs reported no usage |
