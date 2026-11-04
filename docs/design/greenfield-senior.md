# Greenfield Senior: one idea to a verified, running project (Phase G0 design)

**Status:** design for review. No code is written. Nothing here is implemented until you approve a slice.
**Branch:** `claude/sleepy-shannon-dxbk7v`, restarted from the H-B3 tip `948a95b` (see 1.1).
**Frozen v3 set:** 48 of 48 files match their recorded hashes at this commit (`ECCODE_FREEZE_FILE=bench/pilot/phase2-freeze-v3.json node bench/pilot/phase2-seeds.js check` printed `frozen: 48 files`). It is checked again before every commit of this work (section 13).
**Evidence marks:** † = read by me in the file named; ‡ = reported by a read-only recon agent and re-verified before the slice that relies on it.

---

## 0. Summary, and the decisions I need from you

A single idea becomes a verified, running project through four things the engine already has the shape of, and one it does not:

1. **A sequential thinking pipeline (G1)** whose six artifacts are schema-validated and approved through the existing architecture, design and plan gates, then sealed by hash.
2. **Parallel role groups (G2)** that each own a path map, build against the sealed contracts, and talk only through hash-chained events.
3. **A pinned integration run per slice** (contract tests + acceptance tests + security guards), with the behavior diff between slices.
4. **An evidence-only definition of DONE (G3).**
5. **What does not exist yet:** every rule that ties these together, and a way to add them without touching a frozen file.

The last point decides the architecture. The 48 frozen files include `bin/eccode.js`, the reducer, the store, the gate engine, the task engine, the design module, the guards and the security module. I may not edit any of them. So the new layer is **additive**: new files that no frozen file requires, new `gf.*` events in the same hash-chained log (the reducer already ignores unknown events †`lib/reducer.js:611-614`), and enforcement at the three points that are not frozen: the MCP tool layer, the PreToolUse hook, and an audit that replays the log.

### Decisions (my recommendation first)

| # | Decision | Recommendation | Why it needs you |
|---|---|---|---|
| **D1** | Extend without modifying frozen files. Enforcement is *prevented* at write time through the MCP layer and the hook, and *detected* by log replay in every profile. The plain `eccode` CLI cannot refuse a Greenfield-Senior rule (it is frozen). | Accept. Fallback if you reject it: cut a v4 freeze, which means a protocol note and a new hash file. | It trades "refuse everywhere" for "refuse where agents write; detect everywhere". Section 2.2 shows exactly where each applies. |
| **D2** | Slices are sequential `feature` work items after one `greenfield` work item that holds G1 and the walking skeleton. | Accept. | The behavior diff and the api/perf/race guards refuse the `greenfield` track and need a base commit (1.4, C1-C2). A slice as a `feature` work item gets them with zero frozen edits. The cost is a design gate and a plan gate per slice (S4 estimate). |
| **D3** | Stack profile v1: Python, FastAPI, SQLAlchemy/Alembic, SQLite; OpenAPI as JSON. Frontend is free (static or React), tested over HTTP and a browser. | Accept. A project outside the profile can be built and tested but cannot reach DONE. | The security guards, api/perf/race guards and behavior diff operate on FastAPI only (C3). Anything else would make criterion G3.4 vacuous. |
| **D4** | G3.3 ("docker compose up from a clean checkout") fails closed when Docker is unavailable. **The Docker daemon is not running in this sandbox** (C9). | Accept. S4's demo report may honestly end `NOT DONE: deployment unverifiable here` with the other four criteria green. | The first demo you asked for may not be able to say "100% working" in this environment. You can run S5's verifier on a machine with Docker, or I probe for a rootless daemon at S5. |
| **D5** | "Hidden from implementers" is best effort. The hook matcher does not intercept Read/Grep/Glob today (C6). | Seal acceptance tests by hash, deny writes, extend the hook matcher to reads where the harness honors it, and keep a held-out subset outside the repository for G3 and for G4. | The word "hidden" must not overpromise. |
| **D6** | Estimates are in tokens and hours. `pricing.usdPerMillionTokens` is `null` in the config and the compute ledger records tokens only. | Accept. Give me a blended rate and I will convert. | I will not invent a dollar figure. |

Section 10 has the pre-registered estimate per slice. Section 9 has the slice plan.

---

## 1. Recon: what exists

### 1.1 Base and branch (a finding, not a plan change)

`948a95b` is not an ancestor of main's tip `21fc8fc` (v0.16.0, the squash merge of PR #25), and the reverse is also true. Merge base `e3e8b75`; 189 commits on the H-B3 line, 1 on main †(`git rev-list --left-right --count`). The session branch `claude/sleepy-shannon-dxbk7v` pointed at `21fc8fc` and carried no unique commit, so I restarted that same branch name from `948a95b`. `21fc8fc` still exists on three other remote refs.

### 1.2 What "frozen" means here, and the extension surface it leaves

The freeze is `bench/pilot/phase2-freeze-v3.json`, 48 files by sha256. The rule †`bench/pilot/phase2-seeds.js:46-63`: the require-closure of `lib/behavior.js`, plus the CLI entry and its argument parser, the probe runner, and the seed harness. `check` also fails on a file the rule covers that the freeze does not list †(`:88-93`), so **a new `require()` from any frozen file is also a violation**.

| Frozen (do not edit) | Not frozen (I may edit) | New files (not required by any frozen file) |
|---|---|---|
| `bin/eccode.js`, `lib/{reducer,store,gates,tasks,design,plan-budget,project,config,works,delivery,evidence,worktree,lean,compat,preflight,schema,util,cli-args,codebase,bugs,lab,mutate,stack,standards,security,behavior}.js`, `lib/guards/*.js`, `lib/memory/{draft,env,records,search}.js`, `scripts/behavior/probe_runner.py` | `lib/{mcp,install,status,runs,chain,bench,fixverify,profile,cbm}.js`, `scripts/hooks/*`, `hooks/hooks.json`, `scripts/guards/*.py`, `scripts/validate-toolkit.js`, `package.json`, `agents/`, `skills/`, `commands/`, `schemas/`, `templates/`, `docs/`, `tests/` | `lib/greenfield/*`, `bin/eccode-gf.js`, new agents and skills |

I add one rule of my own: **`scripts/guards/*.py` are treated as read-only**, although the freeze does not pin them. The frozen JavaScript computes its verdicts from their output, so changing them would change the frozen behavior by the back door.

### 1.3 Brief item, existing primitive, gap

