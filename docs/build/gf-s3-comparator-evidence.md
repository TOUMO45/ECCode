# S3 bare comparator — n=1, reviewer not identical to S3's (2026-11-09)

**Conclusion (n=1, reviewer not identical to S3's):** given the identical sealed PRD, bare Claude Code passed the same hidden suite (24/24) at about 1/54 of the engine's IEQ per accepted criterion. It escaped 4 of the engine's 5 defects (R-1 to R-4; R-5 absent) plus 5 further minor defects, all reproduced. The engine escaped none of those 5 except B-7, which it shares. BOLA/IDOR was clean in both. These counts are an indicator, not a verdict: one PRD, one run each, a reconstructed reviewer, and a suite author from the same model family as both builders. This compares build plus verification given an identical PRD written by the engine's own pipeline; it does not compare requirements quality. Nothing here claims superiority in either direction.

## 1. Setup
- Protocol: `docs/build/gf-s3-record/comparator/` (unchanged, sha256 of `run-comparator.sh` c6724b9d…). Command: `cd /home/user/ECCode && env -u ECCODE_SEED_KEY bash docs/build/gf-s3-record/comparator/run-comparator.sh`, run once, exit 0. Branch `claude/modest-wozniak-mwpzbm`, from S3 head `4e86296`; pre-run freeze commit `3033882`.
- Gates: clean-context at the start of this run 152,662 ≤ 250K; tree clean; HEAD 4e86296; hidden-suite hash 4/4 OK; `--max-turns` accepted (`claude -p "reply with OK" --max-turns 1` → exit 0, `OK`), so the script was not edited; `ECCODE_SEED_KEY` set in the operator shell, unset in the comparator and probe processes.
- Bare-session isolation (detection): the bare transcript has 9 Bash calls, all inside its own `/tmp/s3-bare-vMAz`. None names the ECCode repo, the S3 record, the hidden suite, the probes or the seed key (scan in section 9). The S3 record was held at `/root/.cache/s3-held-1794182095` during the run and restored by the script's trap.

## 2. Summary: bare vs engine (S3)

| Metric | Bare (this run) | Engine (S3, recorded) |
|---|---|---|
| Hidden-suite criteria | **24 of 24** (220 pass, 0 fail, 1 skip of 221) | 24 of 24 (220 / 0 / 1) |
| Builders' own tests | **139 passed, 0 failed** (re-run on a clean copy) | 180 passed |
| Probe pack (S3's 119 review probes via the HTTP adapter) | 90 pass, 26 fail, 3 N/A | calibration with the same adapter: 110 pass, 6 fail, 3 N/A (S3 in-process: 113 / 6) |
| BOLA/IDOR | **clean** (probe `test_bola.py` 48/49, the 1 failure is R-2; reviewer 23/23 + 6/6 alias) | clean |
| Escaped defects vs R-1..R-5 | **4 of 5** (R-1..R-4 escaped, R-5 absent) | 5 |
| Additional escaped defects (separate) | **5** minor (A-1, A-2, B-3, B-7, B-9) | (not re-measured; B-7 reproduces on the engine tree, see 3.2) |
| All-processed tokens (build) | **668,034** | 86,412,734 (whole S3 delta); builder subagents alone 12,932,152 |
| IEQ (build) | **259,671.2** | 14,017,518 (whole delta); builder subagents alone 2,308,733 |
| IEQ per accepted criterion | **10,819.6** | 584,063 |
| Wall time (build) | **266 s** (API 213.7 s), 10 turns | build 1 h 01 m; active 1 h 35 m |

## 3. Main measurement: escaped defects

### 3.1 The five (R-1..R-5), pre-registered checks (`probe-adapter/r-map.json`, frozen in 3033882)

| Defect | Bare | Probe evidence (`bare-probes/junit.xml`) | Manual reproduction (`manual-repro/bare-output.txt`) |
|---|---|---|---|
| R-1 huge TOKEN_TTL_SECONDS breaks login | **ESCAPED** | `test_huge_ttl_env_login[1e12]`, `[99999999999999999999]` fail: 500 | TTL=1000000000000: register 201, login 500 |
| R-2 4301+-digit id → 422 not 404 | **ESCAPED** | `test_out_of_range_ids_404[9×5000]` fails: 422 | 4300 digits → 404; 4301 → 422 `int_parsing_size` |
| R-3 /docs, /redoc, /openapi.json anonymous | **ESCAPED** | `test_anonymous_docs_endpoints` fails: all 200 | all three → 200 anonymous |
| R-4 anonymous malformed JSON → 422 not 401 | **ESCAPED** | `test_anonymous_malformed_json_gets_401` fails: 422 | anon POST/PATCH `{bad` → 422; anon `{title:""}` → 401 |
| R-5 title of only U+001F accepted | **ABSENT** | `test_unicode_blank_titles[\x1f]` passes | POST title `\x1f` → 422 |

Same script on the engine tree c943799 (`manual-repro/engine-c943799-output.txt`): all five present, as recorded in S3.

### 3.2 Additional defects (not part of the R-1..R-5 count; each reproduced by the orchestrator)

| Id | Severity (mine) | Defect | Bare evidence | Engine c943799, same check |
|---|---|---|---|---|
| A-1 (= reviewer B-4, with B-10) | minor | 422 bodies echo input, including the plaintext password (FastAPI default handler); a 5 MB title is reflected as a 5,000,158-byte 422 | register `{"password":"Sup3rSecretPw!"}` → 422 `"input":{"password":"Sup3rSecretPw!"}`; probes `test_register_422_no_echo` ×10, `test_login_422_no_echo` ×3, `test_malformed_json_no_echo` fail | no echo (422 without input; 112-byte 422 for 5 MB) |
| A-2 (= B-2) | minor | lone UTF-16 surrogate in a JSON string → 500 (register email/password, login, task title/description) | register `\ud800` email → 500; task title → 500; 5 probe cases fail | 422 |
| B-3 | minor | object nested 5,000 deep → 500 (RecursionError while encoding the 422 input), anonymous on register and login | both → 500 `Internal Server Error` | 422 |
| B-7 | minor | non-canonical ids resolve to a real task: `+1`, `01`, `1.0`, `%201` → task 1 (200); AC-16 says a non-integer id gets 422. No owner crossing | owner GET `/v1/tasks/1.0` → 200 task 1 | **same: 200** (shared; escaped the S3 review; not added to R-1..R-5, per the run rules) |
| B-9 | minor | default DB at a fixed, predictable `<tmp>/task_tracker.db`, mode 0644, trusted as-is when pre-seeded | `B-9 default db: task_tracker.db mode 0o644` | randomised `tasktracker-<hex>.db`, also 0644 |

Not counted (the PRD permits the bare behaviour): login with a 280-character password → 401 (AC-6 asks for 422 only for missing or unknown fields); `a@b.c` rejected (the PRD does not define the TLD length). Reviewer findings B-1, B-5, B-6 and B-8 are R-4, R-3, R-1 and R-2 respectively.

**Tally (indicator): bare 4 of the five + 5 additional = 9 minor escaped defects; engine 5 (its list unchanged).**

## 4. Hidden suite, builders' tests, probe pack
- Hidden suite (`bare-out/criteria-result.txt`, run by the protocol script on the delivered tree): every criterion AC-1..AC-24 PASS; 220 pass, 0 fail, 1 skip. No failing test.
- The bare build's own tests (`bare-own-tests/pytest.log`): 139 passed in 16.31 s on a clean copy. The four PRD `command` files: smoke 2, security 4, login_logout 48, migration_contract 4, all pass. The bare build wrote its own `contracts/db-schema.json`, since AC-24 names a file it was not given.
- Probe pack (`bare-probes/`): per file, auth 20 pass / 2 fail (R-1) / 1 N/A; bola 48 / 1 (R-2); conformance 3 / 2 (R-3, R-4) / 1 N/A; input 16 / 21 (A-1 ×14, A-2 ×5, A-3 ×1 and A-4 ×1, both not counted); race 3 / 0 / 1 N/A. The N/A tests were pre-registered: `test_storage`, `test_migration_matches_create_all` and `test_clean_checkout_startup` assert engine-internal names.

## 5. Independent review (Option B: brief reconstructed)
- Brief: `docs/build/gf-s3-record/independent-review-brief.reconstructed.md` (sha256 0e29c28d…, frozen in 3033882; its provenance header separates what is copied from S3 section 4.3 from what is inferred from the probe classes). It was sent to a fresh-context general-purpose agent with `{TREE}` and `{WORK}` filled in and without the provenance header (`independent-review/brief-as-sent.md`). Its clone: the delivered bare tree, given code, PRD, idea and the tree's own `contracts/`, but not the suite.
- Raw output: `independent-review/reviewer-final-report.md` and its probes in `independent-review/review-probes/` (10 files, 574 tests: 504 passed, 70 failed). There are 10 findings, B-1..B-10. The reviewer rated B-1..B-5 major and B-6..B-10 minor; S3's reviewer rated the equivalent R-3 and R-4 minor, which is itself a reviewer difference.
- Classification: B-1 = R-4, B-5 = R-3, B-6 = R-1, B-8 = R-2, B-2 = A-2, B-4 = A-1, B-10 is the same root cause as A-1, and B-3, B-7 and B-9 are new (section 3.2). Per class: BOLA/IDOR clean; mass assignment clean (54/54); admin lookalikes clean (27/27; admin race one 201 + 31 409); anonymous requests clean; storage and sessions clean (scrypt with per-user salt, SHA-256 token digest, one row in a 30-way duplicate race, Alembic matches the models). Findings fall in auth-order, odd ids, malformed bodies, config bounds and docs exposure.

## 6. Spend (same reader `lib/greenfield/usage.js`, same arithmetic as S3 `snap2.js`; IEQ = input + 0.1·cache_read + 1.25·cache_write + 5·output, a ratio estimate, not money; no dollar figure, per R8)
- Bare build session (`c12e004d…`, 10 messages, no subagents, model claude-opus-5-5): input 20, cache-read 588,274, cache-write 52,767, output 26,973 → **668,034 all-processed, 259,671.2 IEQ; per criterion 27,835 / 10,819.6**. Clean-context on the bare run's final message: 77,636 ≤ 250K (first message 26,104).
- Comparison: S3 IEQ per criterion 584,063, about 54× the bare figure. Against S3's two builder subagents alone (2,308,733 IEQ, excluding orchestration, G1, the hidden-suite author and research) the factor is about 8.9×. The S3 delta also bought the G1 artifacts, the sealed contracts, the hidden-suite authoring and the separation proofs, which the bare run did not produce.
- Review cost: the bare tree's reviewer used 3,369,270 all-processed / 758,216.4 IEQ; S3's reviewer used 1,227,036 / 457,178.5.
- This operator session, all snapshots in `gf-s3-comparator-record/snaps/`:
  - run2-00, the start of this run: cumulative 2,698,207 / 425,537.8.
  - run2-01, pre-run: 6,588,124 / 1,031,992.8.
  - run2-02, post-run: **16,562,937 / 2,632,659.1** (13,864,730 / 2,207,121.3 since run2-00, including the review subagent).
  - The `--max-turns` check session used 43,339 / 24,035.3.
  - The cap was never reached (41% of 40M; the pause at 32M was not triggered). Per-message context peaked at about 269K, under the 300K handoff threshold.

## 7. Deviations from the protocol and the prompt
1. This was not a brand-new session: it continues the session that stopped earlier, so it carries that context (2.7M tokens before this run's snapshot 00). Snapshot 00 of this run was its first action; the clean-context test passed (152,662).
2. The review brief is reconstructed (Option B), and it was sent with the provenance header removed and the placeholders filled.
3. The protocol has no R-1..R-5 checks and no probe pack. With the owner's approval, the S3 probe test bodies ran unchanged through an HTTP adapter (`probe-adapter/`). Three engine-internal tests are N/A. Calibration on c943799 found one adapter artifact (h11 refuses a header value with trailing whitespace); the fix strips header OWS. Calibration run 1 is kept in the record, and run 2 reproduces S3's six failures exactly.
4. `ECCODE_SEED_KEY` was removed with `env -u` for the comparator and probe processes (the protocol is silent on it).
5. The hidden suite ran, as the script does, on the bare working directory as delivered (the bare build made no commits), not on a separate clean checkout. The bare build's own tests, the probes and the review used clean copies.
6. The script deletes `docs/build/gf-s3-record` during the run and restores it (as designed). A stop hook asked for a commit and push during that window; I declined.
7. Models differ: the bare run used claude-opus-5-5 throughout; S3 used mostly claude-sonnet-5-5, switching to opus about 22:10Z.
8. The worker process restarted once before the run; the state was verified intact.
9. An interim local commit (`6372efa`) was made before the report, at a hook's request; no push.
10. Late in the session the operator's per-message context passed 250K (peak about 269K). The 250K test is defined at the start and on the bare run's final message, and both passed; the 300K handoff threshold was not reached.

## 8. Limits and caveats
- n=1 on each side, one PRD written by the engine's own pipeline. Run-to-run variance of the bare build is unknown: a second bare run could differ either way.
- The reviewer is not identical to S3's (reconstructed brief, different agent instance, a probe set 4.8× larger), so additional-defect counts are not comparable as a verdict. The engine tree was not re-reviewed with this brief: B-7 and the 0644 mode reproduce on it, and the engine might show further defects under this reviewer.
- The suite author, both builders and the reviewers share a model family.
- The probe pack runs over HTTP via an adapter. The calibration shows parity on the engine tree, but timing probes include one proxy hop.
- These numbers cannot show maintainability, the value of the engine's G1 artifacts, sealing and separation proofs, or behaviour on larger or multi-team projects.

## 9. Reproduction
```bash
cd /home/user/ECCode && env -u ECCODE_SEED_KEY bash docs/build/gf-s3-record/comparator/run-comparator.sh
cd <bare tree copy> && env -u ECCODE_SEED_KEY PATH=/root/.cache/eccode/phase3-venv/bin:$PATH PYTHONDONTWRITEBYTECODE=1 python -m pytest -q -p no:cacheprovider
cd docs/build/gf-s3-comparator-record/probe-adapter && env -u ECCODE_SEED_KEY -u DATABASE_URL -u ADMIN_EMAIL -u TOKEN_TTL_SECONDS PROBE_TARGET_TREE=<tree> /root/.cache/eccode/phase3-venv/bin/python -m pytest -q -p no:cacheprovider -rfs --junitxml=junit.xml .
cd docs/build/gf-s3-comparator-record/manual-repro && /root/.cache/eccode/phase3-venv/bin/python repro.py <tree> && /root/.cache/eccode/phase3-venv/bin/python repro-review.py <tree>
node -e "const u=require('./lib/greenfield/usage.js');console.log(u.sessionUsage('/tmp/s3-bare-vMAz','c12e004d-5d34-4dda-9d0b-ee2505175a8c'))"
```
The bare tree is in `gf-s3-comparator-record/bare-out/bare-tree/` (24 files, `bare-tree.sha256`). The engine tree comes from `git clone docs/build/gf-s3-record/s3-tasktracker.bundle`. The reviewer probes run with `cd independent-review/review-probes && python -m pytest -q --rootdir=.`; their paths point at the session scratch clone, so set them to a copy of the bare tree. Contamination scan: `python3 gf-s3-comparator-record/bare-out/contamination-scan.py <bare transcript>` (output in `contamination-scan.txt`).
