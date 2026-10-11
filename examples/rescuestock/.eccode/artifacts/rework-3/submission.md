# phase:rework-3 — submission

Author: delivery-lead. Gate: `phase:rework-3`. Date: 2026-10-11.
- Opened by the orchestrator for FU-16 (event 595). c6's RS-33 browser journey `test/browser/journey-infeasible.test.js` set aside a 404 on `POST /api/requests/:id/extract` through the helper `withoutUnregisteredExtract()`, because the route did not exist in phase C. d3 added the route and d4's reset (handoff `ho-mv32b3pf-011eac5d`) removed the frontend-side tolerance. Phase C is approved and no phase D task owns the journey file.
- Triggering evidence: ev:ev-mv3226jz-0198f037 (d5's verification, `npm test` plus `npm run test:browser` 8/8, run while the tolerance was still in the journey).
- One task, `rework-3` (test-engineer), handoff `ho-mv32h04t-01f86c40`. Claim base `e011e54`.
- Ownership: `test/browser/journey-infeasible.test.js` only. The rework changed that file and no other file.

## Where the change is in git

- The edit landed in commit `7942bf2`. The orchestrator's commit swept in the engineer's uncommitted edit together with the other agents' modified files (the handoff discloses this). In that commit the journey file's diff is +1/−18, and nothing else in the file changed.
- Commit `966e761` records the completion. It changes only `.eccode/` records and the pilot report.
- Commit `b8e3489` was made at 00:12:07Z, after my run below (00:12:02Z). Against `966e761` it changes only `docs/build/state.md`, so the code and tests I ran are the same as at the current HEAD.

## Finding → change → test → evidence

| Finding (resolution condition) | Change | Tests | Evidence |
|---|---|---|---|
| **FU-16 / rework-3:** any 404 on `POST /api/requests/:id/extract` during a journey must fail the journey | - Deleted the helper `withoutUnregisteredExtract()` and its comment (17 lines).<br>- The journey's final health assertion is now `assert.deepEqual(problems, [], 'no console errors, CSP violations, page errors or failed requests during the journey')`, with no filter.<br>- The journey's path (a text-only request on the manual-form path) is unchanged. | The three tests of the suite `RS-33: an infeasible request ends with an explanation and no purchase`:<br>- `RS-33: Chromium launched and the app answers on the localhost public URL`<br>- `RS-33: at 360x800 the infeasible request shows ...`<br>- `RS-33: at 1280x800 the infeasible request shows ...` | **Failing first (scratch test, see the disclosure below):**<br>- ev:ev-mv32evim-01a6a1d8: injected 404 with the strict assertion, **FAILED as intended**, 0/1. The assertion lists exactly `HTTP 404: POST http://localhost:…/api/requests/1/extract` and the matching `console error: Failed to load resource … 404`.<br>- ev:ev-mv32exvz-01f53643: the same injection with the old helper, **passed 1/1**. This shows that the helper hid the 404.<br>**After the fix:**<br>- ev:ev-mv32f49o-0164536a: journey file only, 3/3 pass.<br>- ev:ev-mv32ffjq-0128651c: `npm run test:browser`, 8/8 pass.<br>- ev:ev-mv32ghnj-01ee0570: `npm test`, 1216 tests, 1208 pass, 0 fail, 8 skipped, 0 todo.<br>**My run on the final tree:**<br>- **ev:ev-mv32jbs1-016d62d1**: `npm run test:browser`, **8 tests, 8 pass, 0 fail, 0 skipped**, 3 suites, 8.9 s. Two of the three suites are phase D's (RS-03 degraded journey, FU-17 column); the third is this journey, 3/3. |

A repository-wide search finds no `withoutUnregisteredExtract` and no `EXTRACT_ROUTE_MAY_BE_MISSING` in any `.js` file (excluding `node_modules`).

## Disclosure: the failing-first proof is a scratch test, not a test in the repository

- **Why.** The engineer owned only the journey file. The journey cannot itself prove the failing case: if the page's own extract call is forced to 404, the page now (after d4's reset) stays on its error state with a Retry button. The journey then stops at `waitForURL`, before the problems assertion runs. That is the first scratch run, ev:ev-mv32eef8-01a1865d: a timeout after 30 s, a failure for another reason, which the handoff explains but does not list.
- **What the scratch test did.** It ran the journey's sign-up and request-creation steps against the real browser harness. It then answered the extract route with 404 through `page.route` and issued the extract call from the request page. Finally it applied either the strict assertion (`RS_MODE=new`) or the old helper (`RS_MODE=old`).
- **Where it lived.** The file was in the session scratchpad (`…/scratchpad/inject-404.test.js`) and was deleted afterwards. It is not part of the repository or of this submission. A reviewer can only verify it through the two evidence logs and their recorded commands.
- **The permanent guard** is the journey's own unfiltered `deepEqual(problems, [])`. Any failed request on any route, the extract route included, now fails all three journey rows.

## Lessons

`mem-sd-mv1audrd-013b7102` (a tool-call guard must resolve the project root from the target's real path) is recorded by the engineer as **not-applicable**.
- Basis: the rework edits one test file and does not design or change any hook or guard.
- The two guard denials the engineer met (a shell redirect, and inline Python writing files) were correct refusals, not the wrong-root failure the lesson describes.

I agree with that decision. It matches the plan's assessment ev:ev-mv1eo87o-01c933d5, which rework-1 and rework-2 also used.

## Open items

None owned by this rework. FU-16 is closed by this rework once it is approved. Phase D's submission refers to this gate for FU-16.
