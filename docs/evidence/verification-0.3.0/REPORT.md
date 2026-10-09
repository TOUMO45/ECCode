# ECCode 0.3.0 — independent adversarial verification of the F1–F9 repairs

**Reviewer role:** independent of the authors of the repairs. I did not write any of the 0.3.0 code or tests; I read the review bundle, the threat model, the shipped regression tests and the engine sources, then wrote and ran my own probes.
**Date:** 2026-10-09.
**Verdict in one line:** the nine demonstrated bypasses of the review are refused on this commit, but the acceptance criteria of **F1, F2 and F4 as the review wrote them are not met**: my probes found three new bypasses the engine accepts (one per finding) that are cheap to exploit and that the shipped tests do not cover, plus a long tail of non-blocking variants and precisely confirmed residuals. No overblocking of a legitimate workflow was found.

## 1. Scope, environment, exact commit

| Item | Value |
|---|---|
| Repository | `/home/user/ECCode`, branch `claude/serene-heisenberg-h9o5vo` |
| Commit under review | `5da89130509204c34384936d6b82dd7e03c588c1` (version 0.3.0) |
| Commit at the end of the run | `cb7ce98443549f9b19e89822d6f477138a2f5855` — the branch head moved **during** this verification (three commits by the lead: a RescueStock pilot, a win32 guard change, and a snapshot of this directory). `git diff --quiet 5da8913 HEAD -- lib bin schemas` reports **no difference**: every engine probe below exercised byte-identical `lib/`, `bin/` and `schemas/`. The only engine-adjacent file that changed is `scripts/hooks/guard.js` (uncommitted when I started, committed later). The guard probes (F4, F5, F6) therefore run against a **pristine `git archive` snapshot of 5da8913** (`scratchpad/head-5da8913/scripts/hooks/guard.js`, verified identical to `git show 5da8913:scripts/hooks/guard.js`) and, for every F4 case, also against the working-tree guard; **no case was decided differently** by the two (`results/F4-…txt`: `workingTreeGuardDiffers: true`, differing cases `[]`). |
| Node | v22.22.0 |
| npm | 10.9.4 |
| git | 2.43.0 |
| OS | Ubuntu 24.04.5 LTS, Linux 6.18.44-fc-v80 x86_64 |
| Windows | **NOT RUN.** Nothing in this report verifies the Windows claims of 0.3.0. |
| Shipped suite | not re-run by me (the lead established 233 passing); I ran `tests/review-F9.test.js` alone (6/6, 0 skipped, upgrade/rollback included) because its skip conditions matter for F9. |

### How to reproduce

```
cd /path/to/ECCode            # at 5da8913 or any commit with identical lib/ bin/ schemas/
# the guard probes want a pristine copy of the committed guard; the default path is this session's scratchpad.
# To point them elsewhere: mkdir -p /tmp/head && git archive 5da8913 | tar -x -C /tmp/head && export ECCODE_HEAD_SNAPSHOT=/tmp/head
for p in docs/evidence/verification-0.3.0/probes/F*.js; do
  node "$p" > "docs/evidence/verification-0.3.0/results/$(basename "$p").txt" 2> "docs/evidence/verification-0.3.0/results/$(basename "$p").stderr.txt"
done
```

Each result file is a JSON document: `steps[]` with `id`, `description`, `expect`, `verdict` (`as-expected` / `UNEXPECTED` / `documented`), `classification` and the `observed` outcome (error code, message, guard decision, values). The `.stderr.txt` file is the one-line-per-step log. **Zero steps are `UNEXPECTED` in the final run**: every bypass that the engine accepts is recorded as a `documented` step whose `classification` starts with `NEW` or `RESIDUAL`, so the result files are self-judging. Do **not** prefix the probes with `ECCODE_TEST=1` from a Claude Code shell: the repository's own PreToolUse guard denies the inline assignment (by design, F5); the probes set the switch internally for the few CLI steps that need it. The probes need no network except F9, which uses `npm pack` and an `--offline` install of the resulting tarball.

