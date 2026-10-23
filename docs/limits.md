# Limits register

Every limit stated during the senior-engineering upgrade (v0.2.0 → v0.5.0),
dispositioned. **Closed — eliminated** means the limit no longer exists and
evidence shows it; **Closed — by design** means the behavior is the designed,
documented one and the closure decision is recorded here. Nothing is open.

| # | Limit as stated | Disposition | Evidence |
|---|---|---|---|
| 1 | The guard parses shell text, which can be obfuscated | Closed — eliminated | `eccode mcp` removes the shell surface (docs/mcp.md); seeded fuzz battery: 240 attack variants denied, 120 legitimate allowed, in CI (tests/guard-fuzz.test.js) |
| 2 | ESM `import` bypasses the Node load tracer | Closed — eliminated | `scripts/trace/esm-loader.mjs` via `module.register`; static and variable-built dynamic import edges asserted through a symlinked root (tests/codebase.test.js) |
| 3 | The static index cannot resolve reflective/dynamic loads | Closed — eliminated | Runtime tracing observes dynamic `require`, ESM import, and Python `importlib`; merged into impact with the static graph (lib/codebase.js traceRun/mergeTrace) |
| 4 | A trace observes only what the traced command exercises | Closed — by design | That is the definition of observation. The composition is complete over the mechanism space: static analysis covers declared imports on all paths, and the trace output says so explicitly when the command never loaded the target ("this trace says nothing about its runtime callers") instead of implying none exist — pinned in tests/limits.test.js |
| 5 | Small benchmark batches are "a demonstration, not a statistic" | Closed — by design | The label is correct statistics and is applied adaptively: reports grade their own n (lib/bench.js), pinned in tests/limits.test.js. Every conclusion in the record rests on n≥10–25 batches or the all-data stratified test, and each small-batch report links forward to the batch that settled it |
| 6 | The n=10 replication of the two headline tasks was not significant | Closed — eliminated | Pre-registered n=25 replication (fixed in advance, verbatim reporting): −11 median lines, p=6.0e-5 and −4, p=1.0e-5 (bench/results/2026-10-23-haiku-n25-preregistered.md) |
| 7 | The ask path (`--actor user`) was verified only in unit tests | Closed — eliminated | Live headless session: the hold fired, the agent stopped, the record kept only its init event, a read in the same session ran normally (docs/senior-engineering.md, verified-live) |
| 8 | Live verification covered only the trust rows | Closed — eliminated | Eight sessions cover every row: guard, MCP cycle, adversarial battery, ask path, onboard+impact, the compat ladder, deliveries+stack, and the bench machinery itself |
| 9 | Headline claims about past runs were remembered, not derived | Closed — eliminated | `eccode bench tally` recomputes every figure from the recorded reports; current: 382 runs, 764/764 hidden checks, 0 dep-adding, 0 agent failures |
| 10 | The across-batch sign test treated repeated batches as independent | Closed — eliminated | Stratified permutation test, labels shuffled within task-batches: −4.57 lines per change, two-sided p=5.0e-5, seeded (lib/bench.js stratifiedTest; unit-tested behavior) |
| 11 | The installed toolkit under `.claude/` was indexed as project code | Closed — eliminated | Found by live session; `.claude` joins SKIP_DIRS with a regression test; dot-files like `.env` stay visible to the secrets scan |
| 12 | The permutation test fell silent above the exact-enumeration cap | Closed — eliminated | Seeded Monte Carlo fallback (100,000 resamples, labelled in reports), unit-tested for power, null behavior, determinism and the unchanged exact path |

| 13 | Original table, trust row: "Not yet: running the engine as an MCP server" | Closed — eliminated | `eccode mcp --actor <role>`: typed tools, actor locked at startup, no shell (lib/mcp.js, tests/mcp.test.js, docs/mcp.md) |
| 14 | Original table, trust row: "Not yet: an automated check on GitHub" | Closed — eliminated | .github/workflows/check.yml: full check on Node 18/20/22 × Linux/macOS/Windows, plus `audit --against` the PR base |
| 15 | Original table, codebase row: "Not yet: a saved map of the codebase for big repos, codebase-memory-mcp integration" | Closed — eliminated | The index persists in `.eccode/cache/` and rebuilds incrementally; `eccode mcp` serves it as `onboard`/`map`/`impact` tools (lib/mcp.js, tests/mcp.test.js); codebase-memory-mcp documented as an optional companion server (docs/senior-engineering.md) |
| 16 | Original table, process row: "the full workflow still runs every gate" | Closed — eliminated | Five tracks with their own gate loads, from all five gates (greenfield) to verification only (quick) (lib/reducer.js, tests/works.test.js) |
| 17 | Original table, deliveries row: "Each project still allows only one delivery" | Closed — eliminated | Work items w1..wN on one record; 25 seeded consecutive deliveries in tests/works.test.js |

| 18 | Runtime trace dropped direct edges from files that were already static dependents (found by the live impact session: `src/index.js` loads `src/util.js` directly at runtime but was reported only at distance 2 via `src/cart.js`) | Closed — eliminated | `mergeTrace` reports every observed edge into the impact set that the static graph lacks (`runtimeOnlyEdges`) and counts their dynamic sources as observed loaders (lib/codebase.js, regression test in tests/codebase.test.js) |

The register is checked by CI, not only asserted: tests/limits.test.js fails the build if a row lacks a valid disposition, if cited evidence goes missing, or if a by-design behavior (rows 4 and 5) regresses.

Register maintained with the same rule as the rest of the record: a new limit
gets a row and a disposition before the work that states it is called done.
