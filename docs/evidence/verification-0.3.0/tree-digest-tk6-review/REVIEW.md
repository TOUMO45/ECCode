# Independent review: TK-6 nested-project tree digest repair (commit cb73d42, 0.3.4)

Reviewed: `cb73d42` on `worktree-agent-a24e7b0bc6643d426` (worktree
`/home/user/ECCode/.claude/worktrees/agent-a24e7b0bc6643d426`) against its parent `220d3fa`
(0.3.3; its `lib/project.js` is byte-identical to the main tree's HEAD). I did not write the change.
git 2.43.0, Node 22.22.0, Linux. Probes and logs are in this directory (`probe*.js`, `probe*.out`,
`summary.txt`, `probe-results.json`, `npm-test.log`). Scratch copies: `base/` (cb73d42's lib and tests
with the parent's `lib/project.js`) and `fix/` (cb73d42 as committed). Nothing in the repository, the
worktree, `examples/rescuestock/**` or any `.eccode/` directory was modified; the pilot record was
read only through git objects (`git show 220d3fa:…`).

## Decision: changes required

The code change is correct for the defect it targets. On 92 digest comparisons in `probe.js` plus 7 in `probe2.js` (nested, nested under a
unicode/space/leading-dash directory, root, linked worktree, symlinked project, renames, copies,
deletions, staged-only, `MM`, untracked trees, record and record-like directories) the fixed
`treeDigest` equals an independent oracle (`git hash-object -- <path>` per working-tree file) in all
82 regular rows of `probe.js`; the 10 rows that differ are edge inputs that differ identically on
0.3.3 (F3, F4, F6), plus the new trailing-space case of F3, and on a root-level project it is byte-identical to 0.3.3 in
all 24 root cases (23 + a linked-worktree root) where 0.3.3 returned a digest. The new tests fail 3/4 on the parent and pass 4/4 on
the fix; the suite is 278/278.

What blocks closing TK-6 is the account of its consequences and the silent failure mode, not the
patch. (F1) TK-6 also dropped `commit` from every pilot submission (19/19), which switches off R30's
release-tree diff for every gate the pilot has approved, and neither the CHANGELOG nor residual 16 says
so; the final handoff's release sentence would over-claim for this project. (F2) Null still means
"pinning off, say nothing", and the fix leaves several reachable null (and one wrong-bytes) inputs
(F3, F4). A warning on a null digest inside a git repository is a few lines and is what would have
caught TK-6 at run 1 instead of run 448. F3–F5 are small; the rest is information.

## Findings

### F1 — Major — CHANGELOG and residual 16 understate TK-6: R30's release-tree check is off for the whole pilot

- Where: `lib/gates.js:186-188` (`const tree = commit ? treeDigest(...) : null; if (commit && tree)
  Object.assign(extra, { commit, tree })` — a null digest drops the commit too);
  `lib/delivery.js` `releaseTreeChanges` (baseline = the earliest approved submission *with a commit*;
  "Records whose submissions carry no commit (older engines) are not judged"); `buildReport`
  ("Every file in it is either older than the first reviewed submission or was pinned by an approved
  review").
- Evidence (read from git objects at `220d3fa`): all 19 `gate.submitted` events lack `commit` and
  `tree`; `state.json` shows architecture, design, plan, b-foundation, c-core-flow, d-extraction,
  rework-1..3 approved, every approved submission without `commit`. Today `releaseTreeChanges`
  returns `[]` for the pilot. After 0.3.4 the baseline becomes the first approved submission recorded
  on 0.3.4, so a file changed after the 0.3.3-era approvals and before that baseline, and not pinned
  as an artifact, is never reported, and the delivery report's release sentence is false for it.
- The CHANGELOG mentions "the submission without commit and tree" but frames the effect only as R28
  ("the completion and review stale checks compared nothing"); residual 16 likewise. R30 in the
  threat model still says "every submission records its commit and tree".
- Resolution: CHANGELOG 0.3.4 "Records already written" and residual 16 state the R30 consequence
  (19/19 pilot submissions without commit; R30's git diff has no baseline for the approved gates), and
  the pilot report records it. Preferably also in code (may be a follow-up): when git is available,
  `unreviewedChanges` reports an approved submission without `commit` (as it already does for a
  baseline git does not know) instead of skipping it silently, or `buildReport` qualifies its release
  sentence.

### F2 — Major — a null digest still turns pinning off silently (residual 16); recommend a warning now, a refusal for new submissions

- Where: `lib/evidence.js:96-97` (`if (tree) data.tree = tree`), `lib/gates.js:187-188`,
  `lib/gates.js:521-522` and `lib/tasks.js:405-406` (`const stale = tree ? … : []` and
  `e.tree && e.tree !== tree`).
- Evidence: the pilot ran 327 of 448 checks and all 19 submissions unpinned with nothing printed;
  F3/F4 show null is still reachable on 0.3.4 (a repository directory whose name ends in a space; a
  file or directory name containing a newline, ending in CR, or a nested project under a directory
  starting with `"`). `treeDigest` also cannot tell "no git" (legitimately unpinned) from "git failed"
  (a defect).
- Recommendation: (a) required before TK-6 is closed: when `gitHead(root)` is non-null and
  `treeDigest` is null, `evidence run` and `gate submit` print a warning naming the effect ("tree
  pinning is off for this run/submission") and record a marker (e.g. `treeUnavailable: true`), so
  the gap is visible in the record and in `eccode status`/`audit`; (b) follow-up: `gate submit`
  refuses in that state (it also disables R30, F1), and completion/review refuse to cite a run
  marked `treeUnavailable` while the current digest is available ("re-run it"). Records without the
  marker (older than the change) keep being skipped, so replay is unchanged. Severity Major: a
  fail-open in an integrity control that hid a defect for an entire pilot.

### F3 — Minor — `--show-toplevel` and `--show-prefix` are trimmed: wrong digest or another repository's bytes

- Where: `lib/project.js:136-137` (`git(root, ['rev-parse', …])` with the default `trim: true`), new
  in this commit for `top`; the prefix trim pre-exists (and `lib/delivery.js:54` has the same).
- Evidence (`probe2.out`, `summary.txt`):
  - repository directory `top-trailing ` (trailing space): `show-toplevel` is `".../top-trailing \n"`,
    trimmed to `.../top-trailing`; the fix's `hash-object` runs in a directory that does not exist →
    null (base: null too). With a sibling repository named `top-trailing` holding
    `nested/app/src/main.js`, the fix returns a non-null digest computed over **that repository's**
    bytes (`fix=fd55e49993`, oracle `dbee399c86`) — the TK-6 defect class, reintroduced by the new
    `top` call.
  - project under a top-level directory ` lead space/` (leading space): the prefix is trimmed to
    `lead space/app/`, no status path matches it, the dirty edit is ignored and the digest equals
    the clean one (base and fix alike): a stale check would pass as current.
- Resolution: call both with `{ trim: false }` and strip exactly one trailing `\n`; add one test with
  a trailing-space repository directory. (Exotic names, hence Minor; the fix is one line.)

### F4 — Minor — the newline-delimited `--stdin-paths` protocol mis-reads some names (pre-existing, partly improved)

- Where: `lib/project.js:173-174`.
- Evidence (`summary.txt`, rows "ROOT:"/"NESTED:"): `hash-object --stdin-paths` reads one path per
  line, strips a CR before LF, and C-unquotes any line beginning with `"`. On both 0.3.3 and 0.3.4:
  a name containing a newline → null; a name ending in CR → null; a root-project file named
  `"bad` → null ("badly quoted"); a root-project file named `"a.txt"` → hashed as `a.txt`, so edits
  of `"a.txt"` do not move the digest (wrong, non-null). A nested project under a directory beginning
  with `"` → null. The fix improves one case: inside a nested project the repository prefix means a
  project file named `"q.txt"` no longer starts the line, so it is now hashed correctly.
- Resolution: C-quote every line (`"` + escape `\\`, `"`, `\n`, `\r`, `\t` and non-printables +
  `"`); hash-object unquotes it. Verified by hand: quoted lines for `x<LF>y`, `tr<CR>` and `"a.txt"`
  give the same blob ids as `git hash-object -- <path>`. This also closes F3's prefix-starting-with-`"`
  case.

### F5 — Minor — the regression test misses the nested cases where 0.3.3 produced a wrong non-null digest via other status codes

- Evidence (`summary.txt`, nested rows): 0.3.3 gave a non-null **wrong** digest for `git rm --cached`
  (`D ` + `??`), a staged delete beside a twin, and `MM` on a twin, and null for `RM`/`CM`. The new
  file covers modified/untracked/twin/`.eccode`, not renames, copies, deletions or `MM` on a nested
  project, nor a linked worktree. The fix handles all of them (oracle-equal).
- Resolution (optional): add a nested `RM` + `MM` + deleted case and a `git worktree add` case to
  `tests/tree-digest-nested.test.js`.

### F6 — Info (pre-existing, outside TK-6) — bytes the digest does not see

Same on 0.3.3 and 0.3.4; listed so residual 16 or R28 can name them:
- `git update-index --assume-unchanged` or `--skip-worktree` on a file, then edit it: status does not
  report it, the index blob is used, the digest is unchanged (`summary.txt`, "fix unchanged despite
  new bytes: true"). A deliberate actor (A1) can make a stale check look current with one command.
- A project inside a gitignored directory: the digest is `sha256("")` and constant across edits.
- Submodules: a clean submodule contributes its gitlink commit id; a dirty one is dropped entirely;
  submodule contents are never hashed.
- A tracked symlink: the index has the link-text blob, a dirty one is hashed as its target's content.
Resolution: name these in R28/residual 16 (and consider `ls-files -v` to detect `h`/`S` flags and
refuse); not required for this commit.

### F7 — Info (out of scope, found in passing) — `gitChangedFiles` returns C-quoted paths for non-ASCII names

- Where: `lib/project.js:113-114` (`diff --name-only` and `ls-files --others` without `-z`).
  Its path *relativity* is correct for nested projects (`--relative`, cwd-relative `ls-files`), so it
  does not share the `--stdin-paths` assumption; no other function in `lib/` or `bin/` uses
  `--stdin-paths` or `hash-object` (grep of `stdin-paths|hash-object|ls-files|show-prefix|show-toplevel`).
- Evidence (`probe3.out`): `["plain.js","\"src/\\303\\274.js\"","\"src/n\\303\\251 w.js\""]`.
  Completion compares these to handoff paths and ownership globs (`lib/tasks.js:413-424`): a declared
  unicode file is refused as "unchanged since claim", and an undeclared one inside ownership is not
  flagged (fail-open). Resolution: use `-z` (as `lib/delivery.js` does); queue separately.

### F8 — Info — what checks out

- Correctness: `status --porcelain -z` paths are repository-relative and unquoted with `-z` (tab,
  backslash, inner `"`, unicode, spaces all arrive raw; confirmed by oracle equality); `R`/`C` entries
  consume the second field correctly (`C ` and `CM` produced with `status.renames=copies`); deletions
  drop the path; `M ` keeps the index blob; `MM` re-hashes; `--untracked-files=all` lists files in
  untracked trees; top-level `.eccode/` is skipped while `.eccode-x/` and `sub/.eccode/` count;
  linked worktree: `--show-toplevel` is the linked worktree's root, edits in the main working tree do
  not move it; project reached through a symlink (to the project, or to the repository) gives the
  real-path digest; nested `.gitattributes` (`text eol=lf`) is applied by repository path.
- Root-level digest identical to 0.3.3: 23/23 root scenarios plus the linked-worktree root where
  0.3.3 returned a digest. The only root difference is where 0.3.3 returned null because of a record
  file (`probe4.out`: a `.eccode/drafts/` name with a newline nulled 0.3.3; 0.3.4 ignores it), the
  intended direction. The CHANGELOG's "same digest as on 0.3.3" holds in that sense.
- Callers (`grep -rn treeDigest lib bin`): `lib/evidence.js:96`, `lib/gates.js:187` and `:521`,
  `lib/tasks.js:405`, `lib/delivery.js:77` (`submissionTreeDigest`). The signature and null contract
  are unchanged; all callers already pass the project root.
- Docs: version 0.3.4 in `package.json`, `.claude-plugin/plugin.json` and `marketplace.json`, no
  other version strings; "327 of the 448 command runs carry no tree" verified from
  `220d3fa:examples/rescuestock/.eccode/events.jsonl` (448 command runs, 327 without `tree`); "3
  failed on 0.3.3, two null and one with the root twin's bytes" verified. The removed doc comment
  was a stale duplicate. The R28 mechanism column still reads as unconditional; append "(when a
  digest is available; residual 16)".

## What I ran

- `git show cb73d42` (full), parent `220d3fa`.
- `node --test base/tests/tree-digest-nested.test.js` → tests 4, pass 1, fail 3 (cases 1 and 4: null;
  case 2: `879fafa3…` vs expected `df70d96e…`). `node --test fix/tests/tree-digest-nested.test.js` →
  4/4 pass.
- `npm test` in the worktree root → tests 278, pass 278, fail 0, cancelled 0, skipped 0
  (112.6 s; `npm-test.log`). `git status --short` in the worktree empty before and after.
- `probe.js` (95 rows, 92 digest comparisons: base vs fix vs oracle) → `summary.txt`; `probe2.js` (copies, trailing-space
  top, `.gitattributes`); `probe3.js` (`gitChangedFiles` quoting); `probe4.js` (root record edge);
  a by-hand check that C-quoted `--stdin-paths` lines hash odd names correctly.
- Pilot record counts from git objects at `220d3fa` (events and state), read-only.

## What I did not test

- Windows (path separators in `prefix`, `\r\n` from git, command-line length) and macOS
  (case-insensitive file systems, NFD unicode normalisation: `ls-files` vs `status` vs the oracle
  could disagree on precomposed names).
- `treeDigest` on the real ECCode repository or the pilot directory (it would run `git status` over
  `examples/rescuestock`, which I was told not to touch; `git status` may also refresh the index).
- `GIT_DIR`/`GIT_WORK_TREE` set in the environment (e.g. from a git hook), sparse checkouts,
  `core.fsmonitor`, clean/smudge filter drivers, very large dirty sets (the `existing.includes`
  loop is O(n²); pre-existing).
- Concurrency (a dirty file deleted between `stat` and `hash-object` still nulls the digest).
