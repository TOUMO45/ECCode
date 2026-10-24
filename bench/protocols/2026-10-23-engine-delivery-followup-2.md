# Pre-registered protocol: does the fixed engine deliver? (second follow-up)

Committed and pushed before any run of this batch starts; the git commit timestamp is the registration.

**Why.** The first delivery follow-up (`2026-10-23-engine-delivery-followup.md`) delivered 16 of 20 engine runs with every audit clean, short of its closing rule of 18. Its saved transcripts show one cause for all four stalls: untracked `__pycache__` files written by `pytest` counted as unreviewed changes at verification (register row 57). The engine at the commit registered below no longer counts tool caches as changes. Nothing else changes.

**Design (fixed in advance).** Identical to the first follow-up except the engine commit:
- Engine at the commit that adds this protocol's fix (named in the report header), run from a pinned worktree. Suite `bench/suites/engine`, all four tasks; variant `engine` only; `guard` profile; subagents inherit the session's model; model `sonnet`; the same agent command and allowlist as both earlier batches.
- n = 5 per task: 20 runs; timeout 2,400 s; one process with `--save`.
- Primary outcome: delivered with a clean audit. Secondary: hidden checks, cost, tokens, time, review rounds, and the cause of every undelivered run from its transcript.
- **Decision rule for register row 56:** delivered with a clean audit in at least 18 of 20 runs: the row closes as eliminated. Otherwise it stays open (mitigated), restated with this rate and the causes that remain.
- Reporting: the report is committed verbatim as `bench/engine-followup/2026-10-23-engine-followup-2-sonnet.md`, whatever it shows. Nothing is re-run or dropped.
- Stopping rule: one batch. If the row stays open, it stays open in this release.
