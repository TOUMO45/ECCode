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

## Finding-by-finding verdicts
Filled after the independent verifier's report (`docs/evidence/verification-0.3.0/REPORT.md`).

## Release blockers found so far
- **RB-1** The documented install path (marketplace default branch) does not install 0.3.0. Resolution: merge the work branch into the default branch or point the marketplace at the release commit; re-verify with a clean plugin install.
- **RB-2** Windows guard fail-open (above): repaired on a branch, pending independent review and a Windows run.
