# Greenfield Senior S1 (G1 pipeline + contract freeze) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. **Execution chosen for this run: native** (one implementer, test-first), then one fresh independent reviewer on the whole branch.

**Goal:** A project that starts from one idea cannot claim a task until six schema-validated, cross-checked artifacts are approved through the existing architecture, design and plan gates and sealed by hash; contract changes after the seal need a recorded amendment.

**Architecture:** An additive layer in `lib/greenfield/` (no frozen file is edited or requires it). `gf.*` events join the existing hash-chained log; a pure projection rebuilds GF state by replay. Rules are pure functions; they run on the managed (MCP) path and in `eccode-gf` before the frozen function is called, and again as invariants in `gf audit`, which guarantees detection of a violation committed by any path in every profile.

**Tech Stack:** Node >= 18 built-ins only (CommonJS, `node:test`), zero dependencies, like the engine.

**Spec:** `docs/design/greenfield-senior.md` (approved by the owner on 2026-11-04; decisions recorded in its section 14).

## Global Constraints

- **Frozen v3 set:** 48 files in `bench/pilot/phase2-freeze-v3.json` are never edited; `ECCODE_FREEZE_FILE=bench/pilot/phase2-freeze-v3.json node bench/pilot/phase2-seeds.js check` must print `frozen: 48 files` before the first change and after the last. No frozen file may `require` anything under `lib/greenfield/`. `scripts/guards/*.py` are read-only.
- **Wording:** the word *prevent* (any form) appears only in the owner's phrase "prevention on the managed (MCP) path plus guaranteed detection by log-replay audit in all profiles", or in a sentence that also contains "managed" or "audit". The claim never appears without its audit half.
- **Merge rule:** never merge or touch `origin/claude/v3-generalization-fastapi-*`. Limit ids stay placeholders `L-GF-n` in a separate file, `docs/limits-greenfield.md`; `docs/limits.md` and `tests/limits.test.js` are not edited.
- **Paid runs:** none. $0 on the meter. Standing rules: no fabricated numbers, labels before figures, nothing tuned after a result.
- **Non-GF projects behave exactly as before:** every wrapped operation is a straight pass-through unless the log holds `gf.project.initialized`.
- **Every rule** has a positive, a negative and a bypass test; every negative and bypass assertion names the rule id in the refusal, so removing the rule fails the test.
- **Stack profile v1:** `python-fastapi-sqlalchemy-sqlite` is the only value `gf init` accepts.
- Estimate on record for S1: 8-14 h, 4-8 M tokens, 1,600-2,400 prod LOC, 1,800-2,800 test LOC, 60-90 tests. The final report scores it.

## Review Focus

1. **A wrapped call that half-succeeds:** the frozen submit commits, then the registration commit fails or the file changed between validation and hashing. Expected: the review of that submission is refused (`GF-ART-1`), never an approval without registrations; tested.
2. **A non-GF project through the MCP tools:** every wrapped tool must behave byte-for-byte as before (results and refusals). Tested against the original handler outputs.
3. **Unicode, duplicate keys and large inputs in artifacts:** a 5 MB `openapi.json`, a BOM, an operationId with spaces. Expected: a rule-id'd refusal, never a crash with a stack trace.
4. **Artifact path tricks:** `../../etc/passwd` or an absolute path in a submission, a symlink as `contracts/openapi.json`. Expected: refused (the frozen `projectRelative` refuses escapes; GF refuses symlinks as stage artifacts).
5. **Concurrent writers:** two actors sending messages at once. Expected: both committed in order under the store lock, the projection consistent (`Store.commit` serializes; one test with two processes).

---

## File structure

