# phase:rework-2 — submission

Author: delivery-lead. Gate: `phase:rework-2`. Date: 2026-10-10.
- Opened by the orchestrator (event 534). Phase D's additive `RequestView.capabilities` key (d3, required by d4's UI) failed c2's approved RS-34 exact key-list assertion in `test/api/requests-plans.test.js`. No phase D task owns that file.
- Triggering evidence: ev:ev-mv31etf6-01061b72 (`npm test` after d3, 1155/1172 pass, 7 fail).
- One task, `rework-2` (backend-engineer), handoff `ho-mv31o4rp-013055fc`. Claim base `c83d80b2`.
- Ownership: `test/api/requests-plans.test.js` only. The rework changed that file and no other file.
  - Between `c83d80b2` and the committed HEAD `cf0e1c2`, the only change under `src/` and `test/` is this file, +3/−1.
  - At submission time the working tree also contains d5's uncommitted, in-progress edits: `test/api/contracts.test.js`, `test/helpers/app-harness.js` and the new `test/helpers/extraction.js`. They are not part of this submission. Their earliest file modification is 23:50:45Z, after my `npm test` run was recorded (23:50:39Z), so neither of my runs below includes them.

## Finding → change → test → evidence

| Finding (resolution condition) | Change | Tests | Evidence |
|---|---|---|---|
| **rework-2:** the RS-34 view-shape case must accept d3's additive `capabilities` key on `GET /api/requests/:id` without weakening the exact key-list check | In the case `RS-34: GET /api/requests/:id carries labels and the planned shape of the contract fixture`:<br>- `'capabilities'` is added to the expected sorted top-level key list. The list is still compared exactly with `deepEqual`, so any other new key still fails.<br>- Two new assertions: `Object.keys(v.capabilities)` deep-equals `['deleteRequest']`, and `typeof v.capabilities.deleteRequest === 'boolean'`.<br>- No other assertion or line in the file changed. | That one RS-34 case, inside c2's verification command (the four c2 API files under the net guard) and inside the single-file run | - Failing first: ev:ev-mv31litb-015e68f5. c2 command, 65/66; the one failure is exactly this RS-34 case.<br>- Passing: ev:ev-mv31ltus-01e665fc. c2 command, 66/66.<br>- My run on the final tree: **ev:ev-mv31qs6q-01bbf318**, `node --disable-warning=ExperimentalWarning --test test/api/requests-plans.test.js`, 35/35 pass, 0 fail. The case ran and passed. |

**Two notes on that row:**
1. **Not one word.** The rework record calls this a "one-word test update". The change also adds the two `capabilities` shape assertions, which were one of the handoff's acceptance criteria. Both assertions tighten the check; neither loosens it.
2. **No net guard in my run.** My single-file run is the command the orchestrator specified. It runs without `--import ./test/helpers/net-guard.js`, so it is not network-guarded. The engineer's two runs used c2's command, which does load the net guard, and the file also runs under the net guard inside `npm test` below. The file counts differ for this reason: 66 tests in four files versus 35 in this one file.

## `npm test` on the final tree: RED, not green

My run is **ev:ev-mv31ru5d-0118aab7**: `npm test`, exit 1, **1172 tests, 1157 pass, 5 fail, 10 skipped, 0 todo**, 42.2 s. The engineer's run ev:ev-mv31mzej-01f53862 shows the same counts and the same five failures.

All five failing tests are in `test/api/contracts.test.js`:

| # | Failing test (verbatim) | Cause (from the log) |
|---|---|---|
| 1 | `NFR6: the route table covers each fixture file exactly once` (in the suite `NFR6: every example response in test/fixtures/contracts has a scenario, and every fixture has the documented wrapper`) | Fixtures without a scenario: `request-extract-degraded.json` and `request-image-upload.json` (new with d3) |
| 2 | `NFR6: contract request-view-planned.json: GET /api/requests/:id -> 200 (RS-FIX-1 base case: feasible plan A+B proposed, nothing rese)` | `capabilities: extra (not in the fixture)` |
| 3 | `NFR6: contract request-view-infeasible.json: GET /api/requests/:id -> 200 (RS-FIX-1 without supplier B and a $90 budget: infeasible, wi)` | same |
| 4 | `NFR6: contract request-view-reserved.json: GET /api/requests/:id -> 200 (RS-FIX-1 base case: plan A+B approved and reserved; supplier)` | same |
| 5 | `NFR6: every registered route has a scenario in the table` (in the suite `NFR6: contract scenarios drive each registered route ...`) | `POST /api/requests/:id/image` and `GET /api/requests/:id/image` have no scenario |

**A correction to the handoff.** The handoff calls the fifth failure "the fixture-wrapper row". The wrapper test itself passes: `NFR6: each fixture is {route, status, response} ...` is `ok 2`. The parent suite whose title mentions the wrapper is reported "not ok" only because its subtest #1 fails. The five leaf failures are the ones in the table.

**Why these failures are outside this rework:**
- **Ownership.** `test/api/contracts.test.js` and the contract fixtures belong to `d5-extraction-contract-browser` (test-engineer; the plan lists `test/api/contracts.test.js` under d5, and c6 before it). Neither file is in this rework's ownership.
- **Same failures as before the rework.** The triggering run ev:ev-mv31etf6-01061b72 had 7 failures: these same five NFR6 tests (identical names), plus the RS-34 case and `NFR1: package.json is exactly as the Deployment section specifies`.
  - This rework removed the RS-34 failure.
  - d2's revert removed the NFR1 failure (handoff `ho-mv31n07e-01ec72ff`).
  - Nothing else changed between the two runs.
- **Status of d5.** d5 was claimed during my run (event 553, run `run-mv31px8b-01bc2982`). Its first evidence, ev:ev-mv31rk2w-01e1c7c2, records this red state as expected before its edit.

**Consequence for the rework's stated purpose.** The rework record says "so the suite is green before the phase D submission". This rework makes c2's part of the suite green. The whole suite turns green only after d5. Per the orchestrator's decision, rework-2 is reviewed on its own file's evidence, and the red d5 rows are disclosed here. The phase D submission must cite a green `npm test` after d5.

## Lessons

`mem-sd-mv1audrd-013b7102` (a tool-call guard must resolve the project root from the target's real path) is recorded by the engineer as **not-applicable**.
- Basis: the lesson applies when a hook or guard maps file writes to a project record or root in a repository with several records.
- This rework edits one test assertion and does not design or change any hook or guard.

I agree with that decision. It matches the plan's assessment ev:ev-mv1eo87o-01c933d5, which rework-1 also used.

## Open items

None owned by this rework. The red `npm test` rows above belong to d5, which is in progress.
