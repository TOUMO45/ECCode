---
description: Review recurring findings and propose an evidence-based improvement to ECCode skills/checklists (evaluated, independently reviewed, adopted only with user approval).
argument-hint: [focus area]
---

Use the `self-improvement` skill. Focus: $ARGUMENTS

1. Run `eccode metrics` and `eccode memory list --layer workflow` to find recurring problems.
2. Have `learning-debugger` draft a proposal grounded in verified lessons.
3. Evaluate the baseline and the candidate, then have an independent reviewer decide.
4. Adoption is the user's decision and you never run `--actor user`: show the user `eccode improve adopt <id> --actor user` to run in a terminal, or ask for a delegation (`eccode delegate grant --actor user --to orchestrator --action improve.adopt --target <id> --reason "<why>"`) and then run `eccode improve adopt <id> --actor orchestrator --delegation <dlg-id>`.
