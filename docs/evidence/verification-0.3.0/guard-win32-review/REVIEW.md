# Independent review: commit cde0b84 (branch `eccode/win32-guard-paths`)

- Commit reviewed: `cde0b841082a660e8faa6ae5686e8e54d95c95e7` — "Guard: Windows paths keep their separators; record patterns accept both separators (review F9 follow-up, Windows CI on 5da8913)". Parent: `5da8913`.
- Files changed: `scripts/hooks/guard.js` (+45/−14), `tests/review-F9-win32-guard.test.js` (new, 4 tests).
- Reviewer: independent (did not write the change). No tracked file was modified; nothing committed. The only files created are in this directory.
- Date: 2026-10-09. Host: Linux, Node v22.22.0. Windows was not run; see item 5.

## Verdict: changes requested

The three regex repairs are correct and genuinely platform-independent: a record or memory file named with backslashes is denied by the raw-command check before any tokenizing, on every platform, from every context, and the two Windows CI assertions that failed on `5da8913` are satisfied by the new code under win32 semantics (item 5). The actor binding by Windows path works. Tests and `npm run validate` pass.

The blocking finding is the tokenizer's win32 branch. It keeps a backslash before `.`, so a command written as `.eccode/drafts/.\./state.json` is resolved by the guard to `.eccode/drafts/state.json` (a draft: allowed for every role) while Git Bash, the shell behind the Bash tool on Windows, reads `.\.` as `..` and writes `.eccode/state.json` (the record). The parent commit's tokenizer denied exactly this command on Windows. The commit message's claim that the win32 reading "fails closed" relative to Git Bash is therefore not true in general: it holds for the regex part, not for the tokenizer part. Fix F-1 (small) and the change is approvable.

## Findings

### F-1 (High, new in this commit, blocking): the win32 tokenizer lets `.\.` hide a parent-directory traversal

`WIN_PATH_CHAR = /[A-Za-z0-9_.~-]/` includes `.`, so on win32 `splitCommands` keeps `\` in `.\.`. Bash (Git Bash included) drops an unquoted backslash before any ordinary character, so the shell reads `.\.` as `..`. `bashWriteTargets` then hands `path.resolve` a different path than the one the shell opens.

Reproduction (`probe-hook.js`, run against the exported `cde0b84` tree; `old` = `5da8913` guard, `new` = `cde0b84`, `new/win32` = `cde0b84` with `ECCODE_TEST=1 ECCODE_GUARD_PLATFORM=win32`):

```
# drafts/.\. to record (Git Bash reads .\. as ..), reviewer  [technical-reviewer]  want: deny
  $ echo x > .eccode/drafts/.\./state.json
  old        : deny: .eccode/state.json is part of the ECCode record and is written only by the eccode CLI.
  new        : deny: .eccode/state.json is part of the ECCode record and is written only by the eccode CLI.
  new/win32  : allow

# drafts/.\. to record, backend-engineer  [backend-engineer]  want: deny
  old        : deny: .eccode/state.json is part of the ECCode record ...
  new/win32  : allow

# drafts/.\./.\. to src/server.js, reviewer  [technical-reviewer]  want: deny
  $ echo x > .eccode/drafts/.\./.\./src/server.js
  old        : deny: technical-reviewer reviews/designs but does not edit project files ...
  new/win32  : allow
```

On a real Windows runner `process.platform === 'win32'` without any override, and `path.win32.resolve` gives the same answer as the simulation (`probe-tokenizer.js`):

```
"echo x > .eccode/drafts/.\\./state.json"
       guard (win32) resolves the target to: .eccode/drafts/state.json
       Git Bash actually writes:              .eccode/state.json
"echo x > .eccode/drafts/.\\./.\\./src/server.js"
       guard (win32) resolves the target to: .eccode/drafts/src/server.js
       Git Bash actually writes:              src/server.js