| Brief item | What exists | Gap |
|---|---|---|
| Phase gates, evidence-backed approval, author is not approver | `lib/gates.js`: order, evidence per criterion, open findings, escalation †`:50-78,205-303` | Only prose gates; no machine-validated artifact schemas |
| PRD | The `architecture` gate with config `requiredSections` †`gates.js:165-171`, headings only | No acceptance-criteria structure, none machine-checkable |
| Architecture with >= 2 alternatives and an ADR per choice | `design alternatives/decide/adr` †`design.js:63-132`; the track rule refuses ownership without one decision †`tasks.js:141-146` | One decision is enough to pass; nothing ties each technology choice to its own ADR |
| Contracts frozen by hash | `plan contracts`: free text `{id, kind, text}`, refused after work starts †`plan-budget.js:25-49`; `design amend` for interfaces †`design.js:135-143` | Not hashed, not machine-readable, not enforced against code |
| Access matrix | `security policy`: cells `{role, endpoint, ownership: own\|other\|none, expected: allow\|deny}`; matrix, IDOR, authflow, input probes ‡`lib/security.js`, `lib/mcp.js:213-218` † | Hand-declared, not generated from a contract; FastAPI only |
| Work breakdown under a size budget | `validatePlan` DAG + owners †`tasks.js:19-61`; budget 3 files / 150 lines, waivable †`plan-budget.js:10-12,65-74`; checkpoint every 3 tasks †`:92-103` | No group, slice, or estimate |
| Ownership | Per-task globs enforced at claim, completion and by the hook †`tasks.js:156-160,259-260`, `guard.js:453-470` | Per task, not per group; the shared scratch `.eccode/drafts/**` is writable by all †`tasks.js:16` |
| Migration guard (reversible) | Alembic `missing-downgrade` is blocking; rollback proof on a seeded DB ‡`lib/guards/migration.js` | Alembic only; proof only if `guards.json` configures it |
| N+1 / perf guard | Query-count delta >= 3 relative to a baseline ‡`lib/guards/perf.js` | Needs a baseline where the app exists |
| IDOR/BOLA, mass assignment, field-leak oracle, SQL differential | In `scripts/guards/access_probe.py` (oracles at ‡`:333-375`, `:426-559`, `:683-745`) | FastAPI only; single-sided, so usable on a new project |
| Behavior diff v3 | `lib/behavior.js` | **Refuses the greenfield track** †`behavior.js:25,49`; no flag for the base commit ‡ |
| Headless rule, DECLARED_ASSUMPTION | `request.ambiguity` / `request.assumption` with `headless: true` †`design.js:224-245`, `docs/design-decisions.md`; the label set ASKED / DECLARED_ASSUMPTION / SILENT_GUESS / NEITHER exists in the bench relabel pipeline †`tests/relabel.test.js:54-60` | Nothing forces a PRD to surface its ambiguities |
| Hash-chained events | `Store.commit` → `events.jsonl`, `audit()` †`store.js:103-147` | Group-to-group messages are not events |
| Run accounting for estimates | `run start/end`, `metrics` †`mcp.js:109-110` | No estimate is registered before work |
| Pre-registration | Protocols committed before runs; hash freezes of code | No code gate on spend (‡ recon: text only, "Nothing starts without the owner's approval") |

### 1.4 Constraints found (each shapes the design)

| ID | Constraint | Evidence | Consequence |
|---|---|---|---|
| C1 | The behavior diff runs on `fix`, `feature`, `refactor` only, and needs the work item's `baseCommit`; there is no flag for two commits | †`behavior.js:25,49,330-331` | Slice-to-slice diff = each slice is a `feature` work item whose base is the previous slice's commit (D2) |
| C2 | `api`, `perf`, `race` need a baseline in which the app already exists. `security` and `migration` are single-sided | ‡ `lib/guards/*` | Slice 1 onward gets real before/after pairs. The first work item (skeleton) must **not** configure `behavior.json` `app`, or `guard api` fails on a baseline with no app |
| C3 | Every HTTP guard, the security probes, and the behavior diff are FastAPI-only; migrations are Alembic-only; the behavior diff's database is SQLite | ‡ `lib/guards/*`, `docs/limits.md` rows 145, 182 | Stack profile D3 |
| C4 | Greenfield guard routing changes with the base: with no base commit only `release` is required; with a base commit and a configured app it also demands `api`, `perf`, `security` | †`worktree.js:57-59`, `guards/index.js` (`requiredFor`) | Work item 1 keeps `app` unset; work items 2..n configure it (rule GF-CONF-1) |
| C5 | One work item is active at a time | ‡ `docs/architecture.md` work items; `works.js` | Slices are sequential; groups are parallel *inside* a slice |
| C6 | The hook matcher is `Bash\|Edit\|Write\|MultiEdit\|NotebookEdit`; reads are not intercepted | †`hooks/hooks.json` | D5 |
| C7 | `limits.maxConcurrency` defaults to 2; checks run one at a time (row 87) | †`.eccode/config.json`, `tasks.js:152-155` | `gf init` writes a concurrency of 4 (the number of simultaneously active groups); evidence runs still serialize |
| C8 | Roles come from config and arrays are replaced, not merged †`config.js` `deepMerge`; `LOCKABLE` and the hook's role sets are hard-coded | †`mcp.js:19-23`, `guard.js:32-47` | New roles are added through project config plus those two unfrozen lists |
| C9 | `docker` and `docker compose` clients exist, but there is no daemon socket in this sandbox. Python has no `fastapi`, `sqlalchemy`, `alembic`, `pytest`, `hypothesis` or `httpx`, but pip reaches the index (a `fastapi==0.115.0` wheel downloaded). **35 of the 53 baseline test skips are this missing stack**, so the baseline does not exercise the behavior-diff and guard paths G2 and G3 call | Probed in this session; `baseline-check.txt` skip census (section 13) | D4. S2 creates a virtualenv (`ECCODE_PYTHON`) first and records the skip count before and after, so a green run is never read as covering code it skipped |
| C10 | The behavior diff v3 flagged **27 of 57** seeded unintended changes (47.4 percent, exact 95 percent interval 34.0 to 61.0); its 50 percent threshold was **not met**. v3 is not a superset of v2 (one seed v2 caught was lost). The absolute claim "zero false positives" is retired | †`docs/build/state.md`; †`git show cc6af4f`, the positioning correction on `origin/claude/v3-generalization-fastapi-s1df80`, which is **not in this line** | "Behavior diff clean" is evidence of *no detected* change, never of no change. The delivery report carries this sentence, and the doc makes no false-positive-rate claim |

---

## 2. Architecture of the Greenfield-Senior layer ("GF")

### 2.1 Components

```
lib/greenfield/
  index.js            open(), wrap(), audit(): the public surface
  events.js           the gf.* event schemas; every commit is validated against them
  projection.js       pure replay: events.jsonl -> GF state (no state.json change; the base reducer is untouched)
  rules.js            the rule catalog (section 8): pure functions (baseState, gfState, root, input) -> problems[]
  wrap.js             wrappers over gate/task/deliver operations: rules.check(), then the frozen function
  jsonschema.js       zero-dependency JSON-Schema subset (artifact schemas, response validation)
  openapi.js          OpenAPI 3.x structural validator + operation index
  contracts.js        seal, hash, amend, drift, conformance
  ownership.js        group map, glob algebra, plan cross-check
  mock.js             mock server generated from the sealed OpenAPI
  contract-tests.js   provider + consumer test generator
  slice.js            slice open / pinned integration run / invalidate
  done.js             G3 verification
  report.js           delivery report, estimate vs actual
  messages.js         gf.message
bin/eccode-gf.js      CLI: init, g1, seal, amend, slice, message, estimate, verify-done, report, audit
schemas/gf-*.schema.json            prd, architecture, contracts, threat-model, breakdown, estimate
agents/{integration,database,security}-engineer.md
skills/orchestrate-greenfield/SKILL.md
tests/gf-*.test.js
```

