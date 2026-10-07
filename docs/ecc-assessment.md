# ECC Assessment and Implementation Recommendation

**Subject:** [affaan-m/ECC](https://github.com/affaan-m/ECC) v2.2.3, commit `ef648e01899ba3e8dc6371642deaaf64b4477775` (2026-10-01), MIT license.
**Method:** I cloned the repository read-only and had three parallel research passes cover different areas (definitions and packaging, hooks and memory, orchestration and verification). Then I spot-checked the load-bearing claims myself with `grep` and `sed` against the source.
**Date checked:** 2026-10-07.

All paths are relative to the ECC repository root. **ECC capability** marks what exists in ECC today. **ECCode addition** marks what this toolkit adds.

---

## 1. How ECC defines its building blocks

| Building block | ECC mechanism | Evidence |
|---|---|---|
| **Agents** | 68 Markdown files with YAML frontmatter (`name`, `description`, `tools`, `model`), followed by a role prompt. Core agents share a "Prompt Defense Baseline" preamble. | `agents/planner.md`, `agents/code-reviewer.md` (frontmatter lines 1–6), `agents/security-reviewer.md` |
| **Skills** | 293 `skills/<name>/SKILL.md` directories with `name`, `description`, `metadata.origin`. A few also ship `scripts/`, `references/` or `agents/` folders. | `skills/tdd-workflow/SKILL.md`, `skills/continuous-learning-v2/` |
| **Commands** | 94 `commands/*.md` files with `description` (and optionally `argument-hint`) frontmatter that take `$ARGUMENTS`. 12 retired commands live in `legacy-command-shims/`. | `commands/plan.md`, `legacy-command-shims/README.md` |
| **Rules** | `rules/common/*.md` plus per-language directories scoped by `paths:` frontmatter. They are installed by copying into `~/.claude/rules/ecc/` and **cannot ship through a Claude Code plugin**. | `rules/typescript/coding-style.md`, `rules/README.md`, `README.md` (~line 298) |
| **Hooks** | `hooks/hooks.json` dispatches through `scripts/hooks/run-with-flags.js` with profiles (`minimal`/`standard`/`strict`) and kill switches (`ECC_HOOKS_ENABLED`, `ECC_DISABLED_HOOKS`). | `hooks/hooks.json`, `scripts/lib/hook-flags.js` |
| **Session memory** | Markdown `*-session.tmp` files in `~/.claude/session-data/`, parsed back with regexes. SessionStart injects the latest one wrapped in a "HISTORICAL REFERENCE ONLY" guard. | `scripts/lib/session-manager.js`, `scripts/hooks/session-start.js`, `commands/save-session.md` |
| **Learning ("instincts")** | Hooks append tool observations to JSONL. An optional Haiku observer loop writes instinct files with an LLM-assigned `confidence`. Instincts at ≥0.7 are auto-injected at SessionStart. | `skills/continuous-learning-v2/hooks/observe.sh`, `skills/continuous-learning-v2/agents/observer-loop.sh`, `scripts/hooks/session-start.js` (line 37: `DEFAULT_INSTINCT_CONFIDENCE_THRESHOLD = 0.7`) |
| **State store** | A sql.js (SQLite/WASM) store at `~/.claude/ecc/state.db` with tables `sessions`, `skill_runs`, `decisions`, `work_items`, among others. | `scripts/lib/state-store/`, `schemas/state-store.schema.json` |
| **Packaging** | `.claude-plugin/plugin.json` + `marketplace.json` (source `./`). Agents and hooks are discovered by convention, not declared. There is also a selective installer with 38 modules and 7 profiles. | `.claude-plugin/PLUGIN_SCHEMA_NOTES.md`, `manifests/install-modules.json`, `scripts/install-apply.js` |

## 2. How ECC coordinates plan → implement → review → verify

- **Planning:** `commands/plan.md` runs inline: restate requirements, identify risks, write a step plan, then wait for the user's confirmation. The `orch-*` family (`skills/orch-pipeline/SKILL.md`) adds a size classifier and the phases Intake → Research → Plan → **GATE 1** → Implement (`tdd-guide`) → Review (`code-reviewer`, `security-reviewer`) → **GATE 2** → Commit. Line 78 states: *"This family is gated, not autonomous."*
- **The gates are honor-system:** nothing in code checks that GATE 1/2 happened. `commands/orch-add-feature.md` says "Honor both gates."
- **Review:** `commands/code-review.md` is a decision table ("Any CRITICAL issues → BLOCK") that the model applies to itself. `commands/santa-loop.md` asks for two independent reviewers, but only as a prompt rule.
- **Verification:** `skills/verification-loop/SKILL.md` is a six-phase checklist ending in READY/NOT READY. The code-level eval gate is deliberately disabled: `scripts/lib/eval-harness/gate.js:176` throws *"Candidate execution is disabled: no verified OS containment backend is implemented."*
- **Executable orchestration is narrow:**
  - `scripts/lib/tmux-worktree-orchestrator.js` creates worktrees and tmux panes from a JSON plan, without sequencing, gates or retries.
  - `scripts/gan-harness.sh` is a real planner/generator/evaluator loop with an iteration cap and a score threshold.
  - `workflows/orch-review.workflow.js` is a pilot parallel-review Workflow that fails closed on unverifiable CRITICAL findings.
  - `ecc2/` is a ~54k-line Rust control plane, self-described as **alpha** (`ecc2/README.md` line 5). It contains the only budget enforcement in code (`enforce_budget_hard_limits`). No CI workflow builds or tests it.
- **Blocking hooks:** `scripts/hooks/gateguard-fact-force.js` (line 1822, `permissionDecision: 'deny'`), `block-no-verify.js`, `config-protection.js` and `pre-bash-commit-quality.js`. All of them guard *tool use*. None of them guard *stage transitions*.
- **Author ≠ approver** is not enforced anywhere. Independence comes only from running separate subagents.
- **Handoffs** have several Markdown shapes:
  - `## HANDOFF:` (the original orchestrate format, now kept only in translations such as `docs/pt-BR/commands/orchestrate.md`)
  - the tmux worker `handoff.md` (`scripts/lib/tmux-worktree-orchestrator.js:145`)
  - the Codex worker "Summary / Files Changed / Validation / Remaining Risks" format (`scripts/orchestrate-codex-worker.sh`)

  None of them is schema-validated.

## 3. Reuse decision per component

| ECC component | Decision | Rationale |
|---|---|---|
| Agent/skill/command file formats | **Reuse the convention** (it is Claude Code's native format) | Standard Claude Code formats, so no ECC code is needed. |
| Prompt Defense Baseline idea (`agents/*.md` preamble) | **Adapt** | ECCode puts a shorter, role-specific untrusted-input clause in each agent and enforces the important parts in code (schema-validated reviews, evidence checks). |
| `orch-pipeline` phase/gate structure | **Adapt and enforce** | The idea of gates after planning and before commit is sound. ECCode turns each gate into an engine state transition that **refuses** to advance without an independent, evidence-backed approval. |
| `santa-loop` dual review / `orch-review.workflow.js` "fail closed" principle | **Adapt** | Becomes code-level rules: approval with unverifiable evidence is rejected, and approval with open blocking findings is rejected. |
| Hook profiles / kill switches (`scripts/lib/hook-flags.js`) | **Simplify** | ECCode ships 3 hooks (resume context, identity/ownership guard, stop reminder) and one `ECCODE_HOOKS=off` switch. |
| Session `.tmp` Markdown memory | **Replace** | Replaced by a hash-chained JSONL event log with a rebuildable snapshot, so resume is deterministic and needs no regex parsing. |
| Instincts / continuous learning v2 | **Replace** | ECCode lessons need captured reproduction evidence, executed verification, a reviewer who is not the author, explicit applicability conditions and revision history. Confidence comes from review status, not from an LLM-written number. |
| sql.js state store | **Replace** | A zero-dependency JSON/JSONL store is enough at this scale, readable in diffs and has no WASM dependency. |
| 68 agents / 293 skills catalogue | **Do not import** | Scope: ECCode needs 12 well-specified roles. The large ECC catalogue is a complement, not a base (see §5). |
| Selective installer (`manifests/`, 38 modules, 17 targets) | **Simplify** | ECCode needs one plugin plus a project-local copy installer. |
| `ecc2` Rust control plane | **Do not use** | It is alpha, untested in CI, and solves a different problem (a session TUI). |

## 4. ECC limitations that matter for this toolkit

1. **Gates are advisory.** Stage gates, review decisions and "do not proceed until validated" rules are prompt text (`skills/orch-pipeline/SKILL.md`, `commands/code-review.md`, `commands/multi-plan.md` "Stop-Loss Mechanism"). A model can skip them silently.
2. **No separation of duties.** Nothing stops the author of an artifact from approving it.
3. **Learning is not evidence-gated.**
   - Instinct confidence is written by the LLM (`observer-loop.sh`).
   - The decay and contradiction rules exist only as prompt text in `agents/observer.md`; grepping the code for `decay` finds nothing.
   - Instincts are auto-injected at ≥0.7.
   - The memory vault schema allows only `"trust": "unreviewed"` (`schemas/memory.schema.json`).
   - Updates overwrite files, so there is no supersession history for instincts.
4. **Handoffs are unvalidated Markdown** in several incompatible shapes.
5. **Budget, concurrency and iteration limits** are enforced only in the alpha `ecc2/` (`ecc2/src/session/manager.rs:1177`). Elsewhere they are prose (`agents/loop-operator.md`).
6. **Maintenance load.**
   - About 2,790 Markdown files and about 82k lines of JS in `scripts/`.
   - Four overlapping orchestration systems, some needing external runtimes (`ccg-workflow`, DevFleet).
   - Docs and code have drifted: instinct storage paths differ between `commands/promote.md:41` and `scripts/instinct-cli.py:54-67`, and `checkpoint.md` still calls the retired `/verify`.
7. **Rules cannot be distributed through the plugin** (`README.md` ~line 298), which matters for any review rules we want enforced.

## 5. Recommendation: independent implementation, ECC-inspired, ECC-compatible

| Option | Pros | Cons |
|---|---|---|
| **Extension** (an add-on plugin on top of ECC) | Users keep ECC's catalogue. | Depends on ECC's plugin surface and naming (`ecc:`), which churns (legacy shims, renamed commands). Our core value, code-enforced gates, needs no ECC code at all. |
| **Fork** | Starts from everything. | Inherits ~85k lines of JS/Rust, 13 locales, per-harness mirrors and CI count checks we would never use. Every upstream sync becomes a merge burden. The core problem (advisory gates) sits in ECC's architecture, not in a missing file. |
| **Independent implementation** ✅ | Small, auditable core. Zero runtime dependencies. Gates enforced in code. Its own memory model. | We re-create role prompts rather than inheriting ECC's, and must credit ideas we adapt. |

**Decision: independent implementation.** ECCode is a separate, MIT-licensed toolkit that:

- **adopts Claude Code's native formats** (agents, skills, commands, hooks, plugin manifest), which ECC also uses;
- **adapts ECC ideas** (gated pipeline phases, dual-review, fail-closed review, prompt-defense preamble, project-scoped learning, hook kill switch) and credits them in `NOTICE`;
- **coexists with ECC**: its agent names do not collide with ECC's, and ECC's language reviewers can be listed as extra reviewer roles in `.eccode/config.json` (`roles.*.reviewers`);
- **copies no ECC source files.** If code is copied in future, the MIT license requires keeping ECC's copyright notice, and `NOTICE` already carries it.

## 6. ECC capabilities vs ECCode additions

| Capability | ECC today | ECCode |
|---|---|---|
| Agent / skill / command definitions | ✅ Large catalogue | 12 focused roles, 7 skills, 6 commands |
| Pipeline stages | Prompt-level (`orch-pipeline`) | **Engine state machine.** A stage cannot start until its predecessor gate is approved. |
| Independent review | Advised (`santa-loop`) | **Enforced.** A reviewer who is any author or task owner of the gate is rejected. The reviewer role is checked against `config.roles`. |
| Evidence-backed approval | Not checked | **Enforced.** Every criterion must cite resolvable evidence. Implementation and verification approvals need a passing command the *reviewer* executed after the latest submission. Stale artifacts are detected by SHA-256. |
| Re-review of fixes | Not tracked | **Enforced.** An approval must resolve every earlier blocking or major finding. |
| Review-iteration limit / escalation | Prose | **Enforced.** After N rejections the gate escalates with a recovery report, and only `user` can reopen it. |
| Handoffs | Several Markdown shapes | **JSON-schema validated**, with the fields the brief requires and evidence IDs that must resolve. |
| Resume / interruption | Session `.tmp` summaries | **Event-sourced log.** Replay is deterministic, the hash chain detects tampering, interrupted runs are detected and claims released. |
| Concurrency / ownership | Worktrees (tmux) | **Ownership globs.** Overlapping claims are refused, there is a concurrency cap, and a PreToolUse guard blocks edits outside the claimed scope. |
| Budgets / retries | `ecc2` only (alpha) | **Enforced** runtime, cost and retry limits, configurable per project. |
| Learning memory | LLM-scored instincts, auto-injected | **Four layers.** Lessons need reproduction and verification evidence plus a non-author review, keep revision history and supersession, carry environment applicability checks, are retrieved as evidence (never as instructions), and go through sanitized promotion. |
| Self-improvement | `evolve` generates skills | **Proposal → evaluation (before/after) → independent review → versioned adoption with rollback.** Protected paths (permissions, approval rules) can never be changed this way. |
| Metrics | Cost tracker, skill-run tracker | Review rejection rate, repeat-bug frequency, time to verified fix, recurrence, workflow-change regressions |

## 7. Licensing and attribution

- ECC is MIT (`LICENSE`, "Copyright (c) 2026 Affaan Mustafa"). MIT permits use, modification and redistribution as long as the copyright and permission notice are included with copies or substantial portions of the software.
- ECCode copies **no** ECC source or prompt text. It re-implements ideas. Ideas are not covered by copyright, but crediting the inspiration is good practice and is done in `NOTICE` and the README.
- If a later version copies ECC files (for example a language-reviewer agent), it must keep ECC's MIT notice next to them. The `NOTICE` file already contains it so that requirement is easy to meet.
