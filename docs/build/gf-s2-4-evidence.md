# S2.4 as built: kernel-enforced group isolation (2026-11-08)

**Decision.** The owner's master prompt of 2026-11-08 built section 21 (the spike's design) as slice S2.4, with the usage-source probe (P0), the attacker-first review (P2), GF-ISO-0 to 4 plus the hardening list (P3), one independent review and one closing verification (P4), and the S2.3 recommendation (P5). Caps: ≤45 M processed tokens, hard stop 60 M. S2.3 stays suspended, no review rounds. Branch `claude/wonderful-goldberg-o6u7m6`; base `39b3715`.

## P0: the usage source (built)

**Finding.** The harness's `get_session` returned no `external_metadata.usage` in this session (L-GF-73), so that is not a reliable source. The authoritative per-agent source is the **session transcript** the harness writes at `~/.claude/projects/<project-slug>/<sessionId>.jsonl`, with a subagent's transcript beside it at `<sessionId>/subagents/agent-<id>.jsonl`:

| Field | Where | Reliability |
|---|---|---|
| per-message tokens | every `assistant` line's `message.usage` (`input_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens`, `output_tokens`) | present on every assistant line; a streamed message repeats on several lines with one `message.id`, deduplicated by the reader |
| model | `message.model` | per message; catches a mid-session model switch |
| running cost | the `cost-state` line's `totalCostUSD` and `modelUsage` (per-model `costUSD`) | written at the harness's own cadence, so it can lag the messages; one line in a 680-line transcript |

**Built (read-only):** `lib/greenfield/usage.js` (`sessionUsage`, `readTranscript`, `listSessions`, `difference`), with `tests/gf-usage.test.js` (7 tests: the slug, the sum with streamed-message dedup, per-model totals, the cost-state read, a missing or empty transcript as `unmeasurable`, the subagent sum, the snapshot difference with a stale/reset guard). It enforces nothing; GF-COST-1 (S4a) will use it.

**Measured on this live session** (`docs/build/gf-s2-4-record/s24-usage-reader.json`): the reader read 167 session messages plus 1 subagent transcript (the adversary, 7 messages, 745,337 all-processed), **66,391,848 all-processed tokens, 309,554 output, $20.68** (the cost-state figure), across `claude-fable-5-1` (117 messages) and `claude-opus-4-8` (50 messages, the mid-session model switch). This is the session cumulative since start, which spans S2.3, the spike and S2.4; a per-slice figure needs a start snapshot taken with the reader, which this session did not capture before S2.4. Going forward the reader makes per-slice snapshots possible without the harness's `get_session` usage field.

## P1: the cross-family experiment E1 (environment limit, skipped)

No second vendor is reachable. `env` lists only `ANTHROPIC_BASE_URL` (no `OPENAI_*`, `GEMINI_*`, `GOOGLE_API_KEY`, `MISTRAL_*` or the like), and no credential for one was provided through the environment. Recorded as L-GF-74 and skipped; P2 to P4 did not depend on it. The one independent review of P4 is therefore a fresh Claude reviewer briefed with the P2 rows.

## P2: attacker-first review (done before the build)

A separate adversary agent with fresh context, given only the threat model (18.0), the ownership map (18.2) and the section-21 design (not the spike outputs or any implementation), wrote **54 evasion rows** (`docs/build/gf-s2-4-adversary.json`): 11 in-model, 43 out-of-model, across symlink/hardlink (8), proc (5), mount/userns (4), ptrace/ipc (5), git-plumbing (5), env-hijack (5), toctou (4), rename/unicode (2), special-files (3), network (6), env-leak (2) and design-specific (5). Its structural finding drove the build: **Landlock is a filesystem write set only** (no pid/mount namespace, no network scope unless asked, and the engine runs outside the sandbox as the same uid), so the process, IPC and network surface against the engine, and `/dev`, are not closed by Landlock alone. The five rows it judged most dangerous (A-5/A-6 hardlink through to the real tree or `.git`; A-19 process_vm_writev into the engine; A-17 raw `/dev` block-device write; A-42/A-46 network exfiltration and malicious dependency installs) each map to a defence below.

How the build answers each class:

