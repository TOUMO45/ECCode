# Evidence (RescueStock)
Requirement-to-evidence matrix. Status: Passed | Failed | Unverified. Every row names the test or probe, the commit and the environment. Filled per slice; the final acceptance report is `docs/acceptance-report.md`.

| Requirement | Status | Evidence and tested version | Limitation or blocker |
|---|---|---|---|
| RS-01..RS-33 | Unverified | (not yet implemented) | — |

## Id mapping (ARCH-8)
The gate's criterion-id grammar allows one hyphen, so the user's non-functional ids are carried in the brief and all reports as:

| User id (goal.md) | Brief / report id |
|---|---|
| RS-NF-1 clean-checkout setup | NFR1 |
| RS-NF-2 desktop/mobile/keyboard/states | NFR2 |
| RS-NF-3 separate live suites | NFR3 |
| RS-NF-4 secrets via environment only | NFR4 |
| (added by the brief) performance | NFR5 |
| (added by the brief) cost and observability | NFR6 |

The functional ids RS-01..RS-33 are used verbatim; RS-34..RS-39 are additions made by the brief (labelling, six on-screen answers, separate state machines, guarded reset, append-only ledgers, upload limits).