"echo x > src/api/.\\./core/x.js"
       guard (win32) resolves the target to: src/api/core/x.js        (inside an implementer's claim)
       Git Bash actually writes:              src/core/x.js            (outside it)
```

Impact, on Windows only: every ECCode role (reviewers, document authors, implementers) can overwrite the project record (`state.json`, `events.jsonl`, ...) and any project file through a shell redirect, `tee`, `cp`, `sed -i`, etc., by spelling `..` as `.\.`. The raw-command check does not see it (no literal `.eccode\<record>` in the command). The old guard denied these on Windows because its POSIX tokenizer produced the same path bash does. This is a regression of rule 1 (record integrity) and rule 3 (ownership) of the guard header, limited to Windows.

Why the "stricter than Git Bash" reasoning fails: keeping a backslash is only stricter when the kept path is a superset of what bash writes. `..` → `.\.` is the case where keeping it makes the guard see a *more harmless* path than the shell. `~` is in the same set (`\~` keeps a literal tilde in bash) but I found no damaging use of it.

Suggested fix (small, testable on Linux): on win32, judge each write target under both readings — as kept, and with `\` collapsed before a path character (the bash reading) — and run `checkEdit`/record checks on both; deny if either is denied. Alternatively reject any target containing `\.` or `.\` adjacent to a `.` segment. Pin it in `tests/review-F9-win32-guard.test.js` with `echo x > .eccode/drafts/.\./state.json` under the override for a reviewer and an implementer (today it is allowed under the override; with the bash-reading check the posix resolve yields `.eccode/state.json` and denies, so the test is meaningful on Linux).

A harmless instance of the same mismatch: under Git Bash, `echo x > .eccode\drafts\a.json` creates a file literally named `.eccodedraftsa.json` in the project root, while the win32 guard reads it as a draft and allows it (reviewer writes a junk file at the root). The commit's "drafts with either separator" wording describes the guard's view, not the shell's.

### F-2 (Low, new): the "override is ignored without ECCODE_TEST" assertion in the F9 test is vacuous

`tests/review-F9-win32-guard.test.js` test 3 asserts that the main session's `echo x > C:\Users\me\notes.txt` with `ECCODE_GUARD_PLATFORM=win32` and `ECCODE_TEST=''` returns `null`. The main session has no ownership rules and the path is not a record, so the result is `null` under either platform reading; the assertion cannot fail if the override were honoured. A non-vacuous check exists: for a reviewer, `cd /tmp && echo x > C:\Users\me\notes.txt` is denied under both readings on Linux, but the quoted path in the reason differs (`probe-hook.js`, last block):

```
new, ECCODE_GUARD_PLATFORM=win32, ECCODE_TEST unset : deny: ... writes the relative path "C:Usersm...   (override ignored)
new, ECCODE_GUARD_PLATFORM=win32, ECCODE_TEST=1     : deny: ... writes the relative path "C:\Users...   (override honoured)
```

Assert on the reason text (`/"C:Usersmenotes\.txt"/`) instead. Item 4 below confirms the behaviour itself is right.

### F-3 (Low, new, wording): the commit message overstates "fails closed"

"On win32 the tokenizer keeps a backslash that is followed by a path character (stricter than Git Bash: fails closed)" is false for `.` (F-1). The regex part of the commit does fail closed (a literal `.eccode\...` is denied even where Git Bash would have written a differently named file). Rewrite the message/comment once F-1 is fixed.

## Residuals (pre-existing on `5da8913`, not introduced here; reported for the record)

| # | Residual | Evidence (`probe-hook.out` unless noted) | Severity |
|---|---|---|---|
| R-1 | Path normalisation escapes the raw-command check for the **main session** on every platform: `echo x > .eccode/./state.json` and `echo x > .eccode/drafts/../state.json` are allowed (old and new). ECCode roles are protected by `path.resolve` in `bashWriteTargets`. Likewise `rm -rf .eccode` and `rm -rf .eccode/memory` from the main session are allowed (the record patterns need a separator after `memory`). | "dot segment, main", "drafts/.. to record, main", "rm -rf .eccode, main", "rm -rf .eccode/memory, main": old allow / new allow | Medium (main session is the orchestrator, A3 in the threat model; rule 1 says the record is never hand-written from any context) |
| R-2 | Case-insensitive filesystems (NTFS, default APFS): `.ECCODE` is not a record name to any regex. In the project, roles are still denied by ownership, but outside it `echo x > ~/.ECCODE/memory/records/x.json` is allowed for every role, and `echo x > .ECCODE/state.json` for the main session. On Windows and macOS these are the real files. The Edit path is partly covered by `realpathSync` on Windows (canonical case), the Bash path is not. | "uppercase .ECCODE outside", "uppercase .ECCODE in project, main": old allow / new allow | Medium on Windows/macOS |
| R-3 | `ECCODE_WORD` does not match the npm shims Windows actually installs for the `eccode` bin (`eccode.cmd`, `eccode.ps1`), nor `eccode.exe`. `eccode.cmd gate reopen design --actor user ...` and a reviewer's `eccode.cmd task complete api --actor backend-engineer` are allowed. The CLI's TTY check still backs `--actor user`; a role mismatch has no backstop. | "eccode.cmd shim --actor user", "eccode.cmd identity mismatch": old allow / new allow; `probe-regexes.out` ECCODE_WORD rows | Medium on Windows |
| R-4 | `RECORD_FILES` has no right anchor and the drafts exclusion needs a trailing separator: `.eccode/reviews/drafts` (the directory) is matched as record, so `cp a.json .eccode/reviews/drafts` is denied for a reviewer (false positive, fails closed). `.eccode/state.json.` is matched, which is correct on NTFS (trailing dots are stripped) — my probe expectation was wrong there, the regex is right. | `probe-regexes.out` rows `.eccode/reviews/drafts` and `.eccode/state.json.` | Low |
| R-5 | `SHELL_WRITE` uses `RECORD_AREA` without a left anchor: `echo x > my.eccode/state.json` is denied (false positive). `RECORD_FILES` itself is anchored. | `probe-regexes.out` row `my.eccode/state.json` | Negligible |

## Item-by-item

### 1. Regex changes (RECORD_AREA, RECORD_FILES, ECCODE_WORD)

`probe-regexes.js` → `probe-regexes.out`: 42 `RECORD_FILES` strings, 23 `SHELL_WRITE` (raw-command) strings, 25 `ECCODE_WORD` strings, each tagged with my expectation.

- False negatives (record write not matched): none among literal record paths — mixed separators, doubled and quadrupled backslashes, UNC `\\server\share\.eccode\state.json`, `~/.eccode/memory/...`, `$HOME\.eccode\...`, `%USERPROFILE%\.eccode\...`, a quoted path with spaces, `.\.eccode\state.json` are all matched. Not matched, by design of a literal regex: URL-encoded `.eccode%2Fstate.json` (not a real path to the shell), uppercase `.ECCODE/...` (R-2), normalised forms `.eccode/./state.json`, `.eccode/drafts/../state.json`, `.eccode/drafts/.\./state.json` (R-1 for the main session; F-1 for roles on Windows).
- False positives: `.eccode/drafts/`, `.eccode\drafts\`, `.eccode/reviews/drafts/` with either separator, `.eccode/artifacts/`, `src/eccode/`, `.eccodex/`, `.eccode-backup/`, `my.eccode/` (RECORD_FILES) are all correctly not matched. `.eccode/reviews/drafts` without trailing separator and `my.eccode/state.json` through `SHELL_WRITE` are the two (pre-existing) false positives, both failing closed.
- `ECCODE_WORD` matches `eccode`, `eccode.js`, `bin/eccode.js`, `C:\proj\.claude\eccode\bin\eccode.js`, `C:/proj/bin/eccode.js`, `\\server\share\eccode`; does not match `myeccode.js`, `eccodex`, `eccode-cli`, `src/eccode/index.js`, nor (R-3) `eccode.cmd`, `eccode.ps1`, `eccode.exe`, nor uppercase forms.
- The probe exits 1 because of my one wrong expectation (`.eccode/state.json.`), see R-4.

### 2. The win32 tokenizer branch

`probe-tokenizer.js` → `probe-tokenizer.out` (0 unexpected results). With `__setPlatform('win32')`: `a\ b` → `a b`; `\"` → `"`; `\$HOME` → `$HOME`, not dynamic; `\\` → one literal backslash; `\`+newline → continuation; `\;`, `\|`, `\&`, `\'`, `\#`, `\>` → literal; double and single quoting unchanged; a quoted path with an embedded space stays one word. `cd C:\x && echo y > C:\z\file` → `[['cd','C:\x'],['echo','y','>','C:\z\file']]`, and `path.win32.isAbsolute('C:\...')` is true (`node -e` check in this review's transcript). `\\server\share\...` collapses the leading pair to one (bash would too); the raw regex catches the record name anyway.

