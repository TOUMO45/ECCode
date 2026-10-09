# ECCode 0.3.0: independent verification of the review repairs (F1–F9)

**Status:** in progress (2026-10-09). This is the lead's matrix; the independent verifier's own report lives in `docs/evidence/verification-0.3.0/REPORT.md` and takes precedence where they differ.

## Claims checked against the repository
| Claim (developer report) | Checked | Result |
|---|---|---|
| Reviewed commit `b8def3da…` is the tip of `claude/brave-bardeen-6y5ng9` | `git ls-remote`, `git merge-base` | True. Linear history: default `claude/keen-allen-5z33eb` (0.1.0, `d2d0c24`) → `b8def3d` (reviewed) → `5da8913` (`claude/funny-feynman-rt1io9`, 0.3.0) |
| Version 0.3.0 at `5da8913` | `package.json`, `.claude-plugin/*.json` | True (`npm run validate` checks the three agree) |
| 233 passing tests | `npm run check` on Linux, Node 22.22 | True: 233/233, toolkit validation passed |
| Documented installation path installs this version | README quick start points at the marketplace (`TOUMO45/ECCode`) whose default branch is still `claude/keen-allen-5z33eb` (0.1.0) | **Not true as documented**: installing from the default branch yields 0.1.0. The work branch must be merged to the default branch (or the plugin install must name the branch) before "install the release" holds. Recorded as release blocker RB-1 |
| Review bundle preserved byte for byte | `sha256sum -c MANIFEST.sha256` | 5 files OK |
| Probes are reconstructions, not the reviewer's `review-probes.cjs` | bundle README | Disclosed by the branch; restated here |
| CI green on supported platforms | GitHub Actions run 37947041902 | Linux and macOS × Node 18.17/20/22: success; Groundwork suite: success; Windows (non-gating): **failure, 2 of 233** |

## Probe results (reconstructed probes, `docs/evidence/review-bundle/probes/`)
Run by the lead on 2026-10-09, Linux, Node 22.22.0, `ECCODE_TEST=1`. Raw outputs: session scratch `probe-results/*.{old,new}.json` (copied into `docs/evidence/verification-0.3.0/lead-probe-runs/`).

| Probe | Old `b8def3d` | Repaired `5da8913` |
|---|---|---|
| F1 review coverage + bogus anchor | approved with one criterion | `REVIEW_REJECTED`: anchor not found; required criteria AC1, AC2 not covered |
| F2 omitted owned file | completed, approved, delivered | `INVALID_HANDOFF` at completion (undeclared owned change); the probe's own control path then fails the F1 coverage rule (probe predates 0.3.0 rules) |
| F3a unrelated passing check | completed and approved | `INVALID_HANDOFF`: must cite a passing run of the declared command by the owner after the claim |
| F3b log deleted/altered | still resolvable, completed, approved | probe aborts earlier (`DEPENDENCY_PENDING`, stricter setup); covered by `tests/review-F1-F3.test.js` and the verifier's variation |
| F4 reviewer shell writes (10 cases) | no denial | all denied (redirect, sed -i, cp, inline node/python writes) |
| F5a main session `--actor user` | allowed; reopen succeeded | denied by the guard in every context; CLI refuses without a TTY |
| F5b open critical risk delivered | delivered | probe aborts at phase approval (coverage rule); covered by `tests/review-F2-F5b.test.js` and the verifier's variation |
| F6 tampered shared lesson | `applies`, no objection | quarantined: "shared record content changed after promotion" |
| F7 forged snapshot | trusted; design gate advanced; rebuild laundered it | `SNAPSHOT_DIVERGED` thrown before any transition |

## Windows (F9)
- Declared platforms: Linux and macOS (gated). Windows is reported, not claimed. The five failures from the review's Windows run are gone on `5da8913`; two different tests fail (`tests/review-F4-F5-guard.test.js` 131, 133) and one is skipped (pty). Analysis: `docs/evidence/verification-0.3.0/windows-ci-5da8913.md`.
- Root cause: the guard tokenized native Windows paths with POSIX escaping, dropping separators: a shell write to a shared-memory record was not denied on Windows (fail-open), and an absolute path after a `cd` was denied as relative.
- Repair: branch `eccode/win32-guard-paths`, commit `cde0b84` (record patterns accept both separators before tokenizing; the CLI is recognised by its Windows path; the tokenizer keeps path backslashes on win32, failing closed). 4 new tests; 237 pass on Linux. Independent review pending. **A Windows run is still required to confirm**; the CI job remains the confirmation.