| Class | Answer in S2.4 |
|---|---|
| symlink/hardlink (A-1 to A-8) | the sandbox worktree's `.git` and other groups' paths are read-only, so a hardlink or symlink write-through is refused by the kernel; the commit step refuses a hard-linked file (`nlink > 1`), a symlink entry (not a regular file), a regular file reached through a symlinked directory (resolve check), and a `.gitattributes`. The real-tree hash of the copy runner is not used here, so A-5/A-6's "the diff is blind" is answered by the kernel read-only mount, not by a hash |
| proc (A-9 to A-13) | `/proc/self/*` is a read-through of the sandbox's own view (cwd and root are the worktree); the private tmp is outside every project tree; secrets and `ECCODE_*` are scrubbed from the environment, so `/proc/<pid>/environ` of the sandboxed process holds nothing (A-13 against OTHER processes is L-GF-75) |
| mount/userns (A-14 to A-17) | GF-ISO-0's canary tries a user-namespace remount and a `/dev` write; `/dev` is granted as named character devices only (`/dev/null`, `/dev/zero`, …), never the whole directory, so a block-device write (A-17) has no node to open; the canary refuses group mode if any of this is not contained |
| ptrace/ipc against the engine (A-18 to A-22) | **L-GF-76, a named limit, partially mitigated:** under Landlock the engine runs as the same uid and is visible; a pid namespace (`unshare --pid`, used when available) hides other processes from the sandboxed one, and bubblewrap's `--unshare-all --new-session` does the same; `kernel.yama.ptrace_scope` is the OS control the engine cannot set. Where the pid namespace is available (measured here) the sandboxed process sees only itself, so ptrace and `/proc/<enginepid>/mem` have no target; where it is not, this is the residual |
| git-plumbing / env-hijack (A-23 to A-32) | the commit step runs outside the sandbox with a sanitized environment: `GIT_CONFIG_NOSYSTEM`, `GIT_CONFIG_GLOBAL=/dev/null`, `GIT_ATTR_NOSYSTEM`, no `GIT_DIR`/`GIT_WORK_TREE` from the caller (set by the engine), `GIT_EDITOR=:`, `GIT_PAGER=cat`, `GIT_SSH_COMMAND=/bin/false`, `core.hooksPath=/dev/null`, no filters, `GIT_NO_REPLACE_OBJECTS`; the repository's own config is refused if it names an include, filter, textconv, external command or hook path; a `.git` write by the group is impossible (read-only in the sandbox) |
| toctou (A-33 to A-36) | the commit step hashes the bytes it validated and commits exactly those blobs (validate-and-commit are one read), so a change after validation is not committed; A-33 (an in-group, in-task change by a surviving background process) is the acknowledged L-GF-17/L-GF-51 residual; A-36 (the globs change between the disjointness check and process start) is answered by reading the map once per run |
| rename/unicode (A-37, A-38) | the commit step refuses a non-NFC name and a case-fold collision (two paths differing only by case) |
| special files (A-39 to A-41) | the commit step refuses a fifo, device node or socket (not a regular file); a symlinked-directory loop is loop-guarded with a depth cap |
| network (A-42 to A-47) | the group sandbox denies the network (Landlock net scope at ABI ≥ 4, or bubblewrap `--unshare-all`); GF-ISO-0's canary refuses group mode if a TCP connect succeeds; dependency installs are the only networked step, an orchestrator-only pinned form |
| env-leak (A-48, A-49) | the scrubbed environment passes an allowlist only; secrets, proxies and `ECCODE_*` are dropped |
| design-specific (A-50 to A-54) | GF-ISO-4 records every glob widening and the audit checks it against the map; the merge step (GF-ISO-3) refuses an out-of-order or conflicting merge; the private tmp is wiped per run; GF-ISO-0 records the self-test so the audit requires one before every sandboxed run |

## P3: what was built