The probes create throwaway projects under `os.tmpdir()` with `tests/helpers.js` (`tmpProject`, `initRepo`) and delete them. They never modify the repository. Nothing was committed by me (the lead's snapshot commit `cb7ce98` captured intermediate versions of some probe files; the final versions are the ones on disk and referenced here).

## 2. Verdict table

| Finding | Verdict | Demonstrated bypass of the review | New bypass found by this verification | Overblocking |
|---|---|---|---|---|
| F1 review coverage and anchors | **Not closed** (acceptance not met) | refused `REVIEW_REJECTED` | **Yes, 2** (one blocking) | none |
| F2 omitted / later-changed deliverable files | **Not closed** (acceptance not met) | refused `INVALID_HANDOFF` / `DELIVERY_BLOCKED` | **Yes, 2** (one blocking) | none |
| F3 evidence bound to check, tree and log | **Closed with residual** | refused `INVALID_HANDOFF` / `REVIEW_REJECTED` | 2 non-blocking (cwd unbound; dead `cwd` binding) | none |
| F4 reviewer writes through the shell | **Not closed** (a one-token redirect bypass) | refused `deny` (all ten probe cases) | **Yes, 1 blocking** (the noclobber redirect) + 10 non-blocking known-shape escapes | none |
| F5 agent as the human; release risk policy | **Closed with residual** | refused `USER_AUTH_REQUIRED` / `DELIVERY_BLOCKED` | 1 non-blocking guard gap (a wrapper hides the CLI word; identity binding) | none |
| F6 shared lesson attestation | **Closed with residual** | quarantined (`provisional`, exit 3 / audit exit 2) | 2 non-blocking (metadata outside the hash; inline shared-store redirect) | none |
| F7 corrupted snapshot drives a transition | **Closed with residual** (residual 3 confirmed precisely) | refused `SNAPSHOT_DIVERGED` | none new; residual 3 shown to also mint `user` events | none |
| F8 limits as runtime enforcement | **Closed** (within the declared scope) | n/a (no reproduction in the review) | none | none |
| F9 portability and release reproducibility | **Closed with residual** (Windows not run) | n/a | none; one hygiene note (the package ships 259 files of `docs/evidence/`) | none |

Blocking means: the acceptance sentence the review wrote for the finding is falsified by a reproduction that needs only the roles and tools the threat model already grants (a document author, a reviewer with Bash, a committed file), and the record then reads as clean (`eccode audit` OK, delivery produced).

## 3. Finding by finding

### F1 — reviews need not cover the agreed acceptance criteria

**Acceptance (review):** "omitting any mandatory criterion or citing an invalid section fails approval; complete, valid coverage passes."
**Required repair (review):** "persist immutable, versioned requirement IDs; derive each gate's mandatory coverage from the approved requirements and plan. Reject missing, duplicate, or unknown IDs. Validate cited sections where anchors are supported."

**Probe:** `probes/F1-coverage-variations.js` → `results/F1-coverage-variations.js.txt` (29 steps).

What holds (observed codes):

| Step | Outcome |
|---|---|
| `F1.table.required` | ids derived from a **Markdown table** under Acceptance Criteria: `["AC1","AC2"]` |
| `F1.table.attack` "the document has a title" + bogus anchor | `REVIEW_REJECTED` |
| `F1.lookalike.lowercase` `ac1`+`AC2` | `REVIEW_REJECTED` (AC1 missing; `ac1` is free-form) |
| `F1.lookalike.cyrillic` `АC1`+`AC2` | `REVIEW_REJECTED` |
| `F1.lookalike.ac01` `AC01`+`AC2` | `REVIEW_REJECTED` (unknown id of the AC family + AC1 missing) |
| `F1.duplicate` AC1 twice, AC2 omitted | `REVIEW_REJECTED` |
| `F1.table.legit` AC1+AC2 against the table brief | approved (no overblocking for tables) |
| `F1.reflow` brief reflowed after submission | `REVIEW_REJECTED` (artifact changed after submission); restored bytes → approved |
| `F1.plan.badpath` `#phases.9.goal`, `F1.plan.badphase` `phase:nope` | `REVIEW_REJECTED`; `#phases.0.goal` + `#tasks.api.verification` → approved |
| `F1.verification.omitAC2` | `REVIEW_REJECTED`; AC1+AC2 → approved |

**NEW-1 (BLOCKING): required ids are derived from the brief file as it is on disk NOW, not from the bytes the architecture approval pinned.** `lib/gates.js` `criteriaOf()` reads the approved submission's artifact path from disk; nothing compares the bytes with the pinned `sha256`. The developer README claims "Ids are persisted in the submitted artifact bytes the gate pins (hash)". They are pinned, but they are not what the design and verification gates use.

Reproduction (`F1.edited.*`): brief with AC1 and AC2 approved at architecture → a document author rewrites `brief.md` with AC1 only (the guard allows `technical-designer` to write under the artifacts area through the shell: `F1.edited.guard` = `allow`, and the shipped test "designer redirect into artifacts" asserts the same) → `requiredCriteria(design)` = `["AC1"]` → design approved covering AC1 only → plan, phase as usual → `unreviewedChanges` before verification does report `brief.md modified after approval (architecture)` → the delivery-lead lists the edited brief among the **verification** artifacts → `requiredCriteria(verification)` = `["AC1"]` → verification approved covering AC1 only → **`deliver()` succeeds** (release commit recorded) → **`eccode audit` exits 0: "Audit OK: 32 events, chain intact, approved artifacts unchanged."** AC2 was never covered by any gate after architecture, and the record says nothing about it.

Why blocking: the acceptance sentence is falsified with the normal roles (a document author plus two honest-but-literal reviewers who approve what `eccode gate show` lists). Fix shape: derive `criteriaOf` from the pinned content (store the criteria list in the `gate.submitted` event, or refuse to derive when the file's hash differs from the pin), and refuse a later submission that re-pins an artifact of an earlier approved gate unless that gate is reopened.

**NEW-2 (non-blocking): a brief whose acceptance criteria carry no ids has no required criteria, so the original F1 attack succeeds again.** `F1.noids.required` = `[]`; `F1.noids.attack` "the document has a title" citing `#Risks` → **approved**, gate status `approved`. `eccode gate show` prints "none derivable - the brief lists no criterion ids … add ids and resubmit", but the engine does not act on it (`recordReview` has no such refusal). The author controls whether the F1 control exists. Same for `F1.config.noheading.attack`: `review.criteriaSections.architecture: ["Definition of Done"]` (a heading the brief lacks) silently yields no coverage. Fix shape: refuse an architecture submission (or at least its approval) when the criteria section exists but yields no ids, and refuse approval when `criteriaSections` matches no heading.

Residual (documented, agreed): a criterion's meaning still needs judgement.

### F2 — an omitted or later-changed deliverable file escapes review and delivery

**Acceptance (review):** "omitted, newly added, deleted, renamed, or subsequently changed deliverable files block delivery until reviewed."

**Probe:** `probes/F2-release-tree-variations.js` → `results/F2-release-tree-variations.js.txt` (21 steps).

What holds: `F2.delete.undeclared` (owned file deleted during the claim, not declared) → `INVALID_HANDOFF`; declared → `done`; the phase submission pins the files that exist and delivery passes with the reviewed deletion (`F2.delete.deliver` ok, `unreviewedChanges` `[]`). `F2.userDirty.claim` → `DIRTY_OWNERSHIP`; committed by the user first → claim and completion pass (`F2.userCommitted.*`). `F2.ignore.*`: `dist/**` under `release.ignore` is invisible, `src/server/extra.js` untracked after approval → `DELIVERY_BLOCKED`, removed → delivered. No overblocking found in any of these.

**NEW-3 (BLOCKING): a file added and committed between the phase approval and the verification submission, listed by no gate, reaches the release; the audit says OK.** `lib/delivery.js` `releaseTreeChanges()` diffs the tree against the commit of the **last approved** gate's submission. Before the verification approval the file is reported (`F2.between.beforeVerification`: `src/server/backdoor.js added after approval (phase:core)`). Once verification is approved on a later commit the baseline moves to that commit and the file disappears (`F2.between.afterVerification`: `[]`). Nothing in `gates.submit` or `checkReview` for the verification gate consults `unreviewedChanges`, and the verification submission lists only what the delivery-lead names. Result: `deliver()` succeeds (`F2.between.deliver`), the release commit's tree contains `src/server/backdoor.js`, no approved submission pins it (`F2.between.pinned`: `pinned: false`), and `eccode audit` exits 0.

Why blocking: "newly added … deliverable files block delivery until reviewed" is falsified by a file that was committed by anyone with commit access (the orchestrator, the user, a CI bot, a compromised tool) in the window every delivery passes through. Fix shape: on a gate submission, refuse (or auto-pin) every file `unreviewedChanges` reports at that moment; or make `releaseTreeChanges` walk every approved gate's commit range, not only the last one.

**NEW-4 (non-blocking): the source path of a staged rename is never declared, pinned or reviewed.** `lib/project.js` `gitChangedFiles` runs `git diff --name-only <base>` without `--no-renames`; git ≥ 2.9 folds a staged rename into the new path only (`F2.rename.gitView`: `nameOnly: ["src/server/new.js"]`, `noRenames: ["src/server/new.js","src/server/old.js"]`). A handoff declaring only `src/server/new.js` after `git mv src/server/old.js src/server/new.js` is accepted (`F2.rename.newOnly`), the phase pins `new.js`, and the delivery passes while `old.js` silently left the tree (`F2.rename.deliver`). An unstaged rename (fs.rename) is caught as delete + untracked (shipped test). Fix shape: `--no-renames` (and `-M` only where a rename record is wanted).

Residual (documented): git-ignored files remain invisible (residual 6).

### F3 — passing evidence not bound to the required check or source version

**Acceptance (review):** "an unrelated success, obsolete source version, missing/tampered log, or missing required check cannot authorize completion."

**Probe:** `probes/F3-evidence-binding-variations.js` → `results/F3-evidence-binding-variations.js.txt` (14 steps).

| Step | Outcome |
|---|---|
| `F3.whitespace` declared command with extra blanks | accepted (no overblocking) |
| `F3.log.newline` one newline appended to the log | `INVALID_HANDOFF` (`logFileSha256`) |
| `F3.tree.editAfterCheck` check before the last edit | `INVALID_HANDOFF` ("ran on different bytes") |
| `F3.reviewer.citesImplementer` reviewer cites the implementer's post-submission run | `REVIEW_REJECTED` |
| `F3.reviewer.unrelatedOnly` reviewer's own unrelated passing run | `REVIEW_REJECTED` (missing the declared command) |
| `F3.reviewer.declaredOnly` reviewer's run of the api command only | `REVIEW_REJECTED` — correct: the other two tasks declare the helper's default command, and every declared command must be cited |
| `F3.reviewer.declared` reviewer's runs of every declared command | approved (no overblocking) |
| `F3.taskId` evidence recorded with `--task ui` cited for task `api` | accepted — the task id on evidence is informational; the binding is command + actor + time + tree. Not a defect, stated so nobody relies on `--task` |
| `F3.methodOnly` | any passing check by the owner completes a method-only task (documented rule in CHANGELOG; the plan reviewer must insist on a command) |

**NEW-5 (non-blocking): the working directory of a declared check is never bound.** `tasks.matchesVerification` compares the cwd only when the task declares one, and **the plan schema refuses `verification.cwd`** (`F3.cwd.schema`: `INVALID_PLAN: $.tasks[0].verification.cwd: unknown property`), so no task can declare one: the engine's cwd branch (`F3.cwd.matchesVerification`: `atRoot: false, inCwd: true` on a synthetic object) is dead code. Consequence (`F3.cwd.undeclared`): the same command string run with `--cwd src/server` satisfies the declared check; `npm test` run in a subdirectory with its own `package.json` is "the declared command". Fix shape: default the declared cwd to `.` and require `ev.cwd === '.'` when none is declared; add `cwd` to the schema if the feature is meant to exist.

Residual (documented by the developer: "not done: binding to … the environment"): `F3.env.forced` — a declared `node -e "process.exit(process.env.FORCE_OK ? 0 : 1)"` fails honestly and passes with `FORCE_OK=1` exported in the runner's environment; the record captures no environment, and the guard denies only inline `ECCODE_*` assignments. Confirmed, not new.

### F4 — reviewer write restrictions bypassed through the shell

**Acceptance (review):** "equivalent writes through direct tools, shell redirects, scripts, interpreters, or alternate paths have the same authorization outcome."
**Developer's own claim (README):** "Partly: equivalent writes through direct tools, redirects and inline interpreters now get the same answer; a script file the guard cannot see into still escapes (residual 1)."

**Probe:** `probes/F4-guard-shell-variations.js` → `results/F4-guard-shell-variations.js.txt` (63 cases, fed to the guard as PreToolUse JSON; nothing executed; `F4.untouched` confirms the file is unchanged). Decisions of the 5da8913 guard; the working-tree guard agreed on all 63.

Denied as expected (reviewer unless noted): `printf` redirect, heredoc redirect, `sh -c` and `bash -c` with a redirect inside, `cp` into `.claude/` (reviewer and implementer), `ln -s` into the evidence directory, `cd src` then a relative redirect, `env VAR=1 node -e` with a file-writing API, `xargs -I{} sh -c` with a redirect, python heredoc, `git stash`, `mkdir` then a redirect, `tee -a`, `exec 3>`, `&>`, `2>`, a variable target (`f=…; echo > $f`, fail closed), `perl -pi`, `sed -i.bak`, `rsync`, `install`, `node -e` with `execSync` of a redirect, python `pathlib.write_text`, ruby `File.open(…,'w')`, `eccode evidence run -- '<redirect>'`, a write into another project's record, a write to an **existing** symlink under the reviewer's draft area that points at `src/server.js`; implementer `mv` out of the ownership, implementer redirect outside the ownership, main-session write to the record. Allowed as expected: scratch writes outside the project, `eccode evidence run -- npm test`, the main session writing sources, an implementer writing inside its claim.

**NEW-6 (BLOCKING): the `>|` redirect operator is invisible to the guard.** `splitCommands` ends a command at `|`, so `>|` becomes a bare `>` with no following word and no target is recorded. `echo x >| src/server.js` by a reviewer → `allow` (`F4.clobber`); `1>|` (`F4.clobber-fd`), `cat a.js >| src/server.js` (`F4.clobber-cp`) and an implementer writing outside its ownership with `>|` (`F4.clobber-impl-outside`) → all `allow`. `>|` is a standard bash redirection (the noclobber override) and writes exactly like `>`. One token, every role, no setup. This falsifies "redirects … get the same answer as the Edit tool". Fix shape: tokenize `>|` as one operator before splitting on `|`.

Non-blocking NEW escapes, all known-shape commands the guard could recognise (the developer's residual 1 concedes "a program it cannot read"; these are not programs):

| Case | Decision | Note |
|---|---|---|
| `rm src/server.js`, `rm -rf src` (reviewer), `rm src/web/x.js` (implementer outside ownership) | allow | deletion is a mutation; `rm` is matched only against the record area |
| `git rm -q src/server.js` | allow | only a whole-tree `git rm` is denied |
| `git checkout -- src/server.js` (reviewer) | allow | the guard's own message suggests it; for a reviewer it is still a tree mutation |
| `git apply <patch>`, `patch -p1 < <patch>`, `git am <patch>` (reviewer and implementer) | allow | a patch file is content the guard cannot see, like a script, but the verbs are known |
| `find src -name '*.js' -exec sed -i s/a/b/ {} \;` | allow | the command word is `find`; `-exec` is not walked |
| `ls src/*.js \| xargs sed -i s/a/b/` | allow | files on stdin; no positional |
| `curl -sSo src/server.js …`, `wget -qO src/server.js …`, `tar -xf … -C src` | allow | download / extraction into the tree |
| `node -e` with `openSync('src/server.js','w')` | allow | `openSync(…,'w')` truncates; the inline-code pattern matches `open(` but not `openSync(` |
| `echo x > /tmp/…/link-into-project.js` where that path is a symlink into `src/server.js` (reviewer and implementer) | allow | an absolute target outside the project is skipped **before** any `realpath`; the reviewer can create the link itself (`ln -s <project>/src/server.js /tmp/x` → allow) |
| `ln -s src/server.js <draft>/link.js && echo x > <draft>/link.js` | allow | TOCTOU in one line: the link does not exist when the hook runs; the same write to an existing link is denied |
| `node <draft>/write.js`, `npx prettier --write src/server.js` | allow | residual 1 (script / unknown tool), documented |

### F5 — an agent can claim to be the human; critical risks do not block release

**Acceptance (review):** "agents cannot reopen reserved gates, raise reserved limits, waive findings, or accept risks by changing an actor argument. Altering the approved action invalidates its authorization."

**Probe:** `probes/F5-authority-variations.js` → `results/F5-authority-variations.js.txt` (36 steps; guard = 5da8913 snapshot; CLI with stdin closed and `ECCODE_TEST`/`ECCODE_NOW`/`ECCODE_ACTOR` scrubbed unless a step says otherwise).

| Variation | Guard | CLI |
|---|---|---|
| `--actor=user` (equals form), main session and subagent | deny | `USER_AUTH_REQUIRED`, exit 2, nothing appended |
| `--actor User` | allow (not the string `user`) | `USER_AUTH_REQUIRED`: "User" is an unknown role, not the user (`gate reopen`, `risk update --status accepted`) |
| exported `ECCODE_ACTOR=user`, no `--actor` | deny | `USER_AUTH_REQUIRED` |
| `ECCODE_TEST=1` inline | deny | — |
| `"yes"` piped on stdin | — | `USER_AUTH_REQUIRED` (not a TTY) |
| `ECCODE_TEST=1` exported | — | **works** (`F5.cli.testSwitch`) — residual 2, documented |
| delegation: wrong role, wrong action, replay after 1 use, wrong target, revoke by an agent, after revoke, expired (1 min, spend 2 min later on a pinned clock), granted by the orchestrator, granted by the user without a TTY | — | all `USER_AUTH_REQUIRED`; a refused use spends nothing; audit OK |
| delegation: the valid one | — | reopen succeeds, "on the user's behalf" |
| `decision add --on-behalf-of user` without / with a delegation | — | `USER_AUTH_REQUIRED` / ok |
| risk accepted by the orchestrator; delivery with an open high risk; after mitigation | — | `USER_AUTH_REQUIRED`; `DELIVERY_BLOCKED`; delivered |
| `release.blockRiskSeverities: []` with an open critical risk | — | delivered — a policy knob; `config.json` is record-protected and validated as a list of severities; worth a warning in the handoff but not a bypass |

**NEW-7 (non-blocking for user authority; relevant to identity binding, residual 1): the guard binds actors to the literal CLI word; a shell function hides it.** `e() { eccode "$@"; }; e gate reopen architecture --actor user --resolution …` → guard `allow` (`F5.guard.shellFunction`); the CLI still refuses it without a TTY, so user authority holds. But the same wrapper from a `technical-reviewer` subagent, `e task claim api --actor backend-engineer` → guard `allow` (`F5.guard.impersonateRole`) while the direct form is denied, and **the CLI has no role binding at all**: the reviewer records work as the implementer. (A copied binary via `$(command -v eccode)` is denied because of the command substitution, not because the copy is recognised.) Fix shape: treat a function definition or `alias` whose body names the CLI as making every later command word in that line an eccode invocation, or deny function/alias definitions in agent shells.

Residual 3 as it bears on F5 is demonstrated under F7 (`F7.forgedUserEvent`): an actor who can write the event log appends a `risk.recorded … actor: user, status: accepted` event with valid hashes; `audit` is OK and the final handoff prints it under "User decisions … confirmed by a person at a terminal". The handoff's wording over-claims for records that can be edited offline.

### F6 — shared lessons lose their verification binding

**Acceptance (review):** "changing one byte of a promoted solution makes it unusable as verified knowledge until reviewed again."

**Probe:** `probes/F6-attestation-variations.js` → `results/F6-attestation-variations.js.txt` (20 steps; a shared store under `ECCODE_SHARED_MEMORY`, project A promotes two verified lessons, project B retrieves).

Caught (quarantined: `verdict: provisional`, `quarantined: true`, search weighted down and flagged, `memory check` exit 3, `memory audit --scope shared` exit 2): one byte of the solution (`400` → `401`); the first index line deleted (both records); the index lines reordered; the record file replaced by another valid attested record under the same id (`attestation mismatch with the index`). `revise` / `review` on a shared record → `SCOPE`. Untouched record → `applies`, audit exit 0; restored after each tamper → `applies` again. The acceptance sentence holds for the solution bytes.

**NEW-8 (non-blocking): everything outside `{layer, status, trust, content}` is unbound.** With the content intact the record still returns `applies`, not quarantined, full search weight, after each of: `attestation.reviewer` set to the lesson's author (self-verification), `reviews[0].notes` rewritten, `reviews[0].decision` flipped from `verify` to `reject`, every `evidenceSnapshots[*]` flipped to `failed`/exit 1 (the recorded proof that the fix worked), `attestation.engine`, `provenance.promotedBy`, `lastVerifiedAt` moved ten years ahead (`F6.meta.*`). None of these change what the lesson *says*, but they are what a human or an agent reads to decide how much to trust it, and `memory show` prints them as fact. Fix shape: include `reviews`, `evidenceSnapshots`, `provenance` and the attestation's own review fields in `attestationSha256` (or hash the whole record minus `attestation.attestedSha256`).

`F6.index.forgedAppend` (by design, recorded): a third index line with a stale `prevHash` breaks the chain *after* the two good lines; both records still apply because `readAttestationIndex` trusts the prefix before the first broken link, and `memory audit` reports the corrupt index (exit 2). Reasonable, as long as the audit is run.

**NEW-9 (non-blocking, a variant of residual 3): a subagent can redirect the engine to a shared store it forged.** `ECCODE_SHARED_MEMORY=/tmp/forged-shared eccode memory search … --actor learning-debugger` → guard `allow` (`F6.guard.sharedRedirect`); `IDENTITY_ENV` covers only `ECCODE_ACTOR/TEST/NOW`. Combined with `F6.rewriteAndRehash` (below) the agent needs no access to the real index at all. Fix shape: add `ECCODE_SHARED_MEMORY` (and `ECCODE_ROOT`) to `IDENTITY_ENV`.

Residual 3 confirmed precisely (`F6.rewriteAndRehash`): solution replaced, `attestation.attestedSha256` recomputed, `attestations.jsonl` rebuilt from genesis with the new digest → `applies`, not quarantined, `memory audit --scope shared` exit 0. Undetectable without an external checkpoint, as the threat model says.

### F7 — state mutation can proceed from a corrupted snapshot

**Acceptance (review, implicit):** a snapshot whose content differs from the log must not drive a transition; multi-step transitions recoverable; crash and concurrent-writer tests.

**Probe:** `probes/F7-store-variations.js` → `results/F7-store-variations.js.txt` (19 steps).

| Step | Outcome |
|---|---|
| forged snapshot (status flipped, seq/lastHash intact): `state()`, `gate start` | `SNAPSHOT_DIVERGED` both; `eccode rebuild --actor orchestrator` repairs; then `GATE_BLOCKED` |
| torn tail, crash shape (N complete lines + a fragment, snapshot at N) | `state()` OK (seq N), audit OK, next commit cuts the fragment, audit OK, `events === seq`, log ends with a newline |
| torn tail, disk-fault shape (the last recorded event itself cut, snapshot at N) | `LOG_ROLLBACK` for `state()` and for a commit; audit names it. Fail-closed and correct: recovering it is the user's `rebuild --force` |
| 8 concurrent writers (4 `risk add` + 4 `evidence run`) | all exit 0; seq 9 = 9 events; 4 risks, 4 evidence; audit OK; snapshot equals replay |
| crash between `task.completed` and `handoff.recorded` | task `done`, handoff absent; audit OK with one warning naming `eccode handoff record --actor backend-engineer --file …`; `eccode resume` exit 0; the CLI recovery works; warning gone |
| **rewrite and re-hash** (event 2's risk severity `critical` → `low`, every later `prevHash`/`stateHash`/`hash` recomputed, snapshot rewritten) | **not detected**: `audit()` OK, `eccode audit` exit 0, `state()` returns the forged severity — residual 3, confirmed exactly as the review and threat model describe |
| **forged `user` event appended** with valid hashes (`risk.recorded`, `status: accepted`, `actor: user`) | **not detected**: audit OK; the risk reads `accepted`; `buildReport` prints it under "User decisions (recorded with `--actor user` …)" |

No new defect. The two last rows are the documented residual, now with a precise reproduction (`rehash()` in the probe is 20 lines).

### F8 — limits are accounting checks, not complete runtime enforcement

**Probe:** `probes/F8-limits-variations.js` → `results/F8-limits-variations.js.txt` (19 steps).

| Step | Outcome |
|---|---|
| `maxActiveRuns=4`, 3 open, **three concurrent** `run start` processes | exactly one exit 0, two `RUN_LIMIT`; 4 open after; audit OK (the lock serialises the cap) |
| reservation boundary: `$5` spent + 2 slots × `$3` = `$11` vs cap `$11` | allowed (strict `>`); vs `$10.99` → `BUDGET_EXCEEDED`; a 4th → `BUDGET_EXCEEDED` |
| recorded spend equal to the cap (`$5` of `$5`) | `BUDGET_EXCEEDED` (`>=`): the two comparisons differ in strictness; harmless, worth one line in the docs |
| `run end` without usage / `--no-usage` | `USAGE_MISSING` / ok; `status --brief` "1 run with unknown usage; spend is a lower bound"; `status --json` `budget.lowerBound: true` |
| `--tokens 1234` without pricing | cost `null`, tokens counted, listed as unknown usage |
| `--tokens 0` | `$0`, `usageReported: true` (an explicit zero is a figure; documented) |
| `recover` of a run started 10:00, recovered 12:00 | `durationMinutes: 120`, cost/tokens `null`, totals `$0`, status says lower bound |
| `recover` by a subagent | `ROLE_NOT_ALLOWED` |
| `maxActiveRuns: 0` / `-1` / `1.5` | `INVALID_CONFIG` / `INVALID_CONFIG` / accepted (1.5 behaves as 2 open) — cosmetic |
| `--cost-usd -5` | `INVALID_INPUT` |

Closed within what the developer declares; deadlines, cancellation and provider-side metering are host work and are documented as such. No new defect.

### F9 — portability and release reproducibility

**Probe:** `probes/F9-release-checks.js` → `results/F9-release-checks.js.txt` (18 steps).

| Check | Outcome |
|---|---|
| `npm run validate` | exit 0 |
| `npm pack --dry-run --json` | 357 files; `package.json`, `lib/index.js`, `bin/eccode.js`, `hooks/hooks.json`, `scripts/hooks/guard.js`, `schemas/review.schema.json` present; nothing under `tests/`, `examples/`, `.eccode/`, `eval/`, `.github/`; no nested record directory |
| real tarball → `npm install --offline` into a throwaway consumer → `require('eccode')` | `{"version":"0.3.0","exports":24,"hasStore":true,"hasGates":true}` |
| the **installed** CLI (`node_modules/eccode/bin/eccode.js`) in a fresh git repo: `init`, `evidence run`, `audit` | all exit 0 |
| installed `hooks/hooks.json` names `guard.js` | yes |
| `.gitattributes` | `* text=auto eol=lf`; the review bundle and evidence logs `-text`; `git ls-files --eol` shows `i/lf w/lf` for engine files and `i/crlf w/crlf attr/-text` for the Windows log |
| static scan of `tests/*.js` (helpers included) for `sh -c`, `grep -q`, `; exit N`, `'true'`/`'false'` commands, "hook input" lines excluded | no hits outside `review-F9.test.js` (which holds the rules); the three `sh -c` strings in the guard test are hook input only |
| versions: `package.json`, `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`, CHANGELOG first heading, `lib/index.js` | all `0.3.0` (`ENGINE_VERSION` in `lib/memory/records.js` reads `package.json`) |
| `node --test tests/review-F9.test.js` | 6 pass, 0 fail, **0 skipped**; the 0.1.0 commit `d2d0c243` is in the clone, so the upgrade/rollback test really ran |
| **Windows** | **NOT RUN.** The five Windows fixture fixes rest on the developer's reading of the reviewer's log and on CI; this verification adds nothing on Windows. |

Hygiene note (not a defect): the tarball is 8.07 MB unpacked, 259 of its 357 files are under `docs/evidence/` (the review bundle, Groundwork records). A consumer installing `eccode` gets the project's evidence history. Consider excluding `docs/evidence/` from `files`.

## 4. New defects, consolidated

| # | Finding | Severity | One-line reproduction | Probe step |
|---|---|---|---|---|
| NEW-1 | F1 | **BLOCKING** | approve the brief with AC1+AC2; rewrite `brief.md` to AC1 only (a document author may, per the guard); design and verification now require AC1 only; list the edited brief in the verification artifacts; deliver; `eccode audit` → OK | `F1.edited.*` |
| NEW-3 | F2 | **BLOCKING** | after the phase approval, `git add` + commit `src/server/backdoor.js`; submit and approve verification without listing it; deliver; the release commit contains it; audit → OK | `F2.between.*` |
| NEW-6 | F4 | **BLOCKING** | reviewer (or any role, any target): `echo x >| src/server.js` → guard `allow` | `F4.clobber*` |
| NEW-2 | F1 | non-blocking | a brief whose Acceptance Criteria carry no ids: "the document has a title" is approved; `gate show` tells the author to add ids but nothing enforces it | `F1.noids.attack` |
| NEW-4 | F2 | non-blocking | `git mv old.js new.js` inside the ownership; declare only `new.js`; accepted; `old.js` leaves the release unreviewed (`git diff --name-only` folds renames) | `F2.rename.*` |
| NEW-5 | F3 | non-blocking | the declared command run with `--cwd <subdir>` satisfies the check; the schema refuses `verification.cwd`, so the engine's cwd binding is unreachable | `F3.cwd.*` |
| NEW-7 | F5 | non-blocking | `e() { eccode "$@"; }; e task claim api --actor backend-engineer` from a reviewer subagent → guard `allow`; the CLI has no role binding | `F5.guard.shellFunction`, `F5.guard.impersonateRole` |
| NEW-8 | F6 | non-blocking | flip `evidenceSnapshots[*].status` to `failed`, or `attestation.reviewer` to the author: the record still `applies` as verified | `F6.meta.*` |
| NEW-9 | F6 | non-blocking | `ECCODE_SHARED_MEMORY=/tmp/forged eccode memory search …` from a subagent → guard `allow` | `F6.guard.sharedRedirect` |
| F4 tail | F4 | non-blocking | `rm`, `rm -rf`, `git rm <file>`, `git apply`, `patch`, `git am`, `find -exec sed -i`, `xargs sed -i`, `curl -o`, `wget -O`, `tar -x -C src`, inline `openSync(…,'w')`, a write through a symlink that lives outside the project, `ln -s … && echo > …` in one line | `F4.*` |

## 5. Overblocking

None found. Every legitimate completion of each workflow I set up passed once the rules were followed: table-format criteria, whitespace-variant commands, a reviewed deletion, a user-committed base, a reviewed rename's new path, a mitigated risk, a valid delegation, a recovered handoff gap, a torn-tail crash. Two things that look like overblocking are not:

- A phase approval must cite a reviewer run of **every** verification command the phase's tasks declare (`F3.reviewer.declaredOnly` was refused because the helper's `ui` and `tests` tasks declare the default command). That is the rule working; my first draft of the probe had it wrong.
- From a Claude Code shell, `ECCODE_TEST=1 node …` is denied by the repository's own guard, so the maintainer cannot run the suite's switch inline through the Bash tool. That is the F5 design; `npm test` does not need it.

One recoverability note: a disk fault that cuts the **last recorded** event (not a crash fragment after it) leaves the record in `LOG_ROLLBACK`, which only the user can clear (`rebuild --force --actor user`). Correct fail-closed behaviour; the recovery path should be named in the troubleshooting docs next to the crash case.

## 6. Residuals confirmed (already documented by the developer, now with reproductions)

- Residual 1 (guard cannot read programs): `F4.node-script`, `F4.npx-prettier`.
- Residual 2 (`ECCODE_TEST=1` in an agent's environment): `F5.cli.testSwitch`.
- Residual 3 (digests on the same writable disk): `F7.rewrite`, `F7.forgedUserEvent`, `F6.rewriteAndRehash`. The handoff's sentence "Events recorded as the user were confirmed by a person at a terminal" should be qualified by this residual.
- Environment not bound to evidence: `F3.env.forced`.
- Residual 6 (git-ignored files): not re-probed; the developer's statement stands.
- Windows unverified: `F9.windows`.

## 7. Files

- `probes/_lib.js` — shared scaffolding (`attempt`, self-judging `report`, git helpers, cleanup).
- `probes/F1-coverage-variations.js` … `probes/F9-release-checks.js` — one probe per finding, self-contained, requiring the engine by path from `__dirname`, throwaway projects via `tests/helpers.js`, cleaned up.
- `results/<probe>.js.txt` — stdout JSON of the final run; `results/<probe>.js.stderr.txt` — the per-step log of the same run.
- This report.
