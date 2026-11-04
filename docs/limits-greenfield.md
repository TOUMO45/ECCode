# Limits register: Greenfield Senior layer

These limits belong to the additive greenfield layer (`lib/greenfield/`, `bin/eccode-gf.js`). Their ids are placeholders (`L-GF-n`) on purpose: the main register `docs/limits.md` is not edited by this line of work, because the `claude/v3-generalization-fastapi-*` line edits it too (it already claims row 186), and reconciling the two is the owner's task. Dispositions are the register's: **Open, named** (the limit remains and the tool reports it), **Open, mitigated** (the limit remains and its containment is named), **By design**.

Enforcement wording used everywhere in this layer: **prevention on the managed (MCP) path plus guaranteed detection by log-replay audit in all profiles.**

| Id | Limit | Disposition | Slice |
|---|---|---|---|
| L-GF-1 | The layer is additive: the 48 files of the frozen v3 set are not edited, so the plain `eccode` CLI cannot refuse a Greenfield-Senior rule. The layer gives prevention on the managed (MCP) path plus guaranteed detection by log-replay audit in all profiles; a hook adds best-effort write-time checks where the harness runs hooks | Open, mitigated | S1 |
| L-GF-2 | Stack profile v1 is Python / FastAPI / SQLAlchemy / Alembic / SQLite. Other stacks can be built and tested but cannot reach DONE in v1, because the security, api, perf and behavior guards operate on FastAPI only | Open, named | S1 |
| L-GF-3 | Sub-agents of a group share the group's role id and are not individually identified | By design | S2 |
| L-GF-4 | `.eccode/drafts/**` stays a shared scratch area, and the orchestrator's dispatch prompt stays an out-of-band channel | Open, named | S2 |
| L-GF-5 | The mock server is stateless; multi-step flows are verified against the real backend at integration | Open, named | S3 |
| L-GF-6 | The contract-test and artifact validators implement a stated JSON-Schema subset (`lib/greenfield/jsonschema.js`); an unsupported keyword is reported, never ignored | Open, named | S1 |
| L-GF-7 | "Hidden" acceptance tests are write-denied and hash-sealed; read-denial depends on the harness running hooks on Read | Open, mitigated | S3 |
| L-GF-8 | The engine cannot detect an undeclared guess, only make a declared one impossible to omit from the report and the ambiguity scan mandatory | Open, named | S4 |
| L-GF-9 | Per-slice design and plan gates are overhead the `feature` track imposes; their measured cost is reported after S4 | Open, named | S4 |
| L-GF-10 | DONE criterion 3 needs a Docker daemon; without one the project is `NOT DONE: deployment unverifiable here`. A process-level E2E (uvicorn from a clean checkout plus smoke probes) is recorded as secondary evidence and never upgrades the status | Open, named | S5 |
| L-GF-11 | "Behavior diff clean" means no *detected* change: the behavior diff v3 detected 27 of 57 seeded changes (47.4 percent, exact 95 percent interval 34.0 to 61.0) | Open, named | S5 |
| L-GF-12 | Estimates are agent predictions from a single project; no calibration claim until several projects | By design | S4 |
| L-GF-13 | A v4 freeze that absorbs the greenfield layer is deferred until after S5 is stable and has not been started; until then the plain `eccode` CLI is outside the layer | Open, named | S1 |
| L-GF-14 | The cross-file consistency of an *amended* contract bundle (for example a new operation without its access-matrix cells) is checked at slice integration (S3), not at amendment: an amendment is validated per file, and the approved bundle is re-validated at its sealed bytes from the snapshots | Open, named | S1 |
| L-GF-15 | Between the edit of a sealed contract and the phase review that approves its new bytes, the frozen audit reports the file as modified after approval (its own rule, unchanged); the amendment event explains the change, and the layer's audit stays clean | Open, named | S1 |
| L-GF-16 | A Greenfield-Senior project starts with `eccode-gf init`; an existing ECCode project cannot be adopted in v1 | Open, named | S1 |
