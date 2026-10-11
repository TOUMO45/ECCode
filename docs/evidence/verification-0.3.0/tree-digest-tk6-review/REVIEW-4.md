# Independent review, round 4: TK-6 repair (commit b5c7510 on 366c8ab, 0.3.4)

Reviewed: `b5c7510` on `worktree-agent-a24e7b0bc6643d426` (worktree
`/home/user/ECCode/.claude/worktrees/agent-a24e7b0bc6643d426`), the answer to `REVIEW-3.md` R3-1. I did not
write any of the four commits. git 2.43.0, Node 22.22.0, Linux. Nothing in the repository, the worktree,
`examples/rescuestock/**` or any existing `.eccode/` directory was modified; the pilot record was copied out
of git objects into a scratch repository for replay. Scratch copies: `fix4/` (b5c7510), `red3/` (b5c7510
tests over 366c8ab code). Probes: `probe11.js` (environment bypasses, `.git` file), `probe12.js` (guard),
`probe13.js` (a failing `git` on `PATH`), `probe7-r4.js` (pilot replay), `probe-r4.js` (digest battery);
outputs `*.out`; suite log `r4-npm-test.log`.

## Decision: changes required (two guard-sized changes)

The engine change is right: with `gitEnv()` every `GIT_*` override I tried (including `GIT_INDEX_FILE` alone,
`GIT_DIR` + `GIT_WORK_TREE` elsewhere, lower-case `git_dir`) is ignored, a run made under them is pinned and
refused as stale, `gate submit` under them records its commit and tree, and a legitimate `.git` file
(`--separate-git-dir`) still works. The pilot record still replays byte-identically. 324/324.

