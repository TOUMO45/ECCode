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
| **D1** | Extend without modifying frozen files. Enforcement is **prevention on the managed (MCP) path plus guaranteed detection by log-replay audit in all profiles**; the hook adds best-effort write-time checks. The plain `eccode` CLI cannot refuse a Greenfield-Senior rule (it is frozen). | Accept. Fallback if you reject it: cut a v4 freeze, which means a protocol note and a new hash file. | It trades "refuse everywhere" for "refuse where agents write; detect everywhere". Section 2.2 shows exactly where each applies. |
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

### 2.2 Enforcement model: managed-path prevention and audit detection

Every rule is one pure function in `rules.js` and is evaluated at up to four points.

| Point | Mechanism | Strength |
|---|---|---|
| **P** MCP / `eccode-gf` write | `wrap.js` runs the rule, then calls the frozen function | Structural: in the `sandbox` and `no-shell` profiles (the install default) agents write the record only through MCP (in `no-shell` they have no shell; in `sandbox` the record is read-only to shell commands, OS-enforced), so there is no path around it |
| **H** PreToolUse hook | `guard.js` evaluates the rule for file writes and for `eccode` shell commands | Text-level, as today (limits rows 91, 117): it reads command text |
| **A** Audit replay | `eccode-gf audit` replays the whole log and re-evaluates every rule as an invariant over history | Detects a violation committed by *any* path, including the frozen `eccode` CLI, in every profile |
| **D** Done verification | `gf.done.verified` requires a clean GF audit and a clean base audit | Nothing is declared DONE on top of a violation |

What this means for D1, stated plainly:

- In `sandbox` / `no-shell`: **prevention on the managed (MCP) path** (agents have no other writer), plus guaranteed detection by log-replay audit.
- In the opt-out `guard` profile (CLI + hook): the hook checks best effort, and the audit still detects.
- With hooks off or a harness without them: **detection only**, by audit at A and D. The project can still be built, but it cannot be declared DONE on top of a violation.

**The managed path** is the role-locked MCP servers together with the PreToolUse hook that wires them and the file-writing tools: an engine write through a role's own server (point P) and a file write through the file tools, judged by the hook (point H). A rule is a prevention on the managed path only while both controls are in force, which the preflight reports (16.4, F0); the term means this everywhere in this document and in the limits register. GF-OWN-2's strength follows from it: GF-OWN-2, GF-FRZ-1, the hook half of GF-CONF-1 and the drafts rule are H rules, so a file-tool write is prevented on the managed path in every profile, while a shell write (group roles have a shell in the `sandbox` and `guard` profiles) is judged on its command text only, which is best effort (L-GF-1), and the audit detects a cross-group write only as L-GF-24 states.

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
| 3 | Full E2E on a deployed instance from a clean checkout | `git clone --no-local` to a fresh directory at the commit; `docker compose up -d --build --wait`; HTTP probes: health, every `http` criterion, the flow criteria; teardown | **No Docker daemon (D4)**, a build failure, or any probe failure. A non-compose "process runner" exists for development and is labelled `DEGRADED`; it can never produce DONE **Secondary evidence (owner decision 4):** a process-level E2E (uvicorn started from a clean checkout, then the same smoke probes) is run and recorded in the delivery report. It never substitutes for the compose check and never changes the status to DONE. |
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
| `gf.ownership.amended` | `id`, `group`, `from`, `to`, `reason`, `message` | reviewer | GF-OWN-5 (built in S2: `from` must be the globs in force, `message` a recorded message) |
| `gf.slice.opened` | `slice`, `workId`, `baseCommit`, `configHashes{behavior,guards,security}`, `criteria[]`, `operations[]` | orchestrator | GF-SLC-1 |
| `gf.acceptance.baseline` | `scope`, `tests[{id,criterion,file,sha256}]`, `redRun{evidence,collected,failing,erroring}` | test-engineer | GF-ACC-1 |
| `gf.acceptance.amended` | `id`, `test`, `fromSha`, `toSha`, `reason` | reviewer | GF-ACC-2 |
| `gf.slice.run.started` / `.finished` | `slice`, `treeHash`, `commit` | engine | GF-SLC-2 |
| `gf.slice.integrated` | `slice`, `treeHash`, `commit`, `contractsHash`, `runSeq[from,to]`, `steps[]`, `criteriaPassed[]` | engine | GF-SLC-2 |
| `gf.slice.invalidated` | `slice`, `cause{amendment\|drift}`, `reason` | engine | GF-SLC-3 |
| `gf.done.verified` / `.refused` | `commit`, `treeHash`, `items{1..5}`, `evidence[]` / `reasons[]` | engine | GF-DONE-1..6 |
| `gf.report.generated` | `path`, `sha256` | engine | GF-DONE-6 |
| `gf.config.pinned` | `id`, `scope` (a label), `files{path: sha256}`, `reason` (10 characters or more) | orchestrator, user | GF-CONF-1 (S2) |
| `gf.dispatch.recorded` | `id`, `scope`, `role`, `step`, `treeHash`, `inputs[{path, sha256}]` | orchestrator | GF-CLOSE-5 (S2) |
| `gf.review.recorded` | `id`, `scope`, `step`, `dispatch`, `treeHash`, `summary`, `verdict`, `findings[{id, severity, kind, summary}]?`, `evidence[]?` | a reviewer role | GF-CLOSE-1 (S2); verdict values: comprehension and critique `clean` or `findings`, readiness `go` or `no-go` |
| `gf.finding.resolved` | `id`, `finding`, `resolution`, `proof?`, `reproduction?`, `reason?`, `limit?` | see GF-CLOSE-2 | GF-CLOSE-2 (S2) |
| `gf.battery.recorded` | `id`, `scope`, `round`, `treeHash`, `evidence`, `total`, `killed`, `survived`, `survivors[{key}]` | orchestrator (the engine, after its own run) | GF-CLOSE-3 (S2) |
| `gf.slice.closed` | `scope`, `treeHash`, `steps{comprehension, critique, readiness}`, `batteries[]`, `accepted[{key, reason}]`, `accounting{unit, start, end}` | orchestrator, user | GF-CLOSE-1 to 5 (S2) |

---

## 8. Rule catalog and test matrix

Every rule ships with a **positive** test (valid input accepted), a **negative** test (refused with a stable code), and a **bypass** test (an attempt to get around it that must be refused or caught). The generic bypass battery is run against every rule: **B1** commit the forged `gf.*` event directly through `Store.commit` (the frozen-CLI path); **B2** edit an artifact after its registration or seal; **B3** spoof the actor; **B4** replay the log with events reordered or truncated; **B5** call the frozen function (`gates.startGate`, `tasks.claim`) directly. B1, B2 and B5 must be caught by `gf audit`; B4 by the frozen store's hash chain. **B3 is different:** the log asserts the actor and does not bind it (the frozen engine's own limit, `docs/architecture.md`), so an actor spoof is stopped only where the identity is locked (the MCP server per role, the hook) and is otherwise judged by the content rules, which do not read the actor except where a rule names one (L-GF-17). The table adds each rule's own bypass.

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
| GF-FRZ-1 | contract paths writable by the api group only | H, A (the audit half is GF-FRZ-2; 18.1) | frontend writes `contracts/openapi.json` through a shell redirect |
| GF-FRZ-2 | contract bytes equal seal or latest amendment | A,slice,D | change one byte and keep the hash chain intact |
| GF-FRZ-3 | implementation OpenAPI equals sealed OpenAPI | slice,D | add an undeclared route |
| GF-FRZ-4 | migrated schema equals `db-schema.json` | slice,D | add a column in a migration only |
| GF-FRZ-5 | amendment: reviewer, reason, hash, invalidation | P,A | amend with a `toSha` that is not the file's bytes |
| GF-OWN-1..4 | plan, write, completion, tree attribution | P,H,A,slice | complete with a file outside the group map but inside the task glob |
| GF-OWN-5 | map changes only by reviewer amendment | P,A | rescope a task into another group's globs |
| GF-ACC-1 | red baseline: collected and failing for the right reason | P,A | tests that all error on import counted as red |
| GF-ACC-2 | change after baseline needs an amendment | P,A,D | edit an acceptance test to make it pass |
| GF-CONF-1 | guard configs pinned by hash (`gf.config.pinned`, 18.1) | H, A | loosen a `security.json` cell mid-slice |
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
| **S1** | G1 pipeline and contract freeze: events, projection, six schemas and validators, OpenAPI structural validator, `jsonschema.js`, seal and amendment, estimate registration, the `wrap.js` wrappers, `eccode-gf` (`init`, `g1`, `seal`, `amend`, `audit`), MCP `gf_*` tools, 3 agents, orchestrator skill v1, rules GF-INIT/PRD/ARC/CON/THR/WBS/EST/SEAL/FRZ-2/5/MSG | `lib/greenfield/{index,events,projection,rules,wrap,jsonschema,openapi,contracts,messages}.js`, `bin/eccode-gf.js`, `schemas/gf-*.json` | every S1 rule has positive / negative / bypass; a forged-event battery is caught by `gf audit`; the sample G1 bundle seals; a contract edit after the seal is detected by the audit (not refusable at write time: the plain CLI is outside the layer) and a contract change goes only through a recorded amendment |
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

The register `docs/limits-greenfield.md` is authoritative: this table is the G0 snapshot (L-GF-1 to 13), and later limits are added to the register only.

**Numbering.** The limits of this layer live in `docs/limits-greenfield.md` with placeholder ids, so that `docs/limits.md` is not touched. Row 186 is already claimed by `cc6af4f` on `origin/claude/v3-generalization-fastapi-s1df80`, a line that is not in this one. I therefore do **not** assign numbers here: each limit below carries a placeholder id (`L-GF-n`) and takes the next free row *at the commit of the slice that introduces it*, checked against every remote branch at that moment. `docs/limits.md` and the open-count sentence pinned in `tests/limits.test.js` will conflict when the two lines meet; that is a merge task for you, and I will not edit the other line.

| Id | Limit | Disposition | Slice |
|---|---|---|---|
| L-GF-1 | The plain `eccode` CLI cannot refuse a Greenfield-Senior rule; prevention on the managed (MCP) path plus guaranteed detection by log-replay audit in all profiles | Open, mitigated | S1 |
| L-GF-2 | Supported stack is Python / FastAPI / SQLAlchemy / Alembic / SQLite; other stacks can be built and tested but cannot reach DONE | Open, named | S1 |
| L-GF-3 | Sub-agents of a group share the group's role id and are not individually identified | By design | S2 |
| L-GF-4 | `.eccode/drafts/**` stays a shared scratch area, and the orchestrator's dispatch prompt stays an out-of-band channel | Open, named | S2 |
| L-GF-5 | The mock server is stateless; multi-step flows are verified against the real backend at integration | Open, named | S3 |
| L-GF-6 | The artifact validators implement a stated JSON-Schema subset; unsupported keywords are reported on the nodes the validator visits, unknown formats are annotations, and a user-supplied `pattern` is not guarded against catastrophic backtracking (S1 never evaluates one; S3 must before it does) | Open, named | S1 |
| L-GF-7 | "Hidden" acceptance tests are write-denied and hash-sealed; read-denial depends on the harness running hooks on Read | Open, mitigated | S3 |
| L-GF-8 | The engine cannot detect an undeclared guess, only make a declared one impossible to omit from the report | Open, named | S4 |
| L-GF-9 | Per-slice design and plan gates are overhead the `feature` track imposes; their measured cost is reported after S4 | Open, named | S4 |
| L-GF-10 | DONE criterion 3 needs a Docker daemon; without one the project is `NOT DONE: deployment unverifiable here`. A process-level E2E (uvicorn from a clean checkout plus smoke probes) is recorded as secondary evidence and never upgrades the status | Open, named | S5 |
| L-GF-11 | "Behavior diff clean" means no *detected* change (v3 detected 47.4 percent of seeded changes); carries rows 184 and 186 of the other line | Open, named | S5 |
| L-GF-12 | Estimates are agent predictions from a single project; no calibration claim until several projects | By design | S4 |
| L-GF-13 | A v4 freeze that absorbs the greenfield layer is deferred until after S5 is stable; until then the layer is additive and the plain `eccode` CLI is outside it | Open, named | S1 |

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

