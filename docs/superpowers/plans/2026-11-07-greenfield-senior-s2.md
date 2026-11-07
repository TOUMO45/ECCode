# Greenfield-Senior S2 Implementation Plan (ownership map, path-scoped permissions, slice closure)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task (the session is the implementer; the independent reviews in R1 and R2 are fresh agents). Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add GF-OWN-1..5, GF-FRZ-1, GF-CONF-1, the drafts namespacing and the slice-closure rule GF-CLOSE-1..4 to the Greenfield-Senior layer, with the L-GF-17 preflight, test-first, then close S2 by its own rule.

**Architecture:** All new behaviour is additive in `lib/greenfield/` (new files, `gf.*` events in the same hash-chained log, a pure projection) plus two thin edits to existing unfrozen files (`scripts/hooks/guard.js`, `lib/mcp.js`' `extendTools` use). No frozen file is edited or requires `lib/greenfield`. Enforcement wording: prevention on the managed (MCP) path plus guaranteed detection by log-replay audit in all profiles.

**Tech Stack:** Node (`node:test`), the frozen store/gates/tasks called through their exports, git for tree identity, the FastAPI virtual environment (`ECCODE_PYTHON`) for the full check.

**Spec:** `docs/design/greenfield-senior.md` section 16 (S2 design, registered estimate, accounting protocol), sections 4.2 and 8; owner decisions of 2026-11-07 (16.1).

## Global Constraints

- Frozen v3 set 48 of 48 by hash before and after: `ECCODE_FREEZE_FILE=bench/pilot/phase2-freeze-v3.json node bench/pilot/phase2-seeds.js check` prints `frozen: 48 files`.
- No edit to any of the 48 frozen files, to `scripts/guards/*.py`, or to `docs/limits.md`; no frozen file requires `lib/greenfield`.
- Limit ids stay placeholders (`L-GF-n`) in `docs/limits-greenfield.md`; no merge with `claude/v3-generalization-fastapi-*`.
- Every new rule has a positive, a negative and a bypass test; every bypass runs the generic battery rows that apply (forged event through `Store.commit`, edit after registration, direct call of the frozen function, spoofed actor where identity is not locked).
- The word "prevent" never stands alone in a document or in `lib/greenfield` (same sentence says managed or audit): `tests/gf-docs.test.js`.
- Tests that run git commits in temporary repositories use signing disabled by environment only: `GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=commit.gpgsign GIT_CONFIG_VALUE_0=false` (the scratchpad wrapper `t.sh`); real commits stay signed.
- Full check with `ECCODE_PYTHON=<scratchpad>/venv/bin/python`; the skip count is reported before (49, measured) and after.
- No paid run; $0 on the benchmark meter. Nothing tuned after a result. Stop after S2 and report.

## Review Focus

Failure modes the design implies and no single task's rule names, most likely first; each has its test in the task that owns the code.

1. A path owned by **no** group (for example `pyproject.toml` when no group declared it): a group role's write is refused with a message that names the remedy (an ownership amendment), not silently allowed. Owned by T2 (`gf-permissions`).
2. A **glob with `..`, an absolute path, a backslash or an empty string** in an amendment's `to`: refused (GF-OWN-5), never stored. Owned by T1.
3. **`filesChanged` with a path that normalises into another group** (`app/../web/x.js`, `./web/x.js`, a symlinked directory): judged on the normalised path; a path outside the project root is refused. Owned by T3.
4. **A group role called while the project is not yet sealed, or whose breakdown file was edited after approval**: the hook fails closed with the reason (GF-OWN-1 hash mismatch), and the audit reports it. Owned by T2.
5. **A closure with a review bound to the right tree but recorded by the closer, by a role that also completed a task, or after a late commit**: refused (GF-CLOSE-1). A `gf.review.recorded` whose `treeHash` is not a 40-hex git tree object is refused at the schema. Owned by T5.

---

### Task 1: Ownership map core, amendment, rescope (GF-OWN-1, GF-OWN-5)

**Files:**
- Modify: `lib/greenfield/ownership.js`, `lib/greenfield/stages/breakdown.js` (use the shared reserved-path check), `lib/greenfield/events.js`, `lib/greenfield/projection.js`, `lib/greenfield/constants.js`, `lib/greenfield/wrap.js`, `lib/greenfield/index.js`, `lib/greenfield/audit.js`, `bin/eccode-gf.js`
- Create: `lib/greenfield/ownership-ops.js`
- Test: `tests/gf-own.test.js`, rows in `tests/fixtures/gf/own-rows.js`

**Interfaces:**
- Produces in `ownership.js`: `RESERVED: [{glob, group}]`; `reservedProblems(groups): string[]`; `mapOf(breakdown): {groups: {[name]: {roles, globs, denyGlobs}}}`; `effectiveMap(base, amendments): map`; `mapAt(base, amendments, seq): map` (amendments with `seq` below the given one); `ownerOfPath(map, rel): string|null` (the group whose globs match `rel` and whose `denyGlobs` do not; `rel` is normalised, a path with `..` after normalisation or absolute is `null`); `validGlob(g): boolean`.
- Produces in `ownership-ops.js`: `loadMap(store): {map, problems}` (reads the sealed `breakdown.json`, verifies its sha256 against `gf.seal.hashes`, applies amendments; `problems` carry rule `GF-OWN-1`); `amend(store, config, actor, {group, to, reason, message}): result` (commits `gf.ownership.amended`); `rescope(store, config, taskId, actor, options): result` (GF-OWN-5 then the frozen `tasks.rescope`).
- Events: `gf.ownership.amended {id, group, from: string[], to: string[], reason (>= 30), message}`; projection field `gf.ownershipAmendments`.
- CLI: `eccode-gf ownership show`, `eccode-gf ownership amend --group --to a,b --reason --message`, `eccode-gf task rescope`; MCP: `gf_ownership_show`, `gf_ownership_amend`; `task_rescope` wrapped in `extendTools`.

- [ ] **Step 1: Write the failing tests** in `tests/gf-own.test.js` (table-driven rows plus named tests):
  - `ownerOfPath`: `app/main.py` is `backend`; `app/db/models.py` is `db` (backend denies `app/db/**`); `contracts/openapi.json` is `api`; `pyproject.toml` is `null`; `app/../web/x.js` is `frontend`; `../outside`, `/etc/passwd`, `''` are `null`.
  - positive: `effectiveMap` with one amendment replaces exactly that group's globs; `mapAt(…, seq)` ignores later amendments.
  - negative rows (each a distinct refusal with rule `GF-OWN-5` and a stable message fragment): non-reviewer actor; reason under 30 characters; `message` not a recorded message; `from` not the globs in force (stale chain); `to` empty or containing `..`, an absolute path, `\\`, `''`, a non-string; unknown group; a `to` that overlaps another group without deny (disjointness); a `to` that takes `contracts/**` from api or drops it (reserved); a `to` that leaves a pending task of the group uncovered.
  - `task_rescope` rows: new files outside the owner's group are refused (`GF-OWN-5`) before the frozen call runs; a rescope inside the group passes through to the frozen function.
  - bypass: a forged `gf.ownership.amended` committed with `Store.commit` by a non-reviewer, with a stale `from`, with a reason of 5 characters, and a forged `task.rescoped` moving a task into another group are each reported by `audit.run` (rule `GF-OWN-5`); a tampered `breakdown.json` (one byte) is reported `GF-OWN-1` and `loadMap` returns problems; an engine task whose owner is in no group is reported `GF-OWN-1`.
- [ ] **Step 2: Run to verify it fails** — `sh $S/t.sh tests/gf-own.test.js`; expected: failures, the module and functions missing; keep the output in `$S/red2/own.txt`.
- [ ] **Step 3: Implement** the functions above. `reservedProblems` moves the `RESERVED` logic out of `breakdown.js` (same messages, same rule GF-WBS-2) so the validator and the amendment share it. The audit adds: replay every amendment in order (reviewer by `reviewersOf(config)`, chain, reason, message cited and earlier, resulting map valid), every `task.rescoped` (new files inside the owner's group at that seq), every engine task (owner in a group, files inside the group at the seal or the last rescope), and the `breakdown.json` hash. Add `reviewersOf(config)` to a new `lib/greenfield/roles.js` and re-export it from `contracts.js`.
- [ ] **Step 4: Run to verify it passes**, then `sh $S/t.sh tests/gf-*.test.js` (all earlier gf tests still pass).
- [ ] **Step 5: Commit** `git add … && git commit -m "Greenfield S2, T1: ownership map, amendment, rescope (GF-OWN-1, GF-OWN-5)"`.

### Task 2: Path-scoped permissions in the hook (GF-OWN-2, GF-FRZ-1, drafts)

**Files:**
- Create: `lib/greenfield/permissions.js`
- Modify: `scripts/hooks/guard.js` (`ownershipDenial`), `lib/greenfield/constants.js`
- Test: `tests/gf-permissions.test.js`

**Interfaces:**
- Consumes: `ownership-ops.loadMap`, `ownership.ownerOfPath`, `contracts.currentHashes`, `projection.project`.
- Produces: `policy(root, role, rel): null | {drafts: string[], denial: string|null}`. `null` means the project is not a Greenfield-Senior project or `role` is in no group (existing hook rules apply unchanged). For a group role: `drafts` is `['.eccode/drafts/<group>/**']`; `denial` is a reason string or null. Fails closed: if the map cannot be loaded the denial says why. `guard.js` uses `policy` before `draftAreas`: a denial wins; `.eccode/drafts/<group>/**` is allowed; the existing claimed-task check still applies afterwards.

- [ ] **Step 1: Write the failing tests** running the real hook (`spawnSync(node, [GUARD])` with a JSON `tool_input` on stdin, `agent_type` set to the role, in a sealed temporary project with a claimed task):
  - positive: `backend-engineer` writes `app/main.py` inside a claimed task's globs: no denial. `integration-engineer` writes `contracts/openapi.json` before the seal... (pre-seal group roles hold no claims, so this row asserts the existing "no claimed task" message is still what a pre-seal write gets).
  - negative table, each with the exact denial fragment: `frontend-engineer` writes `app/main.py` (belongs to backend); `backend-engineer` writes `app/db/models.py` (belongs to db); `backend-engineer` writes `pyproject.toml` (owned by no group, the message names the amendment); `frontend-engineer` writes `contracts/openapi.json` (GF-FRZ-1); `integration-engineer` writes a sealed `contracts/openapi.json` with no open amendment request (GF-FRZ-1) and **with** one (allowed); any group role writes `.eccode/drafts/other-group/x.md` or `.eccode/drafts/x.md` (namespacing); a group role writes `.eccode/behavior.json` (record rule, unchanged).
  - bypass: the same denials through the Bash path (`echo x > app/main.py`, `tee`, `sed -i`, `cp`, `mv`) because `bashWriteTargets` feeds `ownershipDenial`; `MultiEdit` and `NotebookEdit` tool names; a path written as `app/../web/x.js`; a path through a symlinked directory inside the project; a `delivery-lead` write outside `Dockerfile`, `docker-compose.yml`, `Makefile`, `docs/**`.
  - fail closed: one byte appended to the approved `breakdown.json` makes every group-role write denied with the GF-OWN-1 reason, while the orchestrator and a non-GF project are unaffected; with `ECCODE_HOOKS=off` the hook allows (the stated limit, asserted so the limit cannot disappear unseen).
- [ ] **Step 2: Run to verify it fails**; log in `$S/red2/permissions.txt`.
- [ ] **Step 3: Implement** `policy`. Role to group through `C.groupOf`; delivery-lead and devops-engineer are group `delivery`. Write the denial messages to name the owning group and the remedy.
- [ ] **Step 4: Run to verify it passes**; run `tests/gf-review.test.js` and the existing guard tests (`tests/guard-fuzz.test.js`, `tests/hooks-install.test.js`, `tests/security-guard.test.js`).
- [ ] **Step 5: Commit** "Greenfield S2, T2: path-scoped permissions (GF-OWN-2, GF-FRZ-1, drafts)".

### Task 3: Completion and tree attribution (GF-OWN-3, GF-OWN-4)

**Files:**
- Modify: `lib/greenfield/wrap.js` (`taskComplete`), `lib/greenfield/ownership-ops.js` (`completionProblems`, `attribution`), `lib/greenfield/index.js`, `lib/greenfield/audit.js`, `bin/eccode-gf.js`
- Test: `tests/gf-own-complete.test.js`

**Interfaces:**
- `completionProblems(map, actor, filesChanged): {rule: 'GF-OWN-3', message}[]` (paths normalised; `.eccode/` paths ignored; a path outside the project is a problem).
- `attribution({map, tasks, changed}): {rule: 'GF-OWN-4', path, message}[]` where `tasks` are the engine's completed tasks (`owner`, `files`, `filesChanged`) and `changed` the paths changed since a base commit. A path is attributed when `ownerOfPath` names a group G and a completed task owned by a role of G lists it in `filesChanged` and its `files` cover it. Otherwise a problem: unowned, or owned by G with no completing task of G.
- CLI `eccode-gf attribute --base <commit>`; MCP `gf_attribute {base}`; `task_complete` wrapped; the frozen function is called only after the check.

- [ ] **Step 1: Write the failing tests:** positive (a backend task completing with its own files passes through; `attribution` clean for a change set fully declared by completed tasks of the owning groups); negative table (a completion listing a file of another group is `GF-OWN-3` and the frozen call is not made; `attribution` flags a changed path declared by no task, a path declared only by a task of another group, an unowned path, a path changed but only claimed not completed); bypass (a forged `task.completed` that lists a foreign file, committed with `Store.commit`, is reported by the audit; a handoff listing `app/../web/x.js`; a real temporary git repository where a backend task's handoff omits a changed file of frontend: `eccode-gf attribute --base` reports it, exit code 1).
- [ ] **Step 2: Run to verify it fails**; log in `$S/red2/own-complete.txt`.
- [ ] **Step 3: Implement.** The attribution reads `git diff --name-only <base>` plus untracked files through the frozen `project.gitChangedFiles`; it never throws (a non-git root reports one problem).
- [ ] **Step 4: Run to verify it passes** and the gf suite.
- [ ] **Step 5: Commit** "Greenfield S2, T3: completion and attribution (GF-OWN-3, GF-OWN-4)".

### Task 4: Guard-config pin (GF-CONF-1)

**Files:**
- Create: `lib/greenfield/pin.js`
- Modify: `lib/greenfield/events.js`, `projection.js`, `audit.js`, `index.js`, `permissions.js`, `bin/eccode-gf.js`
- Test: `tests/gf-pin.test.js`

**Interfaces:**
- `pin(store, config, actor, {scope, reason}): result` commits `gf.config.pinned {id, scope, files: {path: sha256}, reason}` for the config files that exist among `.eccode/behavior.json`, `.eccode/guards.json`, `.eccode/security.json` (at least one; each valid JSON); only `orchestrator` and `user` may pin. `drift(root, gf): {rule: 'GF-CONF-1', message}[]` compares the latest pin with the bytes now.
- The hook: a group role writing one of the three paths is denied (GF-CONF-1); the orchestrator is not.

- [ ] **Step 1: Write the failing tests:** positive (pin, then `drift` empty; a second pin moves the expected hashes); negative (a group role pins; no config file exists; invalid JSON; a pin with a reason under 10 characters); bypass (loosen a `security.json` cell with `Store`-free file write after the pin: the audit reports GF-CONF-1; delete the file: reported; a forged `gf.config.pinned` by a group role: reported; the hook denies a group role's write to the three paths, including through `echo >`).
- [ ] **Step 2: Run to verify it fails**; `$S/red2/pin.txt`. **Step 3: Implement.** **Step 4: Run to verify it passes.**
- [ ] **Step 5: Commit** "Greenfield S2, T4: guard-config pin (GF-CONF-1)".

### Task 5: Slice-closure rule (GF-CLOSE-1..4)

**Files:**
- Create: `lib/greenfield/closure.js`
- Modify: `lib/greenfield/events.js`, `projection.js`, `audit.js`, `index.js`, `bin/eccode-gf.js`
- Test: `tests/gf-close.test.js`, fixture helper `tests/fixtures/gf/close.js` (a temporary git repository with commits, a Greenfield-Senior record, stub `mutate`)

**Interfaces:**
- Events: `gf.review.recorded {id, scope, treeHash (40 hex), verdict: 'clean'|'findings', findings: [{id, severity: 'blocking'|'major'|'minor', summary}]}`; `gf.finding.resolved {id, finding, resolution: 'fixed'|'withdrawn'|'deferred', proof?: 'ev:<id>', reason?, limit?}`; `gf.battery.recorded {id, scope, round (integer >= 1), treeHash, evidence: 'ev:<id>', total, killed, survived, survivors: [{key, reason}]}`; `gf.slice.closed {scope, treeHash, review, batteries: string[], accepted: [{key, reason}], accounting: {unit: 'all-processed-tokens', start, end}}` with `start` and `end` a non-negative integer or `'unmeasurable'`.
- `closure.recordReview(store, config, actor, {scope, findings})` (tree hash and clean-tree check done by the function; verdict is `clean` iff no findings); `closure.resolveFinding(store, config, actor, {finding, resolution, proof, reason, limit})`; `closure.runBattery(store, config, actor, {scope, test, base, max})` (calls the frozen `mutate.run` through its exports object, pinned: tree clean and equal before and after, else void); `closure.close(store, config, actor, {scope, accounting, accepted})`; `closure.problems(log, state, root, config): {rule, seq?, message}[]` used by the audit and by `close` inside the lock.
- CLI: `eccode-gf close review|resolve|battery|seal`; MCP: `gf_review_record`, `gf_finding_resolve`, `gf_battery_run`, `gf_close`.

- [ ] **Step 1: Write the failing tests:** a table of closures, each starting from one valid closure and changing one thing. Positive: review bound to the final tree and clean, all findings fixed with a proven fix-verify pair, two batteries (first before the review, last on the final tree after the last fix), accounting with numbers; accounting with `'unmeasurable'` for both; no findings at all. Negative (rule id and fragment each): review on an earlier tree (GF-CLOSE-1); verdict findings (GF-CLOSE-1); reviewer role is the closer; reviewer role also completed a task or submitted to a gate; actor not a configured reviewer; a finding unresolved; fixed with no proof; proof whose pre-fix evidence passed; proof recorded before the finding; proof whose pre-fix and post-fix pair is not linked (`fixVerify.preFix` missing); withdrawn by the orchestrator; deferred by a non-user, or for a blocking finding, or without a limit id; one battery only; last battery on an earlier tree; last battery recorded before the last fixed resolution; survivor with no reason; `accounting` absent, `null`, a blank string, `0` as a string, `end` below `start`, a unit other than `all-processed-tokens`; dirty tracked tree at close; scope already closed. Bypass: forged events committed with `Store.commit` for each of the above (a `gf.slice.closed` citing a review that does not exist; a battery event whose evidence id does not exist; a late `gf.review.recorded` for a closed scope) are each reported by the audit; the author's own tests cannot be recorded as a review (`recordReview` refuses a non-reviewer actor).
- [ ] **Step 2: Run to verify it fails**; `$S/red2/close.txt`.
- [ ] **Step 3: Implement.** Tree identity: `git rev-parse HEAD^{tree}`; clean means `git status --porcelain` is empty outside `.eccode/`. Fix-verify proof: the post-fix evidence is `kind: 'command'`, `status: 'passed'`, carries `fixVerify.preFix`; that pre-fix evidence has `status: 'failed'` and `purpose: 'reproduction'`; order by event `seq` (finding review seq < pre-fix evidence seq < post-fix evidence seq < resolution seq).
- [ ] **Step 4: Run to verify it passes** and the gf suite.
- [ ] **Step 5: Commit** "Greenfield S2, T5: slice closure rule (GF-CLOSE-1..4)".

### Task 6: L-GF-17 preflight and the cross-group spoof matrix

**Files:**
- Create: `lib/greenfield/preflight.js`
- Modify: `lib/greenfield/audit.js` (a `managedPath` section, warnings not errors), `lib/greenfield/index.js`, `bin/eccode-gf.js`
- Test: `tests/gf-spoof.test.js`

**Interfaces:**
- `preflight(root): {profile: 'sandbox'|'no-shell'|'guard'|'unknown', guardWired: boolean, roleServers: {[role]: boolean}, warnings: string[]}` reading the project's Claude settings and MCP configuration the way `lib/install.js` writes them (reuse its profile detection; do not duplicate it). `audit.run` returns `managedPath` and a warning (not an error) for the `guard` profile or missing wiring, naming the consequence.
- CLI `eccode-gf preflight`; MCP `gf_preflight`.

- [ ] **Step 1: Write the failing tests.** Matrix, hook-level: for each ordered pair of group roles (A, B), the real hook denies `mcp__eccode_<B>__task_complete` when `agent_type` is A and allows it for B; `--actor B` from a Bash call by A is denied. Handler-level: every MCP tool of a role-locked server records the server's actor even when the arguments carry an `actor` field. Residual (documented, asserted): a forged `task.completed` by actor B committed with `Store.commit` leaves `audit.run` clean on the ownership rules (the test title cites L-GF-17 so it must change when attestation exists). Preflight: a project installed with each profile reports it; a project with the guard missing reports `guardWired: false` and a warning; the audit includes `managedPath`.
- [ ] **Step 2: Run to verify it fails**; `$S/red2/spoof.txt`. **Step 3: Implement.** **Step 4: Run to verify it passes.**
- [ ] **Step 5: Commit** "Greenfield S2, T6: managed-path preflight and spoof matrix (L-GF-17)".

### Task 7: Verification, reviews, closure by hand, evidence

**Files:** `docs/build/gf-s2-evidence.md`, `docs/build/compute-ledger.md`, `docs/design/greenfield-senior.md` (section 17 as built), `docs/limits-greenfield.md`, `tests/gf-docs.test.js` (wording scan includes the S2 plan and evidence).

- [ ] **Step 1: Battery run 1** on the build tree: `scratchpad/mutation-run.js` extended with GF-OWN-1, GF-OWN-2, GF-OWN-3, GF-OWN-4, GF-OWN-5, GF-FRZ-1, GF-CONF-1, GF-CLOSE-1, GF-CLOSE-2, GF-CLOSE-3, GF-CLOSE-4. Expected: every rule fails at least two tests when removed.
- [ ] **Step 2: Full check with the venv:** `GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=commit.gpgsign GIT_CONFIG_VALUE_0=false ECCODE_PYTHON=$S/venv/bin/python npm run check`. Expected: 0 failures; the 35 FastAPI-dependent tests run; skip count reported.
- [ ] **Step 3: Review pass 1:** a fresh general-purpose agent, given the code, the design section 16 and this plan, not my conclusions. Every finding becomes a failing test (red log kept) before its fix; a fix is proven by fix-verify where it applies.
- [ ] **Step 4: Battery run 2** on the post-fix tree; **review pass 2** (a fresh agent) on the final tree, clean; no commit after it other than evidence.
- [ ] **Step 5: Evidence, ledger (one row per delegated agent, the S2 end snapshot, no blank cell), estimate-versus-actual with the registered predictions P4 to P6 scored, commit, push, report; stop.**

---

## Self-review

- **Spec coverage:** GF-OWN-1..5, GF-FRZ-1, GF-CONF-1, drafts, role sets (T1 to T4); owner condition 1 (T5 and T7), 2 (ledger in T7, GF-CLOSE-4 in T5), 3 (T7), 4 (T6 and design 16.4), 5 (T7); deviations from 4.2 are listed in 16.2.
- **Types:** `loadMap`, `effectiveMap`, `ownerOfPath`, `policy`, `completionProblems`, `attribution`, `pin`, `drift`, `closure.*` and `preflight` are defined once above and used by name in later tasks.
- **Proportion:** the plan states interfaces, tests and decisions; bodies are left to the implementer.
