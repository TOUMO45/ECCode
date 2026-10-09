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
