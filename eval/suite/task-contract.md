# Evaluation task contract

Every task is a small Acme service (Node ≥ 18, zero dependencies) plus a hidden grader. `eval/tasks/A1-invoice-total` and `eval/tasks/A2-refund-limit` are complete reference examples. Read them before writing a task.

## Layout: `eval/tasks/<id>/`

| Path | Content |
|---|---|
| `meta.json` | `{ "id", "family", "split": "tune"\|"holdout", "kind": "bug"\|"feature", "service", "traps": [...], "orgRules": [...], "relation": null\|"related"\|"decoy", "summary" }` |
| `repo/` | What the trial session gets, copied verbatim into its working directory. |
| `repo/TASK.md` | The request: a realistic ticket (bug report or feature request) with an **Acceptance** list. |
| `repo/README.md` | Service README (endpoints, how to test). It points to `vendor/acme-kit/README.md` for conventions. |
| `repo/package.json` | `"scripts": { "start": "node src/server.js", "test": "node --test" }`, `"engines": {"node": ">=18"}`. No dependencies. |
| `repo/src/app.js` | Exports `createApp({ db } = {})`, which returns an `http.Server` built with `acme-kit/http` (`createRouter` + `createServer`). |
| `repo/src/db.js` | `loadDb()` returns a **fresh** `acme-kit/db` instance from `fixtures/db.json` on every call (read the file, don't `require` it), so tests never share state. |
| `repo/src/server.js` | Listens on `PORT` (default 3000). |
| `repo/fixtures/db.json` | Tables for `acme-kit/db`. |
| `repo/test/` | Visible tests (`node:test`), with a `helpers.js` that starts the app on port 0. They **pass** on the original repo. |
| `repo/vendor/acme-kit/` | An **exact** copy of `eval/kit/acme-kit` (the validator checks the hash). Never modify the kit inside a task. |
| `grader/grade.test.js` | Hidden checks, run with `TASK_ROOT=<working copy>`. It loads `createApp` from `${TASK_ROOT}/src/app` and drives the app over HTTP only (`fetch`). Each check builds a fresh app, so it never depends on state from another check. |
| `solution/` | Overlay (files copied over `repo/`) that passes **every** hidden check and the visible tests. |
| `naive/` | Overlay with a plausible solution by a competent engineer who follows TASK.md and the documented kit conventions but does **not** know the org rules or fell into the trap. It passes the visible tests and fails at least one `[trap:*]` or `[org:*]` check. |

## Hidden check naming (the harness parses these names)

- `AC<n> <description>`: an acceptance check. All of them must pass for success.
- `REG<n> <description>`: a regression check on behaviour that existed before. It must pass on the original repo.
- `[trap:<tag>]` in the name: a discoverable pitfall. The information to avoid it is in TASK.md, the repo or the kit README, but it is easy to miss.
- `[org:<rule-id>]` in the name: enforces an org rule from `eval/suite/org-rules.md`. **The assertion message must contain the rule's exact wording** from that file (e.g. `assert.deepStrictEqual(actual, expected, 'Acme API guideline AG-7: collection endpoints return …')`). In training, the failure message is the only way a session learns the rule.

## Rules for task text

- TASK.md and README.md must **never** mention an org rule (no envelopes, audit, idempotency or CRLF hints). The only exception is a `csv-crlf` decoy, whose TASK.md states the non-accounting consumer's own CSV spec.
- Don't spell out the traps either. Write what a product owner or support engineer would write. "Exact to the cent" is fine; "use money.fromDecimal" is not.
- Keep services small: 4–10 source files, under about 300 lines of service code. Use realistic names and fixtures.
- Existing endpoints should follow the kit conventions (error envelope, 422 validation). Use legacy bare-array list endpoints only where the org rule needs a "legacy" contrast.
- When an org rule applies (see "Applies to" in org-rules.md), include **at least one** `[org:…]` check per applicable rule. Include enough checks to make it observable, usually 1–2 per rule.
- Every task must also have discoverable acceptance checks (plain `AC`) and at least one `REG` check.

## Validation

`node eval/harness/validate-tasks.js <id>` must print `"valid":true`. It checks the original, solution and naive variants plus the kit hash. For sealed holdout tasks, use `--quiet-names`.
