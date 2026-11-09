# S3.1 pre-registered predictions (n=1). FROZEN at the commit that adds this file, before any implementation.

## Design these predictions are about (owner's choice, recorded 2026-11-09: "runtime module + gate")
The engine emits no app code today: builders write the whole FastAPI app, so the app-level defect classes cannot be
engine-enforced without an engine-owned runtime. S3.1 adds:
- **`eccode_runtime`**, an engine-owned ASGI guard (Python). The engine vendors it into a generated tree by hash, and
  the app mounts it with one line. Its configuration (which path params are integer ids) is derived by the engine
  from the sealed `contracts/openapi.json`, not written by a builder. The guard enforces GF-VAL-1 (I2), docs closed
  (I3), canonical ids (I7) and error-body scrubbing and capping (I8).
- An engine **runtime check**: the vendored files match the engine's hashes, and the running app shows the guard's
  behaviour on canary requests. The `phase:build` gate pass is refused if the check fails.
- Engine-side (Node) **rejection log** (I4), **action→role matrix** (I5) and **hidden-suite read allowlist** (I6).
- The S3.1 engine tree = c943799 + vendored `eccode_runtime/` + the one-line mount. No builder code is otherwise
  changed.

## Per-item predictions

| Item | Should remove | Counts as FAILURE of the item |
|---|---|---|
| I0 bubblewrap | L-GF-83's skipped/failed bwrap path | `bwrap` not runnable, or any `tests/gf-iso-*.test.js` test failing or skipping for lack of a mechanism |
| I1 GF-PIPE-1 → S4a | nothing (docs only) | any code change under `lib/` for GF-PIPE-1 |
| I2 GF-VAL-1 | A-2, B-3, B-10 classes (RC-6). Checked on a minimal default-FastAPI app in unit tests (the engine tree already lacks them) | any of: a lone surrogate (escaped or raw), a body over the size cap, nesting over the depth cap, or invalid UTF-8 reaches the app or yields 5xx; or the rejection is not 422 |
| I3 docs closed | R-3 (RC-3) | any of `/docs`, `/redoc`, `/openapi.json`, `/docs/oauth2-redirect` answers 200 by default, or the enable switch does not restore them |
| I4 rejection log | L-GF-89 (refusals never logged) | a refusal producing 0 or ≥2 entries; a secret value (the ECCODE_SEED_KEY value, or a password/token field value) appearing in the log; the chain not detecting a rewritten entry |
| I5 action→role | L-GF-86 | `gate start phase:build` by `backend-engineer` accepted; any denied (action, role) combination in the matrix accepted |
| I6 hidden-suite allowlist | agent read of the hidden suite (L-GF-7 / L-GF-82 for this path) | a Read/Grep/Glob/Bash read of the hidden path by an agent allowed, or a denial not logged via I4 |
| I7 canonical ids | B-7 | owner `GET /v1/tasks/{+1,01,1.0,%201, 1}` answers 200 on the S3.1 tree |
| I8 no echo, capped | A-1 and B-10 classes (RC-5). Checked on a default-FastAPI app; the engine tree already lacks them | an error body containing a request secret value, or an error body over the cap |

## Aggregate predictions
- **Hidden suite on the S3.1 tree:** 24/24, 220 pass / 0 fail / 1 skip. Any change is a regression and stops the run.
- **Probe pack on the S3.1 engine tree:** **5 failures**, R-1 ×2, R-2, R-4 and R-5. R-3 is removed by I3, and
  110 → 111 pass (3 N/A). Failure: more than 5 failures, any new failing probe, or R-3 still failing.
- **Probe-pack BOLA file (`test_bola.py`):** clean except the known R-2 case.
- **Defects remaining on the S3.1 engine tree:** R-1, R-2, R-4, R-5. B-7 and R-3 are removed. A-1, A-2, B-3 and B-10
  stay absent. B-9 stays as on c943799 (path randomised, mode 0644; not an S3.1 item).
- **Secondary, engine-enforcement transfer test:** a copy of the bare tree with the same vendored runtime and the
  one-line mount. Builder code is not otherwise changed, and the comparator is NOT re-run: no new bare build. Probe
  failures should fall **from 26 to 6** (R-1 ×2, R-2, R-4, A-3, A-4). RC-3, RC-5 and RC-6 are removed. B-7 (bare)
  and B-3 should be absent on that copy. Failure: more than 6 failures, or any RC-3/5/6 case still failing.

## What these predictions cannot show
n=1; the probes were authored against the engine tree; the comparator's reviewer is not identical to S3's. On the
engine tree, I2 and I8 can only show "no regression", because those classes were already absent there. Their positive
evidence comes from the unit tests and the secondary transfer test.