## Finding-by-finding verdicts (independent verifier, 2026-10-09; report `docs/evidence/verification-0.3.0/REPORT.md`, probes and results alongside)
The verifier was a fresh agent context that did not write the repairs. Engine probes ran on `5da8913`'s engine (`lib/`, `bin/`, `schemas/` identical through `279376b`); guard probes used a `git archive` snapshot of `5da8913`'s guard. Linux, Node 22.22. Zero unexpected steps; every accepted bypass is classified NEW or RESIDUAL in the result files.

| Finding | Demonstrated bypass on 0.3.0 | Variations | Verdict | New defects |
|---|---|---|---|---|
| F1 coverage | refused (`REVIEW_REJECTED`) | look-alike ids, duplicates, table criteria, anchors: refused/handled | **Not closed** | NEW-1 blocking: criteria derived from the brief **on disk**, not the pinned bytes; an edited brief launders the required list through verification. NEW-2: a brief with no ids has no required criteria |
| F2 file coverage | refused (`INVALID_HANDOFF`, `DIRTY_OWNERSHIP`, `DELIVERY_BLOCKED`) | rename, deletion, untracked, committed after approval | **Not closed** | NEW-3 blocking: a file committed between a phase approval and the verification submission disappears from the release check once verification is approved. NEW-4: `git mv` leaves the old path undeclared |
| F3 evidence binding | refused | whitespace, tree digest, altered log, wrong actor | Closed with residual | NEW-5 (non-blocking): `--cwd` not bound (schema refuses `verification.cwd`); environment not bound (documented) |
| F4 reviewer shell writes | all ten probe cases and ~40 variants denied | | **Not closed** | NEW-6 blocking: `>|` clobber redirect allowed for every role. Known-shape escapes (rm, git apply, patch, curl -o, tar -x, symlink outside, …) documented as residual 1 |
| F5 human channel | `--actor=user`, `User`, exported `ECCODE_ACTOR`, piped `yes`, every delegation misuse: refused | | Closed with residual | NEW-7 (non-blocking): a shell function wrapper hides the CLI from the guard; the CLI itself has no role binding |
| F6 shared memory | one byte of solution/status/trust/layer, deleted or reordered index lines, replaced file: quarantined | | Closed with residual | NEW-8: metadata outside the hash (reviewer name, evidence status) unbound; NEW-9: inline `ECCODE_SHARED_MEMORY` allowed by the guard; residual 3 confirmed |
| F7 trusted state | forged snapshot → `SNAPSHOT_DIVERGED`; crash-shaped torn tail recovers; fault-shaped tail → `LOG_ROLLBACK`; 8 concurrent writers consistent | | Closed with residual | rewrite-and-rehash of the whole chain undetected (residual 3); a forged `actor: user` event appended offline passes audit and the handoff calls it a confirmed user decision (wording over-claims) |
| F8 limits | concurrent `run start` respects the cap; reservation arithmetic; unknown usage stays unknown | | **Closed** | — |
| F9 release | validate, pack, offline tarball install, `require('eccode')`, eol policy, fixture scan, versions, upgrade/rollback | | Closed with residual | Windows not run; tarball ships 8 MB of docs/evidence (hygiene) |

Overblocking: none found; every legitimate completion passed.

