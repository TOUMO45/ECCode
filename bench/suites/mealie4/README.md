# mealie4: large multi-file changes, for the multi-file run

These are the multi-file run's items ([spec](../../../docs/specs/2026-10-26-multifile-run-design.md)).
- The proof run (`../mealie3`) took every change within the pilot's size cap: at most 400 lines in at most 12 files. Its bare agent passed 36 of 38 runs.
- This suite takes the changes that cap kept out: large fixes and features that touch many files.
- The window is v3.20.0..`75332567`, which spans the pilot's, the rerun's and the proof run's windows. No earlier suite's item comes back.

**No Mealie file is in this repository.** Tasks name upstream commits, and the harness exports trees and hidden tests from the local mirror when a run happens. Mealie is AGPL-3.0; ECCode is MIT.

**Tools.** This suite shares the pilot suite's tools.

`../mealie/_tools/select.js` validates every eligible change into `_tools/selection.json`. Create `_tools/` first. The command:

```
select.js --suite bench/suites/mealie4 --range v3.20.0..753325676331cf8df48cae7c64ce634f2cb693cb --large --fallback v3.10.0..v3.20.0
```

**Eligible.** A change is eligible when it meets all of these:
- it is a fix or feature, not a dependency update or bump;
- it changes `mealie/` and has backend tests;
- it is multi-file. Counted without tests, docs, translations or lockfiles, it has:
  - at least 5 files;
  - at least 4 of them under `mealie/`;
  - 100 to 1,500 lines;
- it is not an item of `mealie`, `mealie2` or `mealie3`.

**Validation and the fallback.**
- Each eligible change is validated live: its new or changed tests fail on its parent and pass at the commit, twice on each side, and the regression set passes on both sides.
- When fewer than 12 are accepted, every eligible change of v3.10.0..v3.20.0 is drawn too.
- Every skip is recorded with its reason.

**Building.**
- `../mealie/_tools/build.js --suite bench/suites/mealie4` writes one task directory per accepted change, in upstream order, from the selection and `_tools/prompts.json`.
- A `fix` subject runs on the fix track, a `feat` subject on the feature track.
- `_tools/env.js` builds and links the environments as `../mealie/_tools/env.js` does.

**Requests** (`_tools/prompts.json`) are issue-style, under the proof run's rules:
- they name what the hidden tests pin by symbol, never by the path of a file the fix changes;
- they contain no line of the fix;
- they state every behaviour the target tests check;
- the backend is always in scope; frontend work is in scope only when the change adds or changes frontend specs.

Agents drafted the requests from the commits and their tests. The operator reviewed, corrected and approved each one before registration. `_tools/coverage.json` keeps, for each request, the test functions it covers and the drafter's notes. A `spec-gap` label is judged against it.
