# Study: morluto/rea against ECCode (bounded, read-only)

Date: 2026-11-08. Written on `claude/dazzling-clarke-mwkg8f`. No code was changed; this file is the only change.

**Evidence tags.** `[S]` read from a source file, with file and line. `[M]` measured by me in this session. `[I]` my inference. `[R]` recalled from memory, not verified here. A row tagged `[R]` or `[I]` is a hypothesis, not a finding.

**What was done.** Files of github.com/morluto/rea were fetched as plain text (raw.githubusercontent.com, branch `main`) and treated as data (GF-REF-3). Nothing from that repository was installed, built, run or copied. I did run ECCode's own code (a tool-list measurement and the test suite) on a throwaway `git archive` copy under the scratchpad, never inside the repository.

## 0. Findings that change how this study reads

| # | Finding | Evidence |
|---|---|---|
| P1 | The designated branch has **no greenfield layer**: no `gf_*` tools, no `lib/greenfield`, no GF-REF records, no G0.5 text, no usage reader. All of it lives on `origin/claude/wonderful-goldberg-o6u7m6` (cbae463), which is `sleepy-shannon-dxbk7v` plus 14 commits and is 251 commits ahead of this branch. I used cbae463 as "ECCode today". | [M] `git ls-tree`, `git rev-list --count` |
| P2 | The tip has **24** `gf_*` tools and 109 tools in total, not 9. The first 9 in registration order are measured separately in Q1. | [M] tool dump |
| P3 | The usage snapshot is `lib/greenfield/usage.js` at the tip, a read-only reader of the harness transcript. `get_session` reported `used_tokens: 0`, which is unusable. | [S] usage.js:1-12; [M] |
| P4 | The all-processed unit counts the cached prefix again on every assistant message. Here that prefix was 113,646 tokens at message 1 and 165,300 at message 17. A 4M cap therefore buys roughly 20 messages in this environment, whatever is read. | [M] section 9 |
| P5 | No "delegation gateway adapter" exists at the tip (`grep -i gateway` over docs, README and lib found nothing). Q5 is therefore a design input, not a comparison. | [M] |

## Q1. Tool-schema size

