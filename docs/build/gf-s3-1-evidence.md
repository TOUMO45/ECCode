# S3.1 engine-enforced hardening after the S3 comparator: n=1, enforcement opt-in (2026-11-09)

**Conclusion (n=1):** with the engine-owned runtime guard installed and mounted, the S3 engine tree keeps 24/24 on the hidden suite with BOLA clean. Probe failures fall from 6 to 5 (R-3 removed) and B-7 is removed. R-1, R-2, R-4 and R-5 **remain**. The gate that would force the guard on a build (GF-RT-1) is **opt-in** (`gf.runtime.enforce`) and **off by default**, so the default engine does not enforce any of this.

## 1. Summary table

| Measure | S3 engine (c943799) | S3.1 engine tree (c943799 + guard) | Bare (comparator, recorded) | Bare copy + engine guard (secondary) |
|---|---|---|---|---|
| Hidden suite | 24/24 (220/0/1) | 24/24 (220/0/1) | 24/24 (220/0/1) | 24/24 (220/0/1) |
| Probe pack (119 via HTTP adapter) | 110 pass / **6 fail** / 3 N/A | 111 / **5** / 3 | 90 / **26** / 3 | 110 / **6** / 3 |
| BOLA probe file | R-2 only | R-2 only | R-2 only | R-2 only |
| R-1 huge TTL → login 500 | present | **present** | present | present |
| R-2 4301+-digit id → 422 | present | **present** | present | present |
| R-3 docs anonymous | present | absent | present | absent |
| R-4 anon malformed JSON → 422 | present | **present** | present | present |
| R-5 title U+001F accepted | present | **present** | absent | absent |
| A-1 422 echoes password | absent | absent | present | absent |
| A-2 lone surrogate → 500 | absent | absent | present | absent |
| B-3 deep nesting → 500 | absent | absent | present | absent |
| B-7 non-canonical ids resolve | present | absent | present | absent |
| B-9 predictable DB path | absent (random name, 0644) | absent (random name, 0644) | present | present (`task_tracker.db`, 0644) |
| B-10 422 reflects 5 MB | absent | absent | present | absent |

Remaining on the S3.1 engine tree: **R-1, R-2, R-4, R-5**. B-9's mode 0644 is unchanged. B-9 was not an S3.1 item.

**Enforcement is off by default.** The S3.1 column (24/24 and 5 failures) was measured on a tree where the guard had been installed and mounted by `tools/make-s31-tree.sh`. The engine refuses `phase:build` approval without the guard (GF-RT-1) only when a project sets `"gf": {"runtime": {"enforce": true}}` in `.eccode/config.json`. That flag is not set by `init`, because turning it on in `initProject` would break the existing init-config check in `tests/gf-flow.test.js:38`, which may not be edited. A default engine run therefore produces a tree like c943799, with 6 probe failures. The 24/24 itself also holds on c943799 without the guard.

Notes on the secondary column: the comparator was not re-run and no new bare build was made. It is a copy of the delivered bare tree with the vendored guard and a 2-line mount (`tools/make-bare-transfer.sh`).

## 2. Design (owner's choice "runtime module + gate", recorded in `predictions.md`)
- `lib/greenfield/runtime/eccode_runtime/`: an engine-owned pure-ASGI guard. It is vendored into a tree by hash (`MANIFEST.sha256`), configured by `lib/greenfield/runtime.js` from the sealed `contracts/openapi.json`, and mounted with `app.add_middleware(EccodeGuard)` (`s31-mount.patch`: one import, one mount line).
- `lib/greenfield/runtime.js` `check()`: the vendored files must equal the engine's copy, and a canary must run on the app. The canary is a lone-surrogate POST that must get 422 GF-VAL-1, and `GET /docs` must get 404 GF-DOCS-1. A guard that is vendored but not mounted fails the check. In `wrap.js`, GF-RT-1 refuses `phase:build` approval when enforcement is on.
- Engine side (Node): `rejections.js` (I4), `authz.js` (I5), `hidden.js` plus `scripts/hooks/guard.js` and `sandbox.js` (I6).

## 3. Per-item evidence (red, then green; files in `docs/build/gf-s3-1-record/items/<ID>/`)

