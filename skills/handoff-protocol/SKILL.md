---
name: handoff-protocol
description: The ECCode handoff contract between agents - objective, context, inputs, dependencies, expected output, acceptance criteria, completed work, verification evidence, remaining issues and next action - validated by schema and recorded in the project record. Use when finishing any ECCode task or passing work to another role.
---

# ECCode handoffs

Every handoff is JSON matching `schemas/handoff.schema.json`. Record it with `eccode handoff record --actor <you> --file <f>`, or pass it to `eccode task complete`. The engine checks:

- every required field is present;
- `from` equals the acting role;
- every `evidence` id exists;
- for task completion: `task` matches the claimed task, at least one cited check **passed after the claim**, every `filesChanged` entry is inside the task's ownership globs, and git confirms those files actually changed.

## Template (`templates/handoff.json`)
```json
{
  "from": "backend-engineer",
  "to": "delivery-lead",
  "task": "api-triage-endpoint",
  "objective": "Implement POST /api/triage per spec §3.1",
  "context": "Contract in .eccode/artifacts/design/spec.md#interface-contracts; AI client stubbed via provider interface.",
  "inputs": [".eccode/artifacts/design/spec.md"],
  "dependencies": ["foundation-server"],
  "expectedOutput": "Endpoint returning {category, urgency, summary, source}",
  "acceptanceCriteria": ["400 on invalid JSON", "413 on >8KB body", "schema-valid 200 response"],
  "completedWork": "Added route, validation, error mapping and unit tests.",
  "filesChanged": ["src/server/routes/triage.js", "test/triage.test.js"],
  "evidence": ["ev:ev-…"],
  "remainingIssues": ["Rate limiting deferred to hardening phase (RISK-3)"],
  "nextAction": "test-engineer: contract tests against the running server",
  "lessonsConsulted": ["mem-d-…"]
}
```

## Writing a useful handoff
- **Completed work:** state what is true now, not what you tried.
- **Remaining issues:** list the problems and gaps you know about. An empty list is a claim that there are none.
- **Next action:** name a specific role and a specific step.
