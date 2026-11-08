# Spike: OS-level isolation for cross-group writes (2026-11-08)

**The owner's decision.** S2.3 (the allowlist) was replaced, part-built, by a time-boxed spike (cap 15 M processed tokens, no engine or gate change, no frozen file touched): find out whether cross-group isolation can be enforced by the kernel, per-group git worktree plus a sandbox, instead of by the engine inspecting commands. Pre-registered decision rule: if kernel isolation works in this environment and blocks every listed evasion, write a short design (section 21 of `docs/design/greenfield-senior.md`) that replaces the S2.x runner-copy approach for process isolation, keep the hook, the ownership map and the audit, stop and report; the owner approves before any build.

**Result, in one line.** Kernel isolation works in this environment, by two independent mechanisms (Landlock, kernel ABI 7; bubblewrap 0.9.0 in a mount and user namespace), as root and as an unprivileged user, and blocked all sixteen listed evasions while the group's own writes landed. The decision rule's first branch applies: section 21 is written as design text, nothing is built. The artefacts are in `docs/build/gf-spike-isolation/` (scripts and the exact outputs).

## 1. The execution environment, as measured

From `docs/build/gf-spike-isolation/env-facts.txt` and `probes-1.txt`, `probes-2.txt`:

| Fact | Value here |
|---|---|
| Kernel | Linux 6.18.44-fc-v310, x86_64, a Firecracker microVM (kernel command line `--firecracker-init`; `systemd-detect-virt` says `docker` for the container inside it); a real Linux kernel, not gVisor (no gVisor markers in `dmesg`, Landlock answers) |
| Distribution | Ubuntu 24.04.5 |
| Process identity | uid 0, every capability in the bounding set (`CapEff 000001fffeffffff`), `NoNewPrivs 0`, `Seccomp 0` |
| Landlock | **available: `landlock_create_ruleset(LANDLOCK_CREATE_RULESET_VERSION)` returns ABI 7**, so every filesystem right up to `REFER`, `TRUNCATE` and `IOCTL_DEV` is handled. `/sys/kernel/security` is not mounted, so the LSM list cannot be read that way; the syscall answers anyway |
| Mount namespace | works as root: `unshare -m` with a read-only bind remount refused a write (`Read-only file system`), the file outside the namespace unchanged |
| Unprivileged user namespaces | **work**: as uid 1000, `unshare -Ur` gives uid 0 inside, `unshare -Urm` mounts a tmpfs; `/proc/sys/user/max_user_namespaces` = 64267; the Ubuntu AppArmor switch `kernel.apparmor_restrict_unprivileged_userns` is absent (no AppArmor) |
| PID and network namespaces | work (`unshare -pf --mount-proc`, `unshare -n`) |
| bubblewrap | **not installed**; `apt-get update` then `apt-get install bubblewrap` installs 0.9.0-1ubuntu0.3 from the mirror (the first `apt-get install` without `update` failed: "Unable to locate package"). Works as root and as uid 1000 (`--ro-bind / / --unshare-all`, a read-only root, read-write binds) |
| `@anthropic-ai/sandbox-runtime` (`srt`) | installs with `npx -y`; **refuses to run until `socat` is installed** ("Sandbox dependencies not available: socat not installed"); with `socat` it runs, using bubblewrap for the filesystem and network and a seccomp filter for Unix sockets (`srt -d`); its `filesystem.allowWrite` list restricted writes as configured (below) |
| Docker | the client is installed and a server answers `docker info`; not used by the spike |
| `firejail`, `podman` | absent |

What was not measured here: a normal local machine or VM; section 4 documents it from the kernel's and the distributions' own facts, labelled as not tested.

## 2. The prototype and the evasion matrix

