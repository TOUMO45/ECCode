# Independent review: guard repairs (commit ffbdc8d, branch `eccode/guard-repairs`)

**Verdict: changes requested.** One blocking regression introduced by the nested-root change (F2), plus the NEW-6, NEW-7 and NEW-9 repairs are each incomplete in ways the probes below reproduce with one-line commands. The nested-root behaviour itself (the pilot's failure) is repaired and holds up under every legitimate and hostile probe I ran except the one in F2.

- Commit reviewed: `ffbdc8d16f26d3d6d03fa9dbd4291667f10d5571` ("Guard: >| is a redirect; nested projects are judged by their own record; …"), parent `a088c6a`, checked out as a worktree at `/tmp/claude-0/-home-user-ECCode/f72396f5-b89f-576d-a680-29d481cd71c9/scratchpad/guardfix`.
- Files changed: `scripts/hooks/guard.js` (+27/-7), `tests/guard-verification-repairs.test.js` (new, 4 tests).
- Reviewer: independent (did not write the change). Environment: Linux, node v22.22.0, GNU bash 5.2.21.
- Evidence in this directory: `probes.js` (313 PreToolUse probes fed to the worktree guard, throwaway projects via `tests/helpers.js`, nested ones via `lib/project.js init`, claims driven through the engine), `results.txt` (its full table and every input), `repro.sh` + `repro-output.txt` (standalone one-liners for each finding, also run against the pre-commit guard for regression classification).

## 1. Findings

| # | Severity | Area | Status vs parent | Summary |
|---|---|---|---|---|
| F1 | **High** | NEW-6 | pre-existing, not closed by the commit | `echo x >| .eccode/events.jsonl` from the main session (or any non-ECCode agent) is **allowed**. The tokenizer now sees the target, but the textual record check `SHELL_WRITE` (`(>|…)[^|;&]*.eccode/...`) still stops at the bar, and the main session only has that check. One token, the exact NEW-6 operator, onto the record. |
| F2 | **Blocking** | nested root | **regression introduced by ffbdc8d** | Record protection is now relative to the *nearest* `.eccode/events.jsonl`, and the main session can plant one inside the record with a guard-allowed command (`eccode init --root .eccode --name a --idea b`, or `cp -r .eccode .eccode/.eccode`). Afterwards `Write`/`Edit` of `.eccode/state.json`, `events.jsonl`, `config.json`, `reviews/*.json`, `memory/*`, `evidence/*` are **allowed** (the project-relative path becomes `state.json`). The parent commit denies all of these after the same planting. |
| F3 | **High** | NEW-7 | incomplete | `SHELL_WRAPPER` is a prefix-anchored regex over the raw line. Nine valid-bash wrapper forms are **allowed** from a reviewer subagent, each ending in `e task claim api --actor backend-engineer`: `function e() { … }`, `function e ( … )`, `e() ( … )` (subshell body), `e() if …; fi` (compound body), a leading space, `if …; then e() { … }; fi`, `{ e() { … }; }`, the wrapper inside `bash -c '…'` / `sh -c "…"`, and inside `eccode evidence run … -- '…'` (the CLI then runs the nested call as `technical-reviewer` with no guard at all). |
| F4 | **High** | identity binding | pre-existing, not in REPORT.md | The whole identity check is skipped when the raw text lacks the substring `eccode`: `node bin/ecc"ode".js task claim api --actor backend-engineer` (reviewer) and `node bin/ecc'ode'.js gate reopen design --actor user` (main session) are **allowed**; so is `bin/ecc\ode.js`. The tokenizer reassembles the word, but `/eccode|ECCODE_/.test(cmd)` in `checkBash` and `mentionsEccode` in `eccodeActors` read the raw string. This makes the NEW-7 wrapper moot (why wrap when the word can be split). |
| F5 | Medium | NEW-9 | incomplete | `V=ECCODE_SHARED_MEMORY; export $V=/tmp/x; eccode memory search race --actor learning-debugger` is **allowed** (bash exports `ECCODE_SHARED_MEMORY`). `export ECC''ODE_SHARED_MEMORY=/tmp/x` alone is allowed (the gate in F4), which matters wherever the Bash tool's shell persists between calls. The literal spellings (inline, `env`, `env -S`, `export …;`, `declare -x`, `sh -c`, `eval`, alone) are all denied as intended. |
| F6 | Medium | record protection | pre-existing | The main session may replace the whole record directory: `rsync -a /tmp/forged/ .eccode/` and `cp -r /tmp/forged/. .eccode` are **allowed** (the record patterns need a file name after `.eccode/`; the target `.eccode` itself is not one). Implementers are denied by ownership; the main session (A3 in the threat model) has no other check. |
| F7 | Low | NEW-6 | new edge | A quoted or escaped bar is read as the clobber operator: `echo x >"|" src/server/a.js` from an implementer whose claim is `src/server/**` is **allowed** because the guard binds `src/server/a.js`, while bash writes a file literally named `|` in the cwd (outside the claim). Verified with bash: the file `|` is created. Nuisance value only. |
| F8 | Low | NEW-7 | false positive | `f() { echo hi; }; f # see the eccode docs` (reviewer) is **denied**: `mentionsEccode` matches the comment. `f() { echo hi; }; f; eccode status --brief` is denied by design (acceptable), but a comment is not a CLI call. |

### F2 in detail (blocking)

`main()` resolves `fileRoot = findRoot(path.dirname(abs)) || root` and `checkEdit(fileRoot, rel, role)` tests `RECORD_FILES` against `rel`. With `/proj/.eccode/.eccode/events.jsonl` present, `/proj/.eccode/state.json` has `fileRoot=/proj/.eccode`, `rel=state.json`, and `RECORD_FILES` (which requires a `.eccode/` segment) does not match; the main session has no ownership check, so the write is allowed. The same applies to `checkBash`'s `targetRoot` for shell targets, but there the textual `SHELL_WRITE` regex still catches literal record paths, so only the `Edit`/`Write`/`MultiEdit`/`NotebookEdit` path is open.

Planting is guard-visible and allowed for the main session in two ways (`repro.sh` F2, `probes.js` `bogus-cli-init-main`, `bogus-cp-dir-main`):

- `eccode init --root .eccode --name a --idea b` — `bin/eccode.js` resolves `--root` anywhere and `lib/project.js init` accepts any actor and any directory, including one inside an existing project's record. The CLI itself writes `.eccode/.eccode/{events.jsonl,state.json,config.json,…}`.
- `cp -r .eccode .eccode/.eccode` — the target word is `.eccode/.eccode`, which no record pattern matches.

Roles cannot profit from the same trick: after planting, a reviewer loses even its draft area (`reviewer-draft-after` → deny) and an implementer with a `**/*.json` claim is denied because the planted record has no claim (`impl-json-record-after` → deny). The regression is the main session's: before the commit `main-record-after` and friends were all denied (`repro-output` second run, pre-commit guard: four `deny` lines).

Reproduction (from `repro.sh`, decisions quoted from `repro-output.txt`):

```
== F2. main session: a record created inside the record unprotects the record for Write/Edit
   before:            deny: .eccode/state.json is part of the ECCode record …
   planting command:  allow        (eccode init --root .eccode --name a --idea b)
   after:             allow        (Write .eccode/state.json)
                      allow        (Edit  .eccode/events.jsonl)
                      allow        (Write .eccode/config.json)
                      allow        (Write .eccode/reviews/architecture-1.json)
```

Fix shape: test `RECORD_FILES` against the absolute posix path of every target (as the `outsideProject` branch already does) before any root is chosen, so a record file is a record file wherever it lives and whatever root is nearest; and honour a nested root only when it is not inside an enclosing project's `.eccode/`. `lib/project.js init` should also refuse a root inside an existing project's record, and the guard should treat `init --root <p>` from a subagent as a write to `<p>/.eccode` (ownership rules).

### The bogus-nearest-root question (the one the task flagged as most important)

Classification: **not a guard-visible bypass for implementers; a guard-level loosening only through residual-1 channels; caught by completion accounting; but it is a guard-visible bypass for the main session (F2).**

Probed (`probes.js` section `BOGUS-ROOT`):

1. Guard-visible creation inside a claim. An implementer claiming `src/server/**` is denied `touch`/`>`/`cp` of `src/server/.eccode/events.jsonl` (record patterns), but **allowed** `cp -r .eccode src/server/.eccode`, `mv src/server/tpl src/server/.eccode`, `rsync -a src/server/tpl/ src/server/.eccode/` (directory targets owned by the claim) and `eccode init --root src/server --name x --idea y --actor backend-engineer` (the CLI writes it; identity matches). `eccode init --root src/web …` (outside the claim) is **also allowed** — the guard does not apply ownership to what the CLI writes.
2. What a copied or CLI-created record gains: nothing. The copied record's claims (`src/server/**`) are now relative to `src/server/`, so `src/server/b.js` becomes `b.js` and is **denied** — the implementer locks itself out (`post-bogus-copy-write-inside`, `nonprefix-js-after-empty`). An empty CLI-created record has no claim → every write under it is denied.
3. What a *crafted* record gains (a record with an approved plan and a `**` claim, which only a script can build since every gate/review step is identity-bound): with a real claim of `src/**/*.js` and a crafted `src/.eccode` claiming `**`, `echo x > src/config.yaml` and `Write src/config.yaml` are **allowed** (`nonprefix-yaml-after-crafted*`). That is a loosening versus the parent guard, confined to the directory under the crafted root, and reachable only through residual 1 (a script the guard cannot read). A crafted record cannot reach above its directory (`crafted-outside` → deny) or the real record (`crafted-real-record` → deny).
4. Engine accounting of case 3: `tasks.complete` refuses the handoff — `files changed since the claim that no task declares: src/.eccode/.gitignore, src/.eccode/artifacts/…, src/.eccode/config.json, src/.eccode/events.jsonl, src/.eccode/state.json, src/config.yaml (in no task's ownership)` (`engine-completion-with-crafted-record`). With a directory claim (`src/**`) the planted record files would instead be *owned* and would have to be declared in `filesChanged`, where the phase reviewer sees them. Files git ignores remain the documented residual.

So the crafted-record loosening is real but bounded and backstopped; the unbounded case is F2, where the planting needs no script and the target is the record itself.

## 2. What holds (verified)

All 313 probes and their decisions are in `results.txt`; the 32 mismatches are exactly the findings above (F1: 1, F2: 6 + 1 collateral, F3: 9, F4: 3, F5: 3 incl. the sourced-file residual, F6: 2, F7: 1, F8: 1, plus `symlink-dir-same-project` and the crafted-record pair discussed as residuals). Everything else answered as expected:

- NEW-6: `>|`, `>|file`, `1>|`, `2>|`, `>>|`, `&>|` (both bash syntax errors; over-deny harmless), quoted/double-quoted targets, a tab after the operator, inside `sh -c`/`bash -c`, before and after a pipe, `tee` — all denied for reviewers and for an implementer without a claim or outside it; `>|` into `.eccode/reviews/drafts/` (reviewer) and `.eccode/drafts/` (implementer) and inside a claim allowed. `a | b`, `a |grep`, `a || b`, `a |& b`, `2>&1 |`, `>&2 |`, `> /dev/null |` unaffected.
- Nested root (outer record + `examples/app` with its own record, `CLAUDE_PROJECT_DIR` = outer): reviewer/author writes to the inner draft and artifact areas allowed from the outer and inner cwd via `Write`, `Edit`, `>`, `>|`, `cp`, `tee`; inner record files (`state.json`, `events.jsonl`, `config.json`, `reviews/*.json`, `memory/*`, `evidence/*`) denied for the main session and every role from both cwds via `Write`, relative and absolute redirects, `cp`, and `git checkout -- examples/app/.eccode`; inner source without an inner claim denied (implementer, reviewer), allowed for the main session; with a claim set up through the engine (plan approved with a task owning `src/**`, phase started, claimed as `backend-engineer`) writes to inner `src/` allowed from both cwds via `Write` (absolute and relative), `>`, `>|`, `cp`, `tee`, `sed -i`; outer `src/` from the inner cwd (`../../src/server.js`, absolute, `src/../../../src/server.js`) judged by the outer record and denied; outer record from the inner cwd denied; outer draft area from the inner cwd allowed for a reviewer; a directory with only the outer record above it (`../../docs/notes.md`, `examples/other/src/y.js`) judged by the outer and denied; symlinks from inner `src/` to the outer record file, the outer `.eccode` directory and the outer `src` directory all denied (`Write` and redirect); identity rules unchanged in the inner cwd.
- NEW-9: `ECCODE_SHARED_MEMORY`/`ECCODE_ROOT`/`ECCODE_SEQUENTIAL_ROLES`/`ECCODE_HOOKS` denied inline, via `env`, `env -i`, `env -S`, `export …;`, `… ;`, `declare -x`, `sh -c`, `bash -c`, `eval`, and alone; a variable exported in the hook's environment leaves `eccode memory search …` and `eccode status` allowed; `FOO=1 eccode …` and `ECCODE_ROOTX=1 eccode …` allowed.
- NEW-7: `e() { … }`, `e(){ … }`, `function e { … }`, newline-separated definitions (brace on the same or the next line), definition on a later line, `alias`, `shopt -s expand_aliases; alias`, `eval "eccode … --actor user"`, `$(eccode …)`, backticks, `c=eccode; $c …`, `exec`/`command eccode …` all denied; `f() { echo hi; }; f`, a quoted `'e() {'` grep pattern next to a CLI call, and a function inside an `evidence run` command that never calls the CLI allowed.
- Tests: the six named files pass (71/71) and `npm run check` passes (toolkit validation + 241/241 tests) in the worktree.

## 3. Residuals (not blocking, should be stated)

- Crafted nested record inside a claim (above, case 3): guard-level loosening through residual 1, bounded to the crafted directory, refused at completion unless the files are git-ignored.
- `eccode init --root <anywhere>` is accepted from every role with any actor and writes outside any claim (`bogus-cli-init-outside-claim`). Harmless today only because an empty record denies everything beneath it; it is the planting primitive in F2.
- `--root /elsewhere` on an eccode command is allowed from subagents (`root-flag`), which is the flag form of the now-denied `ECCODE_ROOT=`. Probably intended (the deny message says "pass --root explicitly"); say so in the threat model or deny it for subagents too.
- A symlinked *directory* inside a claim that resolves elsewhere inside the same project (`src/tolib -> lib`) is allowed by the guard (`symlink-dir-same-project`; the lexical path is owned and the real path does not start with `..`); completion's git accounting sees the real files as unaccounted. Pre-existing.
- `set -a; . ./env.sh; eccode …` sets any variable from a file the guard cannot read (residual 1).
- Aliases do not expand in a non-interactive shell; denying `alias` is harmless over-deny, not a control.
- `>>|` and `&>|` are bash syntax errors; the guard denies them as redirects, which is harmless.
- Shell state persistence: where the Bash tool's shell keeps functions and exports between calls, a definition in one call that avoids the substring `eccode` (F4) and a bare `e task claim …` in the next call are both unchecked. The guard reads one line at a time; the threat model should say so.

## 4. Recommended repairs before approval

1. F2: `RECORD_FILES.test(toPosix(abs))` on every `Edit`/`Write` target and every shell target before choosing a root; do not honour a nested root inside an enclosing project's `.eccode/`; make `init` refuse a root inside an existing record; add the F2 reproduction as a test (plant with `init`, then `Write .eccode/state.json` from the main session must stay denied).
2. F1: let the first `SHELL_WRITE` alternative be `>{1,2}\|?` (or drop `|` from the `[^|;&]*` class only directly after `>`), and add `echo x >| .eccode/events.jsonl` from the main session to the NEW-6 test.
3. F4: decide "mentions the CLI" on the tokenized words at every depth (`ECCODE_WORD` over `walkCommands`), not on the raw string; then F5's split name and F8's comment resolve with it.
4. F3: apply the wrapper check inside the `walkCommands` visitor at every depth (nested `sh -c`, `eval`, `evidence run -- …`), and match a definition anywhere in the command (`function\s+NAME` or `NAME\s*\(\s*\)` followed by any compound-command opener, not only `{`), without the prefix anchor.
5. F5: deny `export`/`declare`/`typeset`/`printf -v`/`read` with a dynamic (`$`-bearing) argument in a line that calls the CLI.
6. F6: treat a shell write whose target is `.eccode` or `.eccode/` (after trailing-slash normalisation) as a record write for every role including the main session.
7. F7 (optional): mark a word whose `|` came from quotes so it is not read as the clobber operator.

## 5. Exact commands and outputs

Worktree: `/tmp/claude-0/-home-user-ECCode/f72396f5-b89f-576d-a680-29d481cd71c9/scratchpad/guardfix` (`git log --oneline -1` → `ffbdc8d Guard: >| is a redirect; nested projects are judged by their own record; …`).

```
$ node --test tests/guard-verification-repairs.test.js tests/review-F4-F5-guard.test.js tests/hooks-install.test.js \
    tests/redteam-regressions.test.js tests/security-regressions.test.js tests/review-F9-win32-guard.test.js
# tests 71 / # pass 71 / # fail 0   (duration 18017 ms)

$ npm run check
# tests 241 / # pass 241 / # fail 0  (duration 49062 ms), exit 0

$ node docs/evidence/verification-0.3.0/guard-repairs-review/probes.js
# node v22.22.0; 313 probes; 32 mismatches with the reviewer's expectation   (full table: results.txt)

$ bash docs/evidence/verification-0.3.0/guard-repairs-review/repro.sh            # worktree guard
F1 >| onto record (main):            allow, allow      (plain > : deny)
F2 after planting .eccode/.eccode:   allow ×4          (before: deny; planting command: allow)
F3 nine wrapper forms (reviewer):    allow ×9          (the two covered forms: deny)
F4 split CLI word:                   allow ×3
F5 indirect name / split name:       allow ×2
F6 rsync / cp -r onto .eccode:       allow ×2
F7 quoted bar:                       deny for the reviewer; bash creates a file named "|"
F8 comment false positive:           deny

$ bash repro.sh <pre-commit guard a088c6a> <scratch>                               # regression classification
F1: allow, allow (pre-existing)      F2 after planting: deny ×4 (regression in ffbdc8d)      F4: allow ×3 (pre-existing)
```

Mismatch list from `probes.js` (section | id): NEW-6 clobber-record-main, quoted-bar-impl; NESTED symlink-dir-same-project; BOGUS-ROOT nonprefix-yaml-after-crafted, nonprefix-yaml-after-crafted-write, main-record-after, main-events-after, main-config-after, main-review-after, main-memory-after, main-evidence-after, reviewer-draft-after, main-rsync-whole-record, main-cp-whole-record; NEW-9 indirect-name, split-name-no-cli, read-from-file; NEW-7 fn-keyword-parens, fn-keyword-subshell, fn-subshell-body, fn-if-body, fn-leading-space, fn-after-then, fn-in-group, bash-c-fn, bash-c-fn-user, sh-c-fn-dq, evidence-run-fn, split-word, split-word-user, escaped-word, fp-unrelated-fn-comment.

Nothing was committed; the worktree is unchanged apart from the test runs. Throwaway projects were created under the OS temp directory by the helpers and removed.

---

# Re-review of d0e2a3b (80ddab0 + test marker), branch `eccode/guard-repairs`

**Verdict: changes requested.** F1, F2 (as reported), F3 (as reported), F4, F5 (as reported) and F8 are closed and the original probe set now has no unexplained mismatch. But re-attacking the new code finds one blocking chain that re-opens F2 through a symlink alias, and the new `RECORD_DIR_WRITE` / `SHELL_WRAPPER` / computed-name rules each have gaps of the same shape they were meant to close, plus one over-denial that will hit everyday commands.

- Commits: `80ddab0` (guard, lib/project.js, tests) and `d0e2a3b` (test marker). Worktree clean before and after.
- Evidence added: `probes-rerun-d0e2a3b.txt` (original 314 probes re-run), `probes2.js`/`results2.txt`/`probes2-output.txt` (180 new probes), `probes3.js`/`results3.txt`/`results3-oldguard.txt` (alias chain, also against a088c6a), `bashsem.sh`/`bashsem-output.txt` (bash 5.2 semantics of every new form), `tests-d0e2a3b.txt`.
- Tests: the six guard files **73/73 pass**; `npm run check` **243/243 pass**, exit 0.

## R1. Original probes re-run (314): 9 mismatches, all explained

| id | now | classification |
|---|---|---|
| `bogus-cp-dir`, `bogus-cp-dir-main` (`cp -r .eccode src/server/.eccode`, `cp -r .eccode .eccode/.eccode`) | deny | improvement (my expectation recorded the old behaviour) |
| `lib-init-inside-record` | `INVALID_INPUT` | fixed as described |
| `quoted-bar-impl` | allow | F7, documented residual |
| `symlink-dir-same-project` | allow | pre-existing residual (completion accounting catches it) |
| `nonprefix-yaml-after-crafted(-write)` | allow | residual-1 crafted record, refused at completion (unchanged analysis) |
| `read-from-file` | allow | residual 1 |
| `fp-grep-fn` (`grep -n 'e() {' x.sh && eccode status`) | deny | new false positive: a quoted pattern is walked as a nested command (low) |
| `fp-evidence-run-fn` (`evidence run -- 'f() { npm test; }; f'`) | deny | by design now; should be documented (an evidence command may not define a function) |

Closed and verified: `clobber-record-main` (F1) deny; all `main-*-after` (F2) deny; all nine F3 wrapper forms deny; `split-word`, `split-word-user`, `escaped-word` (F4) deny; `indirect-name`, `split-name-no-cli` (F5) deny; `main-rsync-whole-record`, `main-cp-whole-record` (F6) deny; `fp-unrelated-fn-comment` (F8) allow.

## R2. New findings

| # | Severity | Status | Summary |
|---|---|---|---|
| G1 | **Blocking** | regression of the nested-root series (a088c6a denies the final step) | Main session, three guard-allowed steps, then the Write tool edits the record: (1) `mkdir -p .eccode/.eccode && cp -r ./.eccode/. .eccode/.eccode/` or `cp -r ./.eccode/. "$PWD/.eccode/.eccode"` → allow (`RECORD_DIR_WRITE` needs the bare word `.eccode`; `./.eccode/.` and `.eccode/.eccode/` do not qualify); (2) `ln -s "$PWD/.eccode" rec` → allow (prefixed path); (3) `Write rec/state.json`, `Edit rec/events.jsonl`, `Write rec/config.json`, `Write rec/reviews/architecture-1.json` → **allow**. Cause: `findRoot(dirname(/proj/rec/state.json))` sees `/proj/rec/.eccode/events.jsonl` through the link, `insideRecord('/proj/rec')` is lexical and false, so `rec` becomes the root, `rel=state.json`, and `realRel` then measures the real path against the real path of that bogus root (`state.json`: not `..`, not a record). `probes3.js` `alias-*-after-plant`; without the planted copy the same Write is denied (`alias-no-plant`); with the pre-series guard it is denied (`results3-oldguard.txt`). |
| G2 | High | F6 only partly closed | `RECORD_DIR_WRITE` matches only a bare `.eccode`/`./.eccode` word. Allowed for the main session: `cp -r /tmp/forged/. <abs>/.eccode`, `rm -rf <abs>/.eccode`, `mv <abs>/.eccode /tmp/away`, `cp -r /tmp/forged/. src/../.eccode`, `cp -r /tmp/forged/. "$PWD/.eccode"`, `rm -rf .eccode/*`, `rm -f .eccode/{events.jsonl,state.json}`, `rm -rf .ecc''ode`, `cp -r /tmp/forged/. .ecc''ode`, `find .eccode -type f -delete`, `find .eccode -type f -exec rm {} +`, `ls .eccode/* \| xargs rm -f`, the nested record from the outer cwd (`cp -r /tmp/forged/. examples/app/.eccode`, `rm -rf examples/app/.eccode`) and the outer from the inner (`rm -rf ../../.eccode`). Record *areas* without a trailing slash were never matched (pre-existing): `rm -rf .eccode/reviews`, `rm -r .eccode/memory`, `mv .eccode/evidence /tmp/x`, `cp -r /tmp/forged/reviews .eccode/reviews` → allow. (`results2.txt` `dir-*`, `nested-dir-*`.) |
| G3 | High | pre-existing, in scope of "shell targets judged on the absolute path" | The tokenized absolute-path record check for shell targets sits inside `if (eccodeRole(role))`, so the main session's record files are still protected only by the raw-text regexes: `echo x > .eccode/"state.json"`, `echo x > .ecc''ode/events.jsonl`, `echo x > .eccode/\state.json`, `cat f \| tee .eccode/"events.jsonl"`, `echo x > <abs>/.eccode/"config.json"` → **allow** for the main session (bash writes the real file, `bashsem-output.txt`). Roles are denied (`file-role-*`). |
| G4 | High | NEW-7 still open | `SHELL_WRAPPER` requires `[A-Za-z_][\w-]*` names. Bash accepts, and the guard allows, `1e() { eccode "$@"; }; 1e task claim api --actor backend-engineer`, `é() {…}`, `e+() {…}`, `e%() {…}` from a reviewer (`results2.txt` `fn-digit-name`, `fn-unicode-name`, `fn-plus-name`, `fn-pct-name`; validity in `bashsem-output.txt`). |
| G5 | High | pre-existing, identity binding | A CLI word carrying a dynamic marker is not bound and the command word is not dynamic, so no check runs: `node bin/$'eccode'.js task claim api --actor backend-engineer`, `node bin/ecc$''ode.js …`, `X=; node bin/eccode.js${X} …` → **allow** from a reviewer; bash runs `bin/eccode.js` (`bashsem-output.txt`). `${X}bin/eccode.js` is caught (the word still ends in `eccode.js`). Fix: a dynamic word that contains `eccode` cannot be bound → deny. |
| G6 | Medium | new over-denial | The computed-name clause refuses any `export`/`declare`/`env`/`local` whose later argument is dynamic and contains `=`: `export OUT="$HOME/x"; eccode …`, `env FOO="$BAR" eccode …`, `local x=$y; eccode …` → **deny** (`fp-dynamic-unrelated-export`, `fp-env-literal`, `fp-local-in-fn-free-line`). `export PATH="$PWD/node_modules/.bin:$PATH"; eccode evidence run …` is an everyday shape. Only a dynamic *name* (`$` before the `=`) should count; the first clause already does that. |
| G7 | Medium | NEW-9 still open | `N=ECCODE_SHARED_MEMORY; printf -v "$N" /tmp/x; export "$N"; eccode …` and `declare -n ref=ECCODE_SHARED_MEMORY; ref=/tmp/x; export ref; eccode …` → **allow**; both export the variable (`bashsem-output.txt`). |
| G8 | Medium | pre-existing (a088c6a: same) | Symlink alias of the record without any planting: `ln -s "$PWD/.eccode" rec` → allow; then `echo x > rec/state.json` (main session; the Bash path never resolves links) → allow; `Write rec/reviews/architecture-1.json` (a *new* file under the alias) → allow because `realRel` returns null for a path that does not exist yet. Existing files through the alias are denied by the Write tool. |
| G9 | Low | pre-existing | Trailing slash on a draft area: `mv x.json .eccode/reviews/drafts/`, `cp x.json .eccode/reviews/drafts/`, `mv x.md .eccode/drafts/` by a reviewer → **deny** (`path.resolve` strips the slash; `reviews/drafts` then matches `reviews/`, and `.eccode/drafts` does not match `.eccode/drafts/**`). The fully named target (`…/drafts/x.json`) is allowed. The coordinator's example command is therefore refused. |
| G10 | Low | new over-denials | The record as a *source*: `cp -r .eccode /tmp/backup-eccode`, `tar czf /tmp/record.tgz .eccode`, `rsync -a .eccode/ /tmp/backup/`, and `rm -rf build # old .eccode junk` (comment) → deny. Quoted strings next to a CLI call: `grep -n 'e() {' x.sh && eccode …`, `awk 'function f(x) { … }' data; eccode …` → deny. |
| G11 | Low | residual | `lib/project.js init` refuses `.eccode`, `.eccode/drafts`, `.eccode/reviews/drafts/x`, `src/../.eccode/drafts` (all `INVALID_INPUT`) but accepts a symlink into the record (`work -> .eccode/drafts` creates `.eccode/drafts/.eccode/…`); harmless to the guard (never re-roots inside a record) but it litters the record. `init(src/server)` inside a claim is still accepted (empty record → self lock-out; completion accounting sees the files). |

## R3. What the re-attack confirmed as sound

- Planted records at every depth never re-root through a lexical path: with copies at `.eccode/.eccode`, `.eccode/drafts/.eccode`, `.eccode/reviews/drafts/.eccode` and `src/server/.eccode`, every record file of the real record is denied for the main session and all roles via Write and Bash (`rec-*-after-plant`), the planted copies' own files are denied, reviewers keep their draft areas (`rec-reviewer-draft-still-ok`, `rec-reviewer-draft-deep`), authors keep artifacts, and the implementer is locked out of its own claim (`claim-after-plant-inside`) but cannot reach outside it or the real record.
- A symlinked `.eccode` inside a claim (`ln -s <abs>/.eccode src/server/.eccode`, allowed as an owned target) only locks the implementer out; `src/server/.eccode/state.json` is denied lexically. The loosening I probed (`src/web/.eccode -> record` granting `src/web/src/server/x.js`) needs the link *outside* the implementer's claim, which the implementer cannot create and the main session does not need.
- The nested example project keeps working after the outer record has planted copies; the hook cwd inside `.eccode/drafts` resolves relative paths correctly.
- `RECORD_DIR_WRITE` has no false positive on `cp .eccode/drafts/a.json b.json`, `ls .eccode`, `ls -la .eccode/`, `cat .eccode/state.json`, `rm .eccode/drafts/tmp.txt`, `rm .eccode/reviews/drafts/old.json` (reviewer), `mv notes.md .eccode/drafts/notes.md`, `cp brief.md .eccode/artifacts/brief.md` (author), `du`, `find`, `git status`, `rm -rf build && ls .eccode`, `echo .eccode/.lock >> .gitignore`, `mkdir -p .eccode/drafts`, `grep`. It denies `cp -r /tmp/forged/. .eccode`, `./.eccode`, `".eccode"`, `rsync … .eccode/`, `mv /tmp/forged .eccode`, `mv .eccode /tmp/away`, `rm -rf .eccode`, `rm -rf -- .eccode`, `tar xf … -C .eccode`, `ln -s /tmp/forged .eccode`, for every role.
- `eccode init --root .eccode` and `--root ./.eccode/drafts/new` are refused by the real CLI (rc 1); `eccode status --root .eccode` is not a project (rc 1).
- Wrappers: all nine F3 forms plus `while`, `case`, `eval '…'`, `printf … > w.sh; . w.sh` are denied; `(cd src && npm test) && eccode …`, `$((1+2))`, `if eccode …; then`, `for`, `case … a)`, `node -e` arrows/calls, `run()` in a double-quoted grep are allowed.
- Computed names: `export $V=`, `declare -x "$V"=`, `read …; export "$N"=`, `eval "export ${X}_MEMORY="`, `env "$V=/tmp/x"`, split names with or without the CLI, `export ECCODE_HO''OKS=off` are denied; `OUT=$(date +%s); eccode …` and `FOO=$BAR eccode …` allowed.

## R4. Repairs needed before approval

1. G1/G8: in `findRoot`, accept a candidate only if `<dir>/.eccode` is a real directory (`lstat`, not a symlink) *and* `insideRecord(realpath(dir))` is false; in `main()`/`checkBash`, also test `RECORD_FILES` against the real path of the target's existing parent directory joined with the file name, so a new file under an alias of the record is caught. Add the alias chain as a test.
2. G2: match the record directory on tokenized targets, not raw text: for `cp/mv/rm/rsync/tar -C/ln/install/rmdir/find -delete/xargs rm`, resolve each positional against the cwd and deny when the resolved path *is* a `.eccode` directory or any record area beneath one (with or without trailing slash), for every role. Keep the raw regex only as a fast path.
3. G3: move the absolute-path `RECORD_FILES` check on `bashWriteTargets` out of the `eccodeRole(role)` branch so the main session gets the tokenized answer too.
4. G4: match any word followed by `()` (`\S+\s*\(\s*\)` with the same body openers) and `function\s+\S+`, rather than an identifier class; bash's function names are not identifiers.
5. G5: deny when any word that contains `eccode` is dynamic (`w.dynamic`), as the file's own comment already promises for "eccode behind a variable".
6. G6: drop the second clause of the computed-name rule (or restrict it to arguments whose `$` precedes the `=`).
7. G7: deny `printf -v` with a dynamic name, `export`/`declare` with a dynamic bare name, and `declare -n` in a line that calls the CLI (or accept as residual and document).
8. G9: normalise a trailing-slash target to `<dir>/` before matching so `.eccode/reviews/drafts/` is a draft area and `.eccode/drafts/` is allowed; or document that targets must be named.
9. G10/G11: document (record-as-source over-denial, quoted-pattern over-denial, evidence commands may not define functions, init through a symlink).

## R5. Exact commands and outputs (re-review)

```
$ cd <worktree> && git log --oneline -2
d0e2a3b Tests: mark the sh -c probe string as hook input for the portability scan
80ddab0 Guard: a record planted inside a record never re-roots the guard; …

$ node --test tests/guard-verification-repairs.test.js tests/review-F4-F5-guard.test.js tests/hooks-install.test.js \
    tests/redteam-regressions.test.js tests/security-regressions.test.js tests/review-F9-win32-guard.test.js
# tests 73 / # pass 73 / # fail 0          (tests-d0e2a3b.txt)
$ npm run check
# tests 243 / # pass 243 / # fail 0, exit 0 (tests-d0e2a3b.txt)

$ node probes.js      → 314 probes; 9 mismatches (probes-rerun-d0e2a3b.txt), all classified in R1
$ node probes2.js     → 180 probes; 52 mismatches (results2.txt, probes2-output.txt): G2 ×24 incl. nested, G3 ×4, G4 ×4,
                        G5 ×3, G6 ×3, G7 ×2, G8 ×3, G9 ×1, G10 ×7, G11 ×1 (ENOENT variant, redone in probes3),
                        1 expectation error of mine (cwd-in-drafts-src: a planted copy at src/server was in play)
$ node probes3.js     → 23 probes; 13 mismatches (results3.txt): G1 chain (plant-step-pwd, plant-step-rel, alias-step,
                        alias-{state,events,review,config}-after-plant, alias-bash-after-plant), G11, G9 ×4
$ GUARD_WT=<a088c6a guard> node probes3.js → alias-state/events/config-after-plant: deny (results3-oldguard.txt)
$ bash bashsem.sh     → every probed bash form is valid and does what the finding says (bashsem-output.txt)
```

---

# Re-review of 3fa6298, branch `eccode/guard-repairs`

**Verdict: changes requested.** The structural rewrite (realize() on every target, recordPath() replacing the enumerated list, real-path findRoot, the tokenizer treating `$'…'`/`$"…"` as quotes and binding the CLI after stripping expansions, the loosened wrapper/computed-name rules) closes G2, G3, G4, G5, G6, G9 and G10 from the d0e2a3b re-review and all the F-series, with no over-denial in ordinary orchestrator/role commands. But one blocking bypass of the same shape G1 named remains open, and the commit's own headline ("every write target is judged on its real path for every context") does not hold for a symlink the command creates in its own line: realize() falls back to the lexical path for a link that does not exist yet, so an alias to the record made earlier in the same command line, then written through, clobbers the record with a guard `allow`.

- Commit: `3fa6298` (+ its test-marker). Worktree clean before and after.
- Evidence added: `probes-3fa6298.txt`, `probes2-3fa6298.txt`, `probes3-3fa6298.txt` (the three earlier suites re-run), `probes4.js`/`results4.txt`/`probes4-output.txt` (90 real-path + over-denial probes), `repro3.sh`/`repro3-output.txt` and `repro3b.sh` (live record-write proof), `regcheck.sh`/`regcheck-output.txt` (the bypass across commits), `tests-3fa6298.txt`.
- Tests: the six guard files **75/75 pass**; `npm run check` **245/245 pass**, exit 0.

## What the three earlier suites say now (re-run against 3fa6298)

- `probes.js`: 11 mismatches, all benign — `quoted-bar-impl` (F7 residual), the four `bogus-cp-dir*`/`bogus-mv-dir`/`bogus-rsync` now **denied** (improvement; my expectation held the old allow), `nonprefix-yaml-after-crafted*` and `read-from-file` (residual-1 crafted/sourced), and `fp-grep-fn`/`fp-evidence-run-fn` now **allowed** (the over-denials G10 fixed).
- `probes2.js`: 9 mismatches — `fp-grep-pattern`, `fp-awk`, `fp-evidence-run-fn` now allowed (over-denials fixed); `rec-drafts-planted-state`/`rec-review-drafts-planted-state` now allowed and are harmless (a record copied under `.eccode/drafts/` is the reviewer's own scratch and never re-roots, since findRoot rejects any dir inside a `.eccode` segment — confirmed); `cwd-in-drafts-src` and `init-via-symlink-into-record` were my probe artefacts (redone in probes3/probes4); the two `fp-mv-into-*drafts` are the new mv-source behaviour (G-min below).
- `probes3.js`: `ln-record-into-claim-abs/rel` now **denied** (an alias of the record directory is caught — improvement); `symlinked-root-lockout` now **allowed** and is correct (a symlinked `.eccode` inside a claim no longer re-roots, so the implementer writes its real claim); the `mv-*drafts-slash` rows are the mv-source behaviour (G-min).

## New findings

| # | Severity | Status | Summary |
|---|---|---|---|
| H1 | **Blocking** | pre-existing, in scope of this commit, not closed | A symlink to the record directory created earlier in the **same command line**, then written through, clobbers the record with a guard `allow`. `ln -s "$PWD/.eccode" lk && echo FORGED > lk/state.json` from the main session → **allow**; bash creates `lk -> .eccode` and clobbers the real `state.json` (proven live: 1995→7 bytes, first line `FORGED`, `repro3-output.txt`). Via the bare-directory alias the same trick forges memory and clobbers config: `ln -s "$PWD/.eccode" lk && printf … > lk/memory/m-forged.json` → allow, file lands in `.eccode/memory/` (`repro3b.sh` output: "forged memory file present in real record: YES"); `… > lk2/config.json` → allow. Cause: `realize()` calls `fs.realpathSync` on the target and, because the link `lk` does not exist when the guard runs, throws and falls back to the **lexical** path `…/lk/state.json`, which has no `.eccode` segment; and the textual `SHELL_WRITE` only matches a record path with a known file/dir suffix, so the bare `"$PWD/.eccode"` in the `ln` source is not matched (`.eccode"` is not `.eccode/<area>`). The main session (orchestrator) has no ownership check, so it is fully exposed; a role is incidentally blocked only because `lk/…` falls outside its claim (`guard(backend-engineer): deny` in `repro3b`). This defeats control #1 ("the record is written only by the CLI, never by hand … this holds … the main session included") and falsifies the commit's "every write target is judged on its real path for every context" for the one case that matters. Present on a088c6a, d0e2a3b and 3fa6298 alike (`regcheck-output.txt`: all three `allow`). Fix shape: when a command creates a symlink (`ln -s`/`ln --symbolic`) **and** writes, and any word of the line names a record directory (`RECORD_SEGMENT` on the `ln` operand — the guard already computes `mentionsRecord`, which is true here because the operand text is `$PWD/.eccode`), deny; or, as with the `cd` rule, refuse to bind a later relative target once the line has created a symlink. |
| H2 | High | same mechanism, Write/redirect through a dangling link | `dangle -> .eccode/newrec.json` (target absent), then `Write dangle` or `echo x > dangle` → **allow** for the main session (`probes4.js` `dangling-into-record`, `dangling-redirect`); bash creates the file inside the record. Here the record path *is* in the `ln` source, so when the two steps are one command the textual `SHELL_WRITE` catches it (`repro3` case 2 shows guard `deny`); the gap is when the link already exists on disk from an earlier tool call (a prior turn), its target still absent — `realize` then falls back to lexical and the Write/redirect is allowed. Same fix as H1 plus: in `realize`, when the deepest-existing ancestor is itself a symlink (even if its target is absent), resolve the link and keep the unresolved tail, instead of treating the link's own name as literal. |
| H3 | Low | residual (filesystem) | A hard link to a record file shares the inode; `realpath` cannot distinguish it, so `Write src/hard.json` / `echo x > src/hard.json` where `src/hard.json` is a hard link to `.eccode/state.json` → **allow** and bash writes the record (`probes4.js` `hardlink-*`, link creation confirmed). Hard links to directories are not allowed by the OS, so only individual record files are reachable, and the implementer still needs the path in its claim. Document as a filesystem residual alongside the git-ignored-files one. |
| G-min | Low | new behaviour, acceptable | `mv`/`cp` now treat a **project-relative source** as a write (mv removes it), so `mv x.json .eccode/reviews/drafts/` and `mv notes.md .eccode/drafts/notes.md` from a role are denied because the *source* `x.json`/`notes.md` is a project file the role may not remove (`results2.txt`/`results3.txt`). Correct in spirit (a reviewer moving/deleting a tracked file is a project mutation); only the message is misleading (it blames the draft target). An absolute or scratch source into a draft area is allowed (`rev-cp-into-draft-abs-src`). Reword the message, or exclude the destination-is-a-draft case from the source check. |

## Real-path attacks that the commit withstands (probes4.js, 90 probes)

- Symlink chain `a -> b -> .eccode`: `Write a/state.json`, `echo > a/state.json`, `cp … a/config.json`, `tee a/events.jsonl` all **denied**; `rm -rf a`, `cp -r forged/. a`, `mv a /tmp/away` (the chain as a directory target) denied.
- A symlink mid-path (`src/link -> .eccode`): `Write src/link/memory/m.json`, the redirect form, and a deep not-yet-existing tail `src/link/evidence/sub/deep/new.log` all denied. A mid-path link to a draft area (`draftlink -> .eccode/reviews/drafts`) stays writable for a reviewer.
- A directory symlink **inside** a draft area pointing back at the record (`.eccode/reviews/drafts/esc -> .eccode`): `esc/state.json`, `esc/events.jsonl`, `esc/memory/m.json` all **denied** (real path is the record); `esc/drafts/n.md` (which resolves to `.eccode/drafts`) allowed. This is the strongest draft-escape attack and it is correctly caught.
- Relative links and `..` through a link: `echo x > src/link/../.eccode/state.json`, `src/../.eccode/state.json`, the dir-link `rm`/`cp`/`mv` forms, and messy absolute spellings (`…/./.eccode/state.json`, `…//.eccode//state.json`) all denied.
- `init` refuses a root whose real path is inside a record.
- Over-denials: **none** in the ORDINARY section (0/46). `git status/add/commit/diff/log/checkout`, `npm ci/install/run build/test`, `mkdir -p`, `touch`, `rm -rf dist`, `cp/mv/sed/tar/redirect` on sources, `node -e` building dist (main session), `find -exec grep`, `cat/ls/grep/cp -r` on the record as a **source**, a comment naming the record, `export PATH="$PWD/…:$PATH"; eccode …`, `env FORCE_COLOR=1 eccode …`, `eccode evidence run -- npm test`, every implementer write inside its claim (redirect/mkdir/cp/mv/sed/tee/touch/draft/evidence-run/`(cd … && node -e read)`), and reviewer/author draft and artifact writes (Write, tee, cp from an abs source, mkdir, the draft directory itself with a trailing slash) are all allowed.

## Commands and outputs

```
$ cd <worktree> && git log --oneline -1 → 3fa6298 Guard: every write target is judged on its real path …
$ node --test <six guard files>        → # tests 75 / # pass 75 / # fail 0   (tests-3fa6298.txt)
$ npm run check                        → # tests 245 / # pass 245 / # fail 0, exit 0
$ node probes.js  → 314; 11 benign mismatches (probes-3fa6298.txt)
$ node probes2.js → 180; 9 mismatches, all improvements or probe artefacts (probes2-3fa6298.txt)
$ node probes3.js → 23; improvements + G-min (probes3-3fa6298.txt)
$ node probes4.js → 90; 7 mismatches: H1 (toctou ×2), H2 (dangling ×2), H3 (hardlink), 2 malformed-link harmless (rel-link ×2), 1 over-denial (dangling-into-draft) (results4.txt)
$ bash repro3.sh  → TOCTOU alias: GUARD allow, state.json clobbered 1995→7 bytes, first line FORGED (repro3-output.txt)
$ bash repro3b.sh → bare-dir alias: guard(main) allow, forged memory file present: YES; config clobber: allow
$ bash regcheck.sh→ a088c6a / d0e2a3b / 3fa6298 all allow the TOCTOU alias clobber (regcheck-output.txt)
```

Nothing committed; worktree clean.

---

# Re-review of 9c4d5aa, branch `eccode/guard-repairs`

**Verdict: approve, with one medium over-denial to tighten (non-blocking).** H1 and H2 from the 3fa6298 re-review are closed and H3 is documented. The real-path record protection now holds for every symlink attack I can construct, including the same-line alias that was the blocking H1 and the dangling/relative/missing-dir links that were H2. The only issue is that the new "creates a link and writes" rule is broader than it needs to be and denies ordinary build/devops command lines that never touch a record.

- Commit: `9c4d5aa`. Worktree clean before and after.
- Evidence added: `probes5.js`/`results5.txt`/`probes5-output.txt` (40 link-rule + realize-hop probes), `probes{,2,3,4}-9c4d5aa.txt` (earlier suites re-run), `repro3-9c4d5aa.txt` (live reproduction now denied), `tests-9c4d5aa.txt`.
- Tests: six guard files **76/76 pass**; `npm run check` **246/246 pass**, exit 0.

## H1/H2/H3 closed (verified)

- H1 (same-line alias): `ln -s "$PWD/.eccode" lk && echo x > lk/state.json` → **deny** ("creates a link and writes files in the same command line"); the bare-directory alias forging memory and clobbering config are both denied; `cp -s "$PWD/.eccode" lk && … > lk/config.json` denied. The live reproduction that clobbered `state.json` at 3fa6298 is now blocked at the guard (`repro3-9c4d5aa.txt`: GUARD deny before bash runs; `repro3b.sh`: both `deny`). `probes4.js` now **0 mismatches** (the toctou and dangling rows it flagged at 3fa6298 all pass).
- H2 (dangling link followed by hand): realize()'s manual `readlink` hop is correct in every case I probed (`probes5.js` REALIZE-HOP, **0 mismatches**): a dangling link into the record (`dangle -> .eccode/newrec.json`) denied for Write/Edit and shell; a dangling link to a dangling link into the record (`l1 -> l2 -> .eccode/newrec.json`) denied; a relative link with `..` into the record (`src/rel -> ../.eccode`, write `src/rel/state.json` and `src/rel/memory/m.json`) denied; a link to a non-existent directory with a tail (`dl -> .eccode/subdir`, write `dl/x.json`) denied; a dangling link into a draft area with a deep missing tail allowed for a reviewer; an existing resolvable link to the record dir denied, its `drafts/` subpath allowed.
- Loop safety: a symlink cycle `cycA -> cycB -> cycA` with a tail returns a decision (allow, no record) and does **not** hang — the 64-hop cap works (`cycle-write`, `cycle-write-bash`). A read through a record link (`cat rs`, `cp rs /tmp/out.json` where `rs -> .eccode/state.json`) is allowed (no over-denial on reads).
- H3 (hard links): documented as a filesystem residual; `probes4.js` `hardlink-*` still allow, as noted.

## Finding

| # | Severity | Summary |
|---|---|---|
| I1 | Medium (over-denial, non-blocking) | The rule `targets.length > 1 && createsLink(cmd)` fires on **any** line that creates a link and has a second write target, even when nothing names a record. Denied though they are record-free (`probes5.js` LINK-RULE, 8 cases): `ln -sf ../lib/cli.js bin/cli && echo built > .build-stamp`, `ln -s a b && touch c`, `ln -s a b && ln -s c d` (two symlinks), `ln -s a b; rm -rf dist`, `ln -sf ../x y && cp p q`, `ln -s a b | tee setup.log`, and a devops release line `ln -sf dist/current releases/latest && echo … > releases/latest.txt` (from the main session and from a `devops-engineer`). These are ordinary build/release shapes, and devops/main are the contexts most likely to run them; the denial message tells them to split the command, which is workable but surprising. Single-link lines are fine (`ln -s a b`, `ln -sf …`, `ln a b`, `cp -l a b`, `cp -s …`, `mklink b a`, `ln -s a b && cat b`, the `mkdir && ln && chmod` postinstall chain). Suggested tightening: gate the rule on `mentionsRecord` as well — the guard already computes it, and in H1 the `ln` operand `"$PWD/.eccode"` makes it true, so `targets.length > 1 && createsLink(cmd) && mentionsRecord` still denies H1 while letting the record-free build lines through. (Alternatively, only count a write target as "second" when it is relative and could resolve through a link created earlier in the same line.) |

No security gap found in the link rule or realize's hop; I1 is purely conservative breadth.

## Earlier suites re-run (unchanged classifications)

`probes.js` 11, `probes2.js` 9, `probes3.js` 6 mismatches — all the benign items already classified at 3fa6298 (F7 residual, residual-1 crafted/sourced records, the now-correct `bogus-*`/`symlinked-root` improvements, the planted-record-under-drafts scratch, and the mv-source behaviour `G-min`). `probes4.js` **0 mismatches**.

## Commands and outputs

```
$ cd <worktree> && git log --oneline -1 → 9c4d5aa Guard: dangling links are followed by hand; a line that creates a link and writes is refused …
$ node --test <six guard files>        → # pass 76 / # fail 0 (tests-9c4d5aa.txt)
$ npm run check                        → # tests 246 / # pass 246 / # fail 0, exit 0
$ node probes5.js → 40; 8 mismatches, all LINK-RULE over-denials (I1); REALIZE-HOP 0 mismatches (results5.txt)
$ node probes4.js → 90; 0 mismatches (probes4-9c4d5aa.txt)
$ bash repro3.sh / repro3b.sh → the H1 clobber/forge are now denied at the guard (repro3-9c4d5aa.txt)
```

Nothing committed; worktree clean.