Edits to **unfrozen** existing files only: `lib/mcp.js` (register `gf_*` tools, wrap base tools, extend `LOCKABLE`), `scripts/hooks/guard.js` (new role sets, group ownership, contract and acceptance paths), `hooks/hooks.json` (matcher), `lib/status.js` (a GF-aware NEXT line), `scripts/validate-toolkit.js`, `package.json` (`bin`), `docs/`.

### 2.2 Enforcement model: prevent versus detect

Every rule is one pure function in `rules.js` and is evaluated at up to four points.

| Point | Mechanism | Strength |
|---|---|---|
| **P** MCP / `eccode-gf` write | `wrap.js` runs the rule, then calls the frozen function | Structural: in the `sandbox` and `no-shell` profiles (the install default) agents have no shell and write the record only through MCP, so there is no path around it |
| **H** PreToolUse hook | `guard.js` evaluates the rule for file writes and for `eccode` shell commands | Text-level, as today (limits rows 91, 117): it reads command text |
| **A** Audit replay | `eccode-gf audit` replays the whole log and re-evaluates every rule as an invariant over history | Detects a violation committed by *any* path, including the frozen `eccode` CLI, in every profile |
| **D** Done verification | `gf.done.verified` requires a clean GF audit and a clean base audit | Nothing is declared DONE on top of a violation |

What this means for D1, stated plainly:

- In `sandbox` / `no-shell`: **prevented** at P, detected at A.
- In the opt-out `guard` profile (CLI + hook): **hook-prevented best effort**, detected at A.
- With hooks off or a harness without them: **detected only**, at A and D. The project can still be built, but it cannot be declared DONE on top of a violation.

### 2.3 The log and the projection

All GF facts are `gf.*` events committed with `Store.commit(type, actor, data, check)` †`store.js:103`. They join the existing hash chain, so `store.audit()` already covers their integrity, and the `check` callback runs inside the lock against the real base state. `projection.js` rebuilds GF state by replay on demand; it never writes `state.json`, so `STATE_VERSION` (7) and snapshot equality are untouched. A newer log stays readable by an older engine, which is the reducer's stated contract †`reducer.js:611-614`.

Artifacts that GF hashes (sealed contracts, acceptance tests, guard configs, the delivery report) are verified by `gf audit`; the frozen `artifactErrors` †`store.js:156-186` knows nothing about them.

### 2.4 Groups and roles

A **group** is a named ownership domain with one lead role. Sub-agents of a group act under the group's role id, so a group's agents are not individually identified (a limit, section 11).

| Group | Role (actor id) | New? | Owns (default globs, declared in the breakdown) |
|---|---|---|---|
| api | `integration-engineer` | new | `contracts/**`, `mocks/**`, `tests/contract/**` |
| backend | `backend-engineer` | reused | `app/**` excluding `app/db/**` |
| db | `database-engineer` | new | `app/db/**`, `migrations/**`, `seed/**` |
| security | `security-engineer` | new | `app/auth/**`: the *implementation* of the access matrix. The matrix itself (`contracts/access-matrix.json`) is api-owned |
| frontend | `frontend-engineer` | reused | `web/**` |
| test | `test-engineer` | reused | `tests/acceptance/**` |
| delivery | `delivery-lead` (+ `devops-engineer`) | reused | `Dockerfile`, `docker-compose.yml`, `Makefile`, `docs/**`, integration tasks |

`security-reviewer` stays a reviewer and cannot author. Authoring (`security-engineer`) and review stay separate, so author is not approver holds without a new rule.

---

## 3. Phase G1: the thinking pipeline

### 3.1 Stages mapped onto the existing gates

The track already fixes the order architecture → design → plan †`reducer.js:17-19`. G1 does not add gates; it adds a **bundle validator per gate**, run by `wrap.js` before the frozen `gate submit`.

| Stage | Artifact (JSON, schema in `schemas/gf-*.schema.json`) | Submitted at | Author / reviewer |
|---|---|---|---|
| 1 PRD | `prd.json` + `prd.md` | `architecture` | product-architect / architecture-reviewer |
| 2 Architecture | `architecture.json` + `architecture.md`, plus one ADR per technology choice | `architecture` (ADRs rendered by the design module) | same |
| 3 Contracts | `contracts/openapi.json`, `contracts/db-schema.json`, `contracts/migrations-plan.json`, `contracts/access-matrix.json`, `contracts/events.json` (optional), `contracts/fixtures.json` | `design` | technical-designer / technical-reviewer |
| 4 Threat model | `threat-model.json` + `.md` | `design` | technical-designer / **security-reviewer added with `--reviewers`**, so both reviewers must approve the same submission †`gates.js:50-62`, `reducer.js:222-224`. The default config allows only `technical-reviewer` on the design gate †`gates.js:61-64`, so `gf init` writes `security-reviewer` into `roles.design.reviewers` in the project config (arrays are replaced, C8) |
| 5 Work breakdown | `plan.json` (existing schema) + `breakdown.json` (groups, ownership, slices) | `plan` | delivery-lead / technical-reviewer |
| 6 Estimates | `estimates.json` → `gf.estimate.registered` | `plan` | delivery-lead |

Dependencies between stages are rules (section 8): a stage cannot be registered unless the stages it cites exist under approved submissions with unchanged hashes.

### 3.2 Artifact schemas (field level)

**PRD** (`prd.json`)
```
problem            string >= 80 chars          users[]       {id, description, goals[]}
scope[]            {id, statement}             nonGoals[]    non-empty, strings
ambiguityScan      {none: true, justification} | [{id, question, resolution: "clarified"|"assumed", assumptionId?}]
criteria[]         {id: "AC-n", statement, covers: [scope ids], priority: P0|P1|P2,
                    verify: {kind: "http", operationId, as: roleName, request, expect: {status, jsonPath[]}}
                          | {kind: "flow", steps[ {operationId, as, request, expect, save?} ]}
                          | {kind: "command", run, expectExit, expectStdout?}
                          | {kind: "browser", script, expect}}
```
A criterion with no `verify`, or with a `kind` outside the closed set, is refused. That is what "machine-checkable" means here: the test group can generate an executable test from the criterion alone, and the engine can check that one exists.

**Architecture** (`architecture.json`)
```
components[]       {id, responsibility, group}
dataFlow[]         {from, to, via: operationId|event, data}
techChoices[]      {id, topic, chosen, alternatives[ >= 2 {id, why-not} ], decision: "<design.decision id>"}
```
`decision` must resolve to a recorded `design.decision` whose alternatives had at least two options, with an ADR rendered. This is how "ADR per choice" becomes checkable: N tech choices need N decisions, not one.