- **GF-ISO-0 (self-test canary).** `lib/greenfield/sandbox.js selfTest`: a canary in a scratch tree writes its own path and must fail to write another path, the scratch root, a hard link and a TCP connection, under every mechanism here (Landlock, bubblewrap). Group mode is refused fail-closed (`groupModeProblems`) when no mechanism contains it, when the platform is not Linux or WSL2 (the owner's support matrix), or when the configuration does not name the `copy` fallback. The engine records `gf.isolation.checked` once per process; the audit requires a passed one before any sandboxed run.
- **GF-ISO-1 (the sandboxed run).** `lib/greenfield/isolate.js run`: the group's own git worktree (`.gf-worktrees/<group>`, excluded through the common dir), a detached checkout of HEAD synced with the group's owned files; the command runs inside the sandbox (`scripts/sandbox/landlock_run.py` for Landlock, a `bwrap` line otherwise) with the write set = the group's owned directories and a private tmp, network denied, environment scrubbed; only the group's own-path changes come back, the rest discarded and listed. Landlock first (ABI check); bubblewrap when the write set has carve-outs (Landlock cannot carve a directory out of a writable one) or Landlock is absent; the write set never contains a project tree (checked before the process starts); the private tmp is outside the project and wiped.
- **GF-ISO-2 (the commit step).** `isolate.commit`: outside the sandbox, the group's changed files (owned and in the claimed task) are validated before any git write — a regular file, no symlink in the path, one hard link, NFC name, no case collision, not `.git`/`.eccode`/`.gitattributes`/`.gitmodules` — then the validated bytes are committed through plumbing (`hash-object`, a temporary index from the parent tree, `commit-tree`, a compare-and-swap `update-ref`) onto `gf/<group>` with the sanitized environment. A file of another group under the group's directory prefix is ignored when it is that group's committed work or unchanged, and refused otherwise. The repository config is refused if it names an include or external command.
- **GF-ISO-3 (the merge step).** `isolate.merge`: the orchestrator or the user merges the group branches into the current branch in the breakdown's dependency order (a cycle is refused), in memory (`merge-tree --write-tree`), after citing passed deterministic checks; a conflict is a GF-OWN violation signal and stops the merge.
- **GF-ISO-4 (the write set).** `sandbox.writeSet`: directory prefixes of the group's globs; a non-prefix glob is widened to its directory and recorded; a glob that would widen to the whole project, or reach the repository or the record, is refused; a denied sub-glob is a carve-out.
- **The engine-mediated dependency install.** `isolate.installDeps`: the orchestrator runs a pinned install form (`pip install -r <file>` without `..`, `python -m pip install -r <file>`, `npm ci`, `uv sync`, `poetry install`) in a sandbox with the network allowed and only the dependency directories writable; the lockfiles' hashes are recorded.
- **Wiring.** Event schemas `gf.isolation.checked`, `gf.group.committed`, `gf.groups.merged`, `gf.deps.installed`; the projection; the audit's GF-ISO replay (every sandboxed run follows a passed self-test; every commit's files are the group's and the task's; every merge cites passed checks in a dependency order; the recorded widening matches the map); the runner routes a group role to the sandboxed worktree run unless `isolation: "copy"`; the MCP tools `gf_commit`, `gf_merge`, `gf_deps_install`, `gf_isolation_check` (the first and last on the group-role allowlist); the CLI `isolation check`, `commit`, `merge`, `deps install`. The S2.x copy runner stays for roles in no group and as the owner's explicit `copy` fallback.

**Measured on this machine** (Firecracker microVM, Linux 6.18, Landlock ABI 7, bubblewrap 0.9.0, a pid namespace):
- GF-ISO-1 end to end (`tests/gf-iso-run.test.js`): an own-path write lands; a cross-group write, the `.venv` symlink write-through, a `git commit`, a network connect and a secret read are all refused by the kernel and never reach the real tree. 7 tests.
- GF-ISO-0, 4 and the sandbox (`tests/gf-iso-sandbox.test.js`): the canary is contained under both mechanisms; the write set and the argv are correct; fail-closed when the self-test fails. 14 tests.
- GF-ISO-2 and 3 (`tests/gf-iso-commit.test.js`): the commit and merge steps, with the symlink, hard link, special file, `.gitattributes`, config-include, cross-group and out-of-order bypass rows. 11 tests.
- The guard-isolation tests (`tests/gf-iso-guards.test.js`): two isolating tests per guard. 20 tests.
- The dependency install (`tests/gf-iso-deps.test.js`): 4 tests.

**Rule-removal battery** (`docs/build/gf-s2-4-record/rule-removal.sh`, `rule-removal.txt`): each GF-ISO guard removed or weakened on a throwaway copy, every one killed by at least two tests — `iso2-owner-off` 4, `iso2-task-off` 3, `iso2-symlink-off` 2, `iso2-hardlink-off` 3, `iso2-regular-off` 3, `iso2-config-off` 3, `iso0-gate-off` 2, `iso4-widen-off` 3, `iso3-check-off` 2, `iso3-actor-off` 3, `allowlist-off` 8.

## P4: review and verification

