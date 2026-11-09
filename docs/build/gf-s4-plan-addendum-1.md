# S4 plan addendum 1: owner decisions D-1..D-6 and P-1, and the new Stage 1 ECCode base

This addendum records decisions and engineering made after the S4 plan was frozen. It does **not** edit the plan.
`docs/build/gf-s4-plan.md` stays frozen at commit `1240da2` (freeze-point hash in its last line). Where this addendum
and the plan disagree, this addendum records what changed and why. The plan text itself still states what was planned.

Branches: `s4-prereq/engine` (engine work) and `s4-prereq/finish` (from `9faeed2`; this addendum and the evidence report). Commits since the plan freeze: `e72497a` (predictions frozen), `caeafec` (D-2),
`35d5cc9` (D-1 + D-6 + CLI/audit wiring), `9faeed2` (snapshot 01 and the metering helper only).
Evidence: `docs/build/gf-s4-prereq-evidence.md`.

## 1. Decisions as recorded

| Id | Plan reference | Decision | Effect on the plan |
|---|---|---|---|
| D-1 | 11 P-5 | Add a stack profile **before Stage 1** (plan option 2). Built: `python-fastapi-postgres-worker-compose` (`lib/greenfield/profiles.js`). | The engine under test now has a compose/worker/dashboard profile. M7 and F6 results no longer measure "the profile cannot express compose". They measure whether the arm delivers within a profile that can. |
| D-2 | 11 P-2 | Build automated slice approval **before Stage 1**. Built: `lib/greenfield/approval.js`, opt-in `gf.approval.auto`, **off by default**. | Stage 1 tests "ECCode as it could be" on the approval axis, but only if the arm's config turns it on (open question O-1 below). |
| D-3 | 11 P-3 | R-1, R-2, R-4 and R-5 **stay open**. No re-base to close them. | The Stage 1 base inherits them unchanged from `650df34`. |
| D-4 | 2.3, 11 D-4 | Attach a sample CSV to every arm. | Plan section 2.3 holds a **proposed** CSV text. The final attached file is for the owner to write and freeze. This addendum does not invent, alter or approve a CSV format. |
| D-5 | 3, 11 D-5 | Model `claude-opus-5-5` for **every arm**, session and all subagents, passed with `--model`. | As the plan proposed. |
| D-6 | 3.1, 11 D-6 | **No docker socket for arms.** The operator runs `tools/deploy-check.sh` after the arm's final exit. Rootless docker per arm is only sketched (`docs/build/gf-s4-prereq-record/design-d6-rootless-docker.md`), not built. | Arms cannot self-test a deployment. This applies equally to all arms. The sandbox binding list in 3.1 drops "docker socket if D-6 allows". |
| P-1 | 11 P-1 | `gf.runtime.enforce` **stays opt-in** (plan option 1). `tests/gf-flow.test.js` is untouched. | Arms b and c stay distinct. Arm c sets the flag by config, as written in section 3. `git diff 1240da2 HEAD -- lib/greenfield/runtime.js` is empty. |

## 2. Stage 1 ECCode base: `650df34` → head of `s4-prereq/finish` (engine content = `35d5cc9`)

Plan section 3 defines arms b and c as "an ECCode engine export of 650df34". The proposed new base is the
**final commit of `s4-prereq/finish`** (hash given in the evidence report and the commit message), exported the same
way (`git archive <commit>` excluding `docs/`). Its engine content is identical to `35d5cc9`, the last engine commit:
everything after `35d5cc9` is under `docs/`. The plan's freeze still applies to
everything else.

Reasons for the change:
- **Engine scope (D-1).** At `650df34`, the engine had one stack profile (`python-fastapi-sqlalchemy-sqlite`) and no
  compose or worker handling. `35d5cc9` adds the compose profile, its scaffold, `eccode-gf stack check` and the audit
  section for it.
- **Autonomy (D-2).** At `650df34` every slice needs a human approval. `35d5cc9` adds the opt-in approver, the
  `auto-approval` and `intervention` event types, and the intervention counter.

`9faeed2` adds only record files under `docs/` (snapshot 01, `snap5.js`) on top of `35d5cc9`. An export that excludes
`docs/` is identical for both commits. The base is named as `35d5cc9` because that is the last engine commit.

Test status at this base (n=1 full run on `s4-prereq/finish`): 1831 tests, 1761 pass, 0 fail, 70 skip. The skips are
10 more than the baseline's 60 because the Python test environment was absent in a recycled container. See the
evidence report.

## 3. New switches and how arms b and c would set them

| Switch | Where | Default | Values |
|---|---|---|---|
| `gf.approval.auto` | `.eccode/config.json` | absent (approver approves nothing, GF-AUTO-0) | `{"enabled": true, "maxSlices": N, "maxTokens": T, "maxWallClockMinutes": M}`, each a positive integer |
| `--stack python-fastapi-postgres-worker-compose` | `eccode-gf init --name <n> --idea <text> --stack python-fastapi-postgres-worker-compose` (usage line, `bin/eccode-gf.js:17`) | v1 profile `python-fastapi-sqlalchemy-sqlite`, no scaffold | selects the compose profile and writes its scaffold |
| `gf.runtime.enforce` | `.eccode/config.json` | absent (off) | unchanged from the plan (arm c only) |

