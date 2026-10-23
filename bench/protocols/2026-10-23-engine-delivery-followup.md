# Pre-registered protocol: does the fixed engine deliver?

Committed and pushed before any run of this batch starts; the git commit timestamp is the registration.

**Why.** While the registered engine batches ran (`2026-10-23-engine-ab.md`), the saved session transcripts of the engine runs showed that many stopped before delivery even though their change was correct. The causes, read from the transcripts:
- a reviewer wrote its review with a shell heredoc, which the CLI-only Bash allowlist refused, then ended without running `gate review`;
- engineers edited the handoff draft with `node -e` or built the CLI from a shell variable (`$E`, taught by the playbook's shorthand), which the allowlist or the guard refused, and stopped;
- the orchestrator treated the stopped step as final instead of re-dispatching;
- `deliver` refused while the delivery lead's own dispatch run was open;
- an ownership glob with a typo left the owner unable to write its test.

Commits 5d2f3fd, fd4d17b, 363c17e and 0a8ed8e change the engine for each (register rows 54–56). The registered batches keep measuring the engine as registered. This batch measures the fixed engine.

**Design (fixed in advance).**
- Engine at commit 0a8ed8e, run from a pinned worktree. Suite `bench/suites/engine`, all four tasks. Variant `engine` only, `guard` profile, subagents inheriting the session's model. Model `sonnet`, with the same agent command as the registered batch:
  `cat PROMPT.md | claude -p --model sonnet --output-format json --allowedTools "Read Grep Glob Edit Write Agent Task Bash(npm test) Bash(node --test*) Bash(pytest*) Bash(node .claude/eccode/bin/eccode.js*) Bash(git diff*) Bash(git status*)"`
- n = 5 per task: 20 runs. Timeout 2,400 s per run. One process with `--save`.
- **Primary outcome: delivered with a clean audit**, as the harness reads the record back.
- Secondary: hidden checks passed, cost and tokens as reported by the session, wall time, review rounds, and for every undelivered run the cause read from its transcript.
- **Comparison:** with the engine arm of the registered `sonnet` batch on the same tasks. This is a before/after comparison of two engine versions, not a randomized one, and is reported as such.
- **Decision rule for register row 56** ("engine runs stopped before delivery"):
  - delivered with a clean audit in at least 18 of 20 runs: the row closes as eliminated;
  - otherwise: the row stays open (mitigated), restated with the delivery rate and the causes that remain.
- Reporting: the report is committed verbatim as `bench/engine-results/2026-10-23-engine-followup-sonnet.md`. Nothing is re-run or dropped.
- Stopping rule: one batch.
