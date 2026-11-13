---
description: Start an ECCode delivery - take a product idea through architecture, independent reviews, design, phased implementation, verification and delivery with the ECCode agent team.
argument-hint: <product idea>
---

Deliver this idea with ECCode:

$ARGUMENTS

**Choose the path by size first. This is a rule, not a judgement call.**

1. **Small** - one package, tool, script or service that one engineer builds in one sitting (no separate frontend and backend, no database migration plan, no deployment design): use the quick path.
   - Run `eccode quick "<the idea in one line>" --actor orchestrator --files "**"`. If it answers "No test command detected", run the exact command it prints, with the test command the project will use.
   - Then do the numbered steps it prints, in order. After each step run `eccode status --brief` and do what NEXT says. Do not load the `orchestrate` skill for small work.
2. **Anything larger**: use the `orchestrate` skill. Initialize the project record, then follow the workflow.

Show the user `eccode status --brief` after every gate decision.
