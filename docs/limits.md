# Limits register

Every limit stated or found during the senior-engineering upgrade (v0.2.0 → v0.5.x) gets a row and a disposition:

- **Closed — eliminated:** the limit no longer exists, and the evidence shows it.
- **Closed — by design:** the behavior is intended, and it is disclosed where it applies.
- **Open — mitigated:** the limit remains; its containment is named.
- **Open — named:** the limit remains; the tool reports it instead of hiding it.

An independent audit on 2026-10-23 checked every row against the code. It found an earlier version of this register overclaimed ("nothing is open"), and that one security claim was false (MCP mode had a general shell through `evidence_run`). The rows below include everything that audit found and how each item was handled. **Three limits are open** (rows 1, 20, 21).

| # | Limit | Disposition | Evidence |
|---|---|---|---|
| 1 | The CLI guard reads shell text, so deliberately obfuscated commands (an interpreter writing a file whose path is built from strings, for example) can get past it | Open — mitigated | The guard states this itself (scripts/hooks/guard.js). Containment: MCP mode gives implementers and reviewers no general shell (row 13); identity values are unquoted and shell expansion fails closed (row 23); `audit --against <ref>` and the session-start anchor detect rewritten committed history; every changed file must be reviewed before verification. The seeded fuzz battery covers the textual classes (tests/guard-fuzz.test.js) |
| 2 | ESM `import` bypasses the Node load tracer | Closed — eliminated | scripts/trace/esm-loader.mjs, registered through `module.register` (Node ≥ 18.19 / 20.6). On older runtimes the trace output says ESM imports were not traced. Static and variable-built dynamic import edges are asserted through a symlinked root in tests/codebase.test.js |
| 3 | The static index cannot resolve reflective or dynamic loads in JS/TS and Python | Closed — eliminated | Runtime tracing records importer → target edges for CommonJS `require`, ESM `import`, and Python imports including `importlib` (the Python importer is found by walking the call stack). Asserted in tests/codebase.test.js. Other languages: row 21 |
| 4 | A trace observes only what the traced command exercises | Closed — by design | That is what observation means. The output names every target the command never loaded ("this trace says nothing about the runtime callers of that target"), and static analysis flags dynamic loaders, now including aliased `require` and `createRequire`. A loader that the flag patterns miss, on a branch the command never runs, can still go unseen. The disclosure is pinned in tests/limits.test.js |
| 5 | Small benchmark batches are "a demonstration, not a statistic" | Closed — by design | Reports grade their own n and name the test they used, exact or Monte Carlo (lib/bench.js, pinned in tests/limits.test.js and tests/bench.test.js). Haiku conclusions rest on n≥10–25 batches and the all-data stratified test. **Sonnet-specific conclusions rest only on small samples and are marked unsettled** in their reports |
| 6 | The n=10 replication of the two headline tasks was not significant | Closed — eliminated | A fixed-protocol n=25 replication gave −11 median lines (p = 6.0e-5) and −4 (p ≤ 1.0e-5) (bench/results/2026-10-23-haiku-n25-preregistered.md). The protocol was stated in the working session before the run but not committed in advance. The Monte Carlo fallback was added after the data came in, and the effect estimates do not depend on it |
| 7 | The ask path (`--actor user`) was verified only in unit tests | Closed — eliminated | Live transcript docs/live/6-ask-path.txt: the command was held for the human, the record was unchanged and the audit passed. Identity written through quoting or expansion now fails closed (row 23) |
| 8 | Live verification covered only the trust rows | Closed — eliminated | Each original red/orange row has a dedicated live session. Six transcripts are in docs/live/; docs/live/README.md lists which earlier sessions' transcripts were not saved |
| 9 | Headline claims about past runs were remembered, not derived | Closed — eliminated | `eccode bench tally` recomputes run counts, hidden-check passes, dependency additions, agent failures, per-batch paired signs and the stratified test from raw runs (lib/bench.js). Doc figures are checked against it in tests/limits.test.js. Per-task medians and p-values come from the same report code and the same raw rows |
| 10 | The across-batch sign test treated repeated batches as independent | Closed — eliminated | Stratified permutation test with labels shuffled within task-batches: −4.57 lines per change, two-sided p ≤ 5.0e-5, seeded (lib/bench.js, tests/bench.test.js) |
| 11 | The installed toolkit under `.claude/` was indexed as project code | Closed — eliminated | The index excludes `.claude/` (lib/codebase.js); regression test in tests/codebase.test.js |
| 12 | The permutation test fell silent above the exact-enumeration cap | Closed — eliminated | Seeded Monte Carlo fallback (100,000 resamples), labelled on each row and in the header (tests/bench.test.js) |
| 13 | Original table, trust row: "Not yet: running the engine as an MCP server" | Closed — eliminated | `eccode mcp --actor <role>`: the actor is locked at startup and no tool takes an actor argument. `evidence_run` runs only approved commands: planned task checks, the behavior command and stack checks. The audit found it previously ran any command; that is fixed and tested in tests/mcp.test.js. Residual: row 20 |
| 14 | Original table, trust row: "Not yet: an automated check on GitHub" | Closed — eliminated | .github/workflows/check.yml: five jobs (Linux on Node 18/20/22, macOS and Windows on Node 22), plus `audit --against` the PR base |
| 15 | Original table, codebase row: "Not yet: a saved map of the codebase for big repos" | Closed — eliminated | The index persists in `.eccode/cache/`, rebuilds incrementally, and is keyed on the parser version (row 22). `eccode mcp` serves it as the `onboard`, `map` and `impact` tools (lib/mcp.js, tests/mcp.test.js) |
| 16 | Original table, codebase row: "Not yet: codebase-memory-mcp integration" | Closed — by design | Not integrated: ECCode's own persistent index fills that role with no install. codebase-memory-mcp is documented as an optional companion server (docs/senior-engineering.md) |
| 17 | Original table, process row: "the full workflow still runs every gate" | Closed — eliminated | Five tracks with their own gates: greenfield runs all of them; quick runs `phase:change` and `verification` (lib/reducer.js, tests/works.test.js) |
| 18 | Original table, deliveries row: "Each project still allows only one delivery" | Closed — eliminated | Work items w1..wN on one record. The endurance test runs 25 seeded consecutive work items on one record, delivering the ones not abandoned: 15, plus w1, with seed 7 (tests/works.test.js) |
| 19 | The runtime trace dropped direct edges from files that were already static dependents | Closed — eliminated | Found by the live impact session. `mergeTrace` now reports every observed edge into the impact set that the static graph lacks (lib/codebase.js; regression test in tests/codebase.test.js; docs/live/2-impact-trace.txt) |
| 20 | In MCP mode, approved commands still execute project code the agent can edit (a test file, for example) | Open — mitigated | MCP mode removes the general shell, not code execution through the project's own checks. That code shows up in the diff, and every changed file must be reviewed before verification (UNREVIEWED_CHANGES), so this is contained by review rather than by construction |
| 21 | Reflection in Java, Kotlin, Ruby and PHP is not traced at runtime | Open — named | These loaders are flagged statically and listed in impact output as possible callers, never silently missed (lib/codebase.js). There is no runtime tracer for these languages |
| 22 | The index cache was reused across parser changes, keeping stale dynamic-load flags | Closed — eliminated | The cache is keyed on a hash of the parser source (lib/codebase.js); regression test in tests/codebase.test.js |
| 23 | CLI identity written through quoting or shell expansion got past the user-decision ask | Closed — eliminated | The guard unquotes the whole `--actor` word, and shell expansion in eccode arguments is denied inside subagents and asked in the main session (scripts/hooks/guard.js; mutation-checked in tests/guard-fuzz.test.js) |
| 24 | ESM call chains lost upstream callers (single-pass merge, top-down edge order) | Closed — eliminated | `mergeTrace` propagates to a fixpoint; regression test in tests/codebase.test.js |
| 25 | The secrets scan stopped reading `.claude/` after row 11's first fix | Closed — eliminated | The `.claude/` exclusion now applies to the codebase index only; regression test in tests/stack.test.js |
| 26 | Report headers claimed exact p-values when Monte Carlo was used, and floor p-values printed as "=" | Closed — eliminated | The header names the test used, and floors print as "p≤" (lib/bench.js, tests/bench.test.js) |
| 27 | Doc figures drifted from the records (a dated addendum still cited 282 runs) | Closed — eliminated | tests/limits.test.js checks the run and hidden-check figures in the docs against `bench tally` |

This register is checked by CI as well as written by hand. tests/limits.test.js fails the build if any of these happen:
- a row lacks a valid disposition;
- cited evidence goes missing;
- a by-design disclosure regresses;
- the table breaks;
- a doc figure disagrees with the records.

New limits get a row before the work that states them is called done.
