# The behavior diff

Before a `fix`, `feature` or `refactor` work item is delivered, the engine knows exactly which observable behaviour changed, and refuses delivery of a change nobody declared. It runs the **baseline** (the work item's base commit) and the **candidate** (the working tree) on the same probes in two isolated worktrees and compares.

`quick` and `debug` skip it by design (they are the tracks for small, reviewed changes and single bugs). On the other tracks, **risk routing** decides: `eccode behavior route` records whether the change reaches a public surface (an HTTP route in a changed or dependent file, a definition another file imports, a CLI entry point, a database schema or migration); if so, the diff must run before the last gate is submitted. A change confined to tests, docs or a helper nothing imports records `skip`, and the engine re-checks that at submission.

## The flow

```
eccode behavior contract --file entries.json --actor technical-designer   # during design or planning, BEFORE any diff
eccode behavior route --actor backend-engineer                            # run or skip, recorded
eccode behavior diff --actor backend-engineer                             # owner's run; exit 2 on an unexplained difference
eccode behavior diff --actor technical-reviewer                           # the reviewer's own run, after submission
eccode behavior amend --result bd-… --file entries.json --reason "…" --actor technical-reviewer   # only a reviewer explains after the fact
eccode behavior waive --result bd-… --reason "…" --actor technical-reviewer                      # only for insufficient-coverage
eccode behavior show
```

A contract entry is `{surface: http|function|cli, target, inputClass, expected}`; the target is `METHOD /path` (with `*` suffix wildcards) or `file.py::function`. A refactor declares nothing: every difference is unexplained by definition.

## What the engine does (`lib/behavior.js`, `scripts/behavior/probe_runner.py`)

1. Two detached worktrees, the candidate with the working tree's changes laid over `HEAD`; dependency directories linked; each side gets its own temporary directory for `{tmp}` placeholders in the configured environment (the database, caches). The runner closes the network for its process (socket connections outside loopback raise).
2. **Probe corpus**, generated once in the baseline:
   - **HTTP** probes from the FastAPI app's OpenAPI schema for the impacted operations. An operation is impacted when its full path matches a route found by pattern on a decorator, **or** (the endpoint-source join) when the endpoint the running app serves for it is defined in a changed file or in a file that imports one: the app's routes are walked the way FastAPI's own OpenAPI generation walks them, so routers included under prefixes (newer FastAPI keeps `include_router` lazy), bound-method endpoints and decorated endpoints are found. The probes that came from the join carry `via: endpoint-file`, and the result artifact lists them as `joinedOperations`. The probes: deterministic example inputs (path and query parameters, JSON bodies, three variants), one probe per configured role (`roles` in `.eccode/behavior.json`, each with its headers). Reads run first, then creations and updates, deletions last, so a destructive probe shapes as few later probes as possible.
   - **Function** probes for the impacted functions of changed Python files: Hypothesis generates bounded, JSON-able inputs from the type annotations (`derandomize=True`, `behavior.functionExamples` per function, default 25); the same inputs replay on both sides; return values and raised exception types are compared.
3. The baseline runs `behavior.baselineRuns` times (default 2). Any field that differs between baseline runs is **nondeterministic**: excluded from the comparison and listed; a probe whose status or result is nondeterministic is dropped and counted.
4. **Normalization**: UUIDs, ISO timestamps, memory addresses, `<X object at …>`, the engine's own worktree path and the line numbers a traceback quotes (`, line 52, in …`) are replaced; the two sides' directories are named with tags of the same length, because output that quotes a path differs by its length; project normalizers (`normalizers: [{pattern, replace}]`), ignored fields (`ignoreFields`) and unordered collections (`unordered: ["$.items"]`, sorted before comparison) come from `.eccode/behavior.json`.
5. **`behavior.diff.result`**: probe count, executed, dropped, every difference (probe, input, changed paths with both values, content hash) classified **expected** (matches a contract entry or a reviewer's amendment) or **unexplained**, the coverage label, the tree fingerprint, and the artifact under `.eccode/behavior/` with both sides' full outputs. `eccode audit` re-hashes it.
6. **Coverage**: a result that executed no probe, or none that reached an impacted surface, is `insufficient-coverage`; it blocks until more probes reach the surface or a reviewer waives it with a reason. It never passes silently.

Every run of the probe runner is an evidence record (`behavior: generate corpus`, `behavior: baseline run 1`, …) under the integrity window.

## The gates (`tests/behavior.test.js`, `tests/phase2-bypass.test.js`)

| Rule | Code |
|---|---|
| The last gate needs a routing; a `skip` is re-checked against the tree | `TRACK_RULE` |
| With routing `run`, the latest result must have no unexplained difference (after amendments) and coverage `ok` or a waiver | `TRACK_RULE`, `DELIVERY_BLOCKED` |
| A result is stale once the tree changes (`treeFingerprint`); so is the reviewer's | `TRACK_RULE`, `REVIEW_REJECTED`, `DELIVERY_BLOCKED` |
| Verification approval needs the diff **re-run by the approving reviewer after the submission** | `REVIEW_REJECTED` |
| A contract after a result exists is refused; only a reviewer amends, never the reviewer whose run it was | `CONTRACT_AFTER_DIFF`, `ROLE_NOT_ALLOWED` |
| A refactor declares nothing | `CONTRACT_REFUSED` |

## Project configuration (`.eccode/behavior.json`, travels with the tree, never runs commands from the record)

```json
{
  "app": "shop.app:app",
  "env": { "SHOP_DB": "{tmp}/shop.sqlite" },
  "setup": null,
  "roles": [{ "name": "anonymous", "headers": {} }, { "name": "user", "headers": { "X-Role": "user" } }, { "name": "admin", "headers": { "X-Role": "admin" } }],
  "normalizers": [{ "name": "etag", "pattern": "W/\"[0-9a-f]+\"", "replace": "<etag>" }],
  "ignoreFields": ["generated_at"],
  "unordered": ["$.body.tags"]
}
```

`setup` is a shell command run in each worktree before the probes (migrations, seed data). The interpreter is `ECCODE_PYTHON`, `python` in this file, the project's `.venv`, or `python3`; it needs `fastapi`, `httpx` (the test client) and `hypothesis`.

## Worked example (fixture change `leaked-field`: a user starts seeing other users' emails; the suite stays green)

```
$ eccode behavior route --actor backend-engineer
Risk routing: run — the change reaches 6 public surface(s): http DELETE /items/{item_id}, http GET /items, …
$ eccode behavior diff --actor backend-engineer
Behavior diff bd-… (base 1a2b3c4d5e6f): 54 probes, 54 executed, 0 dropped as nondeterministic; 2 difference(s): 0 expected, 2 unexplained; coverage ok
  unexplained http:GET /users/{user_id}#0@user: $.body.email undefined -> "ann@example.test"; $.body.role undefined -> "admin"
  unexplained http:GET /users/{user_id}#2@user: $.body.email undefined -> "bob@example.test"; $.body.role undefined -> "user"
Artifact: .eccode/behavior/bd-….json
```

The fixture scorecard (`tests/fixtures/phase2/scorecard.md`, produced by `tests/phase2-fixtures.test.js`): 6 of 6 unintended changes that pass the suite are flagged, and none of the 3 declared changes and the 1 refactor is. That is a hand-written fixture, a ceiling and not a rate.

**What is measured on a real application (Mealie), and what is not claimed.** The absolute claim "zero false positives" is retired. Measured: zero noise on 12 of 12 comment-only controls; 1 false positive among 8 observed intended seeds (a function-level change outside the HTTP contract); the frozen detector v3 flagged 27 of 57 (47.4 percent, exact 95 percent interval 34.0 to 61.0) agent-written, suite-passing changes, below the pre-registered 50 percent. v3 is not a superset of v2: padding strings to `minLength` lost one seed that v2 had caught (limits rows 184 to 186).

## Before you trust it on a real application (three checks; each found a defect in the first real run)

1. **Give the probes something to find.** The probes are schema examples (the first string is `alpha`, the first integer 1). On an empty application most of them end in "not found" and the logic behind existing data is invisible. Use `setup` to create a small, generic data set (through the application's own API or repositories, with names that match those examples); `bench/pilot/phase2-hb/mealie_setup.py` is a worked example. Fields of the `uuid` family (`uuid`, `uuid1`, `uuid3`, `uuid4`, `uuid5`) are filled with valid UUIDs; list ids that **exist** after the setup in `exampleIds` (at most 8) and each operation with uuid inputs gets one variant per id (the first uuid field takes `exampleIds[v]`, the next `exampleIds[v+1]`), so the request reaches the logic instead of a 404. The same ids must exist on both sides: make the setup produce the same ids every time (the Mealie setup renumbers every table in creation order to `…0001`, `…0002`, `…0003` after it has run, and a test asserts the ids a fresh setup produces equal the configured ones). Keep the ids the **roles authenticate as** out of `exampleIds`: with ids that exist, a DELETE probe on the first example id would otherwise remove the user (or the token) that every later probe of that role needs. The generator also makes a mixed-case email (variant 2), a padded mixed-case string (variant 1), values that meet `minLength`, `time` and `uri` formats, and a confirmation field equal to its sibling (`passwordConfirm` = `password`).
2. **Find the application's own nondeterminism, and show that the noise floor is zero on the controls you run.** Run the diff on a change that cannot alter behaviour (prepend a comment line to a widely imported module: every line number shifts) with `behavior.baselineRuns` raised to 6, and read the result artifact's `nondeterministic` list: random tokens, per-run paths and sizes show up there. A field that differs between two baseline runs is excluded automatically, but a two-valued random field agrees by chance in two runs, so list such fields in `ignoreFields`. Two sources of nondeterminism that a richer data set introduces are worth knowing: the order in which a many-to-many relation is read back (the association rows are stored in the order the ORM flushed a set of objects, which differs per run; sort them in the setup) and routes that choose at random (the answer differs per run and a three-valued choice agrees in two baseline runs a third of the time; give the route a single candidate in the data). Then repeat the comment-only control on files of different layers: **a result is only worth reading once the control gives zero unexplained differences.** `bench/pilot/hb2/edit-check.js` does both for a given edit.
3. **Read the coverage label as the weak claim it is.** `ok` means at least one probe executed and at least one reached some impacted surface, not that every impacted surface was probed (register row 176). Read `joinedOperations` and the surfaces before treating "no difference" as "no change".

## Limits

See `docs/limits.md` rows 145–150: FastAPI and Python functions only; stateful probes; generated inputs, not production traffic; nondeterminism found by two runs only; test-observed outputs not captured; the surface rule routes nearly every code change into the diff. Rows 171–177 add what the first run on a real application (Mealie) found: the endpoint-source join reads FastAPI applications only; a route the change adds is not in the baseline corpus; a change to a widely imported module probes every operation of every importer and early writes cascade into later probes; storage-size fields are random per run on Mealie and are excluded; the traceback-line normalizer hides a difference that is only a shifted line.
