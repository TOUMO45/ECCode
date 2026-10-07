---
name: verification-evidence
description: Rules for producing and citing verification evidence in ECCode - run checks through `eccode evidence run` so exit codes and logs are recorded, distinguish verified results from assumptions, and report failures honestly. Use before claiming anything works.
---

# Verification evidence

A claim is **verified** only when there is an `ev:` id for it. That id comes from a command the toolkit executed and recorded: exit code, duration, a log digest and a secret-redacted log in `.eccode/evidence/`.

```
eccode evidence run --actor <role> --label "unit tests" [--task <id>|--gate <gate>] -- npm test
eccode evidence run --actor learning-debugger --purpose reproduction --label "repro: 500 on bad JSON" -- node test/repro.js
eccode evidence file <path> --actor <role> --note "inspected contract section 3"
```

## Rules
- Report results in three categories: **Verified** (cites `ev:` ids), **Assumed** (reasoning, no execution) and **Not tested** (with the reason). Never merge them.
- **A failing check is information.** Record it, keep it, then fix the cause. Re-running until it passes by chance is not verification. Flaky tests are findings.
- **Choose checks that prove the acceptance criterion.** A green unrelated test suite proves nothing about the criterion.
- **AI features:**
  - Evals state their provider.
  - Results from a deterministic fallback or mock are evidence about the *pipeline*, not about model quality.
  - Live-model evals that could not run because there were no credentials are reported as **not run**.
- **Performance and cost** numbers come from measured runs, and the record says how they were measured.