Two problems in what surrounds it. **R4-1:** the new guard rule matches any word on any line that mentions
`eccode` — including words inside quoted commit messages, heredoc bodies and `grep` patterns — so the
orchestrator's ordinary commands are denied: a `git commit -m` whose message contains `GIT_DIR` (as a word)
and `eccode` (this round's own commit message does), `GIT_AUTHOR_DATE=… git commit -m "eccode …"`, and a
reviewer's read-only `grep -n GIT_DIR bin/eccode.js`. **R4-2:** the same bypass R3-1 closed is open through
`PATH`: a failing `git` first on `PATH` (one inline token on the CLI line, which the guard allows) gives an
unpinned, unmarked run with no warning, a submission with no commit (a commit-less approval on 0.3.4), and a
completion that cites a stale run because the current digest is null. Both are small to fix.

## R3-1: resolution

| Claim | Verified |
|---|---|
| `gitEnv()` strips repository-selection and config variables, case-insensitively, in the only two git helpers | Yes: `lib/project.js` `git()` and `lib/delivery.js` `gitOut()` are the engine's only git calls (`grep` of `execFileSync('git'` in `lib`, `bin`); `scripts/verify-install.js` is a script, not the engine. Lower-case `git_dir` ignored (`probe11.out`) |
| A stale citation under `GIT_DIR`/`GIT_WORK_TREE` is refused | Yes (`probe11.out`: `GIT_DIR=<nonexistent>`, `GIT_DIR=<proj>/.git GIT_WORK_TREE=<elsewhere>`, `git_dir`, `GIT_INDEX_FILE` alone: all "ran on different bytes") |
| `gate submit` under `GIT_DIR` elsewhere records its commit | Yes (`commit=…, tree=yes`) |
| The CLI from a git-hook environment pins a nested project | Yes (test 20; red on 366c8ab) |
| `.git` file pointing elsewhere still works | Yes: `--separate-git-dir` project, `.git` is a file, digest computed and moves on an edit, `treePin` gives `tree` |
| Guard refuses inline `GIT_*` and `NODE_OPTIONS` on lines naming the CLI only | Refuses them (incl. `env -i GIT_DIR=… node bin/eccode.js`), but on far more than "inline on the CLI" (R4-1), and not `PATH`/`HOME` (R4-2) |
| 20 new cases, 15 red on 366c8ab | Yes: 15 of the 20 env cases plus the guard case fail on 366c8ab (`red3`); 30/30 green on b5c7510 |

## Findings

### R4-1 — Major (required) — the guard's `GIT_*`/`NODE_OPTIONS` rule denies the orchestrator's ordinary commands

- Where: `scripts/hooks/guard.js` `CLI_ENV` and `if (mentionsEccode && words.some((w) => CLI_ENV.test(w.text)))`.
  `mentionsCli` is true when any word anywhere (at any depth) contains `eccode`, and `walkWords` re-parses
  every word containing whitespace (a quoted `-m` message, a heredoc body) as a command, so a bare word
  `GIT_DIR` in prose matches `^(?:GIT_[A-Za-z0-9_]*|NODE_OPTIONS)(?:=|$)`.
- Evidence (`probe12.out`, b5c7510 guard vs 366c8ab guard on the same payloads):
  - DENY (was allow): `git commit -q -m "an inline GIT_DIR no longer records an unpinned run, and an eccode call from a git hook pins a nested project"` — this round's own commit-message wording.
  - DENY: `git commit -q -m "the guard refuses GIT_DIR=/x before eccode"`; `git commit -q -m "eccode: refuse NODE_OPTIONS inline"`; a `git commit -F - <<'EOF' … GIT_DIR … eccode … EOF`.
  - DENY: `GIT_AUTHOR_DATE=… git commit -q -m "eccode 0.3.4"` (a `GIT_*` variable on git, not on the CLI).
  - DENY for a reviewer: `grep -n GIT_DIR bin/eccode.js lib/project.js`; `git log --oneline -S GIT_DIR -- scripts/hooks/guard.js bin/eccode.js` (read-only).
  - Still allowed: `node ../../bin/eccode.js status --actor orchestrator`; `git commit -m "TK-6: strip GIT variables; NODE checks pass"`; `git push`; `GIT_PAGER=cat git log -1`.
  - The refusal text ("cannot verify who this eccode command acts as … run the eccode command without them") names no workaround for these lines.
- Resolution: match only *assignments that apply to a CLI invocation*: `NAME=value` words (require `=`) in
  the assignment prefix of a simple command whose command word is the CLI, or after `env`/`export`/
  `declare` in the same line as a CLI invocation; never bare names, never words inside quoted arguments of
  another command. Add allowed-cases for the lines above (commit `-m`, heredoc commit, `GIT_AUTHOR_DATE` on
  git, read-only `grep`/`git log -S`).

### R4-2 — Major (required, minimal form) — a failing `git` on `PATH` reopens the R3-1 bypass

- Where: `gitEnv()` keeps `PATH` (as it must); the guard does not refuse `PATH=…` (or `HOME=…`,
  `XDG_CONFIG_HOME=…`) inline on a CLI line; `treePin` returns `{}` when git says "not a work tree";
  `tasks.complete`/`checkReview` skip the stale check when the current digest is null.
- Evidence:
  - `probe13.out`, CLI with a `git` that exits 1 first on `PATH`, on a record that already pins trees:
    `evidence run` exit 0, no tree, no marker, no warning; `gate submit` exit 0, **no commit**, no marker,
    no warning — a commit-less approval on 0.3.4, reported later only as a warning gap.
  - `probe11.out`: run pinned normally, bytes changed, completion with the failing `git` on `PATH`:
    **accepted on bytes the check never saw** (current digest null → stale check skipped).
  - `probe12.out`: `PATH=/tmp/fakebin:$PATH node bin/eccode.js task complete … --actor backend-engineer`,
    `env -i PATH=… node bin/eccode.js …`, `HOME=/tmp/h node bin/eccode.js …` are all allowed.
- An actor who controls `PATH` can also put a *lying* git there, which no engine check can detect; that
  part belongs with residual 1 (the engine trusts its tools). But the *failing* git needs no forgery, and
  the engine can refuse it cheaply.
- Resolution (minimal, required): (a) the guard refuses `PATH`, `HOME` and `XDG_CONFIG_HOME` assigned
  inline on a CLI invocation (same narrowed rule as R4-1); (b) completion and review refuse to cite a run
  that carries a `tree` while the current digest is null ("the tree cannot be verified now"), which also
  closes residual 16's "compare nothing while the current digest is unavailable"; and (c) once the record
  pins (`recordsPins`), "not a work tree" yields `treeUnavailable` plus a warning, and `gate submit`
  refuses — a project does not leave git mid-delivery. Document in residual 16 that the engine trusts the
  `git` on `PATH`. (a) alone is acceptable for merge if (b)/(c) are queued.

### R4-3 — Minor — a repository reachable only through `GIT_DIR`/`GIT_WORK_TREE` is now "outside git"

- A bare repository driven by `GIT_DIR`+`GIT_WORK_TREE` (dotfile managers, some CI layouts) used to be
  honoured; now the engine sees no work tree there and pins nothing, silently (and with (c) above, would
  warn). Rare for an ECCode project; document it in the CHANGELOG/residual 16 as a deliberate behaviour
  change (`.git` files, worktrees and `--separate-git-dir` are unaffected, verified).

### R4-4 — Info — strip every `GIT_*` rather than a list

- `GIT_SELECTION_ENV` is an allowlist of known variables; git grows new ones (`GIT_ATTR_SOURCE`, which
  changes the attributes `hash-object` filters with; `GIT_REPLACE_REF_BASE`/`GIT_NO_REPLACE_OBJECTS`).
  None is needed by the engine's read-only calls; removing every `GIT_*` is simpler and future-proof.

### R4-5 — Info — config that ignores files is residual 6, not a new hole

- `HOME` with a global `core.excludesFile` of `*`, or `git config core.excludesFile …` in the repository
  (no environment at all): an untracked file the task adds disappears from the digest and from
  `gitChangedFiles`. Declared, it is refused ("handoff lists files that git shows as unchanged",
  `probe11.out`); undeclared, it is invisible — files git ignores, residual 6. Worth one sentence there:
  ignoring can come from repository or global configuration, not only `.gitignore`.

## Verified

- **Suites.** `npm test` in the worktree: tests 324, pass 324, fail 0, cancelled 0, skipped 0 (73.1 s);
  worktree clean before and after. New files on b5c7510: 30/30; on 366c8ab code: 14 pass, 16 fail (15 env
  cases + the guard case). Engineer's `r4-red-366c8ab.log` (20: 5 pass / 15 fail), `r4-green.log` (20/20),
  `r4-full.log` (324/324) match.
- **Pilot replay** (`probe7-r4.out`): 944 events, audit OK, rebuilt `state.json` byte-identical to the
  committed one under 0.3.3 and b5c7510; gaps unchanged from round 3 (nine gates, approval order, causes text).
- **Digest battery** (`probe-r4.out`): 89/92 oracle-equal (the 3 by-design rows), root projects equal to
  0.3.3 in 23/23.
- **Round-3 bypasses** (`probe11.out`): all `GIT_*` variants now refused as stale; `gate submit` under
  `GIT_DIR=<nonexistent>` records commit and tree.

## What I did not test

- Windows (case-insensitive environment names are handled by the `i` flag; not run); a wrapper script that
  sets `PATH` and then calls the CLI (residual 1: the guard cannot see inside it; the engine-side (b)/(c)
  of R4-2 would still apply); the guard as installed in a live session (run directly with hook payloads).