| File | Responsibility |
|---|---|
| `lib/greenfield/constants.js` | groups, roles, stages, artifact names, stack profile, event type list |
| `lib/greenfield/jsonschema.js` | JSON-Schema subset validator |
| `lib/greenfield/openapi.js` | OpenAPI 3.x structural validator, operation index, request-field list, differ |
| `lib/greenfield/events.js` | `gf.*` event schemas, `validate`, `commit` (validates, then `Store.commit`) |
| `lib/greenfield/projection.js` | `project(events)` pure replay |
| `lib/greenfield/stages/{prd,architecture,contracts,threat,breakdown,estimates}.js` | one validator per stage |
| `lib/greenfield/bundle.js` | locate stage artifacts in a submission, run validators, cross-validate approved bundles |
| `lib/greenfield/init.js` | `gf init`: base init + config + `gf.project.initialized` |
| `lib/greenfield/wrap.js` | wrapped `gateStart/gateSubmit/gateReview/taskClaim`, seal |
| `lib/greenfield/contracts.js` | contract hashes, current hash per file, amendment request/apply, drift |
| `lib/greenfield/messages.js` | `gf.message` |
| `lib/greenfield/audit.js` | replay invariants |
| `lib/greenfield/index.js` | public surface + `extendTools(tools)` for `lib/mcp.js` |
| `schemas/gf-{prd,architecture,db-schema,migrations-plan,access-matrix,fixtures,events,threat-model,breakdown,estimates}.schema.json` | artifact shapes |
| `bin/eccode-gf.js`, `agents/{integration,database,security}-engineer.md`, `skills/orchestrate-greenfield/SKILL.md` | CLI, roles, playbook |
| `tests/gf-*.test.js`, `tests/fixtures/gf/{sample,mutations}.js` | tests and the sample bundle |
| `docs/limits-greenfield.md`, `docs/build/gf-s1-evidence.md` | limits, evidence |

Edits to unfrozen files: `lib/mcp.js` (LOCKABLE + `extendTools`), `scripts/hooks/guard.js` (role sets), `scripts/validate-toolkit.js`, `package.json` (`bin`), `docs/design/greenfield-senior.md`.

---

### Task 0: Owner decisions recorded, limits file, wording test

**Files:** Modify `docs/design/greenfield-senior.md`; Create `docs/limits-greenfield.md`; Test `tests/gf-docs.test.js`.

**Interfaces:** Produces the placeholder ids `L-GF-1..L-GF-13` that later tasks cite.