Hiding a record write: `echo x > .eccode\\state.json`, `$HOME\.eccode\...`, `%USERPROFILE%\.eccode\...`, a quoted path with a space, UNC — all denied by the raw regex in `old`? No: all were allowed or denied-for-the-wrong-reason on `5da8913` and are denied as record writes on `cde0b84` (see `probe-hook.out`, rows 1–2, 4–5, 13–16). `echo x > .eccode/./state.json` for roles: denied old and new (path resolution); for the main session allowed old and new (R-1). The one **new** escape is F-1.

Classification: F-1 new; everything else in the hook probe is either fixed by this commit or pre-existing (R-1..R-5), as the old/new columns show.

### 3. Tests and validate

Run from a `git archive cde0b84` export (see "Environment note"), without inline `ECCODE_TEST=1` on the command line (the session's own PreToolUse guard denies that form, which is item 4's existing behaviour observed live; the test files set `ECCODE_TEST` in the environments they spawn where they need it):

```
node --test tests/review-F9-win32-guard.test.js tests/review-F4-F5-guard.test.js tests/hooks-install.test.js tests/redteam-regressions.test.js tests/security-regressions.test.js
# tests 67 / # pass 67 / # fail 0 / # skipped 0        (tests.out; F9 tests are 31–34)
npm run validate
Toolkit validation passed: 12 agents, 7 skills, 7 commands, hooks wired, package 0.3.0 (295 files).   (validate.out; exit 0)
```