---

## 14. Owner decisions of 2026-11-04

Recorded verbatim in substance; they change the design as follows.

1. **Additive enforcement: approved.** Wording everywhere is "prevention on the managed (MCP) path plus guaranteed detection by log-replay audit in all profiles", never bare prevention (`tests/gf-docs.test.js` enforces it). Recorded as L-GF-1. A v4 freeze that absorbs the greenfield layer is **deferred** until after S5 is stable and **has not been started** (L-GF-13).
2. **Slices as sequential `feature` work items after one `greenfield` work item: approved.**
3. **Stack profile v1 = Python / FastAPI / SQLAlchemy / Alembic / SQLite: approved.** Other stacks can be built but cannot reach DONE in v1 (L-GF-2).
4. **Docker:** the compose criterion stays fail-closed ("deployment unverifiable here"). **Added:** a secondary, non-substituting process-level E2E check (uvicorn from a clean checkout plus the same smoke probes), recorded in the delivery report; it never upgrades the status to DONE (section 5, L-GF-10).
5. **Merge lines:** I never merge `claude/v3-generalization-fastapi-*` and this branch; limit ids stay placeholders (`L-GF-n`), kept in `docs/limits-greenfield.md` so that `docs/limits.md` is not edited; reconciliation is the owner's.
6. **GO: S1 only.** Estimate on record: 8-14 h, 4-8 M tokens. Test first with red and green evidence; every new rule with positive, negative and bypass tests; the frozen set 48 of 48 before and after; the estimate-versus-actual table updated at the end; stop after S1; no paid runs, $0 on the meter. The plan is `docs/superpowers/plans/2026-11-04-greenfield-senior-s1.md`.

---

## 15. S1 as built (2026-11-04)

S1 (G1 pipeline and contract freeze) is implemented as designed, with the deviations below. Evidence and the estimate-versus-actual table: `docs/build/gf-s1-evidence.md`. Limits: `docs/limits-greenfield.md` (L-GF-1 to L-GF-18 at the end of S1: L-GF-14 to 16 from the build, L-GF-17 and L-GF-18 from the review).

**What exists.** `lib/greenfield/` (constants, events, projection, jsonschema, openapi, six stage validators, bundle, ownership glob algebra, init, wrap, snapshots, contracts, messages, estimate, audit, index), `bin/eccode-gf.js`, ten `schemas/gf-*.schema.json`, three agents, the `orchestrate-greenfield` skill, and edits to four unfrozen files (`lib/mcp.js`, `scripts/hooks/guard.js`, `scripts/validate-toolkit.js`, `package.json`). No frozen file is edited and none requires anything in `lib/greenfield` (checked by hash, 48 of 48, and by `git diff`).

**Rules as built.** Every rule is enforced on the managed path and re-evaluated by `gf audit`; the audit alone detects what no write-time check can (a contract edited on disk, a forged event).

| Rule | Managed path | Audit | Meaning |
|---|---|---|---|
| GF-INIT-1 | `initProject` | GF-AUD-2 | one supported stack profile; a record is not adopted |
| GF-PRD-1/2/3, GF-ARC-1, GF-CON-1..5, GF-THR-1, GF-WBS-1..3, GF-EST-1 (artifact shape), GF-ART-2 | `gateSubmit` | the same validators on the approved bundles | the stage artifacts |
| GF-ART-1 | `gateReview` | yes | every APPROVED document-gate submission was registered at its committed hashes |
| GF-ART-DRIFT | `gateSubmit` | yes | an approved stage artifact changed after approval (contracts are exempt once sealed: they are GF-FRZ-2) |
| GF-THR-1 (reviewers) | `gateStart('design')` | yes | the design gate names the technical and the security reviewer, and both approved the approved submission |
| GF-SEAL-1, GF-ORD-1 | `gateReview`, `gateStart`, `taskClaim` | yes | nothing is claimed or started in a phase before the seal; the seal matches the approved files |
| GF-EST-1 | `gateStart`, `estimate.revise` | yes | one estimate, registered before the seal, revised only beside the original |
| GF-FRZ-2 | detection only | yes | a sealed or amended contract has exactly its recorded bytes |
| GF-FRZ-5 | `requestAmendment`, `applyAmendment` | yes | a reviewer applies a reasoned amendment that moves an unbroken hash chain |
| GF-MSG-1/2 | `messages.send` | yes | messages come from the actor's own group; an amendment request goes to api |
| GF-AUD-1/2 | n/a | yes | every gf.* event is known and well-formed; one init, first |

**Deviations from sections 3 to 8 and from the plan.**
1. `GF-WBS-1` is three rules (`GF-WBS-1..3`); `GF-ART-1`, `GF-ART-2`, `GF-ART-DRIFT`, `GF-ORD-1` and `GF-AUD-1/2` are added.
2. The estimate is registered at seal time (immediately before `gf.g1.sealed`, which cites it), not at each submit; an estimate in a plan submission is still hash-pinned by the plan gate from the moment it is submitted.
3. `breakdown.json` has no checkpoint list: the frozen engine derives checkpoints from `plan.checkpointEvery`.
4. Sealing writes content-addressed snapshots of the sealed contract files (`.eccode/contracts/<sha>.json`). They are needed to classify an amendment against exactly what was sealed and to keep validating the approved bundle at its approved bytes after a legitimate amendment. The hook treats them as record files.
5. The frozen audit pins approved artifacts, so a contract amended on disk is reported "modified after approval" until a phase review approves the new bytes (the frozen `unreviewedChanges` takes the latest approved version of each path). The amendment event explains the change and the layer's audit stays clean (L-GF-15).
6. An amendment is validated per file; the consistency of the amended bundle as a whole is a slice-integration check (L-GF-14).
7. Estimates are in tokens and hours as decided; the session's own token usage is reported cumulatively by the harness and was not snapshotted at the start of S1, so no S1-only token figure exists (evidence file).

**Not in S1, by design.** Write-time ownership by group and the hook's contract and acceptance paths (S2); the generated mock server, contract tests and acceptance baseline (S3); slices as work items, the pinned integration run and the toy project (S4); the done verification (S5); the protocol (S6).

### 15.1 Independent review of S1 and what was done about it

A fresh reviewer (a general-purpose agent, 121 tool calls, about 28 minutes, 419,658 tokens as reported) was given the code, the design, the plan and the constraints but not my conclusions, and asked to break it. Every finding was reproduced as a failing test before it was fixed. Outcome of the 4 blocking, 8 major and 5 minor findings plus its list of tests that could not fail:

| Finding | Result |
|---|---|
| B1 the frozen plan gate imports its tasks from the first `.json`, not `plan.json` | fixed: `plan.json` must be listed first (GF-WBS-1); the audit compares the engine's tasks with `plan.json` |
| B2 stage artifacts matched by file name let an unvalidated file into the seal | fixed: each name belongs to one gate (GF-ART-2); the seal reads hashes gate by gate |
| B3 an OpenAPI could hide operations (`paths` item by `$ref`), count `security: [{}]` as secured, or use empty schemas | fixed (GF-CON-1) |
| B4 `{rel, abs}` entries read any file through the MCP tools | fixed: paths are strings only; nothing about a probed file appears in a message |
| M1 the hook did not treat `eccode-gf` as the eccode CLI | fixed, with a parity test |
| M2 PRD and ADR rules were judged against the live design state | fixed: each gate is judged against the record at its approval |
| M3 a PRD assumption entry could cite any assumption | fixed: its own question's only |
| M4 a failed seal could not be retried | fixed: `eccode-gf seal`, `gf_seal` |
| M5 an orphan submission left the audit dirty | fixed: only approved submissions need registrations |
| M6 the design gate could be approved without the security reviewer | fixed (GF-THR-1), at start and in the audit |
| M7 audit gaps (estimate, message bytes and replies, classification, duplicate requests, unsealed contract files) | fixed |
| M8 validators and the audit crashed on malformed input | fixed: type guards, a guarded validator wrapper, an audit that never throws; a 400-case seeded fuzz |
| m1 symlinked parent directory, non-regular file | fixed |
| m3 the matrix allowed anonymous on a non-public operation | fixed: anonymous follows `x-gf-public` |
| m2 ReDoS latent in a user `pattern`; unknown formats ignored; unsupported keywords reported only on visited nodes | named, not fixed: L-GF-6 (S1 evaluates no user pattern) |
| m4 the three group role names are now reserved by the hook in every ECCode project | named: L-GF-18 |
| m5 documentation claims the code does not back (refused vs detected, actor spoof, which slice) | corrected in this document and the limits |
| tests that could not fail (audit chain checks, seal and amendment in-lock checks, `amendedProblems`, non-GF fallthrough, ...) | fixed: `tests/gf-audit-forged.test.js` (24 cases) and `tests/gf-review.test.js`; the rule-removal battery was re-run (evidence file) |


---

## 16. S2: ownership map and path-scoped permissions (design, 2026-11-07, written before any S2 code)

### 16.1 Owner decisions of 2026-11-07 (S1 accepted; binding on S2 and every later slice)

1. **Slice closure is an engine rule, not advice.** A slice is closed only after (a) an independent reviewer pass on the final tree, (b) every finding reproduced as a failing test before any fix, (c) a second mutation or battery run on the post-fix tree. Implemented as GF-CLOSE-1 to 5 (18.5; GF-CLOSE-5, one dispatch per step, came with the three-step protocol of 17.2) with positive, negative and bypass tests. My own bypass tests never count as the independent pass.
2. **Token accounting.** The unit is **all processed tokens** (input + output + cache reads + cache writes, as the harness reports them). Usage is snapshotted at slice start and end; one ledger row per slice and per delegated agent; where the harness cannot give a number the cell says `unmeasurable`, never blank (18.6; `docs/build/compute-ledger.md`).
3. **FastAPI stack first.** The virtual environment is created before S2 code; skip count recorded before (49 expected, measured: 49) and after; the 35 FastAPI-dependent tests must run in S2's final check (16.8).
4. **L-GF-17.** Assess in this section how unbound actors affect path-scoped ownership between groups; if ownership is spoofable on the managed path, propose the minimal fix and do not accept it silently (16.4).
5. **Estimate-versus-actual every slice**, recalibrated from S1's actuals (16.7).
6. Unchanged: no merge with `claude/v3-generalization-fastapi-*`; placeholder limit ids; frozen 48 of 48 before and after; no paid runs, $0 on the meter; stop after S2 and report.

### 16.2 What S2 builds

Moved to 18.1 and 18.2, the single description of S2 as built. The text as registered before the build is in commit `4799154`.

### 16.3 Effective map and its algebra

Moved to 18.2, the single description of S2 as built. The text as registered before the build is in commit `4799154`.

### 16.4 L-GF-17: can group A forge group B's events? (assessment, before building)

**Method.** Enumerate every way an agent of group A can cause a record entry, or a file write, that is attributed to group B, and for each say what stops it and whether the log could show it afterwards. The managed-path rows are demonstrated by tests in `tests/gf-spoof.test.js`; the others are reasoned from the code cited. The vector table, as built, is in 18.3.