## Repairs in progress (branch `eccode/verification-repairs`, worktree)
| Defect | Repair | Status |
|---|---|---|
| NEW-6 `>|` | tokenizer keeps the bar of a clobber redirect in the operator word | committed, 4 tests, pending independent review |
| Nested root (pilot) | hook cwd finds the root first; every target judged by the nearest record above it | committed, pending review |
| NEW-9 | `ECCODE_SHARED_MEMORY/ROOT/SEQUENTIAL_ROLES/HOOKS` refused inline | committed, pending review |
| NEW-7 | shell function/alias wrapper around the CLI refused | committed, pending review |
| NEW-1, NEW-2, NEW-3, NEW-4, NEW-5 | engine repairs (implementer agent, 5 commits on `eccode/verification-repairs`): pinned-bytes check for required criteria (`APPROVED_ARTIFACT_CHANGED`), baseline-commit release diff plus verification-approval check, no-ids refusal with `[]` opt-out, `--no-renames`, `verification.cwd` bound | **independently reviewed: approved** (`docs/evidence/verification-0.3.0/engine-repairs-review/REVIEW.md`: verifier's probes re-run, 98-step attack probe, 246/246; three low findings L1–L3 on messages and cwd spelling, fixed as follow-ups) |
| Guard review round 2 (`d0e2a3b`) | reviewer found a second blocking regression (a record **alias** made with allowed commands, `ln -s "$PWD/.eccode" rec`, plus a planted copy re-rooted the guard) and that the directory pattern, the wrapper name class, the dynamic CLI word and the computed-name rule were all lexical and incomplete (G1–G11) | **restructured** in `3fa6298`: every target judged on its real path for every context; "everything under `.eccode/` except the draft areas is the record"; `findRoot` on real paths only; `$'…'` quoting; expansions stripped before matching the CLI word; over-denials removed. 245/245. Third review pending. Lesson for the threat model: the original review's statement that "adding more shell regular expressions alone is not a dependable boundary" was confirmed twice in one day |
| Guard review round 1 (`ffbdc8d`) | reviewer found a **blocking regression** (a record planted inside `.eccode/` re-rooted the guard), incomplete `>|` and wrapper coverage, a pre-existing quoting trick (`ecc"ode".js`) that hid the CLI | fixed in `80ddab0`: record files judged on the absolute path before any root; `findRoot` never accepts a directory inside a record; `init` refuses such a root; the record directory itself cannot be copied into, synced, moved, extracted into or deleted; wrappers caught unanchored at every depth; the CLI recognised on tokenized words; computed-name assignments refused. Re-review pending |

## Checkpoint 0.3.1
Both repair branches merged into `claude/serene-heisenberg-h9o5vo` after independent approval (engine: `ec4f641`, one round plus a follow-up; guard: `1fcda26`, five rounds, see `docs/evidence/verification-0.3.0/guard-repairs-review/REVIEW.md`). Version 0.3.1 in the three manifests; `npm run check`: 253/253, validation passed. This is the pilot's frozen toolkit version. Verdict per finding after the repairs, on the declared scope (Linux, Node 22; macOS by CI on 0.3.0 only until CI runs on this branch):

| Finding | Verdict at 0.3.1 |
|---|---|
| F1 | Closed on the declared scope: pinned-bytes criteria, no-ids refusal; residual 4 (a criterion's meaning) unchanged |
| F2 | Closed on the declared scope: baseline-commit release diff, verification approval checks it, renames declared; residual 6 (git-ignored files) and the `release.ignore` config edit (reviewer R1) remain |
| F3 | Closed with residual (environment not bound) |
| F4 | Closed for every demonstrated bypass; residual 1 (programs the guard cannot read) and the documented over-denials remain; the review's read-only snapshots/worktree isolation still need the host |
| F5 | Closed with residual 2 |
| F6 | Closed with residual 3 and NEW-8 (metadata outside the hash) |
| F7 | Closed with residual 3; handoff wording to qualify |
| F8 | Closed |
| F9 | Closed on Linux (and macOS by the 0.3.0 CI); Windows unverified; RB-1 open |

## Release blockers
- **RB-1** The documented install path (marketplace default branch) does not install 0.3.0. Resolution: merge the work branch into the default branch or point the marketplace at the release commit; re-verify with a clean plugin install. Needs the user (a push to the default branch).
- **RB-2 (closed)** Windows: two guard tests failed on 5da8913 (repaired, `4fc7e87`); on 0.3.1 two test fixtures with unquoted native paths failed (quoted, `d9c1cc6`); the Windows CI job then passed 253/253 (run 37974778884) and is gating from `d9c1cc6` on. Analyses: `docs/evidence/verification-0.3.0/windows-ci-5da8913.md`, `windows-ci-ad69e6d.md`.
- **RB-3** NEW-1, NEW-3, NEW-6 (blocking): repairs above; the pilot's payment phases do not start until these are merged after independent review (readiness gate).
