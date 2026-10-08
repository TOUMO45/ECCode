---
name: review-gate
description: How ECCode reviewers write evidence-backed gate reviews that the engine will accept - criteria with ev:/artifact: evidence, severity-ranked findings with resolution conditions, explicit resolution of earlier findings, and independently executed checks. Use whenever recording `eccode gate review`.
---

# Writing an ECCode gate review

The engine (`lib/gates.js`) **refuses** a review when:

- the reviewer authored any submission for the gate, or claimed or completed any task in it (for a phase gate);
- the reviewer's role is not in `roles.<kind>.reviewers`;
- the latest submission's artifacts changed on disk after it was submitted;
- an evidence reference does not resolve: `ev:` ids must exist, and `artifact:` paths must be part of the submission for document gates;
- a criterion marked `met: true` cites a *failed* command;
- an approval has an unmet criterion, a criterion without evidence, or an open blocking/major finding;
- an approval leaves an earlier blocking/major finding without an explicit `resolvedFindings` entry;
- a phase or verification approval lacks a passing check that **the reviewer** ran after the submission and cites;
- `changes_requested` comes without at least one blocking/major finding.

Each refusal is logged (`review.rejected`) and counted in metrics.

## Procedure
1. `eccode gate show <gate> --json`: identify the latest submission, its artifacts and any open findings.
2. Read every artifact. For code, read the diff and the surrounding code.
3. Run checks yourself: `eccode evidence run --actor <you> --label "<what>" -- <cmd>`. Note the `ev:` ids.
4. Write `.eccode/reviews/drafts/<gate>-<n>.json`:

```json
{
  "decision": "changes_requested",
  "summary": "API matches the contract but malformed JSON returns 500 instead of 400.",
  "criteria": [
    { "id": "C1", "description": "Endpoints conform to the interface contract", "met": true,
      "evidence": ["ev:ev-abc123", "artifact:src/server/routes.js"] },
    { "id": "C2", "description": "Invalid input rejected with documented 4xx", "met": false,
      "evidence": ["ev:ev-def456"] }
  ],
  "findings": [
    { "id": "PH1-1", "severity": "blocking", "title": "Malformed JSON crashes handler",
      "detail": "POST /api/triage with body '{' returns 500 (ev:ev-def456).",
      "evidence": ["ev:ev-def456"],
      "recommendation": "Catch parse errors and return 400 {error:'invalid_json'}; add a regression test." }
  ]
}
```

5. On re-review, include one entry per earlier finding:
   `"resolvedFindings": [{ "id": "PH1-1", "resolution": "Handler returns 400; regression test added.", "evidence": ["ev:<rerun id>"] }]`
6. `eccode gate review <gate> --actor <you> --file <draft>`

## Severity guide
| Severity | Meaning | Blocks approval |
|---|---|---|
| blocking | Incorrect, insecure, or fails an acceptance criterion | yes |
| major | Significant risk or maintainability or test gap that should be fixed before dependent work | yes |
| minor | Worth fixing, not risky | no |
| info | Observation or unconfirmed concern | no |

## Anti-patterns that get work rejected later
- Approving on the author's summary instead of the artifact.
- Approving because the deadline is close.
- Re-labelling a blocking issue as minor to approve.
- Citing a check you did not run.
- Reviewing a file version other than the one submitted.