**Finding.** On the managed path, group A cannot act as group B **provided two controls that live outside the log hold**: the per-role server lock together with the harness's tool list, and the PreToolUse hook. The Greenfield-Senior layer neither checks that they are in force nor reports it. If either fails, A acts as B and neither the chain nor the audit can tell, because the log asserts the actor and does not bind it. So ownership **is** spoofable on the managed path in the one sense that matters: its guarantee rests on assumptions the layer does not verify, and a failure is silent. I do not accept that silently.

**Minimal fix proposed.** (F0) a managed-path preflight that reports which regime is in force; (F1) ownership rules that lean on facts of the reviewed plan; (F2) L-GF-17 restated with its exact residual; (F3) keyed attestation, for the owner's decision. What was built, what a spoof buys, and what F3 would add are stated in 18.3.

### 16.5 The closure rule

Moved to 18.5, the single description of S2 as built. The text as registered before the build is in commit `4799154`.

### 16.6 Accounting protocol

Moved to 18.6, the single description of S2 as built. The text as registered before the build is in commit `4799154`.

### 16.7 Registered estimate for S2 (before any S2 code)

Labels: judgment ranges, factor-two uncertainty, no calibration claim (L-GF-12).

| Item | Registered |
|---|---|
| Wall time, active | 2.5 to 4.5 h (S1 actual: 37 min to the last build commit, 1 h 22 min to the review-fix commit; S2 has about 1.5 times the scope and two independent review passes of about 30 min each; clarified after the round-2 review: the factor was my judgment of rules and wrappers, not of lines) |
| New production code | 900 to 1,500 JavaScript lines |
| New test code | 1,600 to 2,800 lines including fixtures |
| Tests | 130 to 260 (S1 registered 60 to 90 and produced 382). Counted, as clarified after the round-3 review, as the `# tests` count of `node --test`, in which each table row is a test when the row is its own `test()` call; rows checked in a loop inside one `test()` count once. This replaces the earlier "table rows now counted" and agrees with 17.9 |
| **Tokens, all processed** | **40 to 150 M** (S1 measured 129.5 M for G0 plus S1; S2 starts with about 146 k of context rather than several hundred thousand, which lowers the read volume per turn, and has two review phases). Source of the 146 k: the same `get_session` call as the S2-start snapshot (15:17Z) reported `context_usage.used_tokens` 146,182 of `max_tokens` 1,000,000; that field was not copied into `s2-usage-start.json` |
| Output tokens (informational) | 0.3 to 1.0 M |
| Delegated agents | two independent reviewers, 0.3 to 0.6 M tokens each as reported (S1's: 419,658) |
| Paid runs | $0 |

Predictions, to be scored in the S2 report and not claimed now (the FastAPI baseline run had started before P6 was written; its output had not been read):
- **P4.** The first independent pass finds at least three defects of major or blocking severity in the S2 code (S1: 4 blocking and 8 major).
- **P5.** The second pass, on the post-fix tree, finds at least one defect that the first pass's fixes introduced or the first pass missed.
- **P6.** With the FastAPI virtual environment, at least one of the 35 FastAPI-dependent tests fails on the unchanged S2-start tree because the installed library versions (FastAPI 0.162.1, SQLAlchemy 2.1.8, Starlette 1.10.0, Pydantic 2.14.3) are newer than the code was written against, not because of S2.

### 16.8 S2 exit (the closure rule applied to S2)

1. Tests green and the **full** suite green with `ECCODE_PYTHON` pointing at the virtual environment; the skip count after, with the 35 FastAPI-dependent tests running: 49 before, so 14 remain (6 need a Mealie checkout, 4 `ECCODE_MEALIE_VALIDATE`, 1 `ECCODE_REALBUGS_VALIDATE`, 1 `ECCODE_CBM`, 1 `kotlinc`, 1 `codebase-memory-mcp`).
2. Frozen 48 of 48 by hash before and after; `docs/limits.md` and `scripts/guards/*.py` untouched.
3. Engine battery run 1 (`eccode-gf close battery`) on the build tree, then **review round 1** (amended by 17.2: R1 comprehension and R2 critique, each a fresh agent given the artifacts and the tree, not my conclusions); every finding reproduced as a failing test before its fix; fixes.
4. **A closing round on the final tree** (R1, R2 and R3, each its own dispatch), with no unresolved finding and readiness `go`; if the round raises findings that are fixed, the fixes make a new tree and the round is repeated on it; **the last engine battery** on the final tree; close; no commit after it other than evidence. S2's closure is recorded by the closure rule itself (17.2) in a Greenfield-Senior record initialised at the start of round 1 inside a separate checkout of the build tree and moved with that checkout from commit to commit (18.5); round 1, its findings, their proofs and battery 1 are in the same record, so the ordering checks of GF-CLOSE-2 and GF-CLOSE-3 are not met vacuously.
5. Evidence file with exact commands and outputs; ledger rows; end snapshot; estimate-versus-actual; stop and report.

---

## 17. Owner continuation of 2026-11-07: five upgrades registered (design-only except the review protocol)

The owner extended the S2 go-message without changing S2's scope (ownership map and path-scoped permissions). Upgrade 2 is **built** in S2; Upgrades 1, 3, 4 and 5 are **registered here** and implemented in the slice named on each. Nothing in this section edits a frozen file (the frozen 48 are checked by hash before and after).

### 17.1 Where each upgrade lands

| Upgrade | What | Status after S2 | Built in |
|---|---|---|---|
| 1 | G1.5 problem-anticipation and resolution gate, rules GF-PRE-1 to 4 | registered | S4a (stage, schema, seal rules), S4b (discovered problems at slice integration) |
| 2 | three-step adversarial review protocol | **built and used to close S2** | S2: GF-CLOSE-1 to 5 |
| 3 | six deterministic evidence tools | registered with measured costs | S4a (adapters for T1 to T3 and T6), S5 (T4 and T5 run in the DONE verification) |
| 4 | UX spec as an artifact of G1 | registered | S4a (stage and rules), S5 (the done checks) |
| 5 | G4 comparison arms; helper MCP tools | noted | S6 (arms), S4 (helper tools) |

The seven G1 artifacts of the owner's wording are the six of S1 (PRD, architecture, contracts, threat model, breakdown, estimates) plus the UX spec; the problem register of Upgrade 1 is the eighth. The order inside the design gate becomes contracts, ux, problems, threat model, so that the register can bind to the contracts and to the UX spec, and the threat model can cite the register's P5 entries (section 17.3).

### 17.2 Upgrade 2: the three-step adversarial review protocol (built in S2)

The independent review that closes a slice is three recorded steps. Each step is its own dispatch of a zero-context reviewer agent that receives only the artifacts the dispatch lists and the final tree, never the implementer's conversation. Pattern aligned with Google's Elephant-Goldfish Model (design-by-context-rich agent, review-by-zero-context agents) as the owner described it; ECCode enforces it in the engine rather than by prompt convention. No code of that model is copied, and I did not study its implementation.

| Step | The reviewer | Recorded as | Findings |
|---|---|---|---|
| R1 comprehension | explains the design and the slice back from the documents alone | `gf.review.recorded` step `comprehension`, with a summary of at least 100 characters | what it could not reconstruct is a **documentation defect** (kind `documentation`) |
| R2 critique | tries to break the rules: forge events, smuggle artifacts, bypass gates | step `critique` | reproducible **defects** (kind `defect`), each reproduced as a failing test before any fix (GF-CLOSE-2) |
| R3 readiness | a go or no-go verdict | step `readiness`, verdict `go` or `no-go` | none; it cites **evidence**: an executed check (`ev:<id>`) or `path:line` in the tree, each resolved by the engine |

What the engine enforces for these steps, and what it cannot see (L-GF-19), are stated once, in 18.5.

**Order in a slice.** Battery 1; a first round of R1 and R2 on the build tree (they are independent and may run in parallel); findings reproduced as failing tests, then fixed; a second round on the fixed tree with all three steps, R3 included; the last battery on that tree; close. Every step of the closing round is on the closing tree; steps of earlier rounds stay in the record with their findings resolved.

### 17.3 Upgrade 1: G1.5, the problem-anticipation and resolution gate

**Why.** A senior team enumerates problems at design time and ships only when every known obstacle has a written, feasible resolution.

**Where.** A fourth stage of the design gate (`problems`, between contracts and threat model), engine-gated like the others, sealed with the contract set. The frozen gates are unchanged: the stage rides on the design gate's submission as `stages: contracts, ux, problems, threat`.

**Artifact `problem-register.json`** (field level; the schema is in the JSON-Schema subset of `lib/greenfield/jsonschema.js`):

```json
{
  "version": 1,
  "coverage": { "P1": { "entries": ["PR-1"] }, "P2": { "none": "at least 40 characters saying why this category has no anticipated problem for this project" }, "...": "P1 to P12 are all required; a category with no entry says why; extra categories are named X-<slug>" },
  "entries": [{
    "id": "PR-1", "category": "P1", "description": ">= 30 characters", "severity": "blocker | major | minor", "likelihood": "high | medium | low",
    "resolution": { "kind": "design-decision | contract-change | task | test | ux-state | scope-amendment | accepted-limit", "text": ">= 30 characters",
                    "binds": [{ "type": "criterion | contract | decision | assumption | ux | task | test", "ref": "the id or path it is bound to" }] },
    "status": "open | resolved | accepted"
  }]
}
```

The twelve categories: P1 ambiguity in the idea (every open reading becomes a DECLARED_ASSUMPTION, linked to the PRD); P2 technical feasibility per PRD criterion; P3 integration risks (what the contract tests will and will not catch); P4 data model (migrations, irreversibility, data-loss paths, N+1); P5 authentication and authorization (non-obvious matrix cells, IDOR-prone resources); P6 external dependencies; P7 performance and scale assumptions; P8 failure modes (timeouts, partial writes, retries, idempotency); P9 UX problem states (bound to the UX spec, 17.4); P10 environment and deployment (what this sandbox cannot verify, with the stated fallback evidence); P11 testability; P12 estimation and scope risk.

**Rules.**

| Rule | Enforces | At | Bypass that must fail |
|---|---|---|---|
| GF-PRE-1 | the **seal is refused** while a `blocker` entry has no resolution or is not `resolved`, or a P1 entry is not bound to a DECLARED_ASSUMPTION (`assumption` bind, checked against the design record) | design gate, plan approval (seal), audit | a blocker with `status: open`; a P1 whose assumption does not exist |
| GF-PRE-2 | every resolution **binds to an artifact that exists at the seal**: a PRD criterion, a sealed contract path, a design decision, a UX screen or flow, a breakdown task (including a test task of the breakdown, the test group's task that will write the test: acceptance tests themselves are written after the seal); a resolution text that only defers ("later", "tbd", "to be decided", "will handle", "future work") is refused (a heuristic, labelled: the binding is the real check) | design-gate submission (the shape and the binds that exist then), seal (task binds: the breakdown does not exist at the design gate), audit | a bind to task `t-99` that the breakdown lacks; "we will handle it later" with a valid-looking bind to nothing |
| GF-PRE-3 | **a living, append-only record.** During a slice, a problem not in the register is committed as `gf.problem.discovered {id, slice, category, severity, resolution, cause}` (hash-chained) before the slice can integrate. To make an undeclared problem visible, `cause` names the engine event that revealed it; a frozen event cannot carry a citation, so the citation is a separate event, `gf.obstacle.cited {seq, problem}`, naming the engine event's seq and an anticipated entry or a discovered record. **Slice integration refuses** unless every `task.failed`, `task.rescoped`, contract amendment request and `blocker` message in the slice's range cites an anticipated entry or a discovered record. The delivery report shows anticipated against discovered counts and their ratio, per project | `slice integrate` (S4b), audit | a `task.failed` in the slice with no discovered or anticipated citation |
| GF-PRE-4 | **a discovered blocker with no feasible resolution does not die silently**: it forces one of a recorded contract amendment, a recorded scope amendment to the PRD (`gf.prd.amended`, recorded by the **user**, surfaced to the owner), or an explicit NOT-DONE verdict (`gf.done.refused`). Silent scope shrink is refused: removing or weakening a PRD criterion without `gf.prd.amended` leaves its acceptance test failing, so DONE is refused (GF-DONE-1) | slice integration, DONE | a discovered blocker with resolution kind `scope-amendment` and no `gf.prd.amended` |

The adversarial reviewer of Upgrade 2 attacks the register as well: the critique step's brief includes naming problems the planners missed, and a missed problem found in review is recorded as a `defect` finding against the register.

### 17.4 Upgrade 4: the UX spec, the seventh artifact of G1

`ux-spec.json`, schema-validated and sealed with the contracts; the frontend group builds against it and cannot edit it: it is `contracts/ux-spec.json`, so it is api-owned (`contracts/**` is reserved to api) and, from S4a, a contract file under GF-FRZ-1. The owner's earlier wording of this artifact is not in my working context (it was lost when the conversation was summarized); the schema below follows this message's description, and I ask the owner to confirm it.

```json
{
  "version": 1,
  "designSystem": { "name": "a named, existing design system (for example shadcn/ui, Material, Bootstrap)", "tokens": "optional path to a tokens file" },
  "responsive": { "approach": "mobile-first | desktop-first", "breakpoints": [{ "name": "mobile", "minWidth": 0 }, { "name": "desktop", "minWidth": 1024 }] },
  "screens": [{
    "id": "s-tasks", "title": "...", "route": "/tasks", "roles": ["member", "admin"], "operations": ["listTasks", "createTask"],
    "states": { "loading": "what is shown", "empty": "what is shown", "error": "what is shown", "denied": "what is shown for a role the matrix denies" },
    "testIds": { "loading": "data-testid", "empty": "data-testid", "error": "data-testid", "denied": "data-testid" }
  }],
  "flows": [{ "id": "f-create-task", "title": "...", "criteria": ["AC-3"], "steps": [{ "screen": "s-tasks", "action": "...", "operation": "createTask" }] }],
  "budgets": { "lcpMs": 2500, "cls": 0.1, "accessibility": "no axe violation of impact serious or critical" }
}
```

**Rules (GF-UX-1 to 4, built in S4a).** GF-UX-1: loading, empty and error are required on every screen, each with a test id; `denied`, with its test id, is required on every screen whose operations have a `deny` cell for one of its roles in the access matrix. GF-UX-2: every operation a screen names exists in the OpenAPI and every non-public operation reachable by a role has a screen or is marked API-only with a reason. GF-UX-3: every PRD criterion whose `verify.kind` is a UI kind maps to a flow, and every flow step names an existing screen. GF-UX-4: a named design system, at least two breakpoints and budgets are present. **P9** of the register binds to screens and states of this artifact. **Done-verification (S5)** adds: Playwright state coverage (T5: each screen state is reached and its test id found), and an accessibility and performance budget through axe and Lighthouse where runnable; where not runnable the report says `unverifiable here`, never a skipped check. **Visual taste is a named limit (L-GF-21), not a guarantee.**

### 17.5 Upgrade 3: deterministic evidence tools

Six tools become **evidence sources**: the engine runs a pinned invocation and records the **raw output's sha256** (the redacted output is stored; a raw output that could hold a secret is hashed in memory and never persisted); an agent-written summary of a tool's output never stands in for it. The hash is defined per tool: for Gitleaks, `rawSha256` is the hash of the redacted report, because the engine never produces an unredacted one; for the other tools it is the hash of the raw output. One event carries them all: `gf.tool.run {tool, version, argv, scope, treeHash, exitCode, rawSha256, artifact {path, sha256}, counts {blocking, advisory}}`. **Rule for all six (GF-TOOL-1):** a tool that is unavailable or cannot run in the environment makes the verdict `unverifiable here`, stated in the delivery report with the reason, and **never** a skipped or silent check (the same honesty as the Docker criterion).

Measured in this sandbox on 2026-11-07 by a delegated agent (ledger row of that date) and spot-checked by me (versions of all five binaries; Ruff and Gitleaks timings and Gitleaks redaction on fixture B re-run: 0.021 s and 0.527 s, two findings, no raw token in the report). Machine: 4 cores, Python 3.13.18, Node 22.23.4. Fixture A is the 1,095-line FastAPI app `tests/fixtures/phase3/ledger`; fixture B is a generated 9,969-line project with a planted lint problem, `eval`, a SQL string built by concatenation and two fake secrets. Times are medians of three runs. Docker: the client is present, **no daemon** (`docker info`: "failed to connect to the docker API at unix:///var/run/docker.sock").

| Tool | Pinned (installed here) | Source, licence | Runs when | Invocation (machine-readable) and exit codes | Refuses delivery when | Measured time per run | Offline, and the `unverifiable here` path |
|---|---|---|---|---|---|---|---|
| T1 Ruff | `ruff 0.17.4` | PyPI; MIT | every Python iteration: at task completion on the task's changed files, and at slice integration on the tree | `ruff check --output-format json` and `ruff format --check`; 0 clean, 1 findings, 2 error | a task's changed files have a finding under the project's **pinned** `--select` set (the default set is 407 rules and changes between versions; `E711` is not in it) | 0.015 s on A, 0.021 s on B; format check 0.016 s and 0.013 s: **negligible against the time problem** | runs offline; exit 2 or a missing binary means `unverifiable here` |
| T2 Gitleaks | `8.30.1` | GitHub release tarball (the release asset URL works through the proxy; the GitHub API does not); MIT | at task completion (the changed files copied into one staging directory and scanned once), at slice integration (`--log-opts="<base>..HEAD"`), at DONE (the whole history); in delivered projects as a pre-commit hook on the staged diff | `gitleaks dir` or `gitleaks git`, with `--no-banner --redact -f json -r <out> --exit-code 7`; 0 none, 7 leaks, 1 fatal error (by default leaks and fatal errors are both 1, so the engine sets 7) | **any finding** | 0.52 s per scan whatever the size (A 0.523 s, B 0.519 s; 3-commit history 0.49 s); one file at a time costs 0.59 s each, so scan a staging directory | offline verified; without `--redact` the report holds the raw secret, so the engine only ever runs it with `--redact` and no raw report exists to persist |
| T3 Semgrep | `1.184.0`; rules: `semgrep-rules` at commit `16b9e6d45f10649f6a531ec4838ed9924372c3bc` | PyPI, engine LGPL-2.1-or-later; rules under the "Semgrep Rules License v1.0", whose text is on a host the proxy blocks | each integrated slice | `semgrep --config <pinned rule dir> --metrics=off --disable-version-check --json --error`; 0 none, 1 findings, 2 network failure, 7 invalid config | a finding of a rule mapped to a security guard class (injection, access control, secrets, dangerous evaluation) is **blocking**; the rest are advisory; a noisy rule is scoped out by a recorded exclusion with a reason, never ignored | 12.4 s on A and 12.7 s on B with the 371 Python rules (9.8 s of it is loading the configuration), 9.2 to 9.8 s with a FastAPI and SQL subset; found the `eval` and the raw SQL plants | **the registry packs (`p/owasp-top-ten`, `p/fastapi`, ...) cannot be fetched here** (proxy 403 for semgrep.dev); local rules work offline; `python/fastapi` holds one rule only, so "FastAPI ruleset" means the Python, SQLAlchemy and framework rules, stated as such |
| T4 Trivy | `0.76.2` | GitHub release tarball; Apache-2.0 | the G3 DONE run (S5) | `trivy fs --scanners vuln,misconfig --format json --exit-code 5`; 0 none, 5 findings, 1 fatal | a CRITICAL or HIGH vulnerability with a fixed version, or a HIGH misconfiguration in the Dockerfile or compose file (thresholds registered before the first run) | warm database: 0.12 s on a 20-package `requirements.txt` (202 vulnerabilities found in old pins), 0.95 s with the Dockerfile; **cold: 9.1 to 9.6 s to download 132 MiB, 1.6 GB on disk** | no Docker daemon needed (`fs` and `config`); offline works with a cached database; an empty cache and no network is FATAL exit 1, so the verdict is `unverifiable here`; a stale database is reported with its age |
| T5 Playwright | `@playwright/test 1.65.0`, `@axe-core/playwright 4.14.0`, `lighthouse 13.6.0`; `@playwright/mcp 0.0.84` as a helper only | npm; Apache-2.0, axe MPL-2.0 | the DONE run and the UX state coverage (S5) | `playwright test --reporter=json`; 0 pass, 1 a failure or no test matched; Lighthouse `--output=json` | a failing E2E or UX-state test, an axe violation of impact serious or critical, a Lighthouse budget missed | 2.3 to 2.7 s for three pages including the browser launch; axe 0.76 s per page; Lighthouse 10.9 s per page | 1.65.0 does not find the preinstalled browser (built for 1.63): run with `executablePath: /opt/pw-browsers/chromium` or pin 1.63.0; no browser means `unverifiable here` |
| T6 pre-commit | `pre-commit 4.7.0` | PyPI; MIT | **a deliverable**, not a guard on ECCode: every greenfield project ships `.pre-commit-config.yaml` with `repo: local`, `language: system` hooks for T1 and T2 (and T3 where its rules are available) | the hooks' own output; 0 pass, 1 a hook failed, 3 unexpected error | DONE verifies that the config exists, parses and passes `pre-commit run --all-files` on the delivered tree | 1.35 to 1.5 s per commit on A | local hooks need no network (verified offline); remote hook repositories need it on first use (exit 3 offline), which is why the generated config uses local hooks |

**Per-slice time cost these add** (from the medians above): per task completion about 0.6 s (Ruff plus one Gitleaks scan); per slice integration about 10 to 13 s (Semgrep) plus 0.5 s (Gitleaks); per DONE run about 1 s for Trivy with a warm database (10 s cold), about 3 s for the Playwright run, plus 0.8 s of axe and 11 s of Lighthouse per page measured. The raw outputs of Semgrep, Trivy, Lighthouse and Playwright are not byte-stable between runs (they embed timings and report ids), so the recorded sha256 identifies the artifact of one run; it is not compared across runs.

### 17.6 Upgrade 5

- **G4 arms (note for the G4 protocol, no action now).** When the benchmark protocol is finalised, the candidate comparison arms are bare, ECC and, at the owner's selection, Aider, OpenHands and SWE-agent as additional arms. They are **benchmark arms only**: no competing harness is integrated into ECCode. The G4 protocol draft (S6) records this.
- **Helper MCP tools in S4.** Serena (LSP symbol tools) and Context7 (library documentation) may be offered to build-phase agents as helper MCP tools, with one rule: **anything they fetch is context, never evidence.** It never enters the hash-chained log as proof of anything (the engine records evidence only from its own runs, so a helper's output has no path into the record), and fetched text is treated as untrusted data, not instructions. Their absence never blocks a build (fail-open, unlike the evidence tools).

### 17.7 Slice plan and costs after the upgrades (re-registered 2026-11-07)

The original registrations in sections 9 and 10 stay as registered, for scoring. S4 as registered cannot hold what the upgrades add, so **I propose splitting it** (the owner decides):

| Slice | Scope | Wall time (active, judgment) | New prod / test LOC | Tokens, all processed | Tests |
|---|---|---|---|---|---|
| S3 | contract-test generator and mock server, GF-FE-1, GF-FRZ-3/4, GF-ACC-1/2 (unchanged) | 1.5 to 3 h | 1,200 to 1,800 / 1,600 to 2,600 | 60 to 200 M | 150 to 300 |
| **S4a** | the two new G1 stages (UX spec, problem register), GF-UX-1..4 and GF-PRE-1/2, the seal changes, the tool adapters T1 to T3 and T6, `gf.tool.run`, the sample bundle and mutation rows for both stages | 2 to 4 h | 1,000 to 1,600 / 1,800 to 3,000 | 80 to 250 M | 200 to 350 |
| **S4b** | `slice open / integrate / invalidate`, GF-PRE-3/4 at integration, `gf.prd.amended`, the "cites an amendment" half of 3.4 point 2 (a task completion that changes a contract cites its amendment), messages in use, orchestrator skill v2, then the toy run from one idea to a delivery report | 3 to 6 h build, 3 to 6 h toy run | 900 to 1,400 / 1,200 to 2,000 | 150 to 450 M (the toy run's dispatched agents, 8 to 16 M, are reported in the ledger beside it) | 120 to 250 |
| S5 | done-verification: the five criteria, T4 and T5 runs, the UX done checks, the compose runner and the labelled process runner | 1.5 to 3 h | 800 to 1,300 / 1,000 to 1,800 | 60 to 200 M | 100 to 200 |
| S6 | the G4 protocol, text only | 1 to 2 h | 0 | 10 to 40 M | n/a |

Basis, stated so it can be scored: S4a and S4b together: section 10's S4 build (6 to 10 h) scaled by about 0.8 to 1.0, not by the smaller factors, because the upgrades add two G1 stages and six adapters to it. the S1 actual was 1 h 22 min wall and 129.5 M all-processed tokens (G0 included) for 2.3 k production and 2.7 k test lines; S1 ran at one sixth to one tenth of its registered wall time; the ranges above are the registered figures of section 10 scaled by factors of about one quarter to two thirds (S3 0.25 to 0.3, S5 about 0.4, S6 0.5 to 0.67), higher than S1's ratio because each slice now has at least two review rounds, which in S1 took more than half the wall time, tokens are scaled from the S1 measurement by relative scope with a factor-three range, because the cost followed turns times context and not lines (18.6). Every slice also pays for two or more independent review rounds (section 17.2), which S1's review phase showed to be the larger part. Labels: judgment ranges, no calibration claim (L-GF-12).

### 17.8 What I assess as infeasible or in conflict with a frozen file, and the minimal alternative

Nothing in the five upgrades requires editing a frozen file. These items cannot be done exactly as worded; each has a proposed minimal alternative, and none is dropped silently.

| # | Item as worded | Problem | Minimal alternative proposed |
|---|---|---|---|
| 1 | GF-PRE-2: every resolution references an artifact that exists "at seal time" | the breakdown (task ids) does not exist when the design gate is reviewed, and the problem register is a design-gate stage | validate the register's shape and every bind that can exist at the design gate (criterion, contract, decision, assumption, ux) when the design gate is submitted, and the task and test binds at plan approval, which is the seal |
| 2 | GF-PRE-3: a group that hits a problem not in the register must commit it | the engine cannot see a problem that is solved inside a task with no event | require a discovered-problem or anticipated citation for every engine-visible obstacle (task failure, rescope, contract amendment request, blocker message); a problem fixed silently inside a task stays invisible, a named limit like L-GF-8 |
| 3 | GF-PRE-4: surface a scope amendment "to the owner" | a sealed PRD has no amendment path today, and an engine cannot reach the owner | a new event `gf.prd.amended` (S4b), recordable only by the user; headless, with nobody to answer, the verdict is NOT-DONE |
| 4 | Upgrade 2: each step "a separate zero-context agent" that receives only artifacts and the tree | the engine cannot observe an agent's context | record and check the dispatch (role, step, tree, hashed inputs, refused inputs, one review per dispatch); the zero-context property itself is the orchestrator's attestation (L-GF-19) |
| 5 | T2 Gitleaks "on every commit the engine makes" | the engine makes no commits; agents and the orchestrator do | scan at task completion (the changed files), at slice integration (the tree) and at DONE (the history); the pre-commit hook of T6 covers commits in the delivered project |
| 6 | T5 Playwright MCP as an evidence source | an agent driving a browser over MCP yields an agent's account of it, not raw output | the evidence instrument is the Playwright **test runner** run by the engine with traces; the MCP server is offered to build agents as a helper (context, not evidence) |
| 7 | "hashed raw output" for every tool | the secret scanner's raw output can contain the secret, and secrets never persist | run the secret scanner only with `--redact`, so the redacted report is the raw output: its hash is recorded and it is persisted (17.5); every other tool's raw output is hashed and stored as it is, unless 17.5 says it could hold a secret, and then 17.5's rule applies: it is never persisted raw |
| 8 | T3 Semgrep OWASP and FastAPI rulesets | measured: the registry packs cannot be fetched here (proxy 403), the rule repository's licence text is on the blocked host, and its FastAPI directory holds one rule | pin the rule repository by commit in the engine's cache (not inside delivered projects until the licence is read), map rules to the guard classes, and state which rules ran; the owner may allow the semgrep.dev hosts if the registry packs are wanted |
| 9 | S4 as registered | it cannot absorb the upgrades | split into S4a and S4b (17.7); the owner decides |
| 10 | the UX artifact "exactly as previously worded" | that wording is not in my context | the schema above, from this message; the owner confirms or corrects it |
| 11 | T5 Playwright, pinned | measured: 1.65.0 does not find the preinstalled browser | pin 1.63.0 (the preinstalled browser's version) or pass the executable path; either is recorded in the tool event |
| 12 | T4 Trivy in every DONE run | the vulnerability database is 1.6 GB and is downloaded on first use | cache it once per machine; the report states the database age, and a cold, offline machine is `unverifiable here` |

### 17.9 S2's registered estimate, amended for the added scope

The owner's continuation added the three-step protocol to the closure rule, the design amendments above, and a delegated measurement of six tools. Registered before the work they cover was measured: **+0.5 to 1.5 h wall, +20 to 60 M all-processed tokens, +1 delegated research agent (0.3 to 0.8 M tokens as reported), and reviewer dispatches instead of 2: 5 if two rounds suffice, and 3 more for every further round** (R1 and R2 of the first round, then R1, R2 and R3 of the closing round). "Tests" in every estimate means the `# tests` count of `node --test`. The S2 totals become 3 to 6 h and 60 to 210 M. Prediction **P7**: the closing round (all three steps on the fixed tree) will raise at least one finding the first round did not. Predictions P4 to P6 stand as registered in section 16.7.

---

## 18. S2 as built (2026-11-07)

**This section is the single description of S2 as built** (the owner's decision of round 5). Section 16 is S2's design as registered before the build: its owner decisions (16.1), the L-GF-17 assessment (16.4), the registered estimate and predictions (16.7) and the exit criteria (16.8) stay there as registrations, and 16.2, 16.3, 16.5 and 16.6 point here; section 17.2 registers the review protocol, and section 7 the event schemas. **Precedence:** sections 2 to 15 describe the layer as designed at G0 and S1; where any other section, the limits register or the plan says something different about S2, this section applies. The plan is the pre-build plan: the plan's interfaces are superseded by section 7 and section 18. The evidence, the closure record and the estimate-versus-actual table are in `docs/build/gf-s2-evidence.md` and `docs/build/gf-s2-record/`.

### 18.1 Rules and enforcement points (and where they deviate from section 4.2)

| Rule | Enforces | At | Built in S2 as |
|---|---|---|---|
| GF-OWN-1 | every engine task's owner is in a group; a pending or claimed task's files lie inside that group's effective globs now (18.2) | P (seal), H (fail closed), A | the effective map (sealed `breakdown.json` groups plus reviewer amendments), checked against the engine's task table by the audit; the seal-time half already exists as GF-WBS-1/2; after the seal the hook denies a group role's write with the GF-OWN-1 reason when the sealed breakdown fails its hash check or the ownership policy cannot be evaluated |
| GF-OWN-2 | a write by a group role lies inside its group's globs **and** a claimed task's globs; a path owned by no group is refused | H | `lib/greenfield/permissions.js`, called by `scripts/hooks/guard.js`; fails closed in a Greenfield-Senior project; a group role has no shell (GF-RUN-1), and a target file with more than one hard link is refused (round 4, E2-2) |
| GF-OWN-3 | `task_complete`: the completing actor is the task's owner, and every listed changed file belongs to the actor's group (the owner half came from the round-1 review); a listed file under `.eccode/drafts/` is skipped, and any other `.eccode/` path is owned by no group and is reported | P, A | wrapper around the frozen `tasks.complete`; the audit replays each `task.completed` against the map in force at that event |
| GF-OWN-4 | tree attribution: every path changed since a base commit is owned by a group that completed a task declaring it | slice, `eccode-gf attribute` | a pure function and a command; its audit integration waits for S4, because the slice base commit is recorded by `gf.slice.opened` (deviation from 4.2, where the audit was listed) |
| GF-OWN-5 | the map changes only by a reviewer amendment: a role of `config.roles.{design,verification,phase}.reviewers`, a reason of 30 characters or more, a cited message that is recorded (whatever its kind, sender or recipient: the engine checks that it exists), and `from` equal to the globs in force; a rescope cannot move a task out of its group, and cites no message (4.5's citation is not built: L-GF-31) | P, A | `gf.ownership.amended`, a wrapper around `tasks.rescope`, audit replay |
| GF-FRZ-1 | contract paths are writable by the api group only, and after the seal only while an amendment request for that file is open | H (audit half: GF-FRZ-2, the bytes against the seal and the amendment chain; no P point, since a file write is not an engine operation) | in `permissions.js`; the byte-level guarantee stays GF-FRZ-2 (S1) |
| GF-CONF-1 | the three guard configs (`behavior.json`, `guards.json`, `security.json`) are pinned by hash; a change after the pin is detected, and no group role may write them | H, A | `gf.config.pinned`, `eccode-gf config pin`; S4's `slice open` calls the same function (deviation: the event exists in S2, not S4) |
| Drafts | group roles write only `.eccode/drafts/<group>/**` | H | `permissions.js`; narrows the shared scratch channel, does not close it (L-GF-4) |
| GF-CLOSE-1..5 | slice closure: three recorded review steps, each its own dispatch (18.5) | P, A | `lib/greenfield/closure.js` |
| GF-RUN-1 | in a Greenfield-Senior project a group role has no shell: the hook denies it Bash, PowerShell and Monitor | H | `permissions.shellDenial`, called by `scripts/hooks/guard.js`; fails closed like GF-OWN-1; the install wires the guard for the three tools, and the preflight's managed-path regime requires it (18.4) |
| GF-RUN-2 | a group role's commands run through the runner, which accepts a pinned form of eight tools or a command the plan pins, runs it through the frozen evidence runner and its integrity window, and reports a new untracked file outside the caller's group | P | `lib/greenfield/runner.js`, `gf_run`, `eccode-gf run` (18.4) |

**Clarifications.** Before the seal, group roles hold no claim, so the hook's existing claimed-task rule answers a group role's write; the fail-closed GF-OWN-1 denial applies after the seal, when the map cannot be trusted. The G1 artifacts live under `.eccode/artifacts/` (written by the document authors, `delivery-lead` included, through the hook's artifact area) and under `contracts/` (drafted by the document authors and the orchestrator before the seal); other `.eccode/` paths are left to the hook's record rules, and handoffs are written by the engine at completion, not by a group role. GF-FRZ-1 binds group roles only: the contract files are the five sealed files plus `contracts/events.json`; a non-api group role is refused, and the api group may write a sealed one only while an amendment request for it is open. An amendment request is open from `gf.contract.amendment.requested` until a `gf.contract.amended` cites it; there is no withdrawal event, so a request never applied keeps its file writable for the api group, and the byte-level check that then matters is GF-FRZ-2 (the audit half of the contract rules). `mocks/**` is an api path under GF-OWN-2, not a contract file. `contracts/events.json` is sealed when it is in the design submission, and then needs an open request like the others; if it is absent at the seal, creating it later is GF-FRZ-2 drift and the hook refuses it (it is not in the seal). GF-CONF-1: the latest pin, whatever its scope, is the reference; with no pin the audit has no GF-CONF-1 opinion (nothing is compared until the first pin, while the hook's refusal of a group role's write to the three files does not wait for one); a pin's `scope` is a label (a slice id or any non-empty string) recorded with the pin and named in drift messages, and is not checked against anything else; a pin needs a reason of 10 characters or more; the orchestrator or the user may pin again at any time with a reason, a config file created after the latest pin is drift, and a loosened file re-pinned by the orchestrator is recorded and visible but not refused (L-GF-22); a group role's write to the three files is refused as GF-CONF-1. Section 3.4 point 2: its group half is GF-OWN-3 and GF-FRZ-1; the "cites an amendment" half of 3.4 point 2 is not built (GF-FRZ-2 detects any contract change without one, at audit), and is registered for S4b.

Group role sets in the hook were added in S1 (`IMPLEMENTERS`); S2 adds the group-to-glob check that makes them path-scoped. The ownership map is **not** copied into a new snapshot: it is read from the approved, hash-sealed `breakdown.json` (its bytes are also covered by the frozen audit's "modified after approval" check) and every read verifies the bytes against `gf.g1.sealed.hashes`; a mismatch is a GF-OWN-1 problem, and the hook then denies group-role writes (fail closed).

**Which projects the hook treats as Greenfield-Senior (after the round-3 review).** For a group role's write the hook opens the record: a `gf.project.initialized` event in the record makes a project Greenfield-Senior for the hook. An initialised record is a record whose `.eccode/events.jsonl` exists (the store's own test); no initialised record, or a record without that event, means the project is not Greenfield-Senior, and the existing hook rules apply unchanged, as they do for the orchestrator and for a role in no group. When the hook cannot decide, because an initialised record's log cannot be read, parsed or replayed (the frozen store skips a torn last line, the trace of a write cut short; any other line that does not parse makes the log unreadable), it fails closed: the group role's write is denied with the GF-OWN-1 reason "the ownership policy could not be evaluated". GF-RUN-1 decides the same way. A missing `events.jsonl` therefore turns the Greenfield-Senior hook rules off; removing or moving it is a write the hook refuses to the file tools (`RECORD_FILES`), and for a group role it would need the shell that GF-RUN-1 denies.

### 18.2 The ownership map: effective map and its algebra

`effectiveMap(base, amendments)` replaces a group's `globs` with each amendment's `to`, in log order; `from` must equal the globs in force (a chain, as for contracts). Every map, sealed or amended, must pass the same checks as GF-WBS-2 (groups disjoint; `contracts/**` and `mocks/**` belong to api, `tests/acceptance/**` to test); S2 moves those checks into `ownership.js` so the breakdown validator and the amendment use one implementation. An amendment is also refused when it would leave a pending or claimed task of the group outside its new globs; it may leave a completed task outside them.

**The algebra.** Two globs may overlap when the frozen engine's literal-prefix test says so (`globsOverlap`); a glob is inside another only when that is provable (equal, `**`, or the outer ends in `/**` and the inner starts with its prefix). Overlapping globs of two groups are allowed only when one is provably inside the other and the outer group lists it in its `denyGlobs`; anything the algebra cannot prove is refused. A path belongs to the group whose globs match it and whose `denyGlobs` do not. An amendment changes `globs` only: an amendment cannot change denyGlobs, roles or the reserved paths.

| Rule | Map it is judged against |
|---|---|
| GF-OWN-1 (audit) | every engine task: its owner is in a group; pending and claimed tasks: their files lie inside the group's effective globs now; rescopes: judged at their event (GF-OWN-5); the sealed bytes for the hash check |
| GF-OWN-2 (hook) | the effective map now |
| GF-OWN-3 (completion; audit) | the effective map now at completion time; in the audit, the map in force at that event |
| GF-OWN-4 (attribution) | the effective map at the time it is run |
| GF-OWN-5 (rescope; amendment; audit) | the map in force at that event |

Because a completed task may be stranded by a later amendment, GF-OWN-3 (judged at its event) and GF-OWN-4 (judged now) can disagree about an old change; attribution in S4 runs per slice, against the map in force for that slice. `gf.g1.sealed.hashes` is the seal event's field; the projection calls it `gf.seal.hashes`.

### 18.3 Identity: L-GF-17 as built

The assessment (16.4) found that ownership between groups is spoofable on the managed path in one sense: its guarantee rests on two controls that live outside the log. As built, the vectors and what stops them:

| Vector | Where | Stopped by | Visible afterwards in the log? |
|---|---|---|---|
| A calls B's MCP server (`mcp__eccode_B__*`) | managed | the hook: server role must equal the caller's `agent_type` (`guard.js`, `main`); and the harness's per-subagent tool list in the `sandbox` and `no-shell` profiles (`install.js`) | no: the event is well-formed and says actor B |
| A passes an `actor` argument to a tool of its own server | managed | nothing is needed: the handler reads the server's locked actor, never an argument (tested) | not applicable |
| A writes B's files with Edit/Write | any | the hook, by the caller's `agent_type`, which the agent cannot set; S2 adds the group-glob check | the write is visible in git; its author is not (see below) |
| A runs `eccode --actor B ...` or any other shell command | a shell: the `sandbox` and `guard` profiles give agents one, the `no-shell` profile denies it | for a group role in a Greenfield-Senior project, the hook denies every shell tool (GF-RUN-1, 18.4); for other roles, the hook on command text (limits rows 91, 117: text-level, obfuscation can pass) | no |
| A writes B's files from a shell (`mv`, a hard link, a `cd` chain, `git rm`, `git mv`, `git apply`) | a shell | GF-RUN-1: a group role has no shell; a hard link made earlier is refused to the file tools by its link count | the change is visible in git; GF-OWN-4 attribution finds it, both names of a rename included |
| A runs project code through the runner, and the code writes B's files | managed (GF-RUN-2) | the frozen integrity window fails a run that changes a tracked file outside A's claimed ownership; a new untracked file outside A's group is reported by the runner (L-GF-29) | the failed run is evidence; the untracked file is visible in git |
| A appends a forged, correctly hashed event to `events.jsonl` | needs a writer other than the hook-covered tools | the hook (`RECORD_FILES`); the chain detects change and truncation, not an append | no: the audit judges content; the actor is asserted, not bound (L-GF-17) |
| the hook is off (`ECCODE_HOOKS=off` in the process or in the project settings, `disableAllHooks`) or the harness sends no `agent_type` | any | nothing; the preflight reports the hooks switched off (F0) | no |

**What a spoof buys.** (1) Writes: an A agent acting as B can claim B's tasks and write B's files; the attribution of a change is per claim, never per author (L-GF-3 is the same fact inside a group). (2) Reviewer-only events (`gf.ownership.amended`, closure reviews, the withdrawal of a finding): an A agent acting as a reviewer could amend the map or record the reviews that close a slice; acting as the orchestrator or the user it could also record dispatches, the closure and deferrals. A fixed resolution needs no role, since its proof carries it (18.5). What a spoof does **not** buy: the sealed contracts, the pinned guard configs and the sealed acceptance tests are content-addressed (GF-FRZ-2, GF-CONF-1, GF-ACC-2): a change outside their recorded change paths is detected whoever made it; a change made through a recorded change path (a contract amendment or an acceptance amendment by a spoofed reviewer, a re-pin by a spoofed orchestrator) is recorded but not flagged.

**Built in S2 (F0 to F2; no secret needed).** (F0) A *managed-path preflight*: `eccode-gf preflight` and a section of `eccode-gf audit` report which regime is in force (computed from the current settings each time; it is not a log event, so it says nothing about the regime when an earlier event was committed): the install profile (`sandbox`, `no-shell` or `guard`), whether the guard is wired for `mcp__eccode_.*`, the file tools and the three shell tools (Bash, PowerShell, Monitor), whether the project settings switch the hooks off (`disableAllHooks`, or `env.ECCODE_HOOKS` set to `off`, in `.claude/settings.json` or `.claude/settings.local.json`; round 4, E2-8), and whether each group role has a role-locked server entry. `guard` profile or a missing wiring is reported as a **warning that names the consequence** ("a group can act as another undetectably"); `eccode-gf verify-done` (S5) will print the regime in the delivery report. (F1) Make the S2 ownership rules lean on facts of the reviewed plan where they can: GF-OWN-4 attributes paths to the task owners' groups through the map in force (sealed plus valid amendments), and GF-OWN-3 reads the completing actor and the task's owner: it checks the actor against the owner (a fact of the reviewed plan) and the listed files against the actor's group. Against a writer who controls the actor string, what F1 adds is narrow, stated after the round-3 review: a forger must name the task's owner as the actor and list only files of the owner's group, so a forged completion under any other actor is reported; a forger who names the owner passes, and that is L-GF-17. (F2) Say it plainly in the register: L-GF-17 is re-stated with the exact residual.

**Proposed, not built, for the owner's decision.** (F3) *Keyed attestation*: `eccode-gf init` generates a per-role key stored outside the repository and handed to each role-locked server; after each commit the server appends `gf.attest {seq, hash, role, mac}`; the audit verifies the MAC and flags a group-role event without a valid attestation. That turns "a forged actor is undetectable" into "a forged actor is detected unless the agent read the key". Cost: about 250 lines, key management, and the key directory must be read-denied to agents, which only works where the harness runs hooks on Read (the same best-effort class as L-GF-7). Recommended for S5, next to done-verification, which should refuse DONE on an unattested group event. It does not help the plain CLI and does not protect against a defeated hook that also reads the key.

**Closure independence rests on the same controls.** A review is recorded under the actor the call asserts: over MCP the role-locked server sets it, over `eccode-gf` the `--actor` argument does, which the hook checks as text and which GF-RUN-1 takes away from a group role with its shell. So the independence the closure rule checks (a reviewer role that authored nothing and is not the closer, 18.5) holds while the two controls above hold, like ownership between groups (L-GF-17); without them a review can be recorded under a reviewer role by any agent (L-GF-19).

### 18.4 No shell for a group role, and the runner (GF-RUN-1, GF-RUN-2; the owner's decision of round 5)

Judging a group role's shell writes from the command text did not end: each review round found another form (C2-5, D2-1, and in round 4 E2-1 to E2-4). The owner decided to close the class instead of modelling it. **GF-RUN-1:** in a Greenfield-Senior project (decided as in 18.1) the hook denies a group role every shell tool: Bash, PowerShell and Monitor. The install wires the guard for all three, and the preflight's managed-path regime requires that wiring. The orchestrator, the reviewer roles and roles in no group keep the shell they have, with the hook's text-level checks (L-GF-1). **GF-RUN-2:** a group role runs commands through the runner (MCP `gf_run` on its role-locked server; `eccode-gf run`). The runner accepts a command the plan already pins (the frozen engine's approved list: task checks, the behaviour command, the detected stack checks) or a command in a pinned form of one of eight tools, and runs it through the frozen evidence runner, whose integrity window fails a run that changes the record or a tracked file outside the caller's claimed ownership. It also lists the untracked files before and after the run, and reports a new one outside the caller's group; that report is not a log event (L-GF-29). A command is words separated by single spaces, each made of letters, digits and `_ . / : = , @ + -`; anything else (`;`, `&&`, `|`, `$`, a backquote, a redirection, a quote, a newline) is shell syntax and is refused. A path argument is inside the project.

| Tool | Pinned forms | Arguments | Writes |
|---|---|---|---|
| pytest | `pytest`, `python -m pytest`, `python3 -m pytest` | `-q`, `-x`, `-v`, `-rA`, `--tb=short`, `--tb=line`, `--tb=no`, `--maxfail=<n>`, `-k <word>`, `--cov=<path>`, `--cov-report=term`; test paths and node ids (`path::name`) | caches only |
| alembic | `alembic upgrade`, `downgrade`, `current`, `history`, `heads`, `check`; `alembic revision --autogenerate -m <word>` | a revision word (`head`, `base`, `+1`, `-1`, an id) | the database; `revision` writes under `migrations/`, so it is allowed only to the group that owns `migrations/` |
| uvicorn | `serve <module>:<app> --port <n> -- <a pytest or playwright form>` | a port from 1024 to 65535 | what the check writes: the runner starts `python3 -m uvicorn <module>:<app> --host 127.0.0.1 --port <n>` (the interpreter is `ECCODE_GF_PYTHON` when it is set), waits up to 20 s for the port, runs the check, then stops the server and everything it started; the check's exit code is the run's |
| ruff | `ruff check`, `ruff format --check` | `--output-format=concise`, `full` or `json`; project paths | nothing |
| ruff, writing | `ruff check --fix`, `ruff format` | at least one path, each inside the caller's group | the named paths |
| semgrep | `semgrep scan` | `--metrics=off` (required), `--config=<word or path>`, `--error`, `--json`; project paths | nothing |
| gitleaks | `gitleaks detect` | `--redact` (required, so that no secret reaches the evidence log), `--no-git`, `--source=<path>`, `--report-format=json` | nothing |
| trivy | `trivy fs` | `--scanners=<list>`, `--severity=<list>`, `--exit-code=<n>`, `--offline-scan`, `--quiet`; one project path | nothing |
| playwright | `npx playwright test`, `playwright test` | `--project=<word>`, `--reporter=line`, `list`, `dot` or `json`, `--workers=<n>`; project paths | its result folders |

Writing forms are for group roles only. New files under the tools' caches and result folders (`.pytest_cache/`, `__pycache__/`, `.ruff_cache/`, `.mypy_cache/`, `test-results/`, `playwright-report/`, `htmlcov/`, `.coverage`, `*.pyc`) are not reported. A tool that is not installed fails its run, which is recorded as failed, and the runner says "unverifiable here: <tool> is not installed" (the fail-closed rule of 17.5). Here pytest, alembic, uvicorn (with the system Python 3), ruff and Playwright are installed; Semgrep, Gitleaks and Trivy are not, so their forms are checked and their runs are unverifiable here until S4a installs and pins them (L-GF-32). Every tool the owner listed has a pinned form, so none needs a blocking limit.

### 18.5 The closure rule (owner condition 1): GF-CLOSE-1 to 5

The closing review is three recorded steps (comprehension, critique, readiness), each its own dispatch (GF-CLOSE-5; the protocol is registered in 17.2). Which reviews count: every valid review of a step on the closing tree counts. A step may be dispatched and reviewed more than once on one tree, each review with its own dispatch; the closing tree needs at least one valid review of each step; every finding of every review is to be resolved; and a readiness `no-go` recorded on the closing tree stands, so a later `go` on the same tree does not override it (round 3, D2-3). A documentation finding, which has no source change for a fix verification to run on, is proven by a paired run of one command (failed as a reproduction, then passed).

A **scope** is the thing being closed: a slice id (S4 binds it to `gf.slice.opened`) or any string a project chooses. Events: `gf.review.recorded`, `gf.finding.resolved`, `gf.battery.recorded`, `gf.slice.closed`. `eccode-gf close` commits `gf.slice.closed` only when the check, run inside the lock against the real log, finds all of the following; the audit replays them as invariants.

| Rule | Requires | Bypass that must fail |
|---|---|---|
| GF-CLOSE-1 | for each of the three steps, a valid review of that step on the git tree object (`HEAD^{tree}`) being closed, on a clean tree; the readiness verdict `go`; a comprehension or critique review on the closing tree may list findings only if each is withdrawn or deferred (a fixed finding needs a new round); each recorded by a configured reviewer role that authored nothing in the record (no claim, completion or gate submission under that role) and is not the closer | a clean review of an earlier tree; a reviewer that also completed a task; the closer recording its own review |
| GF-CLOSE-2 | every finding of every review of the scope is resolved: `fixed` cites a fix-verify proof (post-fix evidence that passed, citing a pre-fix evidence that failed as a reproduction, both recorded after the finding and before the resolution); `withdrawn`: a finding is withdrawn only by the reviewer role that raised it, with a reason; `deferred` only by `user`, with a limit id, for a minor finding or a major documentation finding (the owner's decision of round 5; a blocking finding and a major defect cannot be deferred) | a fix cited with a proof whose pre-fix run passed; a proof recorded before the finding; the orchestrator withdrawing a blocking finding; the user deferring a major defect |
| GF-CLOSE-3 | at least two batteries (pinned mutation runs: tree clean before and after, evidence recorded by the engine); the first recorded before the first review; the last bound to the closing tree and recorded after the last `fixed` resolution; its survivors listed with a reason each, or none | one battery only; a second battery on the pre-fix tree; a battery recorded before the last fix |
| GF-CLOSE-4 | `accounting {unit: "all-processed-tokens", start, end}` where each of start and end is a non-negative integer or the string `unmeasurable`; never absent, never null; `end >= start` when both are numbers | a blank; `null`; a number written as text (`'0'`); a measured `0` is a legitimate number, and a dishonest one cannot be told from it (the check is of form) |
| closed is closed (GF-CLOSE-1, 2, 3 and 5) | after `gf.slice.closed`, a dispatch (GF-CLOSE-5), a review (GF-CLOSE-1), a resolution (GF-CLOSE-2) or a battery (GF-CLOSE-3) for that scope is refused, a second closure of it is refused (GF-CLOSE-1), and the audit flags one that exists under the same rule | a late review or dispatch event for a closed scope |
| GF-CLOSE-5 | each step is its own dispatch: the orchestrator records `gf.dispatch.recorded` (role, step, tree, inputs with their hashes) before the review; inputs are relative project files that are not under the working record; a review cites its dispatch, and is of that role, that step, that scope and that tree; one dispatch carries one review | a review without a dispatch; a dispatch reused for a second review; a dispatch for another role or step; a dispatch listing `.eccode/handoffs/` |

**What the engine cannot see (a named limit, L-GF-19).** Independence is **role-level and record-level**: a reviewer role that authored nothing in the record. The engine cannot tell two instances of the same role apart, so "a fresh agent with no context" is the orchestrator's dispatch, which the engine cannot read (the same out-of-band channel as L-GF-4). My own bypass tests are not an independent pass, and the rule gives no way to record them as one: a review is recorded only under a reviewer role, and that holds while the controls of L-GF-17 hold (18.3): over MCP the role-locked server sets the actor, over `eccode-gf` the `--actor` argument does, which the hook checks as text.

**The closing round, stated once.** The closing tree needs, for each step, a valid review of that step on that tree (verdict values: comprehension and critique `clean` or `findings`, readiness `go` or `no-go`), readiness `go`, and every finding of every review of the scope resolved by a valid resolution. A fixed finding changes the tree, so a closing round cannot carry one: a round whose findings are fixed is followed by another round on the fixed tree, and rounds repeat until one round on one tree passes. A finding withdrawn or deferred leaves the tree as it is. Only records that pass their own checks count (a forged review, resolution or battery stands in for nothing).

**A valid review, stated once.** Every review has a summary of 100 characters or more and cites its dispatch. A comprehension or critique review has the verdict `clean` with no finding or `findings` with at least one; each finding is `{id, severity, kind, summary}` with severity `blocking`, `major` or `minor`, and the kind is fixed by the step (comprehension: `documentation`, critique: `defect`; a mismatch is refused). A readiness review has the verdict `go` or `no-go`, no finding, and at least one citation. A readiness summary may name residuals: they are not findings and need no resolution (round 3's residual was one, and it was enforced in code as D3-1).

**Who closes, and what authoring means.** The orchestrator or the user commits `gf.slice.closed`. "Authored work" means a task claim, a task completion or a gate submission under that role; amendments, resolutions, pins and messages are not authoring. A finding is withdrawn only by the reviewer role that raised it; a deferral is the user's, for a minor finding or a major documentation finding, and names a limit id that the engine does not check against the register (a named residual).

**Definitions.** A **fix-verify** is the frozen engine's fix verification (`eccode fix verify`, the `fix_verify` tool): it runs one command in a worktree at the base commit with the changed tests copied in, where it must fail with an assertion (recorded with `purpose: reproduction`), then on the fixed tree, where it must pass; the post-fix evidence cites the pre-fix one (`fixVerify.preFix`), so both runs are one command by construction. A documentation defect has no source change for a fix verification to run on, so it is proven by a **paired run**: one command (normally a test of the document), recorded with `eccode evidence run --purpose reproduction` while it fails, then recorded again after the fix while it passes. Either way one proof proves one finding. For a paired run the engine checks that the two commands are equal once whitespace is normalised, that the reproduction failed and was recorded with `purpose: reproduction` after the finding's review, that the proof passed after it, and that both precede the resolution; it does not check that the failure was an assertion, nor that the command is a test of the finding: the orchestrator chooses it (L-GF-30). As to trees (after the round-3 review), a paired run has no tree condition of its own: the engine orders the two runs against the finding's review and the resolution, but an evidence run records no tree, so which tree each run saw is not recorded (L-GF-28). What ties the fix to a new tree is the closing-round condition: a closing round cannot carry a fixed finding, so the fixed document is judged on a later round's tree. As to kinds, a paired run is accepted only for a finding of kind documentation (a defect needs a fix-verify), and the kind follows the step: comprehension findings are documentation, critique findings are defects. A fix-verify's base commit must have the tree the finding was raised on.

**Records, stated precisely.** A dispatch input under the implementers' working record is refused by path: `.eccode/drafts/`, `.eccode/handoffs/`, `.eccode/memory/`, `.eccode/runs/`, `.eccode/lab/`, `.eccode/improvements/`, `.eccode/events.jsonl`, `.eccode/state.json` (the tree itself still carries the authors' documents and their conclusions: L-GF-23); an input is judged where it lands, through a symlink or a hard link included (D2-4, E2-6). The orchestrator records a dispatch with `eccode-gf close dispatch` (MCP `gf_dispatch_record`); the engine hashes each input file when the dispatch is recorded, so the hashes record what was given at dispatch time (they are not compared with the tree later). A readiness review needs at least one citation; a `path:line` resolves when that file exists in the review's tree and has that line (1-based); an `ev:<id>` resolves when that evidence exists, precedes the review and has status `passed` (a command that passed) or status `recorded` (the mutation tool's evidence), the frozen engine's status for evidence with no pass-or-fail outcome, which a recorded file also carries; a no-go may also cite one with status `failed`. The proof, not the actor, carries a fix, so any actor may record a fixed resolution; withdrawals and deferrals are restricted as in GF-CLOSE-2. As to ids, finding ids are unique across the whole record (a repeated id is refused), and a resolution names one. The battery event lists survivor keys only; the reasons are in `gf.slice.closed.accepted`. The reviewer roles: amendments of contracts and of the ownership map use the reviewers of the design, verification and phase gates (`config.roles.{design,verification,phase}.reviewers`); a closure step may be recorded by the reviewer of any gate (`config.roles.*.reviewers`, which adds `architecture-reviewer`). A role's group: the map's roles come from the sealed breakdown's `groups[].roles` (3.2's single `role` became a list), while the hook and the message rules name a role's group from the constants (`C.groupOf`); GF-WBS-1 refuses a breakdown whose roles disagree with the constants, so the two agree in a sealed project.

**Three things are called a battery.** (1) The bypass battery B1 to B5 of section 8 is a set of test rows. (2) The engine battery of GF-CLOSE-3 is a pinned mutation run, `eccode-gf close battery --scope <s> --test <command> --base <commit> [--max <n>]`: the frozen mutation tool mutates lines changed since `base` (at most `max`, 25 by default; S2's batteries used `--max 20`) and runs `test` per mutant; there is no kill threshold, but every survivor of the last battery needs an accepted reason at close, because a test that kills a survivor changes the tree, and so needs a new last battery on the new tree (and the round's reviews on it). The battery that GF-CLOSE-3's conditions on the last battery judge is the last valid battery recorded for the scope; the event's `round` field is the orchestrator's label and is not checked. (3) the rule-removal battery, my own scratch script that removes one rule id at a time, is extra evidence about my tests and does not satisfy GF-CLOSE-3. "At least two failing tests per rule" is what I expect of my tests, not a rule.

**Clean tree.** `git status --porcelain --untracked-files=all` is empty outside `.eccode/`, run with `status.showUntrackedFiles=all`, `core.fsmonitor=false` and `core.untrackedCache=false` forced so that the repository's own git configuration cannot hide a change (round 3, D2-2), and no tracked file outside `.eccode/` is marked skip-worktree or assume-unchanged (round 2, C2-2): tracked changes and untracked files that are not ignored count as dirty; `.eccode/` holds the record and is excluded, and the guard configurations inside it are covered by GF-CONF-1, not by the tree check.

**Tree identity.** The `treeHash` of a dispatch, a review, a battery and a closure is the commit's tree object, `HEAD^{tree}`, which contains every tracked path: the tree hash still includes the tracked `.eccode/` files, in a repository that tracks any. Only the clean-tree check excludes `.eccode/`; a working-tree change under `.eccode/` does not make the tree dirty and does not change the tree hash. A closure is a record of the tree it names: a later commit does not undo it, but slice integration (S4) and DONE (S5) judge the current tree, and "no commit after it other than evidence" is my discipline, not an engine check.

**How S2 itself is closed.** By the rule itself (stated as done, after the round-3 review). S2's Greenfield-Senior record was initialised at the start of round 1 inside a separate checkout of the build tree (a `git worktree` of the build commit), before battery 1. The checkout is then moved from commit to commit, each fixed commit checked out in place with the record staying in its `.eccode/`, so battery 1 and round 1 ran on the build tree, each later round on its fixed tree, and the closing round and the last battery run on the final tree, all in one record: the record lives in the checkout it closes, and `HEAD^{tree}` is always that checkout's. This repository tracks an `.eccode/` of its own: in the checkout those tracked files are moved aside and replaced by the record before `eccode-gf init`, a working-tree change under `.eccode/` that the clean-tree check excludes (the tree identity, above, still includes the commit's tracked `.eccode/` files). The record is new, and in a fresh record the authorship condition holds trivially, because the build's claims and completions are not in it: independence is shown there only by the dispatches and the reviewer roles.

### 18.6 Accounting protocol, as built

- **Unit (registered now): all processed tokens** = `input_tokens + output_tokens + cache_read_tokens + cache_write_tokens`, cumulative since session start, as reported by the harness (`get_session` `external_metadata.usage`). Output tokens are reported beside it, informational.
- **Snapshots:** at slice start and slice end, the same call. A delegated agent's figure is what its completion notice reports (`subagent_tokens`, `tool_uses`, `duration_ms`); whether the cumulative session figure already includes those tokens is **unmeasurable** (the harness does not say).
- **Per round (the owner's decision of round 5):** a snapshot at the start and at the end of each review round. A snapshot identical in every usage field to the one before it, while `context_usage` has moved, is stale, and the figure it would give is written `unmeasurable`. S2's rounds 1 to 4 are `unmeasurable` that way (the interim snapshots of 17:49Z and 18:32Z were stale); S2 to the end of round 4 is measured, 266,435,563 all processed tokens (15:17Z to 19:13Z). Round 5 has its own cap, 100 M (the owner's decision).
- **Ledger:** one row per slice and one per delegated agent, in `docs/build/compute-ledger.md`. A cell the harness cannot give says `unmeasurable`.
- **Enforced where an engine record exists:** GF-CLOSE-4. GF-CLOSE-4 checks the form of the numbers, not their truth: the figures are the closer's, copied from the harness.
- **Delegated agents.** The figure is `subagent_tokens` from the completion notice; its unit is not stated by the harness (whether it includes cache reads and writes is unmeasurable), so ledger rows say "as reported", and a resumed agent's several notices are each recorded, since whether they are cumulative is not stated either.
- **A counter reset** is visible only as an `end` below its `start`; the difference is then written `unmeasurable`, and both snapshots stay recorded as numbers. A reset that later use hides behind a larger `end` is not detectable (L-GF-26).
- **Cost** is the harness-reported `cost_usd` of the same call, a measurement; D6's "no dollar figures" is about estimates.
- **S1, restated in this unit.** No S1-start or S1-end snapshot was taken. Two cumulative snapshots exist: 01:17Z on 2026-11-04 (recorded in the S1 evidence) and the S2-start snapshot below. Differences of two harness snapshots are measured; anything finer is unmeasurable.

| Snapshot | Taken | Input | Output | Cache read | Cache write | **All processed** | Cost |
|---|---|---|---|---|---|---|---|
| 01:17Z, 2026-11-04 (G0 plus the S1 build) | recorded in S1 evidence | 172 | 155,778 | 18,300,440 | 743,276 | **19,199,666** | $5.74 |
| S2 start, 2026-11-07 15:17Z (G0 plus all of S1, before any S2 work) | `s2-usage-start.json` | 2,704 | 669,298 | 127,190,368 | 1,631,247 | **129,493,617** | $24.70 |
| difference (the S1 review, fix, verification and documentation phase) | | | | | | **110,293,951** | $18.96 |

In the unit the owner has now fixed, **G0 plus S1 consumed 129.5 M processed tokens, of which 98.2 percent were cache reads**; S1's registered range was 4 to 8 M. The estimate was off by a factor of 16 to 32 in this unit (and the unit was ambiguous when I registered it, which I reported). The review, fix and verification phase used 5.7 times what G0 and the build had, because the context grew with every turn that re-read it. That is the lesson for S2's estimate (16.7): cost follows turns times context, not lines written.

### 18.7 Deviations from the pre-build design

| Item | As designed | As built |
|---|---|---|
| GF-OWN-4 | 4.2 listed the audit | a function and `eccode-gf attribute` / `gf_attribute`; the audit joins in S4 with `gf.slice.opened` (18.1) |
| GF-OWN-3 | the completing actor's group | also the task's owner: a completion by an actor that is not the task's owner is reported (review round 1, R1-6) |
| GF-CONF-1 | `gf.slice.opened.configHashes` (S4) | `gf.config.pinned` now; S4's slice open calls the same pin |
| Closure | one closing review (18.5) | three recorded steps with their dispatches (17.2), GF-CLOSE-5, a paired-run proof for documentation findings, `eccode-gf close status`; one proof per finding and a battery tied to its own run (review round 1, R2-1 and R2-2); only valid records count |
| Preflight | "report, as a recorded fact and not an assumption" (16.4 F0 before round 1) | computed from the current settings each time; not a log event (18.3, F0) |
| Closure, round 2 | (none) | a fix proof is of the reviewed tree and a fixed finding needs a new round (C2-1); index flags that hide a change count as dirty (C2-2); the audit never throws on unreadable settings (C2-3); a symlink in the drafts namespace is judged where it lands (C2-4); the hook models `ln`, `install`, `dd of=`, in-place `perl` and `ruby`, `touch`, `patch`, and a subagent's `git checkout --` and `git restore` (C2-5); a no-go may cite a failed check |
| Closure, round 3 | (none) | an absolute path that leads into the project by another route (`/proc/self/root/...`) is judged as the project path it is (D2-1); the clean-tree check forces its own git configuration (D2-2); a readiness no-go on the closing tree stands (D2-3); a dispatch input is judged where it lands, through a symlinked directory too (D2-4); the audit's S2 sections are isolated, so one malformed event does not stop the others (D2-5); a closing review recorded by the closer does not count, whatever the configuration names as reviewers (the readiness reviewer's residual, D3-1) |
| Shell | the hook judged a group role's shell writes on the command text (C2-5, D2-1; round 4, E2-1 to E2-4 were further forms) | a group role has no shell in a Greenfield-Senior project (GF-RUN-1), and its commands run through the runner (GF-RUN-2): the owner's decision of round 5 (18.4) |
| Closure, round 4 | (none) | GF-OWN-4 attribution sees both names of a rename (E2-5); a dispatch input or a file-tool target with more than one hard link is refused (E2-6, E2-2); the clean-tree check reads only the tree's own `.gitignore` files (E2-7); the preflight reads hooks switched off in the project settings (E2-8); the user may defer a major documentation finding (the owner's decision of round 5) |
| Survivors | none planned | the first engine battery left three survivors (a NUL in a path, a command-only rescope, a proof recorded after its resolution); each got a test. The second (tree `f7b3db2`) left two: `additionalProperties: false` on the dispatch inputs' items flipped to true, now killed by two tests in `tests/gf-events.test.js` that check every nested closed object of the schemas; and `\|\|` flipped to `&&` in the rescope check's early return, which the test of a rescope of an unknown task kills on the round-3 tree (checked by applying the mutant by hand). The third (tree `faa7031a`, 19 of 20 killed) left one: `name === 'ruby'` flipped to `!==` in the hook's in-place-writer branch, which drops `ruby -i` as a writer and takes any other command with an `-i` flag (`grep -i`) for one; now killed by a `ruby -i` row and three read rows in `tests/gf-review-s2-c2.test.js`. The mutation tool picks its mutants from the changed source lines only (test files excluded), evenly spaced, so a tree that adds only tests is mutated in the same 20 places. The fourth (tree `bceec2c`) killed 20 of 20. The fifth (tree `19affb9`, after round 5's fixes, whose new source lines moved the picks) killed 16 of 20: `closure.js:80` (the seq label of a dispatch problem), `events.js:104` (`additionalProperties` on the closure's `accounting`, which the schema walker could not see, so its list is now fixed) and `guard.js:121` (`ln` with one argument) got tests; `closure.js:160` (`<` to `<=` between two seqs) is equivalent, since no two events share a seq, and is accepted with that reason at close |

Predictions P4 to P7 are scored in the evidence file, read this way after the three-step split: a pass is a review round; its code defects are its critique step's findings (kind `defect`), the second pass is round 2, and P7's closing round is every round after round 1.
