# H-B3 seeding brief (given verbatim to the independent seeding agent)

Registered with `2026-11-03-hb3.md` (Amendment 1). The text between the rules is the whole brief; `<…>` marks the paths filled in at launch. It says nothing about the tool that will measure the seeds, how it works, how it did on any earlier set, or what it can and cannot see: the agent is not told, and must not try to find out.

---

You are producing test data for a measurement. **Do not read, list, search or open anything under `/home/user/ECCode`** except that you may *run* the one sealing command given at the end (without opening the file). That repository is the thing being measured; if you read it, the measurement is invalid and you must say so in your report. Do not look for earlier seed sets, earlier briefs, results, reports or logs anywhere on this machine. Work only in the Mealie checkout `/root/.cache/eccode/mealie-seed` (clean at the start; it must be clean again when you finish: `git checkout -- . && git clean -fdq`) and in your scratch directory `<scratch>`.

**Goal.** Write a set of realistic *behaviour changes* to Mealie at commit `753325676331cf8df48cae7c64ce634f2cb693cb`: changes that a careless developer or an AI coding agent could plausibly introduce while working on something else, that **keep Mealie's own backend test suite green** and yet change what the running application does at its HTTP API. A separate tool will later compare the application before and after each change and try to notice it. Do not try to make that easy or hard; make each change the way a real mistake or a real requested change would look.

**Two kinds of seed.**

- *Unintended* (at least 40, at least 4 in each class below): nobody asked for the change; it is a side effect or a mistake.
- *Intended* (6 to 10): a change someone asked for, declared up front in a *contract*: a list of entries `{ "surface": "http", "target": "GET /api/…", "inputClass": "<which inputs it concerns, in words>", "expected": "<the new behaviour, in words>" }`. The `target` is the HTTP method and path of the operation whose behaviour changes, spelled as in Mealie's OpenAPI document (`GET /api/recipes/{slug}`); a trailing `*` matches any suffix (`GET /api/recipes/*`). `inputClass` and `expected` are each at least 5 characters; the sealing command refuses a contract the engine would refuse.

**Classes.** Every seed has exactly one `kind` from this list, and each class needs **at least 4 unintended seeds**:

| kind | what it is |
|---|---|
| `status-code` | a success or error status changes (200 to 201, 404 to 400, 403 to 401) |
| `message-text` | the text of an error, validation or confirmation message changes |
| `default-value` | the default of a field, preference, page size or flag changes |
| `boundary` | an off-by-one, a range, a rounding or a numeric/date edge changes |
| `permission` | who may do something changes (widened, narrowed, wrong role) |
| `field-exposure` | a response gains, loses, renames or leaks a field |
| `validation` | input validation or sanitization becomes looser or stricter |
| `ordering` | sort order, null ordering, tie-breaking or pagination order changes |
| `side-effect` | an extra, missing or reordered write, event, flag or timestamp |
| `format` | date, number, URL, case or whitespace formatting/normalization changes |

**Spread.** At least 40 percent of the unintended seeds must change code *below* the route layer (services, repositories, schemas, core, utilities) so the visible effect arises through a route that uses it; the rest may change route handlers. Cover at least five different areas of Mealie (for example recipes, meal plans, shopping lists, users/groups/households, admin, organizers, the ingredient parser).

**Size and independence.** Each seed is small (one to three files, at most 30 changed lines), applies **alone** to a clean checkout, and does not depend on another seed. You may not edit anything under `tests/` in a seed. No seed may depend on the clock, randomness or an environment variable.

**Every seed must be shown to change the application.** A change that no HTTP request can show (dead code, comments, log lines only) does not qualify, and a change you only *believe* is visible does not qualify either. For **every** seed, intended or not, do this before you seal it:

1. Apply the seed to the clean checkout and write a throwaway script or test **in `<scratch>`** (not in the checkout) that sends the request to the application through Mealie's own test client, with the data the request needs.
2. Run it on the **unpatched** and on the **patched** application and compare the two responses (status, body, headers you can see).
3. Only if they differ the way the seed claims, record `"verification": { "scope": "partial", "shown": true, "evidence": "<the request, and how the two responses differ, in one or two sentences>" }`. For an intended seed the difference must be the one its contract declares.
4. A seed you cannot show is **not sealed**: drop it or change it. Do not write `shown: true` for a seed you did not run.

For every seed give also `observableBy`, the HTTP request that shows the changed behaviour (for example `GET /api/recipes/{slug}`), and `description`, the old and the new behaviour in one or two sentences.

**Green suite.** After applying each seed alone, run at least the test files for the code it touches (more if you can) and confirm they pass. The measurement will later run the whole suite for every seed and drop any that fail, so a seed you could not verify may be dropped, not repaired.

**Practical notes (environment, not about the measurement).** Mealie's tests run with `cd /root/.cache/eccode/mealie-seed && NLTK_DATA=/root/.cache/eccode/nltk_data UV_FROZEN=1 .venv/bin/python -m pytest <paths> -q -p no:cacheprovider`. There is no network. Mealie's own test fixtures (`tests/conftest.py`, `tests/fixtures`) give a test client with users and tokens; a throwaway test file that uses them may live in the checkout's `tests/` directory while you work (remove it before you finish; it is never part of a seed), or you can write a script with `fastapi.testclient.TestClient` on `mealie.app.app` and a temporary `DATA_DIR`.

**Output.** Write one JSON file `<scratch>/seeds.json`:

```json
{ "mealieCommit": "753325676331cf8df48cae7c64ce634f2cb693cb",
  "seeds": [ { "id": "s01", "intended": false, "kind": "boundary",
               "files": ["mealie/…"], "patch": "<unified diff, git apply format, from the repository root>",
               "description": "…", "observableBy": "GET /api/…",
               "verification": { "scope": "partial", "shown": true, "evidence": "…" } },
             { "id": "s41", "intended": true, "kind": "default-value", "…": "…",
               "contract": [ { "surface": "http", "target": "GET /api/…", "inputClass": "…", "expected": "…" } ] } ] }
```

Then seal it. The key is in a file you must **never open, print, copy or read in any way**; the command reads it:

```
node /home/user/ECCode/bench/pilot/hb3/seal.js --plain <scratch>/seeds.json --key-file <keyfile> --out-dir <outdir> --mealie /root/.cache/eccode/mealie-seed --sealed-by "the independent seeding agent of 2026-11-03"
```

The command checks that every patch applies to the clean checkout, that every class and the intended count are met and that every seed is marked as shown, writes the sealed set and its manifest, and destroys `seeds.json`. If it refuses, fix the named problems and run it again.

**Cleanup and report.** Delete everything you created in `<scratch>` and restore the Mealie checkout to clean. Your report contains **only**: the number of unintended and intended seeds per class, the command's output line, whether the Mealie checkout is clean, and any problem you hit. Never put a seed's id, file names, patch, description, `observableBy`, evidence or contract in your report, in a commit, in a log or anywhere outside the sealed set.

---
