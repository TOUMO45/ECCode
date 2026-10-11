# Independent review, round 5: TK-6 repair (commit c8f4ca4 on b5c7510, 0.3.4)

Reviewed: `c8f4ca4` on `worktree-agent-a24e7b0bc6643d426` (worktree
`/home/user/ECCode/.claude/worktrees/agent-a24e7b0bc6643d426`), the answer to `REVIEW-4.md` (R4-1..R4-5).
I did not write any of the five commits. git 2.43.0, Node 22.22.0, Linux. Nothing in the repository, the
worktree, `examples/rescuestock/**` or any existing `.eccode/` directory was modified; the pilot record was
copied out of git objects into a scratch repository for replay. Scratch copies: `fix5/` (c8f4ca4), `red4/`
(c8f4ca4 tests over b5c7510 code). Probes: `probe14.js` (guard: orchestrator shapes and attempts around the
rule), `probe10-r5.js`, `probe11-r5.js`, `probe13-r5.js` (engine bypasses), `probe7-r5.js` (pilot replay),
`probe-r5.js` (digest battery); outputs `*.out`; suite log `r5-npm-test.log`.

## Decision: approve

The orchestrator can merge `c8f4ca4`. Every R4 finding is resolved; the engine now refuses a failing git on
its own, so the remaining ways around the guard's inline rule (R5-1) only reach what the threat model
already places in residual 1 (a git or a preload that lies). The findings below are minor or informational
follow-ups, none blocking.

## R4 findings: resolution

| R4 | Claimed | Verified |
|---|---|---|
| R4-1 (Major) guard over-denial | `cliEnvProblems()` reads only real `NAME=value` assignments that reach a CLI call; heredoc bodies stripped | Resolved (`probe14.out`): all of the orchestrator's real shapes are allowed — `cd examples/rescuestock && node ../../bin/eccode.js run end <id> --actor orchestrator --tokens N --status ok` (from the root and from the nested project, which has its own record), `git add -A … && git commit -q -m "… GIT_DIR=/x … eccode …; PATH and NODE_OPTIONS …" && git push -u origin <branch>`, `python3 -I /path/script.py && git add …`, a heredoc commit whose body holds whole refusable lines, `GIT_TERMINAL_PROMPT=0 git push && node bin/eccode.js status`, a reviewer's `grep -n "GIT_DIR\|PATH=" bin/eccode.js` |
| R4-2a guard covers `PATH`/`HOME`/`XDG_CONFIG_HOME`, `env -i` | Yes | Denied: prefix, `export`/`declare -x`/bare assignment earlier on the line, `env`, `env -i`, `env -S`, `sh -c`, `bash -lc`, `eval`, a subshell `( PATH=…; … )`, a line continuation, an assignment on its own line before the CLI, `xargs`/`timeout`/`nice`/`exec` carrying the assignment, process and command substitution. The one intended change (`export PATH=…; eccode evidence run … -- npm test` now refused) has its workaround (`-- 'PATH=… npm test'`) allowed, in `docs/usage.md` and residual 14 |
| R4-2b completion/review refuse a pinned run while the digest is null | Yes | `probe11-r5.out`: the failing-git-at-completion case is now refused "cannot verify that the cited check(s) … ran on the current tree"; review covered by tests |
| R4-2c once the record pins, failing git → marker, `NO_COMMIT` | Yes | `probe13-r5.out`: CLI `evidence run` with a failing `git` first on `PATH`: marker set, warning printed; `gate submit`: exit 2 `NO_COMMIT`; delivery refusal covered by tests |
| R4-3 bare-repo `GIT_DIR`/`GIT_WORK_TREE` setups | Documented | CHANGELOG, residual 16, `docs/usage.md`; `.git` file / `--separate-git-dir` still works (`probe11-r5.out`) |
| R4-4 strip every `GIT_*` | `GIT_ENV = /^GIT_/i` | Yes; lower-case `git_dir` ignored |
| R4-5 config-sourced ignores | Residual 6 | Documented; behaviour unchanged (declared ignored file refused, `probe11-r5.out`) |

## Findings

### R5-1 — Minor — the guard's inline route is narrower than the docs say

- `probe14.out`, allowed although they set the variable for a CLI call on the same line:
  `{ PATH=/tmp/fake:$PATH; node bin/eccode.js status; }` (a brace group; the subshell form is caught),
  `read -r PATH <<< "…"; node bin/eccode.js status`, `printf -v PATH %s …; node bin/eccode.js status`,
  `. /tmp/env.sh; node bin/eccode.js status`, and `echo "<<EOF"` followed by a refusable line
  (`stripHeredocs` is not quote-aware, so a quoted `<<EOF` hides the following lines from this check — the
  identity checks still see them). `node --require /tmp/x.js bin/eccode.js …` / `node -r …` preload code
  without any environment variable and are not refused (the NODE_OPTIONS rule's purpose).
- Effect today: none on the engine's own checks for a *failing* git (R4-2b/c refuse it however `PATH` was
  changed). What remains is a git or preload that *lies*, which residual 16 already assigns to residual 1.
  The text "which closes the inline route, not a wrapper script" over-states it.
- Resolution (follow-up): say "the common inline forms" in residual 16; optionally treat `{ … }` like a
  subshell, refuse `node -r/--require/--import/--loader/--experimental-loader` on a CLI call, and make
  `stripHeredocs` skip quoted text.

### R5-2 — Info — a record that has not pinned yet still reads a failing git as "no git"

- `recordsPins` is false until the first run with a tree or submission with a commit; before that a
  failing git (exit status, not ENOENT) gives `{}` and an architecture submission without a commit is
  accepted. Every later normal command pins, so this needs a project run end to end on a broken git.
  Distinguishing "git not installed" (spawn `ENOENT`) from "git fails" (`git --version` non-zero) would
  close it. Follow-up.

### R5-3 — Info — small over-denial

- `env path=/x node bin/eccode.js status` is refused (the name match is case-insensitive; on Linux
  `path` is not `PATH`). Harmless; the workaround is obvious.

## Verified

- **Suites.** `npm test` in the worktree: tests 329, pass 329, fail 0, cancelled 0, skipped 0 (76.4 s);
  worktree clean before and after. Round-5 tests over b5c7510 code: 35 run, 28 pass, 7 fail — R4-4,
  R4-2c ×2, R4-2b, the two guard cases, and the existing G6 case whose `export PATH=…` line is the
  intended change. Engineer's `r5-red-guard.log` (2/2 fail), `r5-red-engine.log` (4 of 24 fail),
  `r5-full.log` (329/329) match. All 50 cases of the three TK-6 files pass on c8f4ca4.
- **Engine bypass battery** (`probe10-r5.out`, `probe11-r5.out`): detached HEAD, HEAD on a deleted branch,
  every `GIT_*` override (incl. lower case and `GIT_INDEX_FILE` alone), failing git at completion: all
  refused; orphan submit `NO_COMMIT`; submit under `GIT_DIR` elsewhere records commit and tree.
- **Pilot replay** (`probe7-r5.out`): 944 events, audit OK, rebuilt `state.json` byte-identical to the
  committed one under 0.3.3 and c8f4ca4; nine gaps in approval order with the possible-causes text.
- **Digest battery** (`probe-r5.out`): 89/92 oracle-equal (the three by-design rows); root projects equal to
  0.3.3 in 23/23.

## What I did not test

- Windows and macOS; the guard as installed in a live session (run directly with hook payloads); a full
  CLI delivery on the pilot copy.