**Contracts bundle**
- `openapi.json`: OpenAPI 3.x as JSON. Unique `operationId`s; every operation has a security requirement (or an explicit `public: true`), at least one success and one error response schema, and request schemas for bodies.
- `db-schema.json`: tables, columns, types, nullability, keys, indexes. `migrations-plan.json`: ordered steps, each with `up`, `down`, and the tables it creates or changes. Every table in the schema must be created by exactly one step; every step must have a non-empty `down`.
- `access-matrix.json`: `roles[{name, level}]` and cells `{role, operationId, ownership: own|other|none, expected: allow|deny}`, **complete** over every role × operation (× ownership for operations with a path parameter). It converts one-to-one to the `security.policy` cell format.
- `fixtures.json`: how each role obtains credentials, and the seed object ids provider tests may use. The database group's seed data must satisfy it.

**Threat model** (`threat-model.json`)
```
assets[]  trustBoundaries[ {id, crosses: [operationId...]} ]  threats[ {id, boundary, category, mitigation: {ref: contract|criterion|test, id}} ]
inputValidation[ {operationId, field, rules} ]   accessMatrixSha256
```
Rules: every operation sits behind at least one boundary; every request field of every operation in the sealed OpenAPI has an `inputValidation` entry (the checklist is *generated* from the contract, so a missing field is a computed omission, not a judgement); every threat has a mitigation that points at something that exists; `accessMatrixSha256` equals the contract's.

**Work breakdown** (`breakdown.json`)
```
groups[]   {name, role, globs[], denyGlobs[]}
slices[]   {id, goal, criteria[], operations[], tasks[]}
tasks      the existing plan task fields + {group, slice, estLines}
checkpoints[]  placed every `plan.checkpointEvery` tasks
```
Rules: every task's `owner` is its group's role and its `files` are inside the group's globs; group globs are pairwise disjoint; `contracts/**` belongs only to `api`, `tests/acceptance/**` only to `test`; every task `estLines` <= `plan.maxLinesPerTask` (the engine still enforces the real size at completion †`plan-budget.js:65-74`); every PRD criterion appears in at least one slice **and** in at least one test-group task; every operation has exactly one provider task.

**Estimates** (`estimates.json`): per group `{tasks, minutes: {low, high}, tokens: {low, high}}` plus `basis` text. See 3.5.

### 3.3 Cross-validation (the part prompts cannot do)

PRD ↔ contract: every `http` criterion's `operationId` exists in the OpenAPI, and every operation is covered by at least one criterion or marked `internal: true`. Access matrix ↔ OpenAPI: no missing and no extra cells. Threat model ↔ OpenAPI and matrix: computed above. Breakdown ↔ everything: coverage computed above. Each is a pure function over files plus the log, evaluated at P and re-evaluated at A.

### 3.4 The seal (contract freeze) and amendment

When the `plan` gate flips to approved, the wrapped `gate_review` commits `gf.g1.sealed` in the same call. It records the sha256 of every contract file, the PRD, the access matrix, the breakdown and the ownership map, plus a single `contractsHash` over the sorted list. The base `eccode audit` already reports an approved artifact that changed afterwards: it is `store.audit()` plus `delivery.unreviewedChanges`, and with `--against <ref>` it detects history rewritten since a committed copy †`bin/eccode.js:995-1011`. The seal adds what that does not have: a baseline of *contract* hashes that later rules compare against, and a switch into amend-only mode.

A later contradiction is refused or detected at five places:

1. **Write** (H/P): contract paths are writable only by `integration-engineer` (rule GF-FRZ-1).
2. **Completion** (P): a task whose files include contract paths is refused unless it belongs to the api group and cites an amendment.
3. **Slice run** (rule GF-FRZ-2/3/4): contract bytes still equal the seal or the latest amendment; the implementation's `app.openapi()` (via the existing `openapi_dump.py`) equals the sealed OpenAPI structurally; the migrated database (via `schema_dump.py`) equals `db-schema.json`.
4. **Audit** (A): replay finds any contract hash that changed without an amendment event.
5. **Done** (D): all of the above on the final tree.

**Amendment** is two events. `gf.contract.amendment.requested` is a message-borne request from the consuming group (rule GF-MSG-2 requires it to be a `gf.message` to `api`). `gf.contract.amended` is committed only by a reviewer role (the precedent is `design.amend`, reviewer-only †`design.js:135`). It carries: reason (>= 30 chars), the old and new file hash (the new hash must equal the bytes on disk at commit time), an additive/breaking classification computed by the OpenAPI differ, the affected operations, and the slices it invalidates. Every `gf.slice.integrated` whose operations intersect the change becomes `invalidated` and must re-run.

### 3.5 Estimates as a pre-registered prediction

`gf.estimate.registered` is committed before the first `gate start phase:*`, and the wrapper refuses that start without it (GF-EST-1). It is immutable. `gf.estimate.revised` may follow; the report scores the **original**, shows revisions beside it, and never replaces it. Actuals come from existing records: tokens, cost and run minutes from `run.*` events grouped by the dispatched role †`mcp.js:109-110`, and wall time from `task.claimed` to `task.completed`. The label on every figure is "agent estimate, not calibrated". A calibration claim needs the estimates and actuals of several projects, and I will not make it from one.

### 3.6 Ambiguity and DECLARED_ASSUMPTION (rule d)

Reuse the headless mechanism that exists: a non-blocking question is recorded with its reading as a `request.assumption` with `headless: true` in one step †`design.js:224-245`. Greenfield-Senior adds structure around it:

- `prd.json` must contain `ambiguityScan`. "Nothing ambiguous" is a positive statement with a justification, not an absent field (GF-PRD-3).
- Every scan entry is either `clarified` (a user `request.clarified`) or `assumed` and cites a `request.assumption` id.
- The delivery report prints every `request.assumption` under the label **DECLARED_ASSUMPTION**, the same label the bench relabel pipeline uses †`tests/relabel.test.js:54-60`. G4's "declared-assumption count" is therefore measured with an instrument that already exists.
- A **blocking** question still stops planning †`design-decisions.md`. The engine cannot detect an *undeclared* guess. It makes a declared one impossible to omit from the report (the report is generated from the log) and makes the scan mandatory. That limit is registered (section 11).

---

## 4. Phase G2: team topology

### 4.1 Slices are work items (D2)

```
W1  greenfield   G1 pipeline + walking skeleton + red acceptance baseline + generated contract tests
W2  feature      slice 1   base = W1's delivered commit
W3  feature      slice 2   base = W2's delivered commit
...
Wn+1 feature     "rc" work item, only if anything changed after the last slice (G3.4)
```

The skeleton has the FastAPI app stub, `Dockerfile`, `docker-compose.yml`, the Alembic baseline, the mock server wiring, all generated contract tests (red), and all acceptance tests (red). It does **not** configure `.eccode/behavior.json` `app` (C2, C4).

`gf slice open <id>` is the only way to start a slice. It: requires the previous slice integrated and delivered; starts the `feature` work item; **writes** `behavior.json`, `guards.json` and `security.json` from the sealed contracts (the access matrix becomes `security.policy` cells; GET routes become perf probes; the migration proof config comes from the plan) and records their hashes in `gf.slice.opened` (rule GF-CONF-1). Those three files are engine configuration. An agent cannot weaken the security policy by editing them, because a changed hash refuses integration.

