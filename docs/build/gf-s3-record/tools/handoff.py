#!/usr/bin/env python3
"""usage: handoff.py <outfile> <task> <actor> <files-csv> <ev-csv> <objective> <completedWork> [testsNotNeeded]
Writes a schema-valid task handoff (schemas/handoff.schema.json). All free-text fields must be task-specific."""
import json, sys
f, task, actor, files, ev, objective, done = sys.argv[1:8]
h = {"from": actor, "to": "delivery-lead", "task": task, "objective": objective,
     "context": "Implemented against the sealed contracts in contracts/ and the sealed PRD (.eccode/artifacts/prd.json).",
     "inputs": ["contracts/openapi.json", "contracts/db-schema.json", "contracts/access-matrix.json", ".eccode/artifacts/spec.md"],
     "expectedOutput": "Files of the task, passing the task's pinned verification command",
     "acceptanceCriteria": ["The task's pinned verification command passes", "Only the task's own files were changed"],
     "completedWork": done, "filesChanged": files.split(","),
     "evidence": ["ev:" + e.replace("ev:", "") for e in ev.split(",")],
     "remainingIssues": [], "nextAction": "Next task of the plan, then the orchestrator's checkpoint"}
if len(sys.argv) > 8 and sys.argv[8]:
    h["testsNotNeeded"] = sys.argv[8]
json.dump(h, open(f, "w"), indent=2)
print("wrote", f)