`proto-setup.sh` builds a real repository with two groups' files (`app/**` and `tests/**` for backend, `web/**` for frontend), an ignored `.venv/` and a guard configuration under `.eccode/`, and one git worktree per group whose `.venv` is a symlink into the real tree, as the frozen engine's worktrees are. The backend group's process runs inside the sandbox from its worktree with **write access to `app/` and `tests/` only** (its owned paths), a private tmp directory, and `/dev`; everything else, the other group's paths, the worktree's `.git` file and the repository's common `.git` directory, `.eccode/`, the real tree and the other worktree included, is readable and not writable. `evasions.sh` then attempts, from inside, every evasion of rounds 4 to 6 and I2-1. `run-matrix.sh <bwrap|landlock> <0|1000>` runs it and prints the real state from outside afterwards. The four runs are in `matrix.txt`; the table reads them.

| # | Evasion (its origin) | bwrap, uid 0 | bwrap, uid 1000 | Landlock, uid 0 | Landlock, uid 1000 |
|---|---|---|---|---|---|
| 0 | own path write (control) | landed | landed | landed | landed |
| 1 | `git commit` in the worktree after editing the other group's file (round 6, G2-1) | blocked: `index.lock: Read-only file system` | blocked | blocked: `Permission denied` | blocked |
| 2 | `git update-index --assume-unchanged` (round 6) | blocked (EROFS) | blocked | blocked (EACCES) | blocked |
| 3 | append to the common dir's `.git/info/exclude` (round 6, G2-2) | blocked | blocked | blocked | blocked |
| 4 | absolute-path write to the other group's file in this worktree | blocked | blocked | blocked | blocked |
| 5 | absolute-path write to the real tree | blocked | blocked | blocked | blocked |
| 6 | absolute-path write to the other group's worktree | blocked | blocked | blocked | blocked |
| 7 | write through the symlinked `.venv` into the real tree (I2-1) | blocked | blocked | blocked | blocked |
| 8 | absolute write to another group's draft under `.eccode/` (H2-2) | blocked | blocked | blocked | blocked |
| 9 | a guard-style tool running project code (`seed.py`, I2-1): its three cross-group writes | all three refused; its own-path write landed | same | same | same |
| 10 | `git -C <real tree> commit` (round 6) | blocked | blocked | blocked | blocked |
| 11 | hard link of the other group's file into the own path (round 4, E2-2) | blocked: `Invalid cross-device link` | blocked | blocked (EXDEV) | blocked |
| 12 | rename the other group's file into the own path (round 4) | blocked (the source is not removable; `mv` left a copy in the own path, the original intact) | blocked | blocked (`Permission denied`, no copy) | blocked |
| 13 | delete the other group's file | blocked | blocked | blocked | blocked |
| 14 | remount the own view read-write through a new user namespace | blocked (the mount fails) | blocked | blocked (`/proc/self/uid_map: Permission denied`) | blocked |
| 15 | write the guard configuration (GF-CONF-1) | blocked | blocked | blocked | blocked |
| 16 | write outside the project, `$HOME` | **allowed** | allowed | allowed | allowed |

Outside each run: the real tree's and both worktrees' `web/index.html` unchanged, `HEAD` of the repository and of the worktree unchanged, `.git/info/exclude` unchanged, no assume-unchanged flag, the guard configuration unchanged; the only files that landed are in the group's own path and in the private tmp directory.

