# What happens after Stage 1: the direction rule, written before any result (2026-11-11)

This file edits nothing in the plan or its addenda. Plan section 10.3 describes three outcome patterns and says
"no direction is chosen here". This file chooses, **before any arm has run**, so the choice cannot be fitted to the
result. Owner instruction of 2026-11-11: run Stage 1 once; if it shows parity again, stop adding gates and either
thin the orchestration or reposition as a verification layer; keep a lightweight path.

## In force now, until a Stage 1 report exists

- **Feature freeze on the engine.** No new gate, role, stage or orchestration feature. Allowed: defect fixes,
  measurement tooling, documentation. Reason: the repository records about nine comparisons with a plain agent at
  parity and 3-54x cost (`docs/final-report.md`, `docs/limits.md:11`, `docs/build/gf-s3-evidence.md`). Evidence is
  what is missing, not features.

## After Stage 1 (n=1 per arm: an indicator, never called proof)

The pattern is read from the plan's own failure conditions (10.2), on M4-A3 for interventions.

| Stage 1 pattern | Reading | Direction |
|---|---|---|
| **(i)** F1, F2, F4 and F5 all fail to hold for an ECCode arm | better on quality and autonomy, at a measured cost | Keep the full pipeline. Next work is cost: cut what the builder-only ratio shows is overhead. Recommend Stage 2 to the owner. |
| **(ii)** M1, M2, M4 show no benefit, but M3 is better by its margin (and possibly c > b) | value is verification, not autonomy | Reposition: ECCode becomes a verification and enforcement layer that wraps a plain agent's build (plan 10.3 ii). Stop work on the orchestration path. The claim in plan section 11 is withdrawn and replaced by the narrower one. |
| **(iii)** F1 and F3-F6 hold, and F8 (more than 10x cost with no metric better by its margin) | no measurable benefit at this size | Stop adding gates for good. Reduce the product to a thin layer: project memory, evidence-gated completion, bounded retries. The README and goal documents state the result in their first paragraph. |
| Mixed or invalid (a continuation criterion C1-C6 fails) | the measurement did not work | Fix the measurement, not the engine. No direction is taken from an invalid run. |

## What this rule does not do

- It does not decide whether Stage 2 runs. The plan fixes that: continuation criteria C1-C6 are about measurement
  validity, "a poor ECCode result is not a reason to stop", and C7 is the owner's explicit word. Stage 2 is capped at
  3.0 billion tokens (plan 9.3), so C7 is a spending decision and stays with the owner.
- It does not turn n=1 into a verdict. A direction taken after Stage 1 alone is labelled "on an n=1 indicator" in
  every document that states it, and is reversed if Stage 2 contradicts it.
- It does not change any threshold, margin, prompt, arm or metric.

## The lightweight path

The ideas that pattern (iii) would keep already exist as a single skill and one script outside this repository
(`TOUMO45/Supervisor-Skill`: memory outside chat, a completion gate that needs evidence, bounded retries, mini-goals,
recorded owner questions). It has no with/without measurement on a large project either. If pattern (ii) or (iii)
occurs, the first step is to compare what ECCode's thin layer would be against that skill, and not build twice.
