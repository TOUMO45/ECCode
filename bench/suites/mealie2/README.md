# mealie2: ten fresh real changes to Mealie, for the rerun

The Mealie rerun's Part B ([protocol](../../protocols/2026-10-25-mealie-rerun.md)). The pilot's suite (`../mealie`) is not sampled again with the same model, so this one draws ten new items under the pilot's rules from a later window: v3.27.0..v3.29.0, history the pilot never used.

**No Mealie file is in this repository.** Tasks name upstream commits; the harness exports trees and hidden tests from the local mirror when a run happens. Mealie is AGPL-3.0; ECCode is MIT.

**Tools.** This suite shares the pilot suite's tools:
- `../mealie/_tools/select.js --suite bench/suites/mealie2 --range v3.27.0..v3.29.0` draws the items into `_tools/selection.json`;
- `../mealie/_tools/build.js --suite bench/suites/mealie2` writes the task directories from it and from `_tools/prompts.json`, the requests written by hand;
- `_tools/env.js` builds and links the environments as `../mealie/_tools/env.js` does. Since v3.28 Mealie needs Python 3.14, and each venv is built with the Python its tree requires.

**The refactor item** removes a different duplication from the pilot's: the query-filter validators that the meal-plan rule and cookbook schemas share. It was found by `_hidden/dup_check.py --scan` at v3.27.0, as the largest set of duplicated methods two classes of one layer share once the pilot's pair is excluded.

Set up the environments as for the pilot (`../mealie/README.md`); the selector builds any missing ones.
