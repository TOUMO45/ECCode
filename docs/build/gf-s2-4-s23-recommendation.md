# S2.3 recommendation under S2.4 (evidence only; no decision, no code)

The owner's master prompt asked for a one-page, evidence-only recommendation: which S2.3 tests become redundant under S2.4, what S2.3 still adds as defence in depth, and its false-refusal cost. No decision is made here.

## What S2.3 is

S2.3 (suspended, not closed) is the **default-deny tool allowlist**: in a Greenfield-Senior project a group role may call only a fixed set of its role-locked MCP server's tools (`GROUP_ROLE_TOOLS`), every other tool refused before it runs (`lib/greenfield/index.js`, `tests/gf-tool-allowlist.test.js`). It replaced S2.2's deny-list of eight command tools after the review found guard and security tools running project code outside the runner (I2-1).

## Which S2.3 tests become redundant under S2.4

**None become redundant; they test a different layer.** S2.3 governs *which engine tools a group role may invoke over MCP*; S2.4 governs *what a command does once it runs*. A tool that runs project code (a guard, a security probe, `evidence_run`) is still a tool the group role should not invoke directly, because:
- the S2.4 sandbox protects the filesystem, not the engine's own recording: a guard tool invoked by a group role would run the engine's guard logic and record a `guard.*` result under that role, which the sandbox does not prevent;
- the allowlist keeps a group role's MCP surface to record/read/submit plus `gf_run`/`gf_commit`, so the only route to run project code stays `gf_run` (now the sandboxed worktree run). The enumeration test (`tests/gf-tool-allowlist.test.js`) still fails if a new tool is unclassified, which S2.4 does not cover.

So the allowlist's tests and S2.4's tests are orthogonal: the allowlist's enumeration and default-deny rows catch a tool-surface regression; S2.4's rows catch a filesystem-isolation regression.

## What S2.3 still adds as defence in depth

1. **It narrows the MCP attack surface.** Even with a perfect sandbox, a group role that could call `gf_dispatch_record`, `gf_close`, `gf_ownership_amend` or a guard tool could record engine events under its role (closure reviews, ownership amendments, guard results) — none of which the sandbox touches. The allowlist refuses those at the tool boundary.
2. **It is the fallback where the sandbox is unavailable.** On a machine with no Landlock and no bubblewrap (or a non-Linux OS), GF-ISO-0 refuses group mode and the project runs single-agent or on the `copy` runner; the allowlist still holds, so a group role on such a machine cannot reach a project-code-running tool directly.
3. **It is decided at each call,** so it covers a project that becomes Greenfield-Senior after the server started, which the sandbox (worktree per group) assumes from the slice open.

## False-refusal cost of S2.3

Low, and measured by its own tests. The allowlist is a fixed list of 48 names; a group role's legitimate work (record a run, commit, submit a gate, send a message, read the map) is all on it. The one cost is that a group role cannot run a guard or security probe directly: it must go through the orchestrator or a reviewer, or through `gf_run` for a pinned check. That matches the design (a guard is the orchestrator's or a reviewer's to run) and the S2.2 review's I2-1 finding. No false refusal of a group role's own-path work has been observed in the suite.

## Recommendation (evidence, not a decision)

Keep S2.3 as defence in depth beneath S2.4. The two layers are independent: S2.3 bounds the tool surface (and is the only protection where the kernel sandbox is unavailable), S2.4 bounds filesystem effects. Removing S2.3 would re-open I2-1 on any machine where the sandbox is unavailable and would let a group role record engine events the sandbox does not police. The cost of keeping it is a fixed allowlist the suite already pins. The owner decides whether to review and close S2.3, or to leave it suspended as a tested-but-unreviewed layer (recorded as the "unreviewed" limit in `docs/limits-greenfield.md`).