Each slice has its own design gate and plan gate because the frozen `feature` track requires them. A slice's design gate needs its own recorded decision with two alternatives †`tasks.js:141-146`, and the `feature` track also requires an acknowledged release plan ‡`lib/guards/release.js` (the engine can carry one plan text across slices, but a reviewer still acknowledges each). That is real overhead and appears in the S4 estimate. A "light slice" variant (the engine pre-fills the design document from the sealed contracts; the designer still records two alternatives) is available if the overhead is too high.

### 4.2 Ownership map and path-scoped permissions (rule a)

`breakdown.json` declares the map; the seal hashes it; `gf.ownership.amended` (reviewer-only, with a reason) is the only change path. Enforcement:

| Where | Check |
|---|---|
| Plan (P) | task files inside the owning group's globs; groups disjoint (GF-OWN-1) |
| Write (H) | file inside the actor's group globs **and** inside a claimed task's globs (the second check exists today †`guard.js:464-470`) (GF-OWN-2) |
| Completion (P) | `filesChanged` inside the group map, not just the task's globs (GF-OWN-3) |
| Slice run (A/P) | every file changed since the previous slice commit belongs to a completed task of the owning group (GF-OWN-4) |
| Scratch | `.eccode/drafts/**` is writable by every implementer †`tasks.js:16`. Writes are namespaced `.eccode/drafts/<group>/**`; this narrows the channel, it does not close it. Registered as a limit |

### 4.3 Mock server and contract tests (the API / integration group)

Both are generated from the sealed `openapi.json` and carry a header `GENERATED from contracts sha256:<contractsHash>`. They are zero-dependency Node, so they work for any implementation language.

- **Mock server** (`mocks/server.js`): serves examples from the schema (deterministic); unknown route or method → 404 and a recorded **violation**; request body or parameters that fail the request schema → 4xx and a violation; auth by `Authorization: Bearer mock-<role>` resolved through the access matrix (401 without, 403 on a `deny` cell), so the frontend exercises its error paths. It is stateless in v1: it cannot play a multi-step flow, so flows are verified against the real backend at integration.
- **Frontend cannot invent endpoints:** (1) the frontend test run against the mock must end with an empty violation log (GF-FE-1); (2) a static scan of `web/**` for URL literals not in the contract, labelled heuristic; (3) the frontend group cannot write `contracts/**`.
- **Provider tests** run against the real app; **consumer tests** run against the mock. Both validate responses with `jsonschema.js`, a subset validator (types, required, properties, items, enum, bounds, pattern, local `$ref`, `nullable`, limited `oneOf`/`anyOf`). The subset is stated and tested against the sealed contract's own keywords.

### 4.4 Slice integration: one pinned run (rule b)

`gf slice integrate <id>` is the only way to produce `gf.slice.integrated`. It:

1. requires a clean tracked tree and a committed head; takes `treeHash` and `commit`;
2. requires the three guard-config hashes unchanged (GF-CONF-1);
3. commits `gf.slice.run.started {treeHash}`;
4. runs, each recorded by the engine: provider contract tests, consumer tests against the mock, the slice's acceptance tests **plus every earlier integrated slice's** (regression), OpenAPI and DB-schema conformance, `guard migration`, and the four security guards (`security_matrix`, `security_idor`, `security_authflow`, `security_input`), which record their own `treeFingerprint`;
5. re-reads `treeHash`; if it moved, the run is void;
6. commits `gf.slice.integrated` with a `check` that recomputes everything from the log: every cited evidence and guard result exists, passed, carries the same fingerprint, and has a `seq` between `run.started` and `run.finished`.

"One pinned run" therefore has a definition the audit can recompute: one seq range, one tree, one contract hash, all steps passing. A step run before or after the bracket does not count. The delivery lead then runs the behavior diff (a native `feature` work item rule: `behavior route` → `contract` → `diff`) with the base at the previous slice commit.

### 4.5 Messages (rule c)

`gf.message {id, from, to[], kind, subject, body (<= 4 KB), refs[], inReplyTo}`. `from` must equal the actor's group; `kind` is one of `question | answer | amendment-request | blocker | decision | handoff`; an `amendment-request` must be addressed to `api`; an amendment, an escalation, or a rescope must cite a message id (GF-MSG-1/2). Agents cannot talk to each other except through the record: no subagent has the Agent tool, and file channels are closed by ownership. **Residual out-of-band channel:** the orchestrator's dispatch prompt. The skill instructs it to relay by message id, but the engine cannot read a prompt. Registered as a limit.

### 4.6 Acceptance tests first, and "hidden" (D5)

The test group writes acceptance tests from the PRD criteria **before** any slice's feature tasks are claimable. `gf.acceptance.baseline` records, per test: id, the criterion it covers, file, sha256, and a **red run** (collected N, failing N, none failing with an import or syntax error). A test file changed after the baseline needs `gf.acceptance.amended` (reviewer, with a reason). Implementer roles cannot write `tests/acceptance/**`.

What "hidden" can honestly mean here: sealed by hash and write-denied (enforced); read-denied for implementers through an extended hook matcher *where the harness runs hooks on Read* (best effort); and a **held-out subset kept outside the repository** by the orchestrator, run only at G3 (the same pattern the G4 grader uses). The report states which of the three applied.

### 4.7 Parallelism

Groups work concurrently inside a slice: disjoint globs, `maxConcurrency` 4, claims serialized by the frozen overlap check †`tasks.js:156-160`. Slices are sequential (C5). Expect lock contention on evidence runs (row 87).

---

## 5. Phase G3: the definition of "100% working"

`eccode-gf verify-done` commits `gf.done.verified` only if all five hold on **one commit** in one bracketed run. Otherwise it commits `gf.done.refused` with the reasons (a recorded refusal, not silence).

| # | Criterion | Mechanism | Fails closed when |
|---|---|---|---|
| 1 | Every PRD criterion passes as an executable test | The criterion-to-test map from the baseline; run every mapped test; join results by criterion id | A criterion has no test, a test did not run, or the held-out subset fails |
| 2 | Contract tests pass on both sides; contracts unamended, or amendments justified | Provider + consumer suites; recompute contract hashes against the seal and the amendment chain | Any drift without an amendment; any amendment without reviewer, reason and invalidation |
| 3 | Full E2E on a deployed instance from a clean checkout | `git clone --no-local` to a fresh directory at the commit; `docker compose up -d --build --wait`; HTTP probes: health, every `http` criterion, the flow criteria; teardown | **No Docker daemon (D4)**, a build failure, or any probe failure. A non-compose "process runner" exists for development and is labelled `DEGRADED`; it can never produce DONE |
| 4 | Security guards green; behavior diff clean between the final candidate and the last integrated slice | The four security guards fresh on this tree. The final tree equals the last integrated slice commit, **or** an `rc` work item holds a clean diff (or a `skip` routing the engine accepts) | A guard result is stale or failing; the tree differs from the last slice with no clean `rc` diff |
| 5 | `eccode audit` on the whole history | The same checks `eccode audit` runs (chain, snapshot equals replay, content-hashed artifacts, unreviewed changes †`bin/eccode.js:995-1011`), with `--against <protected ref>` when you give one, **and** `gf audit` (every rule as a replayed invariant) | Either reports an error |

