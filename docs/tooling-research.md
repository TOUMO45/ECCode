# Open-source tools that move ECCode toward senior-engineer level

**Date:** 2026-10-22.

**Method:** web research. Repository pages were opened in this session.

- **Licenses** marked ✓ were read from each repository page.
- **codebase-memory-mcp** was re-checked independently (MIT, local, no API key, Claude Code support).
- **Commit and release dates** could not be read: the GitHub API was rate-limited. Activity is "unverified" unless stated.
- **CLI flags** marked † are from documentation pages or memory, and were not executed here.

## How a tool plugs into ECCode

1. **As a pinned check (works today, no code change).** Put the command in a plan task's `verification.command`, or have a reviewer run it with `eccode evidence run --actor <role> -- <command>`. The gate rules then require a passing run, and reviewers re-run it after the submission. Any CLI with a meaningful exit code fits.
2. **As an MCP server or Claude Code plugin the user installs.** It gives agents better code understanding (symbols, call graphs, impact). ECCode does not vendor these. That keeps ECCode MIT and zero-dependency, and keeps copyleft tools out of the package.
3. **As a benchmark.** A separate harness that runs the same tasks with and without ECCode, to prove the "senior level" claim with paired numbers.

## Top 10 to integrate first

| # | Tool | License | Gap it closes | Integration | Example |
|---|---|---|---|---|---|
| 1 | [codebase-memory-mcp](https://github.com/DeusData/codebase-memory-mcp) | MIT ✓ | Understanding a large codebase without reading every file. A local tree-sitter + SQLite code graph: architecture, call tracing, change impact (`detect_changes`), ADRs, dead code | MCP server (recommended install) | installer configures Claude Code |
| 2 | [dependency-cruiser](https://github.com/sverweij/dependency-cruiser) (JS/TS), import-linter (Python), go-arch-lint (Go) | MIT ✓ / unverified | Architecture boundaries as rules ("UI must not import the DB layer") | pinned check | `npx depcruise src --config` † |
| 3 | [ast-grep](https://github.com/ast-grep/ast-grep) | MIT ✓ | Team conventions as structural rules that pass or fail | pinned check | `ast-grep scan` † |
| 4 | [Gitleaks](https://github.com/gitleaks/gitleaks) (later Betterleaks) | MIT ✓ | Secrets never reach a gate. Gitleaks is feature-frozen; Betterleaks is its successor (pre-stable v2) | pinned check | `gitleaks git --exit-code 1 .` † |
| 5 | [OSV-Scanner](https://github.com/google/osv-scanner) | Apache-2.0 ✓ | Known vulnerabilities in dependencies, including the ones lean checks make agents declare | pinned check | `osv-scanner scan source -r .` † |
| 6 | [StrykerJS](https://github.com/stryker-mutator/stryker-js), mutmut, PIT, cargo-mutants | Apache-2.0 ✓ / unverified | Proves tests catch bugs. The upgrade to lean's "a test file changed" rule | pinned check | `npx stryker run` † |
| 7 | [oasdiff](https://github.com/oasdiff/oasdiff), buf, [squawk](https://github.com/sbdchd/squawk) | Apache-2.0 ✓, unverified, Apache-2.0/MIT ✓ | Breaking API changes and unsafe database migrations caught before review | pinned check | `oasdiff breaking base.yaml rev.yaml` † |
| 8 | [Knip](https://github.com/webpro-nl/knip) (JS/TS), vulture (Python) | ISC ✓ / unverified | Dead code, unused exports and unused dependencies. The repo-wide side of the lean "delete" rung | pinned check | `npx knip` † |
| 9 | [lizard](https://github.com/terryyin/lizard) | unverified | A complexity ceiling for changed functions; non-zero exit when exceeded ✓ | pinned check | `lizard -C 15 src` † |
| 10 | [SWE-bench](https://github.com/SWE-bench/SWE-bench) (Verified) + Harbor / Terminal-Bench 2 | MIT ✓ / Apache-2.0 ✓ | A paired benchmark: same model and harness, with and without ECCode | benchmark | `swebench eval verified -p preds.jsonl` † |

## Also worth knowing

| Area | Tool | License | Note |
|---|---|---|---|
| Code intelligence | [code-review-graph](https://github.com/tirth8205/code-review-graph) | MIT ✓ | Blast radius and dead code, like #1. Its optional embedding providers send code-derived text to cloud APIs. |
| Code intelligence | [Serena](https://github.com/oraios/serena) | **GPL-3.0** ✓ | LSP-precise symbol search and rename in 40+ languages. Recommend users install it; never vendor it. |
| Static analysis | [Opengrep](https://github.com/opengrep/opengrep) | LGPL-2.1 ✓ | Community fork of Semgrep; runs Semgrep rules without a login. Fine as an external CLI. |
| Lint and format | Biome, Ruff, golangci-lint | unverified | Fast per-language conventions; best as each stack pack's default check. |
| Duplication and churn | jscpd, scc, code-maat | unverified | Copy-paste detection, size, and change hot spots. code-maat's license is unverified; run it only as an external tool. |
| Skills ecosystem | [Superpowers](https://github.com/obra/superpowers) | MIT ✓ | TDD, systematic debugging, verification, worktrees. Complements ECCode's engine-enforced gates. |
| Skills ecosystem | [anthropics/skills](https://github.com/anthropics/skills) | Apache-2.0 ✓; document skills are source-available | Reference for skill format. Do not copy the document skills. |
| Decisions and provenance | MADR / adr-tools, Sigstore cosign, in-toto | unverified | Decision records; signed delivery attestations (roadmap). |

## Rejected or used with caution

- **TruffleHog:** AGPL-3.0, and its verification step sends found secrets to third-party APIs ✓. Prefer Gitleaks or Betterleaks.
- **Semgrep CE:** core features moved to a commercial license, according to the Opengrep project. Use Opengrep.
- **Serena:** GPL-3.0 ✓. It can't be bundled into an MIT plugin, but users can install it themselves.
- **Terminal-Bench v1:** superseded by Harbor (Terminal-Bench 2.0) ✓.
- **SWE-bench leaderboard:** compare **paired deltas** (with vs without ECCode, same model and harness), not absolute scores. A 2026 paper argues the top entries can no longer be separated (seen in search results, not read in full).

## What this means for ECCode's roadmap

1. **Stack packs.** Detect the stack from its manifests and propose pinned checks for the plan: lint and format, typecheck, tests, architecture rules (#2), secrets (#4), vulnerable dependencies (#5). Mutation testing (#6) applies on changed files at `strict`.
2. **Code understanding for big repos.** Document codebase-memory-mcp as the recommended companion. `eccode map` stays the zero-dependency fallback.
3. **Compatibility gates.** When a task touches an OpenAPI, protobuf or migration file, require the matching check (#7) as evidence.
4. **`eccode bench`.** A paired SWE-bench Verified / Harbor run, with and without ECCode, reported as deltas with sample sizes, following the same honesty rules as the final report.
