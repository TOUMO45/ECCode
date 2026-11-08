# S3 (reduced build) — evidence and final report (2026-11-08)

One small FastAPI project (a shared task tracker, 7 endpoints, one BOLA/IDOR rule) built by the Greenfield-Senior engine from the
fixed idea, under the pre-registered protocol `bench/protocols/2026-11-08-gf-s3.md`. **n = 1. Nothing here is claimed beyond this one run.**
Record: `docs/build/gf-s3-record/` (snapshots, shim and proofs, G1 reviews, handoffs, hidden suite + results, review probes, the
project as a git bundle `s3-tasktracker.bundle`, 24 commits, delivered head `c943799`).

## 1. Results against the pre-registered metrics (B3)

| Metric | Result |
|---|---|
| 1. Hidden-suite criteria passed | **24 of 24** (221 cases: 220 pass, 0 fail, 1 skip = an optional TTL-expiry test outside the criteria map); run once, clean checkout of `c943799`, app started with env vars only (`hidden-run/criteria-result.txt`) |
| Builders' own tests (separate measure) | **180 passed, 0 failed** (8 test-group tasks; `tests/unit/**`; engine evidence `ev-mw8evwif-01f381cb` on the merged tree) |
| 2. Cost per accepted criterion | **3,600,531 all-processed tokens; 584,063 IEQ (ratio estimate)** per criterion = S3 delta 86,412,734 all-processed / IEQ 14,017,518 over 24. **No dollar figure**: no official price page was fetched |
| 3. Wall time | 2 h 10 m 53 s elapsed from the S3 start probe (20:34:57Z) to the independent review's return (22:45:50Z), the first ~36 min (to 21:10:50Z) mostly owner-decision round-trips (Patches 1-2, the push question); **active 1 h 35 m** (21:10:50Z venv rebuild to 22:45:50Z); the build itself (G1 start to the hidden run) 1 h 01 m |
| 4. Gate refusals | **engine refusals: 1 true (capability), 0 false on any gate/task/run/commit/merge command; 1 friction rule on dry runs** (section 5) |
| 5. Escaped defects (independent review) | **5, all minor, all reproduced by the orchestrator** (R-1 to R-5, section 6); none in authorization |
| 6. Illustrative comparator | **not run here** (owner's decision); prepared in `gf-s3-record/comparator/` (section 9) |
| BOLA/IDOR | **clean in all three layers** (section 6) |

## 2. Setup and owner decisions

- Session branch `claude/amazing-tesla-3avgyd`, reset (owner Patch 1) to `origin/claude/wonderful-goldberg-o6u7m6` = `cbae463`; first push a
  plain push (the remote branch did not exist, so the authorised force-with-lease was refused "stale info" and the owner then approved a plain push).
  `21fc8fc` (v0.16.0, #25) was NOT merged (Patch 2 item 6).
- Frozen v3 engine: 48/48 files before and after; protected files (`docs/limits.md`, `scripts/guards/*.py`, `lib/project.js`) untouched since `c59ee39`.
- Venv rebuilt (it was missing): python 3.13.18, `pip install --only-binary=:all: -r docs/build/gf-s2-4-record/fastapi-reqs.txt`, 11 pins equal,
  50 s. Parity baseline in place: 1793 tests / 1752 pass / 1 fail / 40 skip against the expected 1793/1757/0/36 — both differences
  environmental (no bubblewrap: test A1; no `coverage` in the pins: 4 skips); nothing fixed (`env/parity-baseline.txt`).
- Scratch start (no template) as approved; recorded as the G0.5 ADR `dd-mw8crkxs-01bf8fa7` (scratch vs fork-adapt vs design-only borrow).
- Mid-run model switch by the owner: claude-sonnet-5-5 to claude-opus-5-5 at about 22:10Z (main + subagents after it).

## 3. Metering (registered cap: estimate 100 M, cap 125 M, pause 100 M, hard stop 125 M; `budget-registration.json`)

Unit: all-processed tokens from `lib/greenfield/usage.js` over this session's transcript plus every subagent transcript, as a DELTA from
the start probe (2,358,697; the 2 M absolute test was waived by the owner). IEQ = input + 0.1·cache_read + 1.25·cache_write + 5·output
(published pricing ratios; a relative unit, not money). The cap was checked after every step and every subagent; it was never reached
(final 69.13% of the cap; the 80% pause was not triggered). Clean-context test at start: PASS (169,018 ≤ 250,000); the main prefix then grew
to about 400 K per message (reported at every snapshot, L-GF-87).

S3 delta: all-processed **86,412,734** = input 730 + cache-read 83,804,538 + cache-write 1,973,599 + output 633,867; IEQ **14,017,518**.

| # | step | Δ all-processed | Δ IEQ | Δ msgs | cumulative |
|---|---|---:|---:|---:|---:|
| 01 | setup: plain push + venv rebuild | 2,238,004 | 372,280 | 14 | 2,238,004 |
| 02 | read handoff, protocol, design 19-22, limits | 729,327 | 117,387 | 4 | 2,967,331 |
| 03 | frozen/protected/isolation checks + read-mask shim + proof | 7,538,154 | 1,287,693 | 40 | 10,505,485 |
| 04 | parity baseline + record commit (runbook agent running) | 8,204,074 | 1,074,038 | 28 | 18,709,559 |
| 05 | runbook research subagent returned | 30,212,206 | 3,673,815 | 74 | 48,921,765 |
| 06 | project init + isolation check; G1 author launched | 600,281 | 178,135 | 2 | 49,522,046 |
| 07 | G1 author FAILED (API 403 oauth_org_not_allowed); worker restarted | 2,128,525 | 420,698 | 14 | 51,650,571 |
| 08 | G1 author returned (artifacts written) | 3,553,080 | 873,895 | 17 | 55,203,651 |
| 09 | G1 gates approved + sealed (reviewer returned) | 2,209,110 | 696,481 | 12 | 57,412,761 |
| 10 | hidden-suite author returned | 4,158,742 | 1,252,552 | 19 | 61,571,503 |
| 11 | backend chunk A (3/9) | 4,337,580 | 746,265 | 27 | 65,909,083 |
| 12 | backend chunk B (6/9) | 2,814,068 | 397,025 | 14 | 68,723,151 |
| 13 | backend chunk C (9/9) + checkpoint + merge | 3,375,598 | 464,641 | 16 | 72,098,749 |
| 14 | test chunk D (12/17) | 4,105,537 | 734,824 | 23 | 76,204,286 |
| 15 | test chunk E (15/17) | 3,273,488 | 486,588 | 16 | 79,477,774 |
| 16 | test chunk F (17/17) | 2,887,312 | 418,305 | 12 | 82,365,086 |
| 17 | merge + builders' suite + hidden run + independent review | 4,047,648 | 822,896 | 16 | 86,412,734 |

Per subagent (all-processed, messages): runbook research 39,719,636 (116) · G1 author 3,162,471 (22, incl. the failed attempt) · G1
reviewer 1,212,898 (9) · hidden-suite author 1,744,051 (12) · backend builder 6,870,948 (47) · test builder 6,061,204 (40) · independent
reviewer 1,227,036 (9). Subagents 59,998,244; main thread 26,414,490. By model (whole session incl. the pre-start probe):
claude-sonnet-5-5 63,228,479 (239 msgs), claude-opus-5-5 25,956,321 (127 msgs). The cost driver is the fixed per-message prefix
(cache reads are 97% of the delta), and one research subagent was 46% of the S3 spend. Writing this record after step 17 is outside the delta.

## 4. Separation (enforced, with evidence)

1. **Hidden suite by a separate fresh-context agent from the PRD only, engine-held, unreadable from a group sandbox.** The author received
   only copies of the sealed `prd.json` (sha256 04cbe07f…, identical to the seal) and `idea.txt`; its transcript shows no other path. Suite:
   4 files, 116 test functions / 221 cases, all 24 criteria mapped (`criteria-map.json`), sealed by `hidden-suite-manifest.sha256`, verified
   before the run. Held at `/root/.cache/eccode-gf-hidden/s3` during the build (in the repo only after the review). **Finding:** the stock
   GF-ISO-1 Landlock sandbox grants read everywhere — the stock baseline read `test_acceptance.py` from inside a group sandbox. With the S3
   shim (`shim/gf-python`, an empty tmpfs over the hidden directory in the group's mount namespace, applied before Landlock) the same read
   **fails: `No such file or directory`**; listing shows 0 entries; writes, `umount`, re-`mount --bind` and `/proc/1/root` all fail; the
   engine's namespace still reads it; no mask leaks to the host (`shim/mask-proof-real-suite.json`). Detection layer: every subagent
   transcript scanned — no builder, reviewer, author or research agent named the hidden directory or saw suite text (L-GF-82 for the
   residuals: harness tools outside the sandbox, the author's transcript).
2. **Build groups under S2.4 isolation, strongest usable mode:** `landlock` (ABI 7) is the only usable mode on this host (no bubblewrap),
   flagged `weaker` (UDP/DNS open, L-GF-79/L-GF-83); every group `run` executed in it, with a pid + mount namespace; the engine committed each
   task onto `gf/backend` / `gf/test` (plumbing) and merged in dependency order after cited passing checks (`3cc8993`, `0c1e7af`).
3. **Independent post-build review:** a fresh-context agent on its own clone of `c943799`, given code + PRD + contracts, not the suite.

## 5. G1, contract freeze, build — and the refusals (B3.4)

- G1: architecture, design (technical + security reviewers) and plan approved on first submission; sealed `8a3e4514215d` (`d2dc772` in the
  project); estimate registered; audit OK. PRD 24 criteria (21 P0); 4 ADR'd decisions (scratch, scrypt, opaque hashed tokens, deny-404).
  Reviewer findings: 0 blocking, 0 major, 14 minor/info (e.g. P-1: backend tasks verified by ruff only; S-1: FastAPI's 422 echoed input —
  the builder then fixed it with a non-echoing handler). Independence reduced to one author agent and one reviewer agent (L-GF-88).
- Contract freeze: the 5 contract files hashed in the approved design submission and snapshotted at the seal (no contract-test generator
  exists; design-only, runbook §G).
- Build: 17/17 tasks (backend 9, test 8), one group per task, each claim → files → pinned verification `run` in the sandbox → engine
  `commit` → `task complete` with a handoff; 5 orchestrator checkpoints (every 3 tasks); 2 engine merges; audit OK; tree clean.
- **Refusals, engine (the engine logs none; operator log `refusals.log` + builder reports, L-GF-89):**
  - **True (capability) — 1:** `task claim be-core` → `GATE_BLOCKED` (phase gate pending): correct; cause: the orchestrator had not started `phase:build`.
  - **False (friction) — 0** on gate, claim, run, commit, complete, merge commands.
  - **Friction on dry runs — 1 rule:** `validate design|plan` refused with `GF-ORD-1` while the predecessor gate was unapproved (3 dry runs);
    authoring ahead could not be validated; worked around by the author with a read-only validator script.
  - **Missing refusal (capability gap) — 1:** `gate start phase:build` by `backend-engineer` was accepted (L-GF-86).
  - Not engine: the permission classifier denied the G1 author's approval rehearsal on a scratch copy (self-approval; correct); one
    subagent API failure (HTTP 403 billing/auth), resumed.

## 6. Hidden suite, builders' tests, independent review; BOLA/IDOR

- Hidden suite: 24/24 criteria; per criterion in `hidden-run/criteria-result.txt`. BOLA criteria AC-12 (4/4 cases), AC-14 (6/6), AC-15
  (9/9), AC-19 (4/4), AC-20 (6/6) pass. AC-21 to AC-24 are HTTP proxies of PRD `command` criteria (L-GF-90).
- Builders' tests: 180/180 (te-bola 15 tests: cross-user GET/PATCH both ways → 404 with no foreign fields, no list leak, no ownership move,
  role rejected, admin reads/edits any).
- **BOLA/IDOR, independent review: clean.** Cross-user GET and PATCH both directions → 404, byte- and header-identical to an unknown id, the
  owner's task unchanged; foreign vs unknown timing 6.7 vs 6.2 ms median; odd ids (0, -1, 999999, ±2^63) → 404, non-integers → 422; list:
  no leak, admin sees all; 22 PATCH mass-assignment bodies + create extras + role/is_admin on register → 422, nothing changed; ADMIN_EMAIL
  lookalike, case, whitespace and Kelvin-sign variants → no second admin; concurrent duplicate registration → one account.
- **Escaped defects (both test layers passed; reproduced by the orchestrator: 6 failing probe tests, 113 passing, `review-probes/`):**
  R-1 minor: a huge `TOKEN_TTL_SECONDS` (≈3e11+) makes every login 500 (should fall back/clamp) · R-2 minor: ids of 4301+ digits → 422
  instead of 404 · R-3 minor: `/docs`, `/redoc`, `/openapi.json` answer anonymous callers · R-4 minor: anonymous malformed-JSON POST/PATCH →
  422 instead of 401 (AC-8 order) · R-5 minor (borderline): a title of only U+001F accepted. Unfixed in S3 (the run ends with the review;
  no blocking finding, so the two-attempt rule did not arise).

## 7. Limits created: L-GF-82 to L-GF-90 (`docs/limits-greenfield.md`)
82 stock sandbox reads everywhere; S3 read-mask shim and its residuals · 83 Landlock-alone host (no bubblewrap) · 84 venv pins lack
`coverage` · 85 repo-root engine commands write the repo's `.eccode` · 86 phase gate start accepted from a group role · 87 metering (not
fresh, prefix growth, research-agent cost, harness `subagent_tokens` ≠ all-processed, model switch, no dollars) · 88 G1 independence by two
agents; closure not run · 89 refusals not logged by the engine · 90 the five escaped defects and the proxy criteria.

## 8. Not done / not claimed
- Slice closure (`close *`), the phase-gate submission/review: not run; S3 rests on the owner's acceptance with limits.
- No dollar figure; no calibration claim (L-GF-12); no generalisation beyond n = 1.

## 9. The bare comparator (prepared, NOT run)
`docs/build/gf-s3-record/comparator/`: the identical sealed PRD + idea, `prompt.txt` (the same environment facts the builders got, no mention
of the suite), `run-comparator.sh` (holds the whole S3 record — suite, results, engine-built app — outside the bare run's reach, runs one
headless `claude -p` build in an empty directory, scores it with the identical suite and `tally.py`, restores the record), for the owner in a
separate fresh session:

```bash
bash docs/build/gf-s3-record/comparator/run-comparator.sh
```
Report it as "illustrative, n=1" beside the engine's 24/24. Check the `claude` flags with `claude --help` in that session first.

## 10. 21fc8fc (v0.16.0, #25), read-only, not merged
`git diff --stat cbae463 21fc8fc`: 639 files changed, 5,227 insertions(+), 58,445 deletions(-) — the two lines diverged at `e3e8b75`, so
this mostly shows the greenfield line's absence from 21fc8fc. #25 alone (`git diff --stat e3e8b75 21fc8fc`): 66 files changed,
5,046 insertions(+), 111 deletions(-). The owner decides.