The report (`.eccode/delivery/gf-delivery-report.md`, generated from the log, hashed by `gf.report.generated`) lists evidence per criterion, every DECLARED_ASSUMPTION, every limit that applies, the estimate-versus-actual table, every contract amendment, the message index, and the exact commands to reproduce each check. It states two sentences verbatim:

> The behavior diff v3 detected 27 of 57 seeded unintended changes on its measurement set (47.4 percent, exact 95 percent interval 34.0 to 61.0), so "no difference found" is evidence of no *detected* change.
>
> The security probes are a capability check on the configured roles and objects; they are not a penetration test.

DONE is a *projection*: the latest `gf.done.verified` holds only while the tree hash still equals its commit and no `task.*`, `gf.slice.*` or `gf.contract.*` event follows it. Any later change invalidates it.

---

## 6. Phase G4: measurement (design only; the protocol is S6, text only)

`bench/protocols/<date>-greenfield-1.md` will follow the repository's protocol shape ‡ (Subject / Arms / Hypotheses and decision rules / Prediction before code / Order of events / What counts as tuning / Limits / Estimate for approval / Status). Fixed so far:

- **Specs (2-3):** (1) small SaaS with auth + CRUD + one integration against an offline fake service; (2) an AI-agent app with a pluggable model client and a scripted fake for grading; (3) optional third, chosen after (1) and (2) are written. All in the D3 stack profile, sized for under 2 hours bare. The existing pantry and planner suites are Node and cannot be graded by the FastAPI guards ‡, so they are not reused.
- **Arms:** `bare` (`--variant without`), `ECC` (`--variant ecc`), `ECCode-greenfield` (new; the repository has no arm literally named ECCode ‡).
- **Grading:** hidden acceptance tests written from the spec by an **independent agent in a fresh context before any arm runs**, and the security-guard battery on each delivered tree. The independence of that agent rests on its brief and a tool-log analysis, not a technical barrier, as for the H-B2/H-B3 seeding agents (limits rows 179, 183); the protocol will say so.
- **Primary endpoint:** criteria passed per dollar and per hour. **Secondary:** security findings in delivered trees, silent-failure count, declared-assumption count (via the existing relabel instrument).
- **Spend gate:** the repository enforces "no spend before approval" only in prose ‡. I propose in S6 a launch script that refuses paid arms without a user-signed approval file, so the cap is a code gate. Cost per arm is estimated and sent *with* the protocol, from S4's measured token actuals. **$0 is spent until you approve.**

---

## 7. Event reference

All events are `gf.*`, validated in `events.js`, committed through `Store.commit`. `actor` is the bound role; "reviewer" means a configured reviewer role.

| Event | Data (fields) | Who | Rule that guards the commit |
|---|---|---|---|
| `gf.project.initialized` | `stackProfile`, `groups{}`, `schemaVersion`, `baselineCommit?` | orchestrator, user | GF-INIT-1 (profile is supported; roles exist in config) |
| `gf.artifact.registered` | `stage`, `gate`, `submissionId`, `files[{path,sha256}]`, `validator{name,version}` | engine, after a valid submit | the stage's schema + cross-validation |
| `gf.estimate.registered` / `.revised` | `id`, `basis`, `groups{g:{tasks,minutes{low,high},tokens{low,high}}}` | delivery-lead | GF-EST-1 |
| `gf.g1.sealed` | `contractsHash`, `hashes{}`, `planSubmissionId`, `estimateSeq` | engine, on plan approval | GF-SEAL-1 |
| `gf.message` | `id`, `from`, `to[]`, `kind`, `subject`, `body`, `refs[]`, `inReplyTo?` | any group | GF-MSG-1/2 |
| `gf.contract.amendment.requested` | `id`, `contract`, `reason`, `message`, `proposed` | consuming group | GF-MSG-2 |
| `gf.contract.amended` | `id`, `request`, `contract`, `fromSha`, `toSha`, `reason`, `classification`, `affectedOps[]`, `invalidates[]` | reviewer | GF-FRZ-5 |
| `gf.ownership.amended` | `id`, `group`, `globs`, `reason` | reviewer | GF-OWN-5 |
| `gf.slice.opened` | `slice`, `workId`, `baseCommit`, `configHashes{behavior,guards,security}`, `criteria[]`, `operations[]` | orchestrator | GF-SLC-1 |
| `gf.acceptance.baseline` | `scope`, `tests[{id,criterion,file,sha256}]`, `redRun{evidence,collected,failing,erroring}` | test-engineer | GF-ACC-1 |
| `gf.acceptance.amended` | `id`, `test`, `fromSha`, `toSha`, `reason` | reviewer | GF-ACC-2 |
| `gf.slice.run.started` / `.finished` | `slice`, `treeHash`, `commit` | engine | GF-SLC-2 |
| `gf.slice.integrated` | `slice`, `treeHash`, `commit`, `contractsHash`, `runSeq[from,to]`, `steps[]`, `criteriaPassed[]` | engine | GF-SLC-2 |
| `gf.slice.invalidated` | `slice`, `cause{amendment\|drift}`, `reason` | engine | GF-SLC-3 |
| `gf.done.verified` / `.refused` | `commit`, `treeHash`, `items{1..5}`, `evidence[]` / `reasons[]` | engine | GF-DONE-1..6 |
| `gf.report.generated` | `path`, `sha256` | engine | GF-DONE-6 |

---

## 8. Rule catalog and test matrix

Every rule ships with a **positive** test (valid input accepted), a **negative** test (refused with a stable code), and a **bypass** test (an attempt to get around it that must be refused or caught). The generic bypass battery is run against every rule: **B1** commit the forged `gf.*` event directly through `Store.commit` (the frozen-CLI path); **B2** edit an artifact after its registration or seal; **B3** spoof the actor; **B4** replay the log with events reordered or truncated; **B5** call the frozen function (`gates.startGate`, `tasks.claim`) directly. B1, B2 and B5 must be caught by `gf audit`; B3 and B4 by the store chain and the actor binding. The table adds each rule's own bypass.