Row 9 is the I2-1 case: the tool itself is not refused (nothing inspects what it is), and it cannot write where it should not. Row 16 is by design and is a limit (L-GF-67, below): `$HOME` pointed at the sandbox's private tmp directory in these runs, so the write landed there; a sandbox that is to forbid every write outside the project gets no writable tmp, and the tools' caches then need a path inside the owned paths. Row 12 differs between mechanisms: under bubblewrap the own path and the other group's path are separate mounts, so `mv` fell back to copy-then-delete and left a copy of the other group's file in the own path (harmless: it is the group's path, and the engine's commit step judges it as the group's change); under Landlock the rename is one refused `renameat2`.

**Two mistakes in the first attempt, recorded as rule-construction lessons.** (1) `bwrap --tmpfs /tmp` hid the spike's own scripts, which lived under `/tmp`: a sandbox's scratch mount must not shadow what the sandboxed command needs to read. (2) The first Landlock run granted write access to `/tmp` for the tools' caches while the prototype itself lived under `/tmp`, which made the whole prototype writable and every row "passed": **a writable path must never contain the project**, and the engine must check that the writable set and the project tree are disjoint before it starts a process. The first attempt's output was overwritten; the lesson is recorded here, the corrected runs are in `matrix.txt`.

**The third mechanism, `srt`** (`srt-probe-2.txt`): with `socat` installed and a settings file whose `filesystem.allowWrite` names the group's `app/` and the private tmp, the same prototype refused `git commit` (`index.lock: Read-only file system`), the symlinked `.venv` write, the absolute write to the real tree and the write to `.git/info/exclude`, and let the own-path write land. It is bubblewrap underneath, so its results are bubblewrap's; it adds a network policy by domain, a seccomp filter for Unix sockets, and the Seatbelt and Windows backends.

## 3. What works on a normal local machine or VM (documentation only, not tested here)

- **Landlock** needs a kernel built with `CONFIG_SECURITY_LANDLOCK` and `landlock` in the LSM list (`lsm=` on the kernel command line, or `/sys/kernel/security/lsm`). Mainline since 5.13 (ABI 1: file rights without rename across directories); 5.19 adds `REFER` (ABI 2: renames and links across directories are governed), 6.2 adds `TRUNCATE` (ABI 3), 6.7 TCP rules (ABI 4), 6.10 `IOCTL_DEV` (ABI 5), 6.12 scoping of signals and abstract sockets (ABI 6), 6.15 audit of denials (ABI 7). Ubuntu 22.04 (5.15) is ABI 1, Ubuntu 24.04 (6.8) ABI 4, Debian 12 (6.1) ABI 2, Fedora and Arch current kernels ABI 6 or 7; Ubuntu and Fedora enable the LSM by default, Debian since 11. **No root, no namespaces and no setuid helper are needed**: a process restricts itself and its children. Below ABI 2 a rename or link can move a file across the boundary (rows 11 and 12 would not be governed as such, though the write into the other group's directory still is). The wrapper `landlock-run.py` reads the ABI and handles what the kernel has.
- **bubblewrap** needs unprivileged user namespaces (`kernel.unprivileged_userns_clone` on Debian older than 11; `user.max_user_namespaces > 0`), or a setuid `bwrap`. Ubuntu 23.10 and later restrict unprivileged user namespaces with AppArmor (`kernel.apparmor_restrict_unprivileged_userns=1`): `bwrap` from the Ubuntu package ships an AppArmor profile that allows it; a `bwrap` built from source does not, and then needs a profile or the sysctl. Docker and Podman containers run with a default seccomp profile that denies `unshare`/`clone` with new namespaces unless started with `--privileged` or `--security-opt seccomp=unconfined`, so bubblewrap fails inside an ordinary container (this is the case Claude Code's sandbox documentation calls "an unprivileged container").
- **gVisor** (`runsc`, Cloud Run, some CI sandboxes) does not implement the Landlock syscalls (`ENOSYS`), and its user namespace support is partial; neither mechanism is reliable there. Detect it from `dmesg` ("Starting gVisor") or the syscall answers.
- **macOS**: no Landlock, no bubblewrap; the equivalent is Seatbelt (`sandbox-exec`, deprecated but present), which `srt` and Claude Code's own sandbox use. **Windows**: `srt` provides a backend (a dedicated low-privilege user plus WFP filters); WSL2 behaves as Linux.
- **The fail-closed rule for the engine**: before a group's command starts, probe (Landlock ABI, then `bwrap --ro-bind / / true` in a user namespace); when neither works, refuse to run and say "unverifiable here: no kernel isolation", as 17.5's rule says for a missing tool.

## 4. The engine-side commit and merge step (design, text only)

Written out as section 21 of the design document (GF-ISO-1 to GF-ISO-4). In short: the engine, outside the sandbox, (1) creates one worktree and one branch per group per slice and materialises the group's owned directories; (2) starts every command of a group role inside the sandbox of that worktree, built from the effective ownership map (prevention); (3) at `task_complete` and at slice integration validates `git diff --name-only` of the worktree against the map and the claimed task's files, refuses on any path outside, and commits as the engine with the actor recorded; (4) merges the groups' branches in the breakdown's dependency order into the slice branch only after the contract tests of S3 pass, and treats a merge conflict as a GF-OWN violation signal, since disjoint ownership cannot conflict.

## 5. Reusing Claude Code's own isolation (evaluation)

Read from the current documentation of `worktrees`, `sub-agents`, `agent-teams` and `sandboxing` at code.claude.com on 2026-11-08.

| Feature | What it does | Reusable by ECCode? | Risk |
|---|---|---|---|
| **Subagent worktree isolation** (`isolation: worktree` in the agent file or on the Agent call) | a temporary git worktree per subagent under `.claude/worktrees/`, branched from the default branch unless `worktree.baseRef` is `head`; cleaned up when the subagent made no changes, swept later otherwise. Enforcement is four checks on **the path an edit targets, the directory a command runs in, and the text of the command**: "None of them tracks which files a shell command writes, so a command that writes into the main checkout without running git there, such as `cp` or a shell redirect, isn't refused by them." | **Yes, for the worktree lifecycle** (creation, locking, sweep): ECCode's slice could run each group's subagent with `isolation: worktree` and read the worktree path from the hook's `cwd`. **No, for isolation**: the checks are the text-level class ECCode's rounds 2 to 4 closed (L-GF-1, 18.4), they protect the main checkout only, not one group's paths from another group, and `git commit` inside the worktree is allowed by design. | not marked experimental; the base branch is the default branch, so `worktree.baseRef: head` is needed to work on a slice branch; hooks keep `${CLAUDE_PROJECT_DIR}` at the main checkout |
| **Agent teams** | several Claude Code sessions with a shared task list and mailboxes; "Agent teams are experimental and disabled by default" (`CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`); no per-teammate worktree is documented (the docs say "Two teammates editing the same file leads to overwrites. Break the work so each teammate owns a different set of files"), no per-teammate permission mode at spawn, no spawning in `-p` mode, no session resumption with in-process teammates | the shared task list and messaging overlap ECCode's own task table and `gf_message_*`; nothing there enforces ownership | experimental, interactive only, "known limitations around session resumption, task coordination, and shutdown behavior"; depending on it would tie the engine's guarantees to a feature that can change or go away |
| **Claude Code sandbox** (bubblewrap on Linux, Seatbelt on macOS) | shell commands run with writes limited to the working directory, a temp directory and `sandbox.filesystem.allowWrite`; `denyWrite` exists; writes to the shared `.git` are allowed except `hooks/` and `config`; "local MCP servers run with your full access" (outside the sandbox); nested user namespaces are denied by default | **Partly**: it is the harness's own kernel sandbox for the subagent's shell, and `denyWrite` could carve the other groups' directories out of a worktree; but the writable set is per session and not per role, `.git` stays writable (`git commit` from a group would pass), and ECCode's MCP servers run outside it by design. ECCode's own per-command sandbox (section 21) is narrower and role-aware; the two can stack | the sandbox is per machine configuration (`/sandbox`), can be switched off, and its `allowUnsandboxedCommands` retry must be `false` to mean anything (the install profile already requires that for the `sandbox` profile) |
| **`srt` (`@anthropic-ai/sandbox-runtime`)** | the same runtime as a CLI and library: bubblewrap + seccomp on Linux, Seatbelt on macOS, a Windows backend; `filesystem.allowWrite`, `denyWrite`, domain-based network rules | **Yes, as the sandbox launcher** on macOS and Windows, where ECCode has no Landlock; on Linux it needs `bubblewrap` and `socat` installed | an npm dependency with a native seccomp helper; its config is a file or a control fd, so per-command rule sets are possible |

**Recommendation for section 21:** reuse the worktree lifecycle of the harness where it is there (`isolation: worktree` and the hook's `cwd`), never its text-level checks as the guarantee; enforce the group's write set with Landlock on Linux (first choice: no privileges, no daemon, no package), bubblewrap or `srt` as the fallback and the macOS and Windows path; keep the engine's commit step as the only writer of `.git`.

## 6. The decision rule, applied

Kernel isolation works here and blocked every listed evasion under both mechanisms and both identities: **branch 1**. Section 21 is written as design text; the hook (file tools), the ownership map and the audit stay; the S2.x runner's copy and real-tree hash become unnecessary for process isolation where a sandbox is available, and stay as the fallback where it is not. Nothing is built. **The owner approves before any build.**

## 7. Cost

| Snapshot | Taken | Figure |
|---|---|---|
| S2.3 start | 2026-11-08 15:50Z | `unmeasurable`: `get_session` returned no `usage` field (`external_metadata.usage` absent, `context_usage.used_tokens` 0 and unchanged on every call) |
| S2.3 check | 16:12Z | `unmeasurable`, same |
| spike end | 16:58Z | `unmeasurable`, same |

The 25 M cap of S2.3 and the 15 M cap of the spike could not be watched: the harness reports no usage to this session. What can be counted: the spike took 14 Bash calls, 4 documentation fetches and 6 file writes in about 50 minutes of wall time, in the same session as S2.3 (the owner's cost rules, fresh session per slice and a stable prefix, apply from the next slice). The effect against the S2 baseline (497 M tokens, $218) is therefore **unmeasurable** for this session; the snapshot files are in `docs/build/gf-s2-record/s23-usage-*.json`. No paid benchmark was run; the benchmark meter shows $0. No delegated agent was used in the spike.

## 8. Where S2.3 stands (suspended by the spike decision, not closed)

Built and pushed before the decision arrived, on this branch: the allowlist (`GROUP_ROLE_TOOLS`, default deny, `lib/greenfield/index.js`), the enumeration test (`tests/gf-tool-allowlist.test.js`), the permanent I2-1 reproduction (`tests/gf-review-s2-i2.test.js`), the documentation tests (`tests/gf-docs-s2h.test.js`), the design text (18.1, 18.4, 18.5, 18.7, section 20's owner decisions) and one adapted spoof row. In the closure record (archived in `docs/build/gf-s2-record/`, 563 events): I2-1 resolved fixed by a proven fix verification (`ev-mw80knjh-0165f5c7` failed at `c59ee39`, `ev-mw80ko47-0292ff55` passed), I1-1 resolved fixed by a paired run (`ev-mw80klx9-01b488b4` failed, `ev-mw80rl5v-017fd00e` passed), and battery 13 on tree `be2d7d1e` (commit `92bc68d`): 4 mutants on the changed source lines, 4 killed, 0 survivors (`bat-mw80z7ce-0236dd29`). Not done: the targeted review (no dispatch was recorded), the closure. `close status` lists the missing three steps of the closing round and the equivalent survivor `run-check.js:138` of battery 12, nothing else. The full suite on `92bc68d`: 1,679 tests, 1,625 passed, 1 failed before the spoof row was adapted (the row now passes), 53 skipped (the FastAPI virtual environment is not in this container, so 39 FastAPI tests skip on top of the 14 of S2); frozen 48 of 48 before and after; `docs/limits.md`, `scripts/guards/` and `lib/project.js` untouched.

Under the decision rule's first branch S2.3's allowlist is the fallback, not the main line: the owner decides whether the S2.3 work is kept as defence in depth (a group role's server offers fewer tools), reviewed and closed later, or reverted. It is not reverted here.
