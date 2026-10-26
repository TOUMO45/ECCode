# mealie3: every fresh change in a window, for the proof run

The proof run's items ([protocol](../../protocols/2026-10-26-mealie-proof.md)). The pilot (`../mealie`) and the rerun (`../mealie2`) each drew one change per category. This suite takes every eligible change of a later window instead: W3 = v3.29.0..`75332567` (the head of `mealie-next` on 2026-10-24). That history is newer than any fix ECCode has made.

**No Mealie file is in this repository.** Tasks name upstream commits. The harness exports trees and hidden tests from the local mirror when a run happens. Mealie is AGPL-3.0; ECCode is MIT.

**Tools.** This suite shares the pilot suite's tools:
- `../mealie/_tools/select.js --suite bench/suites/mealie3 --range v3.29.0..753325676331cf8df48cae7c64ce634f2cb693cb --all` validates every eligible change into `_tools/selection.json`. A change is eligible when it is a fix or feature (no dependency update or bump) that changes `mealie/` with backend tests, within the size cap. Each is validated live: its new or changed tests fail on its parent and pass at the commit, twice on each side, and the regression set passes on both sides. Every skip is recorded with its reason.
- `../mealie/_tools/build.js --suite bench/suites/mealie3` writes one task directory per accepted change, from the selection and `_tools/prompts.json`, in upstream order. A `fix` subject runs on the fix track, a `feat` subject on the feature track.
- `_tools/env.js` builds and links the environments as `../mealie/_tools/env.js` does.

**Requests** (`_tools/prompts.json`) are issue-style, under the pilot's rules, with one more: a request states every behaviour its target tests check.
- Four agents drafted them from the commits and their tests, and the operator reviewed, corrected and approved each before registration.
- `_tools/coverage.json` keeps, for each request, the test functions it covers and the drafter's notes on what was hard to state fairly. This is what a `spec-gap` label is judged against.

Set up the environments as for the pilot (`../mealie/README.md`); the selector builds any missing ones.