| Aspect | rea | ECCode today | Verdict |
|---|---|---|---|
| Compact input profile | `REA_MCP_INPUT_SCHEMA_PROFILE=compact` is the default. It renders every input schema within a 13,312-byte budget. It drops nested descriptions, examples, defaults and titles. The root description is kept, and so is the `detail` description. References are inlined within the budget. Five schemas and any schema deeper than 10 levels get a reduced first-level form. Tool set, output schemas and server-side validation are unchanged. [S] mcp-contracts.md:1920-1992 | Schemas carry **no** nested descriptions, titles, defaults or examples. [M] Dropping those keys left the total at 38,605 B, identical. | **Not applicable.** The profile saves 0 B here. |
| Why rea has it | Provider rejection, not token economy: a Moonshot size cap, a depth limit of 10, and Gemini and Anthropic gateway schema-translation failures. [S] mcp-contracts.md:1922-1950 | The largest ECCode tool definition is 807 B (`gf_run`), against rea's 13,312 B budget. [M] | Not applicable, since no provider cap is near. |
| Other rea levers | `REA_MCP_OUTPUT_SCHEMA_PROFILE=compact` (4,096 B per output schema, or `off`). Hot/cold catalog: 5 tools plus `discover_tools` at start. It needs clients that refresh on `notifications/tools/list_changed`. `REA_MCP_TOOL_FAMILIES` registers only the chosen families, and `rea setup --tool-families` writes the choice into the client's registration. [S] mcp-contracts.md:2010-2097, 2145-2152. AGENTS.md:49-53 ranks agent tokens first and says to count schemas. | ECCode servers declare `capabilities: { tools: {} }` (no list-changed) and protocol 2024-11-05. [S] lib/mcp.js (tip). `tools/list` returns every tool, with no per-role filter. [S] lib/mcp.js:279 (tip) | Hot/cold: not applicable without protocol work. **Family or role scoping: adoptable (below).** |
| What rea says it saves | No token figure appears in the files I read. The "Claude Code measurements above" cited at mcp-contracts.md:2060 are not in the fetched file. The catalog breakdown in rea issue #2512 was not fetched. | n/a | Unverifiable, see L3. |
| Size of ECCode's tool list [M] | n/a | **All 109 tools: 38,605 B, about 9,650-12,870 tokens** (bytes/4 to bytes/3). Split: tool descriptions 16,623 chars (about 43%), input schemas 15,964 B (about 41%), names and JSON punctuation (about 16%). | See the next two rows. |
| The `gf_*` subset [M] | n/a | **24 `gf_*` tools: 11,099 B, about 2,780-3,700 tokens.** The first 9 in registration order (`gf_status` to `gf_ownership_show`) are 3,232 B, about 810-1,080 tokens. The 85 non-`gf` tools are 27,506 B. The 48 tools a group role may call are 14,604 B. | |
| Share of the per-turn cached prefix [M] | n/a | Against this session's message-1 prefix (113,646 tokens): all tools **8.5-11.3%**, `gf_*` **2.4-3.3%**, first 9 `gf_*` **0.7-0.9%**. Against the message-17 prefix (165,300): 5.8-7.8%, 1.7-2.2%, 0.5-0.7%. ECCode's MCP server is not attached to this session, so these are hypothetical shares. | **Pre-registered threshold: material = 10% or more.** Only the upper estimate for the whole list crosses it. `gf_*` alone does not. No compact profile is proposed. |
| What is adoptable | `REA_MCP_TOOL_FAMILIES` and role scoping. | A group role may call 48 of the 109 tools (14,604 B), but its server advertises all 109. Advertising only the callable set would save up to 24,001 B, about **6,000-8,000 tokens per turn** per group-role server. [M]+[I] The allowlist is the callable set, not necessarily the minimal advertised set. | **Adopt: role-scoped `tools/list`.** 3 turns, about 0.6M tokens at this session's rate, 0.5 day. Check first that the host loads schemas eagerly (L5). |

## Q2. Evidence shape