### 4. The platform override cannot be used by an agent

- `ECCODE_GUARD_PLATFORM=win32` in the hook's environment without `ECCODE_TEST=1`: ignored. Evidence: `probe-hook.out` last block, the deny reason quotes the POSIX reading `"C:Usersm…"`, the same as `ECCODE_GUARD_PLATFORM=linux ECCODE_TEST=1`; with `ECCODE_TEST=1` it quotes `"C:\Users…"`. An agent cannot set the hook process's environment anyway; inline is the only vector, and:
- Inline `ECCODE_TEST=1 eccode ...` and `ECCODE_TEST=1 ECCODE_GUARD_PLATFORM=linux eccode ...` are denied by old and new ("ECCODE_ACTOR / ECCODE_TEST / ECCODE_NOW may not be set inline"). Observed live twice in this session: my own `ECCODE_TEST=1 node --test ...` and a `grep -n "ECCODE_TEST" ...` command were denied by the repository's guard hook.
- The test's own assertion for this is vacuous (F-2); the probe above is the non-vacuous form.

### 5. "Fails closed" and the Windows CI job

- The claim: true for the regex part (every literal `.eccode\<record>` is denied, even where Git Bash would write a file of a different name); false for the tokenizer part (F-1). The commit also states a premise worth making explicit: the Bash tool on Windows runs Git Bash, so the shell *does* apply POSIX escaping to `C:\Users\me\x.json`; the native-path forms the tests feed are a fixture choice (`os.tmpdir()` unquoted), not what the shell would open. Denying them is still the right conservative answer.
- Test 131 (`cd /tmp && echo x > C:\Users\RUNNER~1\AppData\Local\Temp\eccode-outside-X\notes.txt`, reviewer, expect `null`): on the runner `process.platform === 'win32'`, every `\` is followed by a path character (`U`, `R`, `A`, `L`, `T`, `e`, `n`), the word survives intact, `path.win32.isAbsolute` is true (checked), so the "relative after cd" branch is skipped; `path.win32.relative(root, target)` is `../eccode-outside-X/notes.txt` → outside the project → no decision. The remaining sub-cases of 131 contain no backslashes and passed on `5da8913`. Expected: pass.
- Test 133 (`echo "{}" > C:\...\eccode-home-X\.eccode\memory\records\mem-sd-x.json` from main, expect deny): `SHELL_WRITE` matches `> ... \.eccode\memory\` on the raw command before any tokenizing; platform-independent, shown by `probe-hook.out` row 1 (`old: allow`, `new: deny`). The sub-cases after the one that threw on `5da8913` never ran there; reasoned through for win32: `cp`, `sed -i`, `rm` → raw regex; `node -e` / `python3 -c` → `RECORD_AREA` + `CODE_WRITE` on the raw command; `echo x > <home>\notes.md` for a reviewer → absolute, outside, and the `eccode-home-` substring triggers `eccodeActors`, which finds no `eccode` command word → allowed; `cat <memory>` → no write verb → allowed. Expected: pass.
- Other previously passing tests under the new tokenizer on Windows: the only guard test feeding `\`+path-character is `tests/hooks-install.test.js:142` (`--act''or us\er`); on win32 the actor reads `us\er` and is denied as "must be a literal role name" instead of "reserved for a person" — the test asserts only `'deny'`, so it still passes (verified under the override in this review's transcript).
- This cannot be confirmed without a Windows run; the job is `continue-on-error: true` and should stay so until it has passed on the runner. Nothing in this commit touches the engine, so the other 231 Windows results should be unchanged.

## Exact commands run and results

All from `/home/user/ECCode` unless noted; `$S` = `/tmp/claude-0/-home-user-ECCode/f72396f5-b89f-576d-a680-29d481cd71c9/scratchpad/cde0b84`.

1. `git show cde0b84 --stat`; `git show cde0b84 -- scripts/hooks/guard.js`; read `tests/review-F9-win32-guard.test.js`, `tests/review-F4-F5-guard.test.js:139-215`, `docs/evidence/verification-0.3.0/windows-ci-5da8913.md`, `.github/workflows/ci.yml`, `lib/util.js` (`toPosix`), `hooks/hooks.json`.
2. `git archive cde0b84 | tar -x -C $S`; `git show 5da8913:scripts/hooks/guard.js > $S/scripts/hooks/guard-old.js`; verified `git rev-parse cde0b84:scripts/hooks/guard.js` = `810cb98…` (the blob the export holds).
3. `cd $S && node docs/evidence/verification-0.3.0/guard-win32-review/probe-regexes.js` → `probe-regexes.out`, exit 1 (one wrong expectation of mine, R-4).
4. `cd $S && node .../probe-tokenizer.js` → `probe-tokenizer.out`, exit 0, three mismatches reported (F-1).
5. `cd $S && node .../probe-hook.js` → `probe-hook.out`, 30 cases × {old, new, new/win32} + the override block.
6. `cd $S && node --test <5 files>` → `tests.out`: 67/67 pass.
7. `cd $S && npm run validate` → `validate.out`: passed.
8. `node -e` with `path.win32` for the CI-131 target (`isAbsolute` kept: true; stripped: false; relative from project: `../eccode-outside-BFDuvI/notes.txt`), for `.eccode\drafts\a.json` (→ `.eccode/drafts/a.json`) and for the `.\.` targets (→ `.eccode/drafts/state.json`, `.eccode/drafts/src/server.js`).
9. `node -e` running the `cde0b84` guard on `hooks-install.test.js:142`'s command under linux and under the win32 override (reasons: "reserved for a person at a terminal" vs "must be a literal role name").
10. Temporary `scripts/hooks/guard-old.js` in the shared tree: created, used for the first probe run, deleted (`git status --short scripts/` clean).

## Environment note (affects how to read the evidence files)

While this review was running, the shared checkout was switched from `eccode/win32-guard-paths` (at `cde0b84`) to `claude/serene-heisenberg-h9o5vo` by the other session, which then made commits `84a670b`, `8998270` and `cb7ce98` there; those commits swept the then-untracked `probe-*.js`, `probe-*.out`, `validate.out` and `tests.out` from this directory into its tree (at the time of writing only `REVIEW.md` is untracked; `git ls-files` of this directory lists the other eight). The first test run I made (16:18) executed against the `5da8913` guard with no F9 file and was discarded. Every result cited above was regenerated from the `git archive cde0b84` export, and the `.out` files in this directory were overwritten with those runs before they were committed by the other session; a masked comparison (`compare-outs.js` in my scratchpad: temp-directory names and the validate file count masked) shows the committed `probe-regexes.out`, `probe-tokenizer.out`, `probe-hook.out` and `validate.out` identical to the regenerated ones. The modified tracked files that `git status` shows under `docs/evidence/verification-0.3.0/probes/`, `.../results/` and `examples/rescuestock/.eccode/` belong to the other session's concurrent work; this review did not open or edit them. No tracked file was edited by this review; the temporary `scripts/hooks/guard-old.js` was deleted.

---

# Re-review of 4fc7e87 (branch `eccode/win32-guard-paths`, worktree in the reviewer's scratchpad `repair/`)

- Commit: `4fc7e87fc30853c2ee037f457c804f5381f44df9` — "Guard: keep POSIX tokenizing on every platform; the Windows repair is the raw-command record check and the CLI word pattern (review F-1)". Parent: `cde0b84`. `guard.js` blob `06a0634`.
- Change: the win32 tokenizer branch, `WIN_PATH_CHAR`, the platform variable, `ECCODE_GUARD_PLATFORM` and `__setPlatform` are removed; `splitCommands` is the `5da8913` tokenizer again. Kept: `RECORD_AREA`/`RECORD_FILES` with both separators applied to the raw command, `ECCODE_WORD` with both separators, the module export for tests. `tests/review-F4-F5-guard.test.js` quotes the absolute path of the "cd then absolute write outside" case. `tests/review-F9-win32-guard.test.js` rewritten (4 tests): the dot-backslash-dot cases are pinned as denials, POSIX tokenizing asserted, actor binding by a quoted Windows path through the hook, an unquoted Windows path asserted as "not an invocation".

## Verdict: approve

F-1 is closed by removing its cause rather than patching around it: the guard again reads a command exactly as the shell behind the Bash tool does on every platform, so the file the guard judges is the file bash opens. F-2 is moot (the override no longer exists) and F-3 is corrected in the message and the code comment. No new escape found; the earlier good cases hold. No blocking finding remains.

## (1) Hook probe re-run — `probe-hook-4fc7e87.out` (same 30 cases; `old` = 5da8913, `new` = 4fc7e87; the `new/win32` column is now identical to `new` because the override is gone)

F-1 cases, denied again, with the same reason as the parent commit:

```
# drafts/.\. to record (Git Bash reads .\. as ..), reviewer      new: deny: .eccode/state.json is part of the ECCode record ...
# drafts/.\. to record, backend-engineer                         new: deny: .eccode/state.json is part of the ECCode record ...
# drafts/.\./.\. to src/server.js, reviewer                      new: deny: technical-reviewer reviews/designs but does not edit project files ...
```

Earlier good cases still hold (old → new): Windows-path memory write from main and from a reviewer: allow → deny (record); doubled separator `.eccode\\state.json`: deny; `$HOME\.eccode\...`, `%USERPROFILE%\.eccode\...`, a quoted path with a space, UNC: all deny as record writes (old denied them for ownership reasons or allowed them from main); `cat C:\...\records\x.json`: allow; `echo \$x > .eccode/drafts/a.txt`: allow; inline `ECCODE_TEST=1`: deny; `echo x > src/ser\ ver.js` (reviewer): deny. The two cases that read differently from cde0b84 are both correct under Git Bash: `echo x > .eccode\drafts\a.json` (reviewer) is denied, since bash writes `.eccodedraftsa.json` at the project root, not a draft; `node C:\proj\.claude\eccode\bin\eccode.js ... --actor user` unquoted is allowed, since bash would run `C:proj.claudeeccodebineccode.js`, which does not exist (the quoted form is denied: F9 test 33, and `probe-tokenizer-4fc7e87.out` shows the quoted word intact). Pre-existing residuals R-1..R-5 are unchanged and out of this commit's scope.

Tokenizer (`probe-tokenizer-4fc7e87.js` → `.out`): `.eccode/drafts/.\./state.json` → `.eccode/drafts/../state.json` → `.eccode/state.json` under both `path.win32` and `path.posix`; the other two F-1 strings resolve to `src/server.js` and `src/core/x.js` under both. `a\ b`, `\$x` (not dynamic), `\\`, line continuation and `\;` behave as bash. `__setPlatform` is no longer exported. Regex probe (`probe-regexes-4fc7e87.out`): 89 of 90 rows as expected; the one `FAIL` is the reviewer's own wrong expectation on `.eccode/state.json.` (R-4), unchanged from the first review.

## (2) Tests and validate in the 4fc7e87 worktree — `tests-4fc7e87.out`, `validate-4fc7e87.out`

```
node --test tests/review-F9-win32-guard.test.js tests/review-F4-F5-guard.test.js tests/hooks-install.test.js tests/redteam-regressions.test.js tests/security-regressions.test.js
# tests 67 / # pass 67 / # fail 0 / # skipped 0   (F9 = tests 31–34)
npm run validate
Toolkit validation passed: 12 agents, 7 skills, 7 commands, hooks wired, package 0.3.0 (291 files).   exit 0
```

## (3) Windows CI tests 131 and 133, reasoned for the runner (not run)

- 133 (`echo "{}" > C:\...\eccode-home-X\.eccode\memory\records\mem-sd-x.json`, every context): `SHELL_WRITE` matches `> ... \.eccode\memory\` on the raw command before tokenizing; platform-independent, shown by the probe (`old: allow`, `new: deny`). Of the sub-cases that never ran on 5da8913: `cp`, `sed -i`, `rm`, `node -e`, `python3 -c` are raw-regex / `CODE_WRITE` denials; `cat <memory>` is allowed; the reviewer's `echo x > <home>\notes.md` is unquoted, so it tokenizes to `C:UsersRUNNER~1...notes.md`, there is no `cd`, and `path.win32.resolve(cwd, 'C:Users...')` treats it as drive-relative, resolved against the process's current directory on `C:` rather than the hook `cwd` (the temp project). That lands outside the project and is allowed, which the test expects. This is the one assertion whose outcome depends on `path.win32`'s drive-relative handling on the runner; I rate a failure there unlikely (the resolved path would have to fall under the temp project directory, which is not the process cwd) but it is the assertion the Windows run has yet to show. Expected overall: pass.
- 131, the formerly failing sub-case now `cd /tmp && echo x > "C:\Users\RUNNER~1\...\eccode-outside-X\notes.txt"`: double quotes keep the backslashes (tokenizer probe), `path.win32.isAbsolute` is true, `path.win32.relative(project, target)` is `../eccode-outside-X/notes.txt` → outside the project → no decision; the `eccode-outside` substring triggers `eccodeActors`, which finds no CLI word (`ECCODE_WORD` false on the target, actors `[]`, problems `[]`). The other seven sub-cases contain no backslashes and passed on 5da8913. Expected: pass. The test's new comment is right about the shell: unquoted, Git Bash would open `C:UsersRUNNER~1...notes.txt`, a relative name, so the old expectation was wrong for Windows.
- `tests/hooks-install.test.js:142` (`--act''or us\er`) is back to the POSIX reading (`user` → "reserved for a person"), as on 5da8913.
- Cannot be confirmed without a Windows run; keep the job `continue-on-error` until it passes.

## (4) Files added by this re-review

`probe-hook-4fc7e87.out`, `probe-regexes-4fc7e87.out`, `probe-tokenizer-4fc7e87.js`, `probe-tokenizer-4fc7e87.out`, `tests-4fc7e87.out`, `validate-4fc7e87.out`, and this section. The first-review probe scripts were copied into the worktree for the run and removed afterwards together with the temporary `guard-old.js` copy there. No branch was switched in `/home/user/ECCode`; no tracked file was edited.