**One independent review** (a fresh Claude reviewer, zero context, briefed with the P2 adversary rows, on commit `f32b82a` in an isolated checkout; `docs/build/gf-s2-4-record/reviewer-brief.md`). It read the design, the evidence, the code and all 54 adversary rows, then ran live reproductions through `gf_run` and `isolate.*` on this machine (both mechanisms available).

**Result: one in-scope finding, now fixed.**
- **R-1 (major): `choose()` selected the sandbox mechanism by availability, ignoring the self-test's per-mechanism verdict.** `selfTest().usable` (which mechanism actually contained the canary) was recorded but never consulted; `groupModeProblems` checked only the aggregate `ok` (any mechanism usable). So on a host where Landlock reports an ABI but does not enforce (LSM off, a boot-param misconfiguration), the canary would exclude Landlock from `usable`, but a no-carve-out group would still run under the non-enforcing Landlock, and an absolute write to another group's real-tree file would reach it. Major on this host (both mechanisms enforce here, so no live leak), blocking-class on an affected host. The adversary missed it (it is distinct from A-54, a write-set TOCTOU).
- **Fix:** `sandbox.choose` now takes the self-test's `usable` set and returns only a mechanism in it, or null; `isolate.run` and `isolate.installDeps` pass `selfTest().usable` and refuse fail-closed (GF-ISO-0) when no self-test-passing mechanism fits the write set. Red test first (`tests/gf-iso-sandbox.test.js` R-1 row), then the fix, then two integration tests (`tests/gf-iso-guards.test.js` R-1 #1 and #2). The whole class the canary measures is now bound to the mechanism actually used.

**What the review confirmed blocked** (live, both mechanisms): every in-model adversary row — A-1, A-2 (symlink/.venv write-through), A-9, A-10 (/proc self), A-23, A-24, A-25 (git plumbing into the shared .git), A-35 (rename EXDEV), A-38 (rename/case), A-46 (no network for an in-run install), A-50 (widening write discarded on copy-back). It also verified several rows the adversary had marked "cannot be blocked" are in fact defended: A-5, A-6 (hardlink into the real tree or .git, EXDEV), A-17 (/dev is named char devices only), A-48, A-49 (environment scrubbed), A-28, A-31, A-37, A-40 (commit-step config, NFC, regular-file checks). No blocking real-tree breach was reachable.

**Two out-of-model observations** became limits, not findings: L-GF-79 (Landlock network denial is TCP-only; bubblewrap closes all) and L-GF-80 (the per-run private tmp shares a same-uid base, readable by a concurrent run). The same-uid ptrace/memory/environ rows against the engine stay the named residual (L-GF-76), mitigated here by the pid namespace.

**Verdict:** the reviewer gave NO-GO to close as-is on R-1 (a major defect, which GF-CLOSE-2 forbids deferring), and GO with R-1 fixed. R-1 is fixed, so the condition is met.

## Closing verification (one pass, mine)

- R-1 fixed: the red test failed on the pre-fix `choose`, passes on the fix; the two integration tests pass.
- Full gf suite green; the complete `tests/*.test.js` green at 1,753 tests (0 fail, 49 skipped for the absent FastAPI venv) at concurrency 4; an earlier single `standards.extract` failure was a parallelism flake that passes in isolation and on the limited-concurrency re-run.
- The rule-removal battery still kills every GF-ISO guard with at least two tests.
- Frozen 48 of 48 by hash before and after; `docs/limits.md`, `scripts/guards/` and `lib/project.js` untouched.

## P5: the S2.3 recommendation

(one page, evidence only; `docs/build/gf-s2-4-s23-recommendation.md`)

## Verification

- Full gf suite on the build tree: green (1,180 tests before the deps test and the symlink-walker change; the complete `tests/*.test.js` figure is in the final report).
- Frozen 48 of 48 by hash before and after.
- `docs/limits.md`, `scripts/guards/` and `lib/project.js` untouched.
- `node scripts/validate-toolkit.js`: passes.

## Accounting

The usage reader (P0) read this session at **66,391,848 all-processed tokens and $20.68** cumulative since session start (S2.3 + spike + S2.4 together, one session; a per-slice delta needs a start snapshot the session did not take). Against the S2.4 cap (≤45 M, hard stop 60 M), the per-slice figure is **unmeasurable** for the reason in L-GF-73: no start snapshot was captured when S2.4 began, and the one session mixes three slices. No paid benchmark was run; the benchmark meter shows $0. The adversary subagent used 745,337 all-processed tokens as the reader reports them.
