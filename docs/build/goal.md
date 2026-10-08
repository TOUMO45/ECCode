# Goal: ECC Senior Web & AI Engineering Team

**Source:** the user's `/goal` directive of 2026-10-08, reproduced in requirement form below. The original text is in the session. This file only restates it in testable form; it does not weaken it.

Enhance ECC into a reusable multi-agent toolkit (ECCode) that turns ideas into verified web and AI applications through requirements, architecture, independent review, planning, implementation, testing and delivery. Show senior engineering judgment, persistent memory, systematic debugging and measurable learning.

## Requirements and acceptance criteria

| ID | Requirement | Observable acceptance (all must hold) |
|---|---|---|
| R1 | Installation | (a) Following `docs/usage.md` installs the plugin into a **clean** Claude Code config dir, and agents, skills, commands and hooks load. (b) `eccode init` initialises workflows and memory. (c) One documented entry point (`/eccode:start "<idea>"`) starts a project. (d) Concurrency, cost, runtime and retry limits are configurable and enforced. Proof: recorded install and a demonstration run. |
| R2 | Agent collaboration | Distinct roles for architecture, independent architecture review, technical design (frontend, APIs, backend, data, AI), independent technical review, delivery coordination, debugging/learning, plus implementation specialists. The record contains actual agent executions (runs), assignments, handoff inputs/outputs, decisions, unresolved issues and integration. Proof: a complete execution history. |
| R3 | Review gates | Every phase has acceptance criteria. Authors cannot be sole approvers. Reviewers inspect artifacts and evidence. Blocking findings are resolved before dependent work starts. Proof: an **intentionally** incomplete design and **intentionally** defective code are submitted, rejected, corrected and re-reviewed successfully. |
| R4 | Working application | Responsive frontend, backend API, **persistent database**, meaningful AI feature, validation, error handling, **access controls**, critical journey and integration tests, AI evals with thresholds fixed before implementation, setup instructions, verified reproducible local run. Scope agreed before building. All agreed criteria pass with no known blocking defect. Proof: app, reproducible checks, acceptance report. |
| R5 | Persistent memory | Requirements, decisions, tasks, reviews and lessons persist across sessions. Resume **checks recorded progress against actual files and test results**. Project memories are separated. Proof: interrupt a project and resume it in a **fresh session** without manual history reconstruction. |
| R6 | Verified learning | Each investigation records symptoms, environment, root cause, failed attempts, research sources, verified fix and applicability limits. Demonstrate: (1) a fixed bug with an independently reviewed lesson; (2) that lesson retrieved and correctly applied to a related problem **in a fresh session**; (3) the lesson **rejected** when similar symptoms have a different cause. Only validated lessons become skills or workflow changes, which are versioned, evaluated and reversible (rollback available). |
| R7 | Measured improvement | Before tuning: a fixed evaluation suite with numerical targets, and unfamiliar (holdout) tasks reserved for the final run. Compare **original ECC**, **ECCode without learning** and **ECCode with verified learning** with the same model, tools and budgets, over repeated trials. Measure success, repeated mistakes, regressions, human intervention, time and cost. Meet the predefined targets and disclose failures and tradeoffs. Proof: reproducible results showing whether orchestration and learning each add value. |
| FA | Final acceptance | Toolkit, source, docs, demo, evaluations, results and limitations are delivered. Every requirement is marked Passed / Failed / Unverified with evidence. All mandatory requirements must pass. |

## Assumptions (material, reversible)

- **Environment:** Linux container, Node 22.22, Claude Code CLI 2.1.294. Headless `claude -p` sessions work and report USD cost. There is **no** direct Anthropic API key (direct API returns 401). Live model calls therefore go through the Claude Code CLI.
- **Fresh session** means a new headless `claude -p` process with its own config dir and no access to this conversation.
- **Scope agreement for R4:** the user's goal text (R4 row) is the agreed minimum scope. The demo's architecture brief must contain every R4 item as an acceptance criterion. Any narrowing needs a recorded user decision.
- **"Original ECC"** means `affaan-m/ECC` at the commit assessed in `docs/ecc-assessment.md` (`ef648e01…`), loaded unmodified as a plugin.
- **Spend:** model usage in eval trials and the demo build is required by R4 and R7. Every run carries a hard `--max-budget-usd` cap, and the totals are reported.

## Non-goals

- Claims of general intelligence (the goal requires separate evidence for those).
- Native Codex/Gemini agent mirroring.
- Cloud deployment. A verified reproducible local run satisfies R4.
