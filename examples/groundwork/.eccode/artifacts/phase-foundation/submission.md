# Phase submission: foundation

Tasks done: foundation-be, verifier-notes, ai-providers.

## Acceptance criteria -> evidence

| Criterion | Evidence | Notes |
|---|---|---|
| Migrations versioned and tested (D3) | ev:ev-mv01hpo7-01307b78 (full unit suite, 87/87 pass, includes test/unit/db/migrate.test.js and schema.test.js); ev:ev-mv0160et-015f6c38 (backend-engineer db tests) | Migrations live in src/db/migrations. |
| package.json with zero dependencies (D2) | ev:ev-mv01hpu5-019e8e6c (checks dependencies/devDependencies/optional/peer are empty) | |
| Notes parser and grounding verifier unit-tested (D4) | ev:ev-mv01bxi1-01d4bbaf (task run), ev:ev-mv01hpo7-01307b78 (suite; includes a 2000-line / 5000-verification benchmark) | Unit level only. |
| Validated structured output, injection-safe prompt, timeouts, malformed output handled (D4, D5) | ev:ev-mv01gtex-0175a046 (ai unit tests), ev:ev-mv01gts1-01c82069 (regression), ev:ev-mv01hpo7-01307b78 | Tested against fake-claude and fake providers only. |

Integration: full unit suite test/unit/** 87 pass / 0 fail (ev:ev-mv01hpo7-01307b78); plan validate OK, 5 phases / 13 tasks (ev:ev-mv01hprf-01741890).

## Gaps and honest notes
- No eval or verifier corpus exists yet (no eval/ directory); grounding quality is only unit-tested, not measured. Belongs to a later phase.
- No live test exists (no test/live); real claude -p / Anthropic behaviour and isolation are not proven live in this phase.
- Two failed evidence records in history: ev:ev-mv015yhu-01ea9b31 (backend-engineer first run, superseded by passing ev:ev-mv0160et-015f6c38) and ev:ev-mv017dyv-041fd9cb (orchestrator reconcile re-run of the claude -p isolation check with --json-schema; exit 127 because its scratchpad script iso.sh no longer existed). That isolation check was therefore NOT successfully re-verified at reconcile; the earlier passing isolation init check is ev:ev-mv017dym-036a4bb4. A live isolation test remains to be written.
- No API/browser/eval tests are in scope for this phase; the npm test globs for them match nothing yet.
