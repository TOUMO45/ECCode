---
name: orchestrate-greenfield
description: Lead-orchestrator playbook for a Greenfield-Senior project, G1 (the thinking pipeline). Takes one idea through PRD and architecture, contracts and threat model, work breakdown and estimates, each approved at the existing architecture, design and plan gates and then sealed by hash. Use when the user asks to build a new product from one idea with the ECCode greenfield team.
argument-hint: "<product idea> | resume"
---

# Greenfield-Senior, G1: from one idea to a sealed plan

You are the lead orchestrator. This playbook extends the `orchestrate` skill for projects started with `eccode-gf init`; everything in `orchestrate` about real subagents, run accounting, headless mode and the user's authority still applies. This one covers what G1 adds.

**Enforcement, in the words to use with the user:** prevention on the managed (MCP) path plus guaranteed detection by log-replay audit in all profiles. The plain `eccode` CLI is outside the layer; `eccode-gf audit` (the `gf_audit` tool) finds anything committed through it.

## 0. Start
`eccode-gf init --name "<name>" --idea "<idea>"` (stack profile `python-fastapi-sqlalchemy-sqlite`, the only one in v1). Then `gf_status`. Never present a non-FastAPI stack as able to reach DONE: it can be built, it cannot be declared done (limit L-GF-2).

## 1. Ambiguity first (DECLARED_ASSUMPTION)
Before the architecture is written, list what the idea leaves open and record each question: `request_ambiguity`. Headless, give each non-blocking question its reasonable `reading` so it becomes a recorded assumption and work continues; a blocking question stops planning until it is assumed or the user answers. The PRD must carry an `ambiguityScan` that lists every recorded question, so a guess cannot be silent. The delivery report prints each as DECLARED_ASSUMPTION.

## 2. The three gates (each: start, author, dry run, submit, independent review)
For each of `architecture`, `design`, `plan`: `gate_start`; dispatch the author; have the author run **`gf_validate`** on the artifacts before `gate_submit` and fix every rule id it reports; then dispatch the independent reviewer. A submission that breaks a rule is refused with the rule id and commits nothing.

| Gate | Author submits | Reviewers |
|---|---|---|
| `architecture` | `prd.json` (problem, users, scope, non-goals, `ambiguityScan`, criteria each with a machine-checkable `verify`) and `architecture.json` (components, data flow, technology choices). Each choice has at least two alternatives and its own recorded design decision with an ADR (`design_alternatives`, `design_decide`, `design_adr`) before submission | `architecture-reviewer` |
| `design` | `contracts/openapi.json`, `db-schema.json`, `migrations-plan.json`, `access-matrix.json`, `fixtures.json` (and optionally `events.json`), plus `threat-model.json` | start with `--reviewers technical-reviewer,security-reviewer`: both approve the same submission |
| `plan` | `plan.json` for the walking-skeleton slice, `breakdown.json` for every slice (groups, ownership globs, tasks, estimated lines), `estimates.json` (per group, labelled `agent-estimate-uncalibrated`) | `technical-reviewer` |

Open questions that change the outcome go to the user together, once; headless, they are recorded with their readings.

## 3. The seal
When the plan gate is approved the engine registers the estimate and seals G1: one hash over the PRD and the contract files, and a content-addressed snapshot of each contract. Nothing can be claimed or started in a phase before the seal. Check `gf_status`: `sealed: true`.

## 4. After the seal
- **Contracts are frozen.** A change is a recorded amendment: the group that needs it sends an `amendment-request` message to `api` (`gf_message_send`), files `gf_amend_request`, the api group edits the file, and a reviewer records `gf_amend_apply` with a reason of at least 30 characters. Never edit a sealed contract without that chain.
- **Groups talk only through messages** (`gf_message_send`); relay by message id, never by paraphrase in a dispatch.
- **Estimates:** the registered original is what is scored; `gf_estimate_revise` records a revision beside it.
- Run `gf_audit` at every phase boundary and before delivery; report its errors verbatim.

## 5. What G1 does not do
Write-time ownership by group, the generated mock server and contract tests, slices as work items and the done verification arrive in later slices. Say so when asked; do not imply them.

## 6. Failure handling
A refusal is a rule: read its id, fix the artifact, resubmit. After the review limit the gate escalates to the user as usual. Never edit `.eccode/` files, and never report a gate approved or a seal made unless `gf_status` or the record says so.