New CLI surface: `eccode-gf approve --scope <slice>`, `eccode-gf intervention record --actor user --type <type>`,
`eccode-gf interventions count`, `eccode-gf stack check`, `tools/count-interventions.js`,
`tools/deploy-check.sh [--dry-run] <tree> [--smoke "<command>"] [--timeout <s>]`.
New event types: `auto-approval` (actor `auto-approver`) and `intervention` (actor `user`).
New rules: GF-AUTO-0..5, GF-STACK-0..3, GF-INT-1.

**Open owner questions (not decided here):**
- **O-1.** Do arms b and c enable `gf.approval.auto`? If so, with which `maxSlices`, `maxTokens` and
  `maxWallClockMinutes`? Under plan 6.1, approvals made by an engine mechanism inside a pre-set budget are not counted,
  so this choice directly shapes M4 and F2. If it is not enabled, each slice approval is a counted intervention, as at
  `650df34`.
- **O-2.** Do arms b and c run `init` with `--stack python-fastapi-postgres-worker-compose`, or with the default
  profile? Plan section 3 says "project created by `init` with defaults". If the compose profile is used, that is a
  change to the arm definition and must be frozen before Stage 1.
- **O-3.** If O-1 or O-2 is yes, should the operator script write the config, as it does for `gf.runtime.enforce` in
  arm c? That would keep the setting outside the arm's reach and make it part of the arm definition, not an
  intervention.

## 4. Plan statements made obsolete by `35d5cc9` (the plan text is not edited)

| Plan location | Statement | Status at `35d5cc9` |
|---|---|---|
| 1, "Facts found" | "Nothing in `lib/greenfield/` mentions docker, compose or a background worker." | Obsolete. `lib/greenfield/profiles.js` declares compose, worker and dashboard services. The v1 constant `C.STACK_PROFILES` still lists only the v1 profile (pinned by `tests/gf-events.test.js:71`); the new profile is in `profiles.PROFILES`. |
| 3, arms b and c | "an ECCode engine export of 650df34" | Replaced by `35d5cc9` (section 2 above), subject to owner confirmation. |
| 10.1 M4, Basis | "no automated approval exists at 650df34" | True of `650df34`, but not of `35d5cc9`. The approver exists, but it is off by default (O-1). The M4 prediction for b/c ("3-12 approvals unless P-2 exists") was written before P-2 existed. It is **not** rewritten here. The report must state which config the arms ran with. |
| 10.1 M7, Basis | "no compose/worker in the engine's stack profile" | Obsolete if O-2 is yes. If O-2 is no, the arms run on the v1 profile and the basis still describes what they get. |
| 11 P-2 | ENGINEERING (design sketch only) | Built (D-2). Its shape differs from the sketch: the policy key is `gf.approval.auto` (not `gf.autoApprove`), the budget is per run (`maxTokens`), not per slice, and approvals are `auto-approval` events, not `gf.slice.accepted` with `reviewer: "policy"`. See `design-d2-auto-approval.md`. |
| 11 P-5 | OWNER DECISION D-1 + ENGINEERING | Decided (option 2) and built (D-1). |
| 6 M7, Procedure | `tools/deploy-check.sh <tree> <adapter>` | The built script is **generic**. It takes `<tree>` and an optional `--smoke "<command>"`, and knows nothing about the product. The adapter-specific smoke step (CSV drop, `daily_usage`, cross-building read, restart persistence) is **still to be written and frozen with the manifest** (P-8). |
| 11 P-4 | `tools/count-interventions.js <session jsonl> [<.eccode/events>]` | **Partly built.** The event-record side exists (`auto-approval` and `intervention` events, `eccode-gf interventions count`, `tools/count-interventions.js` on the record). The **bare-arm transcript counter** (user-role, non-synthetic events in a session jsonl) is **not built**. M4 for arm a still needs it, or a manual log only, before Stage 1. The "tested on the S3 record" step has not been done. |

## 5. Unchanged from the plan
- Every arm (bare, b, c) uses the **same model** (`claude-opus-5-5`, D-5), the **same master prompt bytes** and the
  same attachment. This addendum changes neither.

## 6. Known gaps carried into Stage 1
- R-1, R-2, R-4 and R-5 remain open (D-3).
- The compose profile generates **scaffolding only**: compose file, Dockerfiles, `.env.example`, `.dockerignore`,
  `deploy/PROFILE.md`. It writes no application logic and has never been run against a docker daemon.
- The approver has been exercised only by tests on synthetic records, never on a real build.

## 7. Still open before Stage 1 (unchanged by this addendum)
- P-7: whether the docker daemon runs in the Stage 1 container. No daemon-dependent check has been run.
- P-8: `criteria.py`, `repro-union.py`, adapter checklist, adapter smoke for `deploy-check.sh --smoke`, coin-flip seed,
  contamination scan list. None are written. (`deploy-check.sh` itself exists.)
- The hidden suite and manifest are not authored (plan section 4).
- The D-4 CSV file (owner to write).
- O-1, O-2 and O-3 above.