- [ ] **Step 1: Failing test** `gf-docs.test.js`: (a) `docs/limits-greenfield.md` has a row for each of `L-GF-1`..`L-GF-13`, each with a disposition from {`Open, named`, `Open, mitigated`, `By design`}; (b) in `docs/design/greenfield-senior.md`, `docs/limits-greenfield.md`, `skills/orchestrate-greenfield/SKILL.md`, `agents/{integration,database,security}-engineer.md` and the `eccode-gf` help text, every sentence containing `/prevent/i` also contains `managed` or `audit`; (c) `docs/limits.md` is byte-identical to `git show 948a95b:docs/limits.md`.
- [ ] **Step 2: Run** `node --test tests/gf-docs.test.js`. Expected: FAIL (file missing).
- [ ] **Step 3: Write** `docs/limits-greenfield.md` (L-GF-1 the additive-enforcement limit in the owner's exact wording; L-GF-2 stack profile; L-GF-3..12 from design section 11; L-GF-13 the deferred v4 freeze; the process-level E2E check is part of L-GF-10) and add section 14 "Owner decisions of 2026-11-04" plus the corrected wording to the design doc, and the secondary process-level E2E evidence to section 5. Reword every one-sided enforcement claim in the design doc.
- [ ] **Step 4: Run** the test. Expected: PASS.
- [ ] **Step 5: Commit** `docs: record owner decisions and the greenfield limits register`.

### Task 1: JSON-Schema subset

**Files:** Create `lib/greenfield/jsonschema.js`; Test `tests/gf-jsonschema.test.js`.

**Interfaces:** Produces `validate(schema, value, { root? }) -> Array<{ path: string, message: string }>`; `path` is a JSON pointer-like `/a/0/b`. Supports `type` (string or array), `nullable`, `enum`, `const`, `required`, `properties`, `additionalProperties` (bool or schema), `items`, `minItems`, `maxItems`, `uniqueItems`, `minLength`, `maxLength`, `pattern`, `minimum`, `maximum`, `format` (`email`, `uuid`, `date-time`), `allOf`, `anyOf`, `oneOf`, local `$ref` (`#/...`). An unsupported keyword is reported as a problem (never silently ignored).

- [ ] **Step 1: Failing tests:** one accepting and one refusing case per keyword (e.g. `validate({type:'object',required:['a'],properties:{a:{type:'string',minLength:3}}},{a:'xy'})` returns one error with path `/a`); `$ref` resolves and a cyclic `$ref` terminates; an unknown keyword `x-foo` is allowed but `patternProperties` is reported as unsupported; an input of 10^5 array items completes in under 2 s.
- [ ] **Step 2: Run:** FAIL (module missing).
- [ ] **Step 3: Implement** `validate` recursively with a depth cap of 64.
- [ ] **Step 4: Run:** PASS.
- [ ] **Step 5: Commit.**

### Task 2: OpenAPI validator, index and differ

**Files:** Create `lib/greenfield/openapi.js`; Test `tests/gf-openapi.test.js`.

**Interfaces:** Produces
- `validateOpenApi(doc) -> Array<{ rule: 'GF-CON-1', path, message }>` — `openapi` starts with `3.`; `info.title` and `info.version`; non-empty `paths`; methods in get/put/post/patch/delete; unique `operationId` matching `^[A-Za-z][A-Za-z0-9_]*$`; every local `$ref` resolves; every operation has `responses` with at least one 2xx and one 4xx (or `default`) whose JSON content has a `schema` (a 204 may have none); `requestBody`, when present, has `content['application/json'].schema`; every operation has a `security` entry (own or global, non-empty) unless `x-gf-public: true`; used schemes are in `components.securitySchemes`.
- `operations(doc) -> Array<{ operationId, method, path, public, internal, pathParams: string[], security }>`.
- `requestFields(doc, operationId) -> string[]` of `path:<n>`, `query:<n>`, `header:<n>`, `body:<dotted.path>` (object properties flattened to depth 3).
- `diff(a, b) -> { added: string[], removed: string[], changed: string[] }` by operationId, comparing the dereferenced operation JSON.
- `classify(d) -> 'breaking' | 'additive' | 'none'` (removed or changed means breaking, conservatively).

- [ ] **Step 1: Failing tests** with a minimal valid doc: each rule refusal above; `requestFields` for a path-param + query + nested body operation; `diff` on an added, a removed and a changed operation; a duplicate `operationId` is reported once; an operationId with a space is refused; a 5 MB document validates in under 5 s.
- [ ] **Step 2: Run:** FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run:** PASS.
- [ ] **Step 5: Commit.**

### Task 3: Constants, events, projection

**Files:** Create `lib/greenfield/{constants,events,projection}.js`; Test `tests/gf-events.test.js`.

**Interfaces:**
- `constants`: `GROUPS` = `{ api: ['integration-engineer'], backend: ['backend-engineer'], db: ['database-engineer'], security: ['security-engineer'], frontend: ['frontend-engineer'], test: ['test-engineer'], delivery: ['delivery-lead', 'devops-engineer'] }`; `NEW_ROLES = ['integration-engineer','database-engineer','security-engineer']`; `groupOf(role) -> string | null` (`orchestrator` maps to `'orchestrator'`); `STACK_PROFILES = ['python-fastapi-sqlalchemy-sqlite']`; `GATE_STAGES = { architecture: ['prd','architecture'], design: ['contracts','threat'], plan: ['breakdown','estimates'] }`; `CONTRACT_FILES = ['contracts/openapi.json','contracts/db-schema.json','contracts/migrations-plan.json','contracts/access-matrix.json','contracts/fixtures.json']` (+ optional `contracts/events.json`); `EVENT_TYPES`.
- `events.validate(type, data) -> string[]`; `events.commit(store, type, actor, data, check) -> { event, state }` throws `EccodeError('GF_EVENT_INVALID', ...)` before touching the log. S1 types: `gf.project.initialized`, `gf.artifact.registered`, `gf.estimate.registered`, `gf.estimate.revised`, `gf.g1.sealed`, `gf.message`, `gf.contract.amendment.requested`, `gf.contract.amended` with the fields of design section 7.
- `projection.project(events) -> { initialized, stackProfile, registrations, estimate: { original, revisions }, seal, amendments, requests, messages, unknown: string[] }` ignoring non-`gf.` events and listing unknown `gf.` types in `unknown`. Pure; same input gives deep-equal output.

- [ ] **Step 1: Failing tests:** a valid and an invalid payload per event type; `commit` of an invalid payload leaves `events.jsonl` unchanged; projection of a hand-built event list yields the registration, seal and amendment chain; unknown `gf.zzz` lands in `unknown`; replay twice is deep-equal; the base `store.audit()` is still ok after GF events are appended; `state.json` equals a replay (the reducer ignored the events).
- [ ] **Step 2: Run:** FAIL.
- [ ] **Step 3: Implement** (event schemas as JSON-Schema-subset objects validated by Task 1).
- [ ] **Step 4: Run:** PASS.
- [ ] **Step 5: Commit.**

### Task 4: Sample bundle and the six stage validators

**Files:** Create `tests/fixtures/gf/sample.js`, `tests/fixtures/gf/mutations.js`, `lib/greenfield/stages/*.js`, `lib/greenfield/bundle.js`, `schemas/gf-*.schema.json`; Test `tests/gf-stages.test.js`.

**Interfaces:**
- `sample.build() -> { prd, architecture, openapi, dbSchema, migrationsPlan, accessMatrix, fixtures, threat, breakdown, estimates, plan }` — the "Tasks API" project (design section 9): members and admin, register/login/logout, task CRUD with ownership, an admin list; skeleton slice `S0` plus slices `S1` (auth) and `S2` (tasks). Every cross-reference is consistent. `sample.write(dir, art) -> { architecture: string[], design: string[], plan: string[] }` writes the files (contracts under `contracts/`, the rest under `.eccode/artifacts/`) and returns the per-gate artifact path lists. The sample is also the S4 seed.
- `mutations`: an array of `{ rule, name, stage, apply(art) }` — `apply` mutates a deep copy so that exactly that rule is violated; at least one per rule in the table below.
- Each stage module exports `validate(art, ctx) -> Array<{ rule, path, message }>` where `ctx = { config, base, docs }` (`docs` holds the already-parsed artifacts of earlier stages).
- `bundle.js`: `locate(root, files) -> { byName }` (basename lookup; a duplicate basename or a symlink is a `GF-ART-2` problem); `validateGate(root, gateId, files, base, config) -> { problems, registrations: [{ stage, files: [{path, sha256}] }] }`; `validateApproved(root, base, config) -> { problems }` re-validates the architecture, design and plan bundles at their approved submissions and reports `GF-ART-DRIFT` when a file no longer matches its approved hash.

Rules and their pinned checks:

| Rule | Check |
|---|---|
| GF-PRD-1 | schema: `problem` >= 80 chars, `users`, non-empty `scope`, non-empty `nonGoals`; `AC-n` ids unique; `covers` ids exist; every scope id covered |
| GF-PRD-2 | every criterion has `verify.kind` in `http|flow|command|browser` with that kind's required fields |
| GF-PRD-3 | `ambiguityScan` is `{none:true, justification>=20}` or entries; `assumed` entries cite an existing `request.assumption` question id, `clarified` a user `request.clarified`; `none:true` refused while `openQuestions(base)` is non-empty |
| GF-ARC-1 | components/dataFlow/techChoices schema; each tech choice has >= 2 alternatives, a distinct `decision` id resolving to a recorded `design.decision` whose options include the chosen and every alternative, with a rendered ADR |
| GF-CON-1 | `validateOpenApi` problems |
| GF-CON-2 | db-schema shape, a primary key per table, resolving references; migration steps ordered, each with non-empty `up` and `down`; each table created by exactly one step |
| GF-CON-3 | access matrix complete over roles x operations x ownership (`own`,`other` for operations with `{` in the path, else `none`), no extra or duplicate cells, an `anonymous` role at level 0, every `expected` is `allow` or `deny` |
| GF-CON-4 | fixtures roles within the matrix roles, `anonymous` without credentials; optional events file shape |
| GF-CON-5 | every `http`/`flow` criterion `operationId` and `as` role exist; every operation covered by a criterion or `x-gf-internal: true` |
| GF-THR-1 | every operation behind >= 1 boundary; threats cite existing boundaries; mitigations resolve (`contract` operationId, `criterion` AC id, `component` id); `inputValidation` covers exactly `requestFields` of every operation; `accessMatrixSha256` equals the file's sha256 |
| GF-WBS-1 | slice `S0` tasks equal `plan.json` tasks on id, owner and files; task `owner` in its group's roles; task files inside the group's globs; task `estLines` <= `config.plan.maxLinesPerTask`; dependencies do not point to a later slice |
| GF-WBS-2 | group globs disjoint after `denyGlobs`; `contracts/**` and `mocks/**` only in `api`, `tests/acceptance/**` only in `test`; the `api` and `test` groups own those paths |
| GF-WBS-3 | every criterion in a slice and in a `test`-group task; every operation `provides`-ed by exactly one `backend`-group task |
| GF-EST-1 | every group with tasks has an entry; `tasks` equals the breakdown count; `low <= high`; `label` is exactly `agent-estimate-uncalibrated`; `basis` >= 40 chars |
| GF-ART-2 | duplicate basename or symlinked stage artifact |

- [ ] **Step 1: Failing tests:** (a) the sample passes every stage and `validateGate` for all three gates (positive); (b) `for (const m of mutations)` apply the mutation to a copy of the sample, run `validateGate` for `m.stage`'s gate, and assert a problem with `rule === m.rule` (negative), and that the unmutated sample has none of that rule; (c) a coverage test asserting every rule id in the table has at least one mutation.
- [ ] **Step 2: Run:** FAIL (modules missing).
- [ ] **Step 3: Implement** the stages and `bundle.js` to the table; schemas in `schemas/gf-*.schema.json` are the source of the shape checks (loaded with `readJson`, validated by Task 1).
- [ ] **Step 4: Run:** PASS.
- [ ] **Step 5: Commit.**

### Task 5: Init, wrapped operations, seal

**Files:** Create `lib/greenfield/{init,wrap,index}.js`; Test `tests/gf-flow.test.js`.

**Interfaces:**
- `init.initProject(root, { name, idea, stackProfile, actor = 'orchestrator' }) -> store` — fails `GF-INIT-1` on an unsupported profile or when already GF-initialised; calls the base `init(root, { name, idea, track: 'greenfield' })`, rewrites `.eccode/config.json` with `roles.phase.authors` (default list plus the three new roles), `roles.verification.authors` unchanged, `roles.design.reviewers = ['technical-reviewer','security-reviewer']`, `limits.maxConcurrency = 4`, `gf: { enabled: true, schemaVersion: 1, stackProfile }`, then commits `gf.project.initialized`.
- `wrap.isEnabled(store) -> boolean` (the log holds `gf.project.initialized`).
- `wrap.gateStart(store, config, gateId, actor, opts)`, `wrap.gateSubmit(store, config, gateId, actor, opts)`, `wrap.gateReview(store, config, gateId, reviewer, review)`, `wrap.taskClaim(store, config, taskId, actor, opts)` — same arguments and return values as `gates.startGate/submit/recordReview` and `tasks.claim`. Not enabled: call the frozen function unchanged. Enabled:
  - `gateSubmit` on architecture/design/plan: `validateGate` first (refuse with `EccodeError('GF_RULE', ...)` whose `details.problems` carry the rule ids); then `gates.submit`; then commit one `gf.artifact.registered` per stage with the sha256 values taken from the committed submission, refusing (`GF-ART-1`) if they differ from what was validated.
  - `gateStart` for `phase:*`: `GF-SEAL-1` (no seal yet); `GF-EST-1` (no registered estimate).
  - `gateReview`, decision `approve`, gates architecture/design/plan: refuse `GF-ART-1` unless the latest submission has registrations for every stage of the gate with unchanged hashes. After a successful plan approval, run `seal`.
  - `taskClaim`: `GF-SEAL-1` unless sealed.
  - `seal(store, config)`: `validateApproved` over all three gates must be clean; commits `gf.estimate.registered` (from the approved `estimates.json`) then `gf.g1.sealed { contractsHash, hashes, planSubmissionId, estimateSeq }`. `contractsHash = sha256` of the sorted `path:sha256` lines of the contract files and the PRD.
- `index.extendTools(tools) -> tools` appends the `gf_*` tools (Task 8) and replaces `gate_start`, `gate_submit`, `gate_review`, `task_claim` with handlers that call the originals when not enabled and `wrap.*` when enabled.

- [ ] **Step 1: Failing tests:** (a) full happy path: init, architecture (with `design alternatives/decide/adr` per tech choice recorded first), design (with `--reviewers technical-reviewer,security-reviewer`), plan; after the plan approval `gf.g1.sealed` exists and `task_claim` of an S0 task succeeds; (b) negatives: claim before the seal refused `GF-SEAL-1`; phase start without seal refused; submit with a mutated PRD refused with its rule id and nothing committed to the log; approving a submission whose registration is missing refused `GF-ART-1`; init with profile `node-express` refused `GF-INIT-1`; second init refused; a second `gf.estimate.registered` after the seal refused; (c) a non-GF project: the same operations return what the originals return, with identical errors.
- [ ] **Step 2: Run:** FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run:** PASS.
- [ ] **Step 5: Commit.**

### Task 6: `gf audit` and the bypass battery

**Files:** Create `lib/greenfield/audit.js`; Test `tests/gf-audit.test.js`.

**Interfaces:** `audit.run(store, config) -> { ok, errors: Array<{ rule, seq?, message }>, base }` where `base` is `store.audit()` plus `delivery.unreviewedChanges`; `ok` needs both clean. Invariants: `GF-AUD-1` every `gf.*` event valid and known; `GF-AUD-2` `gf.project.initialized` first and unique; `GF-ART-1` every architecture/design/plan submission after init has registrations matching its hashes; `GF-ART-DRIFT` and all artifact rules re-run by `validateApproved` on approved bundles; `GF-ORD-1` no `gate.started phase:*` or `task.claimed` event before `gf.g1.sealed`; `GF-SEAL-1` a plan gate approved without a matching seal, or a seal whose hashes differ from the approved submissions; `GF-FRZ-2` a contract file whose bytes differ from the latest recorded hash; `GF-EST-1` a registration after the seal or a revision without an original.

- [ ] **Step 1: Failing tests:** B0 a clean flow audits ok; for every `mutations` row, **bypass**: drive the whole flow through the frozen API only (`gates.startGate/submit/recordReview` with approvals; `design` module for decisions), with the mutation applied, then `audit.run` reports `m.rule` (the base engine approves it, GF detects it); B1 a forged `gf.g1.sealed` committed with `Store.commit` directly is reported (`GF-SEAL-1`); B2 editing `contracts/openapi.json` one byte after the seal gives `GF-FRZ-2`; B3 a `gf.message` with `from` other than the actor's group is `GF-MSG-1`; B4 an `events.jsonl` with two lines swapped is reported by the base chain and `ok` is false; B5 `tasks.claim` called directly before the seal gives `GF-ORD-1`.
- [ ] **Step 2: Run:** FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run:** PASS.
- [ ] **Step 5: Commit.**

### Task 7: Messages and contract amendment

**Files:** Create `lib/greenfield/{messages,contracts}.js`; Test `tests/gf-amend.test.js`.

**Interfaces:**
- `messages.send(store, config, actor, { to: string[], kind, subject, body, refs?, inReplyTo? }) -> data` — `kind` in `question|answer|amendment-request|blocker|decision|handoff`; `GF-MSG-1`: `from` is the actor's group (`groupOf`), `to` groups exist, `body` <= 4096 bytes; `GF-MSG-2`: an `amendment-request` is addressed to `api`. `messages.list(store, filter) -> data[]`.
- `contracts.current(gf) -> { [path]: sha256 }` (seal hash, then latest amendment `toSha` per file); `contracts.drift(store) -> string[]`.
- `contracts.requestAmendment(store, config, actor, { contract, reason, message, proposed })` — the message must exist, be an `amendment-request` from the actor's group; the contract must be one of `CONTRACT_FILES`; after the seal only.
- `contracts.applyAmendment(store, config, actor, { request, reason })` — actor is a configured reviewer (`design`, `phase` or `verification` reviewers); `GF-FRZ-5`: `reason` >= 30 chars; `fromSha` equals `current[path]`; `toSha` is the file's present sha256 and differs; the request is open; computes `classification` and `affectedOps` (OpenAPI via `diff`/`classify`; any other contract file is `breaking`, `affectedOps: []`); commits `gf.contract.amended` with `invalidates: []` (no slices exist in S1).
- `contracts.verifyOne(store, path) -> { ok, expected, actual }`.

- [ ] **Step 1: Failing tests:** positive message, request and apply (the OpenAPI gains an operation: `additive`; one removed: `breaking`); negatives per rule id; bypass: apply with a `toSha` that is not the file's bytes; edit the file and skip the amendment (audit `GF-FRZ-2`); apply an amendment twice; a non-reviewer actor; a request citing a message from another group; two processes sending messages concurrently both land in order and the projection is consistent.
- [ ] **Step 2: Run:** FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run:** PASS.
- [ ] **Step 5: Commit.**

### Task 8: MCP tools, roles, agents, skill, hook role sets

**Files:** Modify `lib/mcp.js` (add the three roles to `LOCKABLE`; `tools()` result passed through `require('./greenfield').extendTools`), `scripts/hooks/guard.js` (add the three roles to `IMPLEMENTERS` and `ROLES`), `scripts/validate-toolkit.js`; Create `agents/{integration,database,security}-engineer.md`, `skills/orchestrate-greenfield/SKILL.md`; Test `tests/gf-mcp.test.js`.

**Interfaces:** New tools: `gf_status`, `gf_validate { gate, artifacts[] }` (dry run, writes nothing), `gf_message_send`, `gf_message_list`, `gf_amend_request`, `gf_amend_apply`, `gf_estimate_revise { reason, groups }`, `gf_audit`. Agents' front matter: `name` equals file name, `tools: Read, Grep, Glob, Write, Edit, Bash`, `model: sonnet`, no `Agent` tool. The skill is a G1 playbook for the orchestrator: order of gates, what each author submits, how a refusal is read, how assumptions are recorded, the wording rule.

- [ ] **Step 1: Failing tests:** `tools()` lists the eight `gf_*` names; `LOCKABLE` has the three new roles; each new role has an agent file whose name matches (also via `scripts/validate-toolkit.js`); on a GF project `gate_submit` through the tool handler refuses a mutated PRD with the rule id while on a non-GF project the handler output is identical to the original's; the guard script, fed a Write event by `frontend-engineer` with no claimed task, still denies; fed `integration-engineer` it denies the same way (role is known).
- [ ] **Step 2: Run:** FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run:** PASS, then `npm run validate`.
- [ ] **Step 5: Commit.**

### Task 9: `eccode-gf` CLI

**Files:** Create `bin/eccode-gf.js`; Modify `package.json` (`"bin": { "eccode": ..., "eccode-gf": "bin/eccode-gf.js" }`); Test `tests/gf-cli.test.js`.

**Interfaces:** Commands (all take `--actor`, `--json`): `init --name --idea [--stack python-fastapi-sqlalchemy-sqlite]`, `status`, `validate <gate> [--artifact f]...`, `gate start|submit|review`, `task claim <id>`, `amend request|apply`, `message send|list`, `estimate revise`, `audit`. Exit 0 ok, 1 usage, 2 refusal (like the base CLI). Uses `lib/cli-args.parseArgs`.

- [ ] **Step 1: Failing tests** (spawn the CLI in a temp git project): `init` then `status` shows GF enabled; `validate` of the sample bundle exits 0 and of a mutated one exits 2 naming the rule; `audit` exits 0 clean and 2 after a contract byte is changed; unknown command exits 1; help text contains no bare "prevent".
- [ ] **Step 2: Run:** FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run:** PASS.
- [ ] **Step 5: Commit.**

### Task 10: Verification gate

- [ ] **Step 1: Frozen set:** the check prints `frozen: 48 files` (exit 0), and `git diff 948a95b --stat -- <the 48 files>` is empty.
- [ ] **Step 2: Full suite:** `npm run check`; record tests / pass / fail / skipped and the skip census; skips are not expected to change.
- [ ] **Step 3: Mutation checks:** for each rule, temporarily remove its check and confirm at least one test fails (script in the evidence file); restore.
- [ ] **Step 4: Independent review:** one fresh reviewer agent on the whole branch diff against the spec and this plan; fix findings with a failing test first.
- [ ] **Step 5: Evidence and estimate table:** write `docs/build/gf-s1-evidence.md` (commands, outputs, red/green counts per task, the estimate-versus-actual table with the delegated-agent tokens from the ledger and the measured wall time; my own session tokens are not reported to me and are marked "not measurable by the agent"); add ledger rows for any delegated agent; commit and push; STOP and report.

---

## Self-review

- **Spec coverage:** section 3.1-3.6 (stages, schemas, cross-validation, seal, amendment, estimates, assumptions) are Tasks 4, 5, 7 (assumptions in GF-PRD-3); 2.2 the enforcement model is Tasks 5 and 6; 2.4 roles is Tasks 3 and 8; section 8 rules for S1 (`INIT, PRD, ARC, CON, THR, WBS, EST, SEAL, FRZ-2, FRZ-5, MSG`) each map to a table row or interface above. Out of S1 by design: ownership enforcement at write time (S2), mock/contract tests (S3), slices (S4), done verification (S5).
- **Deviation from the spec, recorded:** the design's single rule `GF-WBS-1` is split into `GF-WBS-1..3`, `GF-ART-1/2/DRIFT`, `GF-ORD-1`, `GF-AUD-1/2` are added, estimates are registered at seal time (not at each submit), and checkpoints are dropped from `breakdown.json` because the base engine already derives them. The design doc's as-built section lists these.
- **Type consistency:** `validateGate` returns `{ problems, registrations }` in Tasks 4, 5 and 8; rule ids are the strings in the Task 4 table everywhere.