| Item | Commit | Red | Green | Item-check after (hidden / probes / BOLA) |
|---|---|---|---|---|
| I0 bubblewrap | aea0edb | `which bwrap` printed nothing at session start (deviation 2) | bwrap 0.9.0; `node --test tests/gf-iso-*.test.js` 64/64 pass, 0 skipped | 24/24 / 6 fail / R-2 only |
| I1 GF-PIPE-1 → S4a | cf492fd | n/a (docs only, by instruction) | planning row + note in `docs/design/greenfield-senior.md`; no `lib/` change | 24/24 / 6 / R-2 |
| I2 GF-VAL-1 | 1708079 | 50 guard tests fail (module absent); node file 12/13 fail | 50/50; node 13/13; `npm test` fail 0 | 24/24 / 6 / R-2 |
| I3 docs closed | 2174832 | 8 closed-by-default/switch tests fail | 16/16; node 15/15; direct check: `/docs`, `/docs/oauth2-redirect`, `/redoc`, `/openapi.json` → 404 by default, 200 with `ECCODE_DOCS_ENABLED=1` | 24/24 / **5** / R-2 |
| I4 rejection log | 0dc602c | 5/5 fail | 5/5: exactly one entry per refusal, zero on success, no seed or password value in the log, `verify()` catches rewrite/remove/reorder/truncate | 24/24 / 5 / R-2 |
| I5 action→role | 91ba976 | 4/4 fail (the literal L-GF-86 case accepted) | pass; more than 100 denied (action, role) pairs generated from the matrix; GF-ROLE-1 | 24/24 / 5 / R-2 |
| I6 hidden allowlist | d42aeae | 8/8 fail | 9/9; Read/Bash/`..` denied with exactly one GF-HID-1 entry; bwrap masks the hidden path | 24/24 / 5 / R-2 |
| I7 canonical ids | d39da3f | fail | pass; owner `+1`, `01`, `1.0`, `%201` → 422; `/1` → 200; anonymous → 401 | 24/24 / 5 / R-2 |
| I8 no echo, capped | c527970 | 4 of 6 fail (default-FastAPI app) | 6/6; `npm test` 1829 tests, 1787 pass, 0 fail, 42 skipped | 24/24 / 5 / R-2 |

Final measurement (commit 24f6a7d): `items/final/`, `final/repro-output.txt` and `items/bare-transfer/`.

## 4. Predictions vs outcomes (`predictions.md`, frozen at ede34e6, not rewritten)

| Prediction | Outcome | Verdict |
|---|---|---|
| I0: bwrap runnable, gf-iso tests none failing or skipping | 64/64, 0 skipped | confirmed |
| I1: no `lib/` change | docs only | confirmed |
| I2: surrogate, oversize body, deep nesting, invalid UTF-8 never reach the app or give 5xx; 422 | unit tests green; S3.1 tree A-2/B-3 answered 422 GF-VAL-1; bare copy A-2/B-3 absent | confirmed |
| I3: docs 404 by default, switch restores | as predicted | confirmed |
| I4: one entry per refusal, no secrets, chain detects tampering | as predicted | confirmed |
| I5: L-GF-86 and every denied pair refused | as predicted | confirmed |
| I6: agent reads of the hidden path denied and logged | denied and logged for the covered paths; gaps in section 7 | confirmed for covered paths; gaps not tested by the prediction |
| I7: `+1`, `01`, `1.0`, `%201`, ` 1` not 200 | 422 for each | confirmed (after deviation 3) |
| I8: no secret in error bodies, body ≤ cap | as predicted | confirmed |
| Hidden 24/24 (220/0/1) on S3.1 | 24/24 (220/0/1) | confirmed |
| S3.1 probes: 5 failures (R-1 ×2, R-2, R-4, R-5) | exactly those 5 | confirmed |
| BOLA clean except R-2 | as predicted | confirmed |
| Remaining defects R-1, R-2, R-4, R-5; R-3 and B-7 removed | as predicted | confirmed |
| Secondary: bare copy 26 → 6 (R-1 ×2, R-2, R-4, A-3, A-4) | exactly those 6 | confirmed |

## 5. Deviations
1. Before snapshot 00, I ran one `find`/`git log` call to locate `snap2.js`. R1 required snapshot 00 to be the first action.
2. I0's red is that `bwrap` was missing at session start, not a failing test run. The gf-iso tests were not run before the install.
3. I7: the canonical-id pattern from the brief, `^(0|[1-9][0-9]*)$`, also rewrote `-1`. That regressed AC-16 (hidden 23/24) and two BOLA probes. That version was **not committed**, and the pattern was widened to `^(0|-?[1-9][0-9]*)$` (`items/I7/deviation.txt`).
4. I8: the I8 subagent edited one assertion in a test that the same work had authored earlier in this session, during I7. It changed "the 422 `input` field equals `not-canonical`" to "`input` absent", because I8 removes `input` from error bodies by design (`items/I8/deviation.txt`). This is a change to a test authored in this session, made so the test would pass after I8. No pre-existing test, probe or check was edited. The reader should judge it against R11 ("never edit a test, probe or check to make it pass").
5. The bare transfer copy uses the engine's sealed `contracts/openapi.json` (same PRD), because the delivered bare tree has none.
6. The bare mount script adds a blank line next to the 2 mount lines (a cosmetic regex artefact; visible in the `diff` that `make-bare-transfer.sh` prints).