| Rule | Enforces | At | Rule-specific bypass that must fail |
|---|---|---|---|
| GF-INIT-1 | profile supported, roles configured | P | init with an unsupported stack, then claim DONE |
| GF-PRD-1 | PRD matches schema; non-goals non-empty | P,A | a PRD with `scope: []` forged as registered |
| GF-PRD-2 | every criterion has a closed-set `verify` | P,A | `verify.kind: "manual"` |
| GF-PRD-3 | `ambiguityScan` present and resolved | P,A | `none: true` with a blocking question open |
| GF-ARC-1 | N tech choices have N decisions, >= 2 alternatives, ADR rendered | P,A | one decision reused for three choices |
| GF-CON-1..5 | OpenAPI, DB, matrix, events valid; PRD ↔ contract coverage | P,A | a matrix missing one role × operation cell |
| GF-THR-1 | threat model complete over the contract | P,A | a request field without an `inputValidation` entry |
| GF-WBS-1 | breakdown coverage, budgets, disjoint globs | P,A | a task whose files overlap another group's globs |
| GF-EST-1 | estimate registered before the first phase gate; immutable | P,A | register after the first claim; overwrite via `.revised` and score the revision |
| GF-SEAL-1 | seal only with all six stages approved and unchanged | P,A | seal after editing a contract file post-approval |
| GF-FRZ-1 | contract paths writable by the api group only | H,P,A | frontend writes `contracts/openapi.json` through a shell redirect |
| GF-FRZ-2 | contract bytes equal seal or latest amendment | A,slice,D | change one byte and keep the hash chain intact |
| GF-FRZ-3 | implementation OpenAPI equals sealed OpenAPI | slice,D | add an undeclared route |
| GF-FRZ-4 | migrated schema equals `db-schema.json` | slice,D | add a column in a migration only |
| GF-FRZ-5 | amendment: reviewer, reason, hash, invalidation | P,A | amend with a `toSha` that is not the file's bytes |
| GF-OWN-1..4 | plan, write, completion, tree attribution | P,H,A,slice | complete with a file outside the group map but inside the task glob |
| GF-OWN-5 | map changes only by reviewer amendment | P,A | rescope a task into another group's globs |
| GF-ACC-1 | red baseline: collected and failing for the right reason | P,A | tests that all error on import counted as red |
| GF-ACC-2 | change after baseline needs an amendment | P,A,D | edit an acceptance test to make it pass |
| GF-CONF-1 | guard configs pinned per slice | slice,A | loosen a `security.json` cell mid-slice |
| GF-SLC-1 | open only after the previous slice is integrated and delivered | P | open slice 2 with slice 1 unintegrated |
| GF-SLC-2 | `integrated` only from one bracketed passing run | P,A | an `integrated` event citing evidence outside the bracket |
| GF-SLC-3 | amendment or drift invalidates slices | A,D | integrate on a stale contract hash |
| GF-FE-1 | frontend run on the mock has an empty violation log | slice | a frontend call to an undeclared route |
| GF-MSG-1/2 | messages: sender is the actor's group; amendments cite a request | P,A | a message `from` another group |
| GF-ASM-1 | report lists every declared assumption | D | an assumption event absent from the report |
| GF-DONE-1..6 | criteria 1-5 and invalidation | D,A | `verify-done` after a post-verification commit |

---

## 9. Slice plan

Each slice is committed with tests before the next, and I wait for your go on each. Every slice exits only when: its tests are green, the **full** suite is green, the frozen v3 set is 48 of 48 by hash before and after, new limits are in `docs/limits.md`, the compute ledger has a row for any delegated agent, and an evidence file records the exact commands and outputs.

| Slice | Scope | New files (main) | Exit evidence |
|---|---|---|---|
| **S1** | G1 pipeline and contract freeze: events, projection, six schemas and validators, OpenAPI structural validator, `jsonschema.js`, seal and amendment, estimate registration, the `wrap.js` wrappers, `eccode-gf` (`init`, `g1`, `seal`, `amend`, `audit`), MCP `gf_*` tools, 3 agents, orchestrator skill v1, rules GF-INIT/PRD/ARC/CON/THR/WBS/EST/SEAL/FRZ-2/5/MSG | `lib/greenfield/{index,events,projection,rules,wrap,jsonschema,openapi,contracts,messages}.js`, `bin/eccode-gf.js`, `schemas/gf-*.json` | every S1 rule has positive / negative / bypass; a forged-event battery is caught by `gf audit`; the sample G1 bundle seals; a contract edit after the seal is refused |
| **S2** | Ownership map and path-scoped permissions: GF-OWN-1..5, GF-FRZ-1, GF-CONF-1, group role sets in the hook, drafts namespacing | `lib/greenfield/ownership.js`; edits to `guard.js`, `mcp.js` | a task outside its group is refused at plan, write, completion and tree attribution; each bypass is caught |
| **S3** | Contract-test generation and mock server: GF-FE-1, GF-FRZ-3/4 conformance (via the existing dump scripts), GF-ACC-1/2 | `mock.js`, `contract-tests.js`; tests against a fixture OpenAPI | the generated suite fails against an empty server, passes against a reference server; the mock logs a violation for an undeclared route |
| **S4** | Parallel group orchestration on a toy project: `slice open / integrate / invalidate`, messages in use, estimates versus actuals, orchestrator skill v2, then **one real run from one idea to a delivery report** | `slice.js`, `report.js`; fixture `tests/fixtures/gf/toy-tasks` | the toy run's delivery report, sent to you as the first demo |
| **S5** | G3 done-verification: the five criteria, DONE as a projection, the compose runner and the labelled process runner, a Docker-daemon probe | `done.js` | each criterion refuses on a seeded failure; `NOT DONE: deploy unverifiable` when there is no daemon |
| **S6** | The G4 protocol, text only, plus the spend-gate script proposal | `bench/protocols/<date>-greenfield-1.md` | protocol committed before any arm; per-arm cost estimate sent with it; $0 spent |

**The S4 toy project** ("Tasks API"): register and log in with two roles (member, admin); a member creates, lists, edits, deletes and completes **their own** tasks (an IDOR surface); an admin lists all; one static web page. Skeleton plus two slices (auth; tasks). The idea text deliberately leaves three ambiguities (password policy, delete semantics, how the first admin is made) so the run shows whether they surface as DECLARED_ASSUMPTION rather than as silent choices.

---

## 10. Estimates (pre-registered)

**Basis, stated so the figures can be scored.** These are my judgment ranges for work I perform, with a factor-of-two uncertainty. The compute ledger records only delegated agents, and there is no per-slice build ledger to calibrate against †`docs/build/compute-ledger.md`. The only measured precedents for delegated runs: review-type runs **97k-128k tokens, 3-10 tool uses** (n=4); long worker runs **509k-622k tokens, 21-213 tool uses** (n=2). Author and implementer dispatches have **no precedent**; I assume 150k-350k tokens each, flagged as an assumption. Dollar figures are not given (D6). Spend on paid benchmark arms: **$0**.

| Slice | Wall time (active) | New prod / test LOC | Tokens | Tests (approx.) |
|---|---|---|---|---|
| S1 | 8-14 h | 1,600-2,400 / 1,800-2,800 | 4-8 M | 60-90 |
| S2 | 3-5 h | 500-800 / 700-1,100 | 1.5-3 M | 25-40 |
| S3 | 6-10 h | 1,200-1,800 / 1,200-1,800 | 3-6 M | 40-60 |
| S4 build | 6-10 h | 900-1,400 / 800-1,200 | 3-6 M | 25-40 |
| S4 toy run | 5-9 h | (generated project) | 8-16 M | n/a |
| S5 | 4-7 h | 700-1,100 / 700-1,100 | 2-4 M | 25-35 |
| S6 | 2-3 h | 0 / 0 (text) | 0.5-1 M | n/a |
| G4 hidden tests (independent agent, 2-3 specs) | within S6 | n/a | 1.5-2 M | n/a |
| **Total (sum of the ranges)** | **about 34-58 h** | | **about 24-46 M** | |

