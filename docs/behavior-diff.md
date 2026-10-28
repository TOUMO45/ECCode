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
   - **HTTP** probes from the FastAPI app's OpenAPI schema for the impacted routes: deterministic example inputs (path and query parameters, JSON bodies, three variants), one probe per configured role (`roles` in `.eccode/behavior.json`, each with its headers). Reads run first, then creations and updates, deletions last, so a destructive probe shapes as few later probes as possible.
   - **Function** probes for the impacted functions of changed Python files: Hypothesis generates bounded, JSON-able inputs from the type annotations (`derandomize=True`, `behavior.functionExamples` per function, default 25); the same inputs replay on both sides; return values and raised exception types are compared.
3. The baseline runs `behavior.baselineRuns` times (default 2). Any field that differs between baseline runs is **nondeterministic**: excluded from the comparison and listed; a probe whose status or result is nondeterministic is dropped and counted.
4. **Normalization**: UUIDs, ISO timestamps, memory addresses and `<X object at …>` are replaced; project normalizers (`normalizers: [{pattern, replace}]`), ignored fields (`ignoreFields`) and unordered collections (`unordered: ["$.items"]`, sorted before comparison) come from `.eccode/behavior.json`.
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

The fixture scorecard (`tests/fixtures/phase2/scorecard.md`, produced by `tests/phase2-fixtures.test.js`): 6 of 6 unintended changes that pass the suite are flagged, 0 false positives on 3 declared changes and 1 refactor.

## Limits

See `docs/limits.md` rows 145–150: FastAPI and Python functions only; stateful probes; generated inputs, not production traffic; nondeterminism found by two runs only; test-observed outputs not captured; the surface rule routes nearly every code change into the diff.
