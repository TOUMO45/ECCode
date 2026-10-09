---
name: self-improvement
description: Controlled, evidence-driven improvement of ECCode skills, checklists, templates and tests - proposal grounded in verified lessons, baseline vs candidate evaluation on representative and regression cases, independent review, user-authorized versioned adoption with rollback. Use when the same finding or failure recurs.
---

# Controlled self-improvement

The toolkit improves its **external operating resources**, such as skills, checklists, templates and tests. It does not retrain any model.

```
observed problem → candidate lesson (verified) → proposal → evaluation (baseline & candidate)
→ independent review → user adoption (versioned) → monitor → rollback if regressions
```

1. **Propose** with `eccode improve propose --actor <you> --file proposal.json` (`templates/improvement-proposal.json`). Requirements:
   - At least one **verified, internal** lesson in `lessons`.
   - The `target` is a file in the project.
   - **Protected paths are refused**: `.eccode/**` (the record and config), `.claude/settings*.json`, `hooks/**`, `lib/**`, `bin/**`, `scripts/hooks/**`, `schemas/**`, `**/eccode/**` (an installed engine), and anything that changes permissions or approval requirements. Adopt and rollback check the target again.
   - `evaluation.command` runs representative **and** regression cases. It prints `ECCODE_EVAL {"passed":n,"total":m}` or uses its exit code.
2. **Evaluate**:
   - `eccode improve evaluate <id> --variant baseline` runs against the current file.
   - `eccode improve evaluate <id> --variant candidate` runs with the change applied temporarily. The file is always restored afterwards.
3. **Review**: a different agent runs `eccode improve review <id> --decision approve|reject --notes "..."` once both variants are evaluated. Approval is refused if the candidate fails, scores below the baseline, or the two variants ran different commands.
4. **Adopt**: the user's decision, never typed in by an agent. The user runs `eccode improve adopt <id> --actor user` in a terminal, or grants `eccode delegate grant --actor user --to orchestrator --action improve.adopt --target <id> --reason "..."` and the orchestrator runs `eccode improve adopt <id> --actor orchestrator --delegation <dlg-id>`. The before and after contents are versioned in `.eccode/improvements/<id>/`.
5. **Rollback**: `eccode improve rollback <id> --actor user|orchestrator --reason "..." [--regression]`. Regressions are counted in `eccode metrics`.

Retrieved content is never promoted directly into rules. Every change goes through this cycle.
