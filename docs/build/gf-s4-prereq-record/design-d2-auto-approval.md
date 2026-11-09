# D-2 design: automated slice approval inside a budget (engine code, opt-in)

Module `lib/greenfield/approval.js`; counter `lib/greenfield/interventions.js`; CLI `eccode-gf approve`,
`eccode-gf intervention record`, `eccode-gf interventions count`; standalone `tools/count-interventions.js`.

## Switch (off by default)
`.eccode/config.json` → `"gf": {"approval": {"auto": {"enabled": true, "maxSlices": N, "maxTokens": T, "maxWallClockMinutes": M}}}`.
`initProject` writes nothing under `gf.approval` (so `tests/gf-flow.test.js:38` is unchanged). Absent, disabled or
malformed policy: the approver approves nothing (GF-AUTO-0). The config lives in `.eccode/`, which the guard keeps
out of every agent's reach, so an arm cannot raise its own budget.

## What it approves
A **closed slice** (a valid `gf.slice.closed` for the scope). This is the owner sign-off point the S4 plan's operator
table calls "ECCode gate waits for owner approval". It does not close slices, approve G1 gates, accept limits, defer
findings, or amend contracts: those stay with their existing roles and the user.

## Preconditions (all must hold; the first failing ones are recorded, nothing is approved)
| Rule | Check | Source of truth |
|---|---|---|
| GF-AUTO-0 | policy present, `enabled: true`, every bound a positive integer | config |
| GF-AUTO-1 | the scope has a closure; it is not already auto-approved; the full GF audit (`audit.run`) is clean | event record + replay |
| GF-AUTO-2 | slices: approvals so far < maxSlices; tokens: sum of every closure's `accounting.end - start` ≤ maxTokens, any `unmeasurable` refuses; wall clock: now − `gf.project.initialized` ts ≤ maxWallClockMinutes | event record, clock |
| GF-AUTO-3 | G1 sealed; every contract file in the **closing tree** (read with `git cat-file`) has its sealed/last-amended hash; no contract amendment requested or applied since the last approval baseline; no hidden-suite path (`hidden.paths`) exists in the closing tree | event record, git tree, config/env |
| GF-AUTO-4 | the rejection log verifies (hash chain), and has no denial since the baseline other than the approver's own refusals | `.eccode/rejections.jsonl` |

Baseline = the rejection-log count and event seq recorded by the last `auto-approval` or the last human `intervention`
event (a human intervention acknowledges what came before it). Budget exhaustion is a hard stop: once maxSlices is
reached, every later attempt is refused until the owner changes the policy (itself a counted intervention).

## Record
Approval: event type exactly `auto-approval`, actor `auto-approver`, committed through the frozen store (same hash
chain). Payload: id, scope, closureSeq, treeHash, policy, policyHash (sha256 of canonical policy), budget used after
this approval, rejectionsSeq, checks. The frozen reducer and the GF projection ignore non-`gf.` types, so state and
the existing pinned event list are unchanged. Refusal: one rejection-log entry per failing rule (action
`auto-approve`), and the CLI exits 2 ("human needed").

Human interventions: event type `intervention`, actor `user` only (the guard asks the person), type one of approval,
clarification-answer, correction, restart, unblock, optional `refSeq` to an engine event it describes.

## Audit (replay)
`approval.audit(store, config)`: each `auto-approval` has the right actor and schema, its policyHash matches its
policy, its slice count ≤ maxSlices, its scope had a closure on that tree before it, no scope is approved twice,
and its token sum recomputed at its seq ≤ maxTokens. A forged or over-budget event is reported (GF-AUTO-5).

## Counter
`countInterventions(log)`: counted = explicit `intervention` events by type + `user`-actor engine events not
referenced by one (`request.clarified` → clarification-answer, every other → approval); `auto-approval` events are
reported separately and never counted.

## Known limits (stated, not fixed here)
- Token spend is the orchestrator's own recorded closure accounting; under-reporting stretches maxTokens. maxSlices
  and wall clock are engine-sourced.
- Restart/unblock/correction happen outside the engine; they appear in the record only if the operator records them
  (`eccode-gf intervention record`). The bare arm has no event record; its count still comes from the transcript (P-4).