**The S4 toy run bottom-up:** about 45-70 dispatches: G1 about 8; W1 skeleton about 12; two slices at about 13 each (design 2, plan 2, five task dispatches, phase review 2, verification 2); final about 6. At 100k-130k per review dispatch and the assumed 150k-350k per author or implementer dispatch, that is 8-16 M tokens. The per-slice design and plan gates dominate; the light-slice variant (4.1) would save about 4 dispatches per slice.

**Predictions about outcomes** (to be scored in the S-reports, not claimed now):
- P1. At least one rule will be found to have a hole by its own bypass test before S1 exits (I expect two to four). Findings are fixed with a test that failed first.
- P2. The S4 toy run will not reach DONE in this sandbox, because of D4. It will reach criteria 1, 2, 4 and 5 if S3 and S4 work.
- P3. The agent-estimated minutes in the toy run will miss their actuals by more than a factor of 1.5 for at least one group. This is the case for registering them and not trusting them.

---

## 11. Limits to register in `docs/limits.md`

**Numbering.** Row 186 is already claimed by `cc6af4f` on `origin/claude/v3-generalization-fastapi-s1df80`, a line that is not in this one. I therefore do **not** assign numbers here: each limit below carries a placeholder id (`L-GF-n`) and takes the next free row *at the commit of the slice that introduces it*, checked against every remote branch at that moment. `docs/limits.md` and the open-count sentence pinned in `tests/limits.test.js` will conflict when the two lines meet; that is a merge task for you, and I will not edit the other line.

| Id | Limit | Disposition | Slice |
|---|---|---|---|
| L-GF-1 | The plain `eccode` CLI cannot refuse a Greenfield-Senior rule; prevention depends on the MCP and hook layer, detection on `gf audit` | Open, mitigated | S1 |
| L-GF-2 | Supported stack is Python / FastAPI / SQLAlchemy / Alembic / SQLite; other stacks can be built and tested but cannot reach DONE | Open, named | S1 |
| L-GF-3 | Sub-agents of a group share the group's role id and are not individually identified | By design | S2 |
| L-GF-4 | `.eccode/drafts/**` stays a shared scratch area, and the orchestrator's dispatch prompt stays an out-of-band channel | Open, named | S2 |
| L-GF-5 | The mock server is stateless; multi-step flows are verified against the real backend at integration | Open, named | S3 |
| L-GF-6 | The contract-test and artifact validators implement a stated JSON-Schema subset | Open, named | S3 |
| L-GF-7 | "Hidden" acceptance tests are write-denied and hash-sealed; read-denial depends on the harness running hooks on Read | Open, mitigated | S3 |
| L-GF-8 | The engine cannot detect an undeclared guess, only make a declared one impossible to omit from the report | Open, named | S4 |
| L-GF-9 | Per-slice design and plan gates are overhead the `feature` track imposes; their measured cost is reported after S4 | Open, named | S4 |
| L-GF-10 | DONE criterion 3 needs a Docker daemon; without one the project is `NOT DONE: deployment unverifiable` | Open, named | S5 |
| L-GF-11 | "Behavior diff clean" means no *detected* change (v3 detected 47.4 percent of seeded changes); carries rows 184 and 186 of the other line | Open, named | S5 |
| L-GF-12 | Estimates are agent predictions from a single project; no calibration claim until several projects | By design | S4 |

---

## 12. Risks and what can fail

| Risk | Likelihood (my judgment) | Mitigation |
|---|---|---|
| The frozen guards' config formats (`guards.json`, `security.json`) differ from what I recorded ‡ | Medium | S1/S2 begin by reading each config reader in the frozen code and writing a fixture test that fails first |
| Generated acceptance tests are too weak, so "red then green" proves little | Medium | Mutation testing (`eccode mutate`, exists) on the generated project in S4; the criterion-to-test map is reviewed |
| Per-slice gates make the toy run slower and costlier than the estimate | High | Light-slice variant; measured in S4 and reported |
| `maxConcurrency` 4 plus serialized evidence runs makes parallelism mostly nominal | Medium | S4 measures the idle time between claims and reports it |
| The S4 run hits a container restart | Medium | The record is resumable by design (`eccode resume`, `recover --all`); the delivery report notes any restart |
| A rule I write has a false refusal that blocks a legitimate project | Medium | Each rule's positive test, plus S4's real run as a false-refusal count (the pilot reported 0.64 per item, row 105) |
| I misjudge which behavior of the frozen code is load-bearing | Low-medium | Nothing frozen is edited; the 48-file check runs before every commit |
| The FastAPI guard and behavior paths are skipped in the baseline here (C9), so a green suite proves nothing about them until the virtualenv exists | High until S2 | S2 builds the virtualenv, reruns the baseline, and reports the skip count change before any rule depends on those paths |

Final red team of the idea itself, as the brief asks: "this is a wrapper that re-labels existing gates". The answer is the table in 1.3: every row in the *Gap* column is code that does not exist, and the three structural additions (sealed machine-readable contracts, a recomputable pinned integration run, and a log-replay audit that catches violations committed by any path) are the parts a prompt cannot provide.

---

## 13. Invariants kept, and how they are checked

- **Frozen v3 files:** 48 of 48 by hash before (done: see the header) and after every commit. Command: `ECCODE_FREEZE_FILE=bench/pilot/phase2-freeze-v3.json node bench/pilot/phase2-seeds.js check`. No new `require()` from any frozen file. No edit to `scripts/guards/*.py`.
- **No gate weakened:** the frozen gate, task, design, guard and delivery code is called, never replaced. Every GF rule only adds a refusal.
- **Full suite green** at every slice exit (`npm run check`). **Baseline at `948a95b`, measured in this session:** 569 tests, 516 pass, 0 fail, 53 skipped, 131 s; toolkit validation passed (12 agents, 9 skills, 13 commands). **The 53 skips:** 35 need an interpreter with `fastapi`, `httpx`, `hypothesis`, `coverage`, `pytest` (and `sqlalchemy`, `alembic` for the guard tests); 15 need a Mealie checkout, mirror or an opt-in variable; 1 needs `ECCODE_CBM`; 2 need `kotlinc` / `codebase-memory-mcp`. A repeat run after my doc-only changes gave 569 / 520 pass / 0 fail / **49** skipped: the four `mealieN: no prompt contains a line of its fix` tests ran because the first run created the Mealie mirror cache outside the repository (`/root/.cache/eccode/bench-repos/...`, mtime inside the first run's window). A diff of the two skip lists shows no other difference. A slice report states its own skip count and what the skips cover; "green" is never reported without it.
- **Every limit in `docs/limits.md`;** no fabricated numbers; labels before figures; estimates pre-registered here, before any build.
- **Secrets never through chat.** **Paid runs only inside stated caps: $0 until you approve.** **Nothing tuned after a result.**
