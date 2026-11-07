# Greenfield-Senior S2: evidence

S2 is the ownership map and path-scoped permissions (`docs/design/greenfield-senior.md` section 16), plus the closure rule with the owner's three-step review (section 17.2), and the registration of Upgrades 1, 3, 4 and 5 (section 17). Plan: `docs/superpowers/plans/2026-11-07-greenfield-senior-s2.md`. Status words as in S1: **verified** (a command ran and its output is quoted), **partial** (the gap is named). Times are UTC, 2026-11-07.

## 1. Invariants

| Invariant | Status | Evidence |
|---|---|---|
| Frozen v3 set 48 of 48 before | verified | `ECCODE_FREEZE_FILE=bench/pilot/phase2-freeze-v3.json node bench/pilot/phase2-seeds.js check` printed `frozen: 48 files` before the first S2 code commit (T1, `4c0f593`), and again after T6 |
| Frozen v3 set 48 of 48 after | verified | `frozen: 48 files` on the last S2 tree (`21ef6eb`, 18:52Z, before the round-4 dispatches), and recorded again by the round-4 readiness reviewer (`ev-mw6ri2qa-01220de2`) |
| No frozen file edited or requiring `lib/greenfield` | verified | none of the 48 files of the freeze list changed on the branch since `948a95b` (0 of 48 in `git diff --name-only` plus untracked files), and none of them mentions `lib/greenfield` (`git grep`: none); the round-4 readiness reviewer recorded the same (`ev-mw6rid22-01861160`, `ev-mw6rvil6-01bc1538`) |
| `docs/limits.md` and `scripts/guards/*.py` untouched | verified | `git diff 3f6ee65 21ef6eb -- docs/limits.md scripts/guards` is empty (0 lines) |
| Existing unfrozen files edited | verified | `scripts/hooks/guard.js` (the group policy before the draft areas), `lib/mcp.js` (`approvedCommands` exported); nothing else outside `lib/greenfield`, `bin/eccode-gf.js`, tests and docs |
| No paid run | verified | no benchmark arm launched; the meter is $0 (this session's own compute is in section 9) |

## 2. FastAPI stack (owner condition 3)

| Step | Result |
|---|---|
| Before the venv, on the S2-start tree (`3f6ee65`, `npm run check`) | 951 tests, 902 pass, 0 fail, **49 skipped**, 124 s (as expected) |
| venv created first (`python3 -m venv`; pip): FastAPI 0.162.1, Starlette 1.10.0, Pydantic 2.14.3, SQLAlchemy 2.1.8, Alembic 1.20.1, httpx 0.28.1, Hypothesis 6.170.15, coverage 7.17.2, pytest 9.2.0 | |
| First run with `ECCODE_PYTHON` at that venv, unchanged tree | 982 tests, 963 pass, **5 fail**, 14 skipped. Cause, read from the failures: the checked-in fixture configs `tests/fixtures/phase3/ledger/.eccode/{guards,behavior}.json` name `/root/.cache/eccode/phase3-venv/bin/python`, which did not exist (`sh: 1: /root/.cache/eccode/phase3-venv/bin/python: not found`). An environment gap, not library drift |
| The same venv built at that path; the three affected files | 45 tests, 45 pass, 0 skipped |
| Full check on the unchanged S2-start tree with that venv (a separate worktree of `4799154`) | **982 tests, 968 pass, 0 fail, 14 skipped** |
| Full check on the S2 review tree `e8fee82` with the venv | **1,366 tests, 1,352 pass, 0 fail, 14 skipped**, 303 s (a mutation run was competing for the four cores) |
| Final tree | On the last S2 tree (`21ef6eb`, tree `bceec2c`), recorded in the closure record by the round-4 readiness reviewer: `npm run check` with `ECCODE_PYTHON` at the venv, **1,520 tests, 1,506 pass, 0 fail, 14 skipped** (`ev-mw6rpjk2-01e89d2e`); the FastAPI-dependent test files run with 0 skipped with the venv and skip without it (`ev-mw6rtnox-0190fc75`). My own run on the same tree with the evidence documents added (19:33Z to 19:37Z, `ECCODE_PYTHON=/root/.cache/eccode/phase3-venv/bin/python npm run check`): **1,520 tests, 1,506 pass, 0 fail, 14 skipped**, 229.6 s. |

The 14 remaining skips: 6 need a Mealie checkout, 4 need `ECCODE_MEALIE_VALIDATE`, 1 needs `ECCODE_REALBUGS_VALIDATE`, 1 needs `ECCODE_CBM`, 1 `kotlinc`, 1 `codebase-memory-mcp`. **None is FastAPI-dependent: the 35 FastAPI-dependent tests run** (49 skips before, 14 after).

## 3. Test-first: what "red" was at each task

| Task | Red run (before the code) | What it proves |
|---|---|---|
| docs (limits 1 to 20, later 21) | 5 tests, 1 fail (`row L-GF-19 is missing`) | per-test red |
| T1 ownership map | 1 test, 0 pass: `Cannot find module '../lib/greenfield/ownership-ops'` | a load error, not a per-test red |
| T2 path-scoped permissions | 44 tests, **28 fail**, 16 pass (the 16 assert behaviour that already held: the existing claimed-task rule, reviewers, record files) | per-test red |
| T3 completion and attribution | 32 tests, **31 fail** | per-test red |
| T4 guard-config pin | 1 test, 0 pass: `Cannot find module '../lib/greenfield/pin'` | load error |
| T5 closure rule | **no red run was taken**: I wrote the tests and `closure.js` back to back and ran them only after both existed. A gap in the method, reported as such | the rule-removal battery (section 4) is the evidence that these tests depend on their rules |
| T5b closure CLI and the paired-run proof | 106 tests, **12 fail** | per-test red |
| T6 preflight and spoof matrix | 1 test, 0 pass: `Cannot find module '../lib/greenfield/preflight'` | load error |

## 4. Rule-removal battery (my own; every rule's tests are not vacuous)

The preload `scratchpad/drop-rule.js` makes one rule id never be reported by the bundle validators, the audit, a rule refusal, the problem-returning functions of `ownership-ops.js`, and the hook's path policy (loaded through `NODE_OPTIONS`, so the hook and CLI processes the tests spawn load it too). `scratchpad/mutation-run.js` ran all gf test files once per rule.

**Run 1, on the build tree `260f1ed` (T6), 754 tests per rule, 16:01Z to 16:16Z: 37 rules, every one fails at least two tests when removed, 0 untested.**

| Rule | Fail | Rule | Fail | Rule | Fail | Rule | Fail |
|---|---|---|---|---|---|---|---|
| GF-OWN-1 | 6 | GF-OWN-2 | 17 | GF-OWN-3 | 13 | GF-OWN-4 | 9 |
| GF-OWN-5 | 34 | GF-FRZ-1 | 7 | GF-CONF-1 | 24 | GF-CLOSE-1 | 33 |
| GF-CLOSE-2 | 19 | GF-CLOSE-3 | 10 | GF-CLOSE-4 | 10 | GF-CLOSE-5 | 15 |
| GF-PRD-1 | 16 | GF-PRD-2 | 15 | GF-PRD-3 | 16 | GF-ARC-1 | 16 |
| GF-CON-1 | 13 | GF-CON-2 | 12 | GF-CON-3 | 21 | GF-CON-4 | 12 |
| GF-CON-5 | 9 | GF-THR-1 | 19 | GF-WBS-1 | 22 | GF-WBS-2 | 9 |
| GF-WBS-3 | 12 | GF-ART-1 | 5 | GF-ART-2 | 18 | GF-ART-DRIFT | 2 |
| GF-EST-1 | 21 | GF-SEAL-1 | 12 | GF-INIT-1 | 6 | GF-ORD-1 | 2 |
| GF-FRZ-2 | 7 | GF-FRZ-5 | 19 | GF-MSG-1 | 13 | GF-MSG-2 | 4 |
| GF-AUD-1 | 4 | GF-AUD-2 | 3 | | | | |

The drafts namespace has no rule id, so the battery cannot remove it; its tests are rows of `tests/gf-permissions.test.js`. **Run 2, on the final tree:** **not run.** The rule-removal battery ran once, on the build tree; the engine batteries 1 to 4 (section 5) are the mutation evidence on the later trees, and the round-4 readiness reviewer re-applied the three section-18 survivor mutants by hand (`ev-mw6s2lqa-013f1486`, `ev-mw6s3anz-015969e0`, `ev-mw6s3ng3-012b02e0`). A gap against my S1 practice, named here.

## 5. The engine battery (GF-CLOSE-3), on S2 itself

`eccode-gf close battery --scope S2 --test "<the gf suite, with its temporary directories in the scratchpad>" --base 3f6ee65 --max 20`, run in the closure record's checkout (section 7).

| Round | Tree | Result |
|---|---|---|
| (void) | `ee5ab63` (`e8fee82`) | **refused by the rule itself**: "the tree changed while the battery ran: the run is void and is not recorded". The disk had filled during the run (section 10); `git status` cannot answer on a full disk, and the battery treats an unknown state as dirty (fail closed). Nothing was recorded |
| 1 | `ee5ab63` (`e8fee82`), 16:40Z to 16:55Z | 20 mutants, **17 killed, 3 survived**: `closure.js:230` (`!==` to `===`: no test forged a resolution whose proof comes after it), `ownership-ops.js:224` (`||` to `&&`: no test replayed a command-only rescope), `ownership.js:41` (`||` to `&&`: no test gave a path with a NUL). Each got a test (`d634a2c`) |
| 2 | `f7b3db2` (`010ac02`), 17:09Z to 17:27Z | 20 mutants, **18 killed, 2 survived**: `events.js:83` (`additionalProperties: false` on the dispatch inputs' items flipped to true), `ownership-ops.js:127` (`||` to `&&` in the rescope check's early return). The first got two tests (`78dae31`); the second is killed on the round-3 tree by the test of a rescope of an unknown task (applied by hand) |
| 3 | `faa7031a` (`78dae31`), 18:31Z to 18:48Z, run before the closing round so that a survivor could still get a test | 20 mutants, **19 killed, 1 survived**: `guard.js:123` (`name === 'ruby'` to `!==`: `ruby -i` dropped as a writer, and any other command with an `-i` flag taken for one). Two tests (`21ef6eb`). The mutation tool picks 20 evenly spaced mutants from the changed source lines and excludes test files, so a tree that adds only tests is mutated in the same 20 places |
| 4 | `bceec2c` (`21ef6eb`), after the round-4 reviews | 20 mutants, **20 killed, 0 survived** (`bat-mw6swl1p-02ad7c8a`, evidence `ev-mw6swl1f-01744b1f`, 19:13Z to 19:33Z): the same 20 places as battery 3, as predicted before the run |

## 6. L-GF-17 (owner condition 4)

The assessment is design 16.4, written before any S2 code. Result: on the managed path, group A cannot act as group B **while two controls outside the log hold** (the per-role server lock with the harness tool list, and the hook); the layer did not check them, and a failure is silent. Not accepted silently:
- **F0 built:** `eccode-gf preflight`, `gf_preflight` and the audit's `managedPath` section report the regime (`managed-path` or `text-level`) with warnings that name the consequence. Tested for the sandbox, no-shell and guard profiles, a project never installed, a removed or narrowed guard matcher, a foreign tool in an agent's list, a server not locked to its role, and `ECCODE_HOOKS=off` (`tests/gf-spoof.test.js`).
- **The two controls, proven per pair:** for all 56 ordered pairs of the 8 group roles, the real hook denies a call to another role's MCP server and an `--actor` of another role on the command line; a tool of a locked server ignores an `actor` argument.
- **F1 built:** GF-OWN-3 checks the completing actor against the task's owner (after round 1) and the listed files against the actor's group; GF-OWN-4 attributes paths through the map in force. Against a writer who controls the actor string this is narrow, as design 16.4 now says: a forger must name the task's owner, and one who does passes (L-GF-17).
- **The residual, stated as a test:** an event forged through the store with another group's actor audits clean on the ownership rules (`RESIDUAL (L-GF-17)` in `tests/gf-spoof.test.js`); it must change when keyed attestation exists.
- **F3, keyed attestation, proposed and not built** (L-GF-20), for the owner's decision; recommended for S5.

## 7. S2 under its own closure rule (not closed)

S2 is the first slice put through GF-CLOSE-1 to 5, and it is not closed: the rule refuses, as it should while findings are open. The closure record is a Greenfield-Senior record initialised at 16:22Z, at the start of round 1, inside a separate checkout of the build tree (`scratchpad/s2-record`, a `git worktree` of `e8fee82`), and moved with that checkout from commit to commit (`e8fee82`, `9215bff`, `010ac02`, `86efe13`, `4619c33`, `78dae31` and `21ef6eb`). The repository's tracked dogfood `.eccode/` was moved aside there before `eccode-gf init`: a working-tree change under `.eccode/`, which the clean-tree check excludes; the tree hash still includes the commit's tracked `.eccode/` files (design 16.5, tree identity). Every step below was recorded by the commands of the rule; reviewers recorded their own reviews with their own role. **The record is archived in `docs/build/gf-s2-record/`** (the hash-chained log, the command logs, the paired-run tables, the usage snapshots and the open round-4 reproductions), with how to re-audit it.

**S2 is not closed.** Four review rounds are in the record, each with its own three dispatches (round 1 had two steps, as registered), every finding of rounds 1 to 3 is resolved with its proof (79 resolutions: 28, 32 and 19), and four engine batteries were recorded. Round 4 raised 22 findings (section 8). They are unresolved, and the rule refuses the close: `eccode-gf close status --scope S2` reports **22 problems, every one GF-CLOSE-2**, one per unresolved round-4 finding; nothing else stands in the way: the three steps on the closing tree, readiness go with no standing no-go, the closer not a reviewer, two or more batteries with the last on the closing tree after the last fix and no survivor, all pass. The record's audit is clean (0 errors; 3 warnings, the text-level regime warnings of a checkout that is not an installed project). I stopped there, as I said I would if round 4 were not clean, and put the convergence question to the owner (section 12) instead of starting a fifth round.

| Record | Count |
|---|---|
| events in the closure record | 309 |
| dispatches / reviews | 11 / 11 (round 1: 2; rounds 2 to 4: 3 each) |
| findings raised / resolved | 101 / 79 (rounds 1 to 3: 79 raised, 79 resolved; round 4: 22 raised, all open; readiness steps carry no findings) |
| fix verifications (defects) / paired runs (documentation) | 12 / 67 for rounds 1 to 3 (R2-1, R2-2, C2-1 to 5, D2-1 to 5 / R1-1 to 26, C1-1 to 27, D1-1 to 14), plus the D3-1 fix verification as evidence |
| engine batteries | 4 (17, 18, 19 and 20 of 20 killed) |

## 8. The independent review: findings and dispositions

**Round 1, on tree `ee5ab63` (`e8fee82`).** R1 comprehension (technical-reviewer, review `rev-mw6naux9-01e4eb6a`): **26 documentation findings** (1 blocking, 11 major, 14 minor). R2 critique (security-reviewer, review `rev-mw6naeuh-013836a5`): **2 defects** (1 blocking, 1 major).

| Finding | Disposition | Proof recorded in the closure record |
|---|---|---|
| R2-1 (blocking): one fix proof could resolve any number of findings, through the normal commands | fixed (`d634a2c`): one proof proves one finding; the closure counts only valid records | fix-verify **proven**: pre-fix `ev-mw6nof18-0196f560` failed as a reproduction at `e8fee82`, post-fix `ev-mw6nog7m-024a0cac` passed |
| R2-2 (major): forged battery events (a re-cited run, a relabelled run, hidden survivors) were counted | fixed (`d634a2c`): a battery is tied to its own run (evidence right before it by the same actor, cited once, its numbers and survivors the run's, a real tree object) | fix-verify **proven**: pre-fix `ev-mw6nohu8-0126963a`, post-fix `ev-mw6noj7k-02912c91` |
| R1-1 to R1-26 (documentation) | fixed (`9215bff`), each by a test in `tests/gf-docs-s2.test.js` named by its id | 26 paired runs: each test failed as a reproduction before the documents were edited (`scratchpad/r1-repro.tsv`), then passed (`scratchpad/r1-post.tsv`); one command per finding |
| R1-6 also exposed a code gap: a completion forged by one group of another group's task was not reported | fixed with its own red then green test (`9215bff`) | covered by the R1-6 paired run and by `tests/gf-own-complete.test.js` |

Found by me while resolving: `eccode-gf close resolve --proof <ev>` lost its value, because the frozen argument parser treats `--proof` as a boolean; fixed with `--proof-run` and a usage error, red then green (`010ac02`).

**Round 2, the first closing round, on tree `f7b3db2` (`010ac02`).** R1 comprehension (technical-reviewer, `rev-mw6ofrk5-01528735`): **27 documentation findings** (7 major, 20 minor). R2 critique (security-reviewer, `rev-mw6ojj91-011cb13f`): **5 defects** (1 blocking, 3 major, 1 minor). R3 readiness (architecture-reviewer, `rev-mw6oqq0t-01d7095e`): **GO** with 36 citations; it named four clauses with no test, and each got one.

| Finding | Disposition | Proof |
|---|---|---|
| C2-1 (blocking): a slice closed with a blocking finding "fixed" by an unrelated proof, the tree unchanged | fixed (`c16de4c`): a fix-verify's pre-fix run must be at the tree the finding was raised on, and a closing round cannot carry a fixed finding | fix-verify **proven** at base `010ac02` |
| C2-2 (major): skip-worktree and assume-unchanged hid a working-tree change from the clean-tree check | fixed (`c16de4c`) | fix-verify **proven** |
| C2-3 (major): the audit threw on an unreadable or ill-typed settings file | fixed (`c16de4c`) | fix-verify **proven** |
| C2-4 (major): a symlink in a group's own drafts let the file tools write anywhere, the event log included | fixed (`c16de4c`): every path is judged where it lands | fix-verify **proven** |
| C2-5 (minor): `ln -sf`, `install`, `dd of=`, `perl -pi`, `touch`, `patch`, `git checkout --`, `git restore` were not modelled as writes | fixed (`c16de4c`) | fix-verify **proven** |
| C1-1 to C1-27 (documentation) | fixed (`86efe13`), each by a test in `tests/gf-docs-s2b.test.js` | 27 paired runs (`scratchpad/c1-repro.tsv`, `c1-post.tsv`) |

**Round 3, on tree `9fd568e` (`86efe13`).** R1 comprehension (`rev-mw6phfb2-01c87621`): **14 documentation findings** (3 major, 11 minor). R2 critique (`rev-mw6poscr-01edc5aa`): **5 defects** (1 blocking, 1 major, 3 minor). R3 readiness (`rev-mw6q3txu-010a6624`): **GO** with 26 citations, the full suite with the venv among them (1,482 tests, 1,468 pass, 0 fail, 14 skipped, `ev-mw6pjl79-014630de`), and one residual.

| Finding | Disposition | Proof |
|---|---|---|
| D2-1 (blocking): a group role reached another group's path, the contracts, a guard config or the event log through `/proc/self/root/<project>/...`, which the hook took for a path outside the project | fixed (`4619c33`): an absolute path that really leads into the project is judged as that project path | fix-verify **proven** at base `86efe13` |
| D2-2 (major): `status.showUntrackedFiles=no` in the repository hid an untracked file from the clean-tree check | fixed (`4619c33`): the check forces its own git configuration | fix-verify **proven** |
| D2-3 (minor): a later readiness go on the same tree overrode a no-go | fixed (`4619c33`): a no-go on the closing tree stands | fix-verify **proven** |
| D2-4 (minor): a dispatch input reached the working record through a committed symlinked directory | fixed (`4619c33`): every input is judged where it lands | fix-verify **proven** |
| D2-5 (minor): one forged rescope with a non-list of files stopped the audit before the pin and closure sections | fixed (`4619c33`): the S2 sections are isolated, and the replay skips that event with a GF-OWN-1 report | fix-verify **proven** |
| D1-1 to D1-14 (documentation) | fixed (`4619c33`), each by a test in `tests/gf-docs-s2c.test.js`; D1-10 added L-GF-28 | 14 paired runs (`scratchpad/d1-repro.tsv`, `d1-post.tsv`) |
| Readiness residual: with a configuration that names the closer a reviewer, the closer could record a step and close | enforced in code (`4619c33`, D3-1): a closing review recorded by the closer does not count, at close and in the audit | not a recorded finding (a readiness review carries none); fix-verify **proven** at base `86efe13` as evidence |

**Round 4, on tree `bceec2c` (`21ef6eb`).** R1 comprehension (`rev-mw6rvgc2-01f2b30b`): **14 documentation findings** (3 major, 11 minor). R2 critique (`rev-mw6rx0pf-01727481`): **8 defects** (4 major, 4 minor; none blocking), each with a reproduction that fails on that tree. R3 readiness (`rev-mw6s5sgw-01ca4530`): **GO** with 50 citations (its own 52-check probe of the hook and the engine, the full suite with the venv, the three survivor mutants applied by hand, the frozen set, no later-slice item claimed), and three residuals. **All 22 findings are unresolved; nothing was fixed after round 4.**

| Finding | Severity | What it says |
|---|---|---|
| E2-1 | major | `mv` removes its source, and the hook judges only the destination: a group role moves another group's file, a contract or a guard config out of the project |
| E2-2 | major | a hard link is judged by its name only: `ln -f` or `cp -l`, then a write through the link, changes another group's file or a sealed contract |
| E2-3 | major | `cd dir;`, a `cd` on its own line, and `pushd` are not followed, so a `../` target is taken for a path outside the project |
| E2-4 | minor | a subagent's `git apply`, `git mv` and `git rm` are not modelled as writes |
| E2-5 | major | GF-OWN-4 attribution misses a committed cross-group rename: the frozen engine's `git diff --name-only` (in `lib/project.js`, frozen) reports the new name only |
| E2-6 | minor | a dispatch input hard-linked to the event log is accepted (the symlink form is refused) |
| E2-7 | minor | the clean-tree check still honours `core.excludesFile` and `.git/info/exclude`, which are outside the reviewed tree |
| E2-8 | minor | the preflight reports the managed path when project settings switch the hook off (`env.ECCODE_HOOKS=off`, `disableAllHooks`); the reviewer did not check that the harness applies them to the hook |
| E1-1 | major | 2.2 (as amended in round 3) gives group roles a shell in `sandbox` and `guard`; the 16.4 vector table still says `guard` only, and has no row for a shell write of another group's files |
| E1-2 | major | "no initialised record" (not Greenfield-Senior, fail open) against "the record cannot be opened" (fail closed): the boundary is not defined |
| E1-3 | major | 16.5 and L-GF-19 say a review is recorded only by a reviewer role with the actor locked; 16.4 says the actor is asserted, not bound, so closure independence rests on L-GF-17's assumptions, which 16.5 does not say |
| E1-4 to E1-14 | minor | eleven more: "reviewer-only" resolutions; the precedence order; what makes a review valid; "a test that kills it" against a closing battery; which battery is the final one; `.eccode/` paths in completions; GF-OWN-5's message conditions; a counter reset; how P4 and P5 are scored after the three-step split; the paired run's tie to "a failing test"; Semgrep raw output in 17.5 and 17.8 |

Residuals the readiness reviewer named: (a) GF-OWN-3 judges the listed files as written, without following a symlinked directory (the hook and `eccode-gf attribute` still catch the write); (b) the post-close items of 16.8 item 5 (this file, the ledger row, the scoring) were not in the tree it reviewed; (c) the hook allows a call when it hits an internal error outside `policy()` unless `ECCODE_STRICT=1`.

| Round | Tree | Comprehension (documentation) | Critique (defects) | Readiness | Battery after the round's fixes |
|---|---|---|---|---|---|
| 1 | `ee5ab63` | 26 (1 blocking, 11 major, 14 minor) | 2 (1 blocking, 1 major) | (not in round 1) | 18 of 20 on `f7b3db2` |
| 2 | `f7b3db2` | 27 (7 major, 20 minor) | 5 (1 blocking, 3 major, 1 minor) | GO, 36 citations | (round 3's tree had none of its own) |
| 3 | `9fd568e` | 14 (3 major, 11 minor) | 5 (1 blocking, 1 major, 3 minor) | GO, 26 citations | 19 of 20 on `faa7031a` |
| 4 | `bceec2c` | 14 (3 major, 11 minor) | 8 (4 major, 4 minor) | GO, 50 citations | 20 of 20 on `bceec2c` |

## 9. Accounting and estimate versus actual

**Unit: all processed tokens** (input + output + cache reads + cache writes), from `get_session` `external_metadata.usage`.

| Snapshot | Taken | All processed | Output | Cost (harness) |
|---|---|---|---|---|
| S2 start | 15:17Z (`s2-usage-start.json`) | 129,493,617 | 669,298 | $24.70 |
| interim | 17:49Z (`s2-usage-interim.json`) | 129,493,617 (unchanged in every field) | 669,298 | $24.70 |
| interim 2 | 18:32Z (`s2-usage-interim-2.json`) | 129,493,617 (unchanged in every field) | 669,298 | $24.70 |
| S2 end | 19:13Z (`s2-usage-end.json`) | 395,929,180 | 2,118,265 | $136.98 |
| **S2** | difference | **266,435,563** (97.0 percent cache reads) | **1,448,967** | **$112.28** |

The usage figure is updated late, not continuously: it stood still from 15:17Z to at least 18:32Z while `context_usage` moved from 146,182 to 574,984. Whether it includes the delegated agents' tokens is unmeasurable. The cost is the harness's own figure for this session's compute; no paid benchmark run was launched (the owner's "no paid runs, $0 on the meter" refers to those).

**Estimate versus actual** (registered in 16.7 before any S2 code, amended in 17.9 for the owner's continuation before the work it covers was measured):

| Item | Registered | Actual | Verdict |
|---|---|---|---|
| Wall time, active | 2.5 to 4.5 h; amended 3 to 6 h | 15:17Z (start snapshot) to 18:52Z (last S2 commit, `21ef6eb`) is 3 h 35 min; to the report about 4 h 20 min | inside the amended range |
| New production code | 900 to 1,500 lines | 1,299 added, 30 deleted (`lib`, `bin`, `scripts`, `3f6ee65..21ef6eb`) | inside |
| New test code | 1,600 to 2,800 lines | 2,532 added, 17 deleted (`tests`) | inside |
| Tests (`# tests` of `node --test tests/gf-*.test.js`) | 130 to 260 | 538 (382 at `3f6ee65`, 920 at `21ef6eb`) | over, 2.1 times the top; 117 of them are in the seven review-round test files (`tests/gf-review-s2*.test.js`, `tests/gf-docs-s2*.test.js`), and the survivor tests went into existing files |
| Tokens, all processed | 40 to 150 M; amended 60 to 210 M | 266.4 M | over the amended range by 27 percent of its top |
| Output tokens (informational) | 0.3 to 1.0 M | 1.45 M | over |
| Reviewer dispatches | 5 if two rounds suffice, 3 more per further round | 11 (four rounds: 2 + 3 + 3 + 3), as the formula gives for four rounds | the count matched; the number of rounds was not registered |
| Delegated research agent | 1, 0.3 to 0.8 M as reported | 1, 192,097 as reported | under |
| Reviewer agents | 0.3 to 0.6 M each as reported | 113,993 to 358,830 per final notice | at or under |
| Paid runs | $0 | $0 (no benchmark arm launched) | as registered |

**Predictions, scored strictly against their registered wording:**
- **P4 (the first independent pass finds at least three defects of major or blocking severity in the S2 code): not confirmed.** Round 1's critique raised 2 (R2-1 blocking, R2-2 major). R1-6, a major documentation finding of the comprehension step, exposed a third code gap while I resolved it; it was recorded as documentation, so it does not count. (A note during the work called P4 confirmed; that was wrong.)
- **P5 (the second pass finds at least one defect the first pass's fixes introduced or the first pass missed): confirmed.** Round 2's critique raised 5, among them C2-1 (blocking).
- **P6 (at least one of the 35 FastAPI-dependent tests fails on the unchanged S2-start tree because of the library versions): not confirmed.** The 5 failures of the first venv run were an environment path, not library drift; with the venv at the path the fixtures name, 0 fail (section 2).
- **P7 (the closing round raises at least one finding the first round did not): confirmed**, in every closing round (32, 19 and 22 findings).

## 10. Incidents

- **Disk full at about 16:25Z.** The writable allowance was spent by thousands of throwaway test projects in the system temporary directory (51,342 at the count) and by the tool measurement's caches (the Trivy database is 1.6 GB). Effects: command output was lost, the first engine battery was voided by the rule (section 5), and the reviewers were asked to re-run anything that ran during the window (R2 confirmed its two reproductions afterwards). I deleted only my own scratch (the measurement's caches, the S1 reviewer's bulk copies); a sweep of the shared `/tmp` was refused by the permission check and not attempted again. Later runs keep their temporary directories in the scratchpad and delete them.
- **Two worktrees briefly created at `/s2-record` and `/s2-tree`** (a backgrounded `&&` chain lost a variable). Removed at once, recreated in the scratchpad.
- **Signing.** Tests that make commits in throwaway repositories ran with signing disabled by environment variable only; every commit of the branch is signed.

## 11. Delegated agents (one ledger row each; `docs/build/compute-ledger.md`)

Twelve delegated agents, each a ledger row in `docs/build/compute-ledger.md` with its tokens, tool uses and wall time as the harness reported them: the tool measurement (192,097), and eleven zero-context reviewers (round 1: R1, R2; rounds 2 to 4: R1, R2, R3). Sum of the final notices: **2,931,577**; sum of each agent's largest notice: 3,215,234. The harness does not say whether several notices of one agent are cumulative, so neither sum is the agents' total. Every reviewer recorded its own review with its own role; none was given my conclusions, earlier reviews or the evidence file (which was not in the tree it received).

## 12. The decision for the owner: the closing rounds do not converge

The rule requires a closing round with no unresolved finding. A fixed finding changes the tree and needs a new round; only a minor finding can be deferred, and only by the user. Four rounds have run. Readiness said GO three times in a row, the batteries went 17, 18, 19 and 20 of 20, and blocking findings stopped in round 4. But every round's fresh reviewers found new majors: in round 4, 3 documentation and 4 defects. Two causes are visible in the data:
1. **The hook's shell-text model is open-ended.** 4 of round 4's 8 defects (E2-1 to E2-4) are further shell forms, after the nine commands of round 2 (C2-5); round 3's blocking D2-1 was another path form (`/proc/self/root`). Modelling one more command per round does not end.
2. **The design document grows with every fix.** Each round's documentation fixes add text, and new text adds new inconsistencies: E1-1 and E1-8 were introduced by my round-3 fixes.

Options, my recommendation first:
- **A. One more round, with structural fixes and a stop rule registered before it (recommended).**
  - (i) Shell writes: stop modelling commands one at a time. In a Greenfield-Senior project, the hook denies Bash to group roles; tests run through the engine's approved-command runner, as the `no-shell` profile already does. That removes the class E2-1 to E2-4 on the managed path, rather than patching it. The `guard` profile stays best effort and named (L-GF-1). This is a change for S3's builders, and it is yours to make.
  - (ii) Fix E2-5 to E2-8 in `lib/greenfield`, with no frozen file touched: attribution with its own `git diff --no-renames`; a hard-link check by link count for dispatch inputs and file-tool writes; the clean-tree check without the repository's exclude files; the preflight reading `disableAllHooks` and `env.ECCODE_HOOKS`.
  - (iii) Fix the three major documentation findings, and consolidate: make section 18 the single as-built statement of S2, and section 16 its history.
  - (iv) The stop rule: if round 5 raises no blocking or major finding, you defer its minors with limit ids (the rule already allows that) and S2 closes; if it raises a major, I stop again.
  - Cost, my judgment and not a measurement (the usage figure did not move during rounds 2 to 4, so no per-round figure exists): about 1.5 h and 60 to 100 M all-processed tokens.
- **B. Let the user defer a major finding too** (an engine change), and close S2 now on `bceec2c` with the 22 findings as named limits carried into S3. About 20 minutes. It weakens the gate you made permanent, which the standing rules forbid, so I do not recommend it.
- **C. Keep the rule and repeat rounds until one is clean.** There is no bound: each of the last two rounds raised 19 to 22 findings, and S2's 266 M over four rounds and the build suggests some tens of millions of tokens a round (a judgment; no per-round figure was measured). Not recommended.