Also recorded: the run passed the 32M pause threshold (R9) at 34.2M, mainly from the two implementation subagents. I paused, reported, and resumed on the owner's "continue", with conditions: no new experiments, and stop before 39M.

## 6. Spend (reader `lib/greenfield/usage.js`, `tools/snap3.js` = S3 `snap2.js` arithmetic; IEQ = input + 0.1·cache_read + 1.25·cache_write + 5·output, a relative unit, not money)
- Snapshot 00 (start): baseline 0.
- Snapshot 02 (after measurement): 34,236,517 all-processed / 6,585,550.3 IEQ since 00.
- Snapshot 03 (before this report): 34,895,995 / 6,919,773.3.
- The final figure is in the closing message and `snaps/`. Hard stop 40M not reached.
- Clean-context at start: 125,203 ≤ 250K. Peak per-message context observed: about 215K, under 300K.

## 7. Limits
- **n=1.** One tree per side, one run. Run-to-run variance is unknown.
- **Opt-in enforcement.** GF-RT-1 is opt-in (`gf.runtime.enforce`) and off by default. Without it, nothing in the engine forces the guard onto a build.
- **Probe authorship.** The probes were authored against the engine tree. On the engine tree, I2 and I8 can only show "no regression", because A-1, A-2, B-3 and B-10 were already absent there. Their positive evidence is the unit tests and the bare-transfer copy.
- **Reviewer.** The comparator's reviewer is not identical to S3's, and the S3.1 tree was not re-reviewed by either reviewer.
- **Models.** The same model family built, reviewed and authored the suite. The subagents here ran the same model as this session.
- **I6 gaps (not covered):**
  - paths built at run time (variables, command substitution, concatenation, encodings);
  - programs that read the path from their own config;
  - `git show` of history objects (e.g. `git show HEAD:<hidden>`);
  - MCP and other non-matched tools;
  - env-only configuration outside an ECCode project is denied but not logged.
  - A Grep/Glob over the project root is denied whenever the hidden dir lies inside the project. This is strict, not a gap.
- **`rejections.jsonl` exemption gap.** `run-check.js` does not exempt `.eccode/rejections.jsonl`. A refusal that another agent logs during a `gf_run` window could make that run fail as an out-of-group change.
- **Stage order.** A request with a token that is present but invalid still gets 422 before 401 on a GF-VAL-1 rejection. The R-4 class is moved to S4a (GF-PIPE-1).
- **Canary limits.** The canary runs app code outside the group sandbox, and ignores a tree-shipped `__pycache__`.

## 8. Reproduction
```bash
cd /home/user/ECCode
S=<scratch>; git clone docs/build/gf-s3-record/s3-tasktracker.bundle $S/engine-tree && git -C $S/engine-tree checkout c943799
# (tools/make-s31-tree.sh reads the pristine tree from this session's scratchpad path; edit SRC if different)
env -u ECCODE_SEED_KEY bash docs/build/gf-s3-1-record/tools/make-s31-tree.sh $S/s31-final          # vendor + mount + GF-RT-1 check
env -u ECCODE_SEED_KEY bash docs/build/gf-s3-1-record/tools/item-check.sh final $S/s31-final       # hidden suite + probe pack
env -u ECCODE_SEED_KEY bash docs/build/gf-s3-1-record/tools/item-check.sh base $S/engine-tree      # S3 baseline (6 fail)
python <cmp>/manual-repro/repro.py $S/s31-final; python <cmp>/manual-repro/repro-review.py $S/s31-final   # defect table
bash docs/build/gf-s3-1-record/tools/make-bare-transfer.sh $S/bare-transfer && bash docs/build/gf-s3-1-record/tools/item-check.sh bare-transfer $S/bare-transfer
env -u ECCODE_SEED_KEY ECCODE_PYTHON=/root/.cache/eccode/phase3-venv/bin/python npm test           # engine suite
node docs/build/gf-s3-1-record/tools/snap3.js '<label>' <out.json>                                  # spend
```
`<cmp>` = `git archive origin/claude/modest-wozniak-mwpzbm docs/build/gf-s3-comparator-record` (read-only). The venv is pinned by `docs/build/gf-s3-record/env/pins-lowercased.txt`. The bare figure of 26 is the comparator's recorded number (`bare-probes/pytest.log`) and was not re-run (R10).