| Aspect | rea | ECCode today | Verdict |
|---|---|---|---|
| Epistemic classes | Observations, derivations, inferences and unknowns are distinguished and provenance is preserved. [S] AGENTS.md:5. Records hold identity, source locations, observations, inferences and unresolved findings. [S] cli.md:729-733 | Events carry `{seq, ts, type, actor, data, prevHash, hash}` in a sha256 chain. [S] lib/store.js:110-112. Nothing tags a claim as observation, derivation, inference or unknown. | **Adopt:** a per-statement `basis` tag on findings and review claims. |
| Limitations | Present on records and views: "identity, selection, coverage, limitations and collection counts". [S] cli.md:134, 224. Substantive limitations stay separate from presentation omissions. [S] cli.md:855-878 | `lib/delivery.js:183` writes a "Limitations and unverified items" section of fixed bullets plus open items, only at delivery. No evidence or event schema has a `limitations` field. [S]+[M] (grep over `lib/` and `schemas/`) | **Adopt:** a mandatory `limitations` array (empty allowed, but explicit) on evidence and review records. |
| Unknowns | First-class records with IDs and revisions. `unknowns_added` counts revisions, not distinct IDs. [S] cli.md:746-747. One-sided membership stays unknown and is never inferred from position or display names. [S] cli.md:760 | The `gf.*` events already allow `'unmeasurable'` for token counts (`TOKENS = integer or 'unmeasurable'`). [S] lib/greenfield/events.js. This is the only explicit-unknown pattern found. | **Adopt:** `unknowns: [{id, what, why, revision}]`, generalizing the `unmeasurable` pattern. |
| Coverage | Completeness is derived from examined coverage. [S] AGENTS.md:97 | `eccode mutate` caps mutants with `--max` (default 25). It has no kill threshold, and I did not verify whether the record states coverage [I]. [S] greenfield-senior.md:932 | **Adopt:** `coverage: {examined, total, capped}` on mutation, scan and review evidence. |
| Always-present context | `analysis_profile` is always present, as an object or `null`. Records omitting it are rejected. [S] mcp-contracts.md:14-25 | `gf_config_pin` and `gf_preflight` carry environment facts, but no required fingerprint is attached to each record. | Adopt later: a nullable-but-required `environment` field. |
| Identity and integrity | `ev_<sha256>` ids. Authenticated bundles. Mismatches are refused as `evidence_integrity_mismatch`. Exports never overwrite without `--overwrite`. [S] cli.md:729-785, mcp-contracts.md:14-60 | Per-event hash chain, plus `evidence_file` pinning a file hash. [S] lib/store.js:133-134 | Already comparable. **Not applicable.** |
| Real versus simulated | Not a concept in the files read. | Not a field either. | Adopt: `provenance: real / simulated / recalled` (the owner's REAL vs SIMULATED rule). |
| **Missing fields worth adding** | | `basis`, `limitations`, `unknowns`, `coverage`, `provenance`, `environment`. Events are append-only and hash-chained, so add them as optional, then require them from a bumped `schemaVersion`. Old events are never rewritten. | **Estimate:** 4 turns, about 0.8M tokens at this session's rate, 0.5-1 day. |

## Q3. Mutation testing

| Aspect | rea | ECCode today | Verdict |
|---|---|---|---|
| Main lane | `stryker.config.mjs`: `testRunner: vitest` with `related: true`, TypeScript checker (`prioritizePerformanceOverAccuracy`), `coverageAnalysis: perTest`, `thresholds.break: null` (report only), `concurrency: 2`, `timeoutMS: 30000`. Reporters: clear-text, progress, html, json. [S] stryker.config.mjs:1-30 | n/a | |
| Targeting | `mutate` is built by `mutationRanges(file, [...])` from `scripts/lib/reverse-tools-mutation-targets.mjs` (not fetched). Targets are AST kinds (method, guard, declaration, try, call, expression, constructor, command-handler) on 12 files. Mutants hit specific methods and guards, never whole files. [S] stryker.config.mjs:30-250 | `lib/mutate.js` mutates only the lines a change added. Six regex operators: boundary, equality, logical, boolean, arithmetic, negation. JS and Python. [S] lib/mutate.js:1-30 | A different granularity. |
| Semantics lane | `stryker.semantics.config.mjs`: `testRunner: command` running `npx vitest run --config vitest.reverse-tools-semantics.config.ts`, `coverageAnalysis: off`, 5 targeted expression and declaration ranges in 2 files. Its vitest config runs 3 test files, forks pool, `retry: 0`, `testTimeout: 60000`, and a process-ownership runner. [S] stryker.semantics.config.mjs; vitest.reverse-tools-semantics.config.ts | n/a | This is the shape ECCode could copy: the command runner needs no framework plugin, so it works with `node --test`. |
| CI use | The `reverse-tools-quality` job only runs `stryker run ... --dryRunOnly` on both configs and uploads `reports/mutation/`. [S] ci.yml:372, 389-401. Whether any job runs the real mutation was not verified (L2). | `gf_battery_run` runs a pinned battery and `gf_close` requires it (GF-CLOSE-3). Survivors need an accepted reason. [S] greenfield-senior.md:932 | |
| Rule-removal battery | n/a | A preload makes one rule id never be reported. All 26 rules fail at least 2 tests when removed. [S] docs/build/gf-s1-evidence.md:33-46, 140. This proves the tests depend on each rule. It does not prove each condition inside a rule is pinned. | |
| Would Stryker find gaps the battery misses? | | **Plausible, untested.** [I] The battery works at rule granularity. `eccode mutate` has 6 operators on changed lines. Stryker's operator set is broader (conditionals, block removal, string and array literals, optional chaining and more) [R] and covers whole files. | Hypothesis. Needs the pilot. |
| **Pilot, pre-registered, NOT run** | | **Module:** `lib/greenfield/stages/prd.js` (rules GF-PRD-1..3). **Tests:** resolved at start with `grep -l "stages/prd" tests/*.test.js`. **Tool:** `@stryker-mutator/core` plus `@stryker-mutator/command-runner`, installed only in a throwaway directory outside the repo, because ECCode has zero npm dependencies. Config: `testRunner: command`, command `node --test <resolved files>`, `coverageAnalysis: off`, `concurrency: 2`, `timeoutMS: 30000`, `thresholds.break: null`, reporters clear-text and json. **Caps:** 150 mutants (use `file:start-end` ranges), 90 min wall, 6 assistant turns (about 1.2M tokens at this session's rate), zero repository changes. **Wall estimate:** 6-19 min if the test subset runs in 5-15 s, which is an assumption [I]. **Decision rule:** adopt as a periodic lane only if there are at least 3 distinct real gaps in 150 mutants, or 1 gap in a security-relevant rule. Compare with `eccode mutate` on the same lines. Otherwise drop. | Owner approval needed (Q4 in section 10). |

## Q4. Test lanes and CI

| Aspect | rea | ECCode today | Verdict |
|---|---|---|---|
| Sharding | A `test-shard` job. The matrix is 8 shards on the fast tier and 6 on the full tier, and a comment states a ten-minute budget for the slowest shard. [S] ci.yml:322-337. The shards run `npm run test:ci:shard:run -- --shard=...` and `npm run test:built ... --shard=...`. [S] ci.yml:353, 358. A comment says fast and full shards measure different file costs, so per-tier cost data exist. [S] ci.yml:443 (body not read) | `node --test tests/*.test.js`, 105 files at the tip. [S] package.json (tip). **Baseline [M]:** 1,762 tests, 1,701 pass, 2 fail, 59 skipped. Wall 208.3 s (3m28s), user 4m47s, sys 1m23s, 4 cores, Node v22.23.4. | Sharding is overkill at 208 s. |
| Parallel efficiency | n/a | CPU 370 s over 208 s wall is about 1.8 of 4 cores busy. [M]+[I] One long-pole file probably dominates. The ideal bound is 370/4, about 93 s. Per-file times were not captured. | **Adopt:** measure per-file durations (1 turn, about 0.2M tokens), then split the long pole (2 turns). Wall target 208 s to about 120 s [I]. |
| Tiering and cancel | The `changes` job outputs `tier` and `matrix`. [S] ci.yml:52, 88, 337. PRs cancel in-progress runs unless labelled `ci:full`. [S] ci.yml:37 | ECCode CI was not inspected (L8). | Unverified. |
| Docs-only skipping | A `docs` job (ci.yml:1003) runs `docs:check` and `docs:build` (testing.md:59). Whether docs-only changes skip the test jobs was **not verified**: the `changes` job body (ci.yml:52-135) was not read. | n/a | Unverified (L2). Follow-up: read ci.yml lines 52-135 (about 3k tokens). |
| Separate semantics lane | Yes: the two Stryker configs, each with its own vitest config (Q3). | `gf_battery_run` is the nearest equivalent. | See Q3. |
| Changed-test selection | `npm run test:changed` runs tests affected since the merge base. Its own docs warn: "An empty changed selection means no tests were selected, not verified correctness". [S] testing.md:37, 70-71, 140-143. `check:fast` is typecheck plus lint. The pre-push hook runs `check:fast`. [S] CONTRIBUTING.md:243, 378 | None. | Dev-loop only. 3 turns, about 0.6M tokens, and it can miss registration and generated data (rea says the same). Low priority. |
| Static lanes | `knip --cache` with every rule set to error. `jscpd` with threshold 4, `minLines: 5`, `minTokens: 50`. Both run in `check:ci:deep`. [S] knip.json, .jscpd.json, package.json | None. | Skip for now. They would add devDependencies, and a run would have to be outside the repo. |
| Serialising expensive checks | `run-exclusive.mjs artifacts` wraps artifact-producing tasks. AGENTS.md:91 says to coordinate expensive checks across agents. [S] | ECCode already has `withLock` and a lock wait that restarts after a running check. [S] lib/evidence.js imports; commit 800cbb0 | **Not applicable**, already covered. |
| Token cost | Not discussed in the files read. | Test wall time costs no processed tokens. The turn that runs it does. [I] | Run the full suite once per slice and run single files between. Token-neutral, saves wall time. |

## Q5. Multi-agent setup: backup and approval flow

| Aspect | rea | ECCode today | Verdict |
|---|---|---|---|
| Plan, then approve | "Setup previews configuration changes and asks for approval before applying them." [S] installation.md:4, 22, 51. `--dry-run` returns a read-only plan. [S] installation.md:126. An unapproved apply reports `needs_confirmation`. [S] installation.md:146. AGENTS.md:11 requires the plan and approval before any write. | `eccode install` copies files and merges two hook entries into `settings.json`, idempotently. [S] lib/install.js:10-11. A grep for backup, `--yes`, approval, dry-run and `.bak` finds none of them in `lib/install.js` (only the idempotency comment matched). [M] | **Adopt:** `--dry-run` plan plus an approval flag. 3 turns, about 0.6M tokens, 0.5 day. |
| Backups | Setup and uninstall create backups, stage changes in a private directory and verify the result. An existing `.rea.backup` is retained, never replaced. A verified `.rea.backup.<sha256>.recovery` copy of the current bytes is preserved. A failed update names the backup path. [S] installation.md:68-85, 183-193 | No backup of the user's `settings.json`. | **Adopt:** byte-exact backup named by sha256, never overwritten, with its path named on failure. Included in the estimate above. |
| `--yes` scope | `--yes` needs an explicit scope such as `--client`, and applies only to existing rea-owned registrations. It never selects all detected clients. [S] installation.md:143-146 | n/a | Borrow for gateway adapters. |
| Ownership of entries | A different existing installation path is foreign. Conflicts report the paths and recovery backups. Installers never install unrelated software. [S] installation.md:92; AGENTS.md:11 | Hook entries are merged in place with no ownership marker. [I] | **Adopt:** an ECCode ownership marker on every entry written, so adapters touch only their own. |
| Safe trial | `CLAUDE_CONFIG_DIR=~/.claude-rea ... setup --client claude_code --dry-run` previews against an isolated profile. [S] installation.md:271 | `--target` selects a project, `--scope user` selects `~/.claude`. [S] docs/usage.md | Borrow the isolated-profile trial in docs. |
| Delegation gateway adapters | One adapter per client (`--client codex`, `--client cursor`, and others). | None found at the tip (P5). `eccode export agents-md` already emits roles for harnesses without subagents, run sequentially in one context. [S] lib/install.js:221. Each MCP server is locked to one role. [S] lib/mcp.js:264-268 | **Design input:** an adapter contract of `plan() / apply(approval) / verify() / rollback()` plus a list of backup paths. Additive and idempotent only. Never touch foreign entries. |

## Q6. Honest negatives, and licensing limits for G0.5

| Item | Finding | Evidence | Consequence |
|---|---|---|---|
| Domain | rea is a local reverse-engineering MCP server for binaries (Ghidra, IDA, Hopper and others). ECCode is a workflow and gating engine. | [S] AGENTS.md:5 | Evidence semantics transfer. The domain does not. |
| Toolchain | rea is TypeScript with vitest, turbo, oxfmt, knip and Stryker's TypeScript checker. ECCode is CommonJS, `node --test`, zero npm dependencies. | [S] package.json (rea); [S] docs/usage.md | The vitest runner and checker plugins do not transfer. Only the command-runner idea does. |
| Compact schema profile | Exists to satisfy provider caps. It saves 0 B on ECCode's schemas. | Q1 | Not applicable. |
| Hot/cold catalog | Needs clients that honor `tools/list_changed`. ECCode's server does not declare it. | Q1 | Not now. |
| CI scale | rea's CI lists at least 25 jobs (my listing was cut at 30 lines), 6-8 test shards, and Windows and Apple jobs (Termux appears in its scripts). | [S] ci.yml | ECCode's suite is 208 s on 4 cores. Do not copy the machinery. |
| Real-provider and lifecycle invariants | Late handshakes, cleanup retry, process ownership for Ghidra, IDA, GDB and others. | [S] AGENTS.md:19-23 | Not applicable. |
| Self-reported claims | The budgets and provider caps in rea's docs are theirs. I ran nothing from rea. | n/a | They stay unverified. |
| License | MIT, "Copyright (c) 2026 morluto". Only the header was read (first 5 lines of LICENSE). The notice-retention condition is the standard MIT text, which I did not re-read in full. | [S] LICENSE:1-5 | Ideas may be adopted. Any copied code needs the notice. Default stays re-implementation. |
| Provenance | `NOTICE` already records ECC "studied at v2.2.3 (commit ef648e0...)". The same pattern fits rea, but the commit SHA is unresolved (L1). A GF-REF-1 record (`gf.ref.provenance {component, paths, url, commit, license, taken, what}`) cannot be completed without it. `taken` here is `"design"`, since nothing was copied. | [S] NOTICE; greenfield-senior.md:1017 | Needs the SHA before any adoption is recorded. |
| G0.5 and closed-source targets | G0.5 only imports code under a permissive license (GF-REF-2) and treats external content as context, never evidence (GF-REF-3). It is design-only, and S3.5 is not approved. rea's purpose is analysing binaries, often closed-source. Using its output to copy or re-implement a closed-source product is a legal question (EULA, copyright, clean-room practice) that I did **not** analyse and cannot advise on. | [S] greenfield-senior.md:985-1033, 1065 | Keep REA-style output as analysis only, never a copy source, until the owner or counsel decides. Third-party licenses (Ghidra, IDA) were not assessed. |
| Instructions inside fetched files | rea's AGENTS.md addresses its own contributors (leave "Author readiness" unchecked, a Turborepo block telling agents to read docs in `node_modules`). None of it was followed. | [S] AGENTS.md:132-150 | Data, per GF-REF-3. |

## 7. Ranked adoption list

Estimates: a "turn" is one assistant message. Token figures use this session's measured cost of about 190-215k per turn, a figure driven by this environment's large tool list. A lean session would be much cheaper per turn, so the turn counts transfer better than the token counts.

| Rank | Item | From | Effort | Expected gain | Risk and precondition |
|---|---|---|---|---|---|
| 1 | Role-scoped `tools/list` for group-role servers | Q1 | 3 turns, about 0.6M tokens, 0.5 day | Up to 6,000-8,000 tokens per turn per group-role session. A 100-turn session saves about 0.6-0.8M processed tokens, which repays the cost in about one session. | Confirm the host loads schemas eagerly (L5). The callable set may need review. |
| 2 | `limitations`, `unknowns`, `coverage`, `basis`, `provenance` on evidence and review records | Q2 | 4 turns, about 0.8M, 0.5-1 day | Credibility: no unstated limits. Fits the owner's REAL vs SIMULATED rule. | Schema version bump. Append-only log, so no rewrite. |
| 3 | `eccode install`: `--dry-run`, approval flag, byte-exact backup, ownership marker | Q5 | 3 turns, about 0.6M, 0.5 day | Protects users' `settings.json`. Gives the gateway adapters their contract. | Small. Needs tests for failure rollback. |
| 4 | Per-file suite timing, then split the long pole | Q4 | 3 turns, about 0.6M | Wall 208 s toward about 120 s [I] | Worth it only if the suite grows. |
| 5 | Stryker pilot, pre-registered above | Q3 | 6 turns, up to 1.2M, 1.5 h wall | Answers whether the rule-removal battery leaves gaps | **Owner approval. Run in a separate session.** |
| 6 | Read ci.yml lines 52-135 to settle docs-only skipping | Q4 | 1 turn, about 0.2M | Closes L2 | None. |
| 7 | knip and jscpd outside the repo | Q4 | 2 turns | Low | Zero-dependency policy. |
| — | Compact input profile, output profile, hot/cold, sharding, `test:changed` | Q1, Q4 | n/a | None or negative | Not applicable (Q6). |

## 8. Limits (unverified or unmeasured)

Dispositions follow `docs/limits.md`: all are **Open — named**.

| ID | Limit |
|---|---|
| L1 | rea's commit SHA is unresolved. Files came from `main` via raw.githubusercontent.com on 2026-11-08. `github.com` and `api.github.com` returned 403 through the proxy. |
| L2 | Read only in part: mcp-contracts.md (lines 14-70, 1854-2176), cli.md (lines 640-662, 729-785, plus greps), testing.md, installation.md, CONTRIBUTING.md and ci.yml (greps only). Not fetched: `scripts/lib/reverse-tools-mutation-targets.mjs`, `tests/ciTestSequencer`, `scripts/ci/test-group.mjs`. The `changes` job (ci.yml:52-135) was not read, so docs-only skipping is unverified. |
| L3 | rea publishes no token-saving figure in the files read. The "Claude Code measurements above" (mcp-contracts.md:2060) are absent from the fetched file. |
| L4 | Token figures are estimates (bytes/4 to bytes/3). No tokenizer was available offline. |
| L5 | The prefix share uses this session's prefix, which unrelated connectors dominate, and ECCode's MCP is not attached here. This host listed hundreds of tools by name only (deferred), so schema deferral may shrink or remove the share. The host's deferral threshold was not measured. |
| L6 | The suite ran once, on a `git archive` copy at cbae463 with no `.git`, on 4 cores and Node v22.23.4. Two failures were not investigated. It is not the designated branch. |
| L7 | Stryker operator lists and runner availability are `[R]`, except the command-runner use, which rea's config shows. The pilot was not run, and ECCode's survivors were not compared. |
| L8 | ECCode's CI configuration was not inspected, so whether sharding or docs-only skipping would apply is unknown. |
| L9 | STEP 0 was snapshotted at message 17, not before message 1. Per-step figures are reconstructed from the transcript after the fact. `costUSD` is unmeasurable (no `cost-state` line). |
| L10 | No legal analysis was performed (Q6). |
| L11 | "ECCode today" is my choice of cbae463, and the "9 `gf_*` tools" count differs from the 24 found (P2). |

## 9. Usage (unit: all processed tokens = input + output + cache read + cache write)

Source: `lib/greenfield/usage.js` method (first usage line per message id), read from the harness transcript after the fact. Messages counted: 21. `costUSD`: unmeasurable.

| Step (labels are mine) | Messages | Tokens |
|---|---|---|
| Orientation, premise check, rea fetch and config reads, compact-profile read, greenfield-tip discovery, STEP 0 snapshot (snapshot read 2,336,131 at message 17) | 1-17 | 2,336,131 |
| Bulk evidence pass (rea greps, ECCode greps, usage reconstruction) | 18 | 177,458 |
| Re-run of truncated greps, ECCode tool measurement, suite timing | 19 | 201,372 |
| Write this file and splice the first usage table | 20 | 255,848 |
| Correct two statements, regenerate this table, commit and push | 21 | 263,855 |
| **Total through message 21** | 1-21 | **3,234,664** (output 84,076) |

Budget check: cap 4,000,000, pause 3,200,000, hard stop 5,000,000. No reading or research was done after message 19. The final reply that reports this work is one more message (22), estimated at about 260,566 tokens (the prefix at message 21 was 257,566), which puts the final total near 3,495,230 [estimate]. That **crosses the 3,200,000 pause line**: the crossing is the commit and the report, which preserve and deliver finished work. The cap is not reached.

Per-message detail:

| # | Tokens | Cumulative | Output | First tool call |
|---|---|---|---|---|
| 1 | 114,573 | 114,573 | 927 | Bash: Locate repo layout and usage-snapshot references |
| 2 | 114,984 | 229,557 | 265 | Bash: Inspect usage doc, find GF-REF and gf_ conventions |
| 3 | 116,784 | 346,341 | 564 | Bash: Check for greenfield/gateway/mutation references in repo |
| 4 | 118,786 | 465,127 | 480 | Bash: Check other branch and MCP tool inventory |
| 5 | 123,720 | 588,847 | 510 | Bash: Search all remote branches for greenfield/gf_/GF-REF |
| 6 | 126,968 | 715,815 | 2,314 | mcp__claude-code-remote__get_session:  |
| 7 | 129,887 | 845,702 | 1,133 | Bash: Download rea files as text into scratchpad |
| 8 | 130,742 | 976,444 | 611 | Read: /tmp/claude-0/-home-user-ECCode/64587f03-2a38-5191-92b3- |
| 9 | 140,515 | 1,116,959 | 582 | Bash: Outline mcp-contracts and find compact/full profile ment |
| 10 | 140,897 | 1,257,856 | 306 | Bash: Outline mcp-contracts and find compact profile mentions |
| 11 | 142,567 | 1,400,423 | 183 | Bash: Read schema advertisement and compact profile sections |
| 12 | 147,384 | 1,547,807 | 410 | Bash: Read tool families and output-schema sections, find meas |
| 13 | 150,143 | 1,697,950 | 585 | Bash: Locate gf_* tool definitions across greenfield branches |
| 14 | 153,700 | 1,851,650 | 813 | Bash: Compare greenfield branches and MCP tool counts |
| 15 | 156,461 | 2,008,111 | 1,575 | Bash: Inspect usage.js and how gf tools reach MCP |
| 16 | 162,720 | 2,170,831 | 1,304 | Bash: Extract tip tree; locate transcripts and usage CLI |
| 17 | 165,300 | 2,336,131 | 635 | Bash: Take usage snapshot with the project's read-only reader |
| 18 | 177,458 | 2,513,589 | 11,639 | Bash: Reconstruct usage per message and gather ECCode evidence |
| 19 | 201,372 | 2,714,961 | 11,215 | Bash: Re-read rea evidence and snapshot sections with caps |
| 20 | 255,848 | 2,970,809 | 41,736 | Write: /home/user/ECCode/docs/research/rea-study.md |
| 21 | 263,855 | 3,234,664 | 6,289 | Bash: Fix two statements, regenerate usage table, commit and p |

## 10. Questions the owner must answer

1. **Which branch is "ECCode today"?** I used `claude/wonderful-goldberg-o6u7m6` (cbae463). The designated branch is 251 commits behind and has no greenfield layer. Should this file also go onto the greenfield branch?
2. **Which 9 `gf_*` tools did you mean?** The tip has 24. I measured all 24 and the first 9 in registration order.
3. **STEP 0 rule.** I read "more than 10 messages" as the session's state at its first turn (1 user message), and I took the snapshot late. Should a run abort at its first assistant message if the reader reports more than 10? Is the all-processed unit, with its roughly 114-165k prefix re-counted per message, the intended unit for a 4M cap? Here it allows about 20 messages.
4. **Pilot approval.** May the Stryker pilot run in a separate session, in a throwaway directory outside the repo, under the caps in Q3?
5. **Pin rea's commit.** May I attach `morluto/rea` read-only to resolve the SHA, or can you give it? Without it no GF-REF-1 record or `NOTICE` row can be written.
6. **Legal line for G0.5.** Who decides whether REA-style analysis of closed-source targets may feed G0.5 at all?
7. **Docs-only skipping.** Spend one turn (about 0.2M tokens) to read ci.yml lines 52-135?
