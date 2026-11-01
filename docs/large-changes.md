# Large-change planning (Phase 3, Part D)

The multi-file run delivered 9 of 18; the causes were rescope, oversized steps and timeouts. Phase 3 makes a plan decompose and finish.

- **Interfaces first.** `eccode plan contracts --file contracts.json` records the interfaces, schemas and API shapes agreed before implementation (`[{id, kind: interface|schema|api, text}]`); refused once a task is claimed.
- **Task budget.** A task may change at most `plan.maxFilesPerTask` files (default 3) or `plan.maxLinesPerTask` changed lines (default 150). Over budget, completion is refused until the task is split, or the orchestrator waives it with a reason (`eccode task waive-budget <task> --reason "…"`). This reverses the earlier "measure lines, never cap" decision (docs/architecture.md): the cap is a planning guard with an explicit waiver, so a correct-but-large change is still possible, on the record.
- **Integration checkpoints.** After every `plan.checkpointEvery` completed tasks (default 3) a checkpoint must pass before the next claim: `eccode plan checkpoint --evidence ev:<id>,…` cites the passing checks the orchestrator ran. A due checkpoint blocks the next claim (`CHECKPOINT_DUE`).
- **Rescope cites a contract.** When the plan declared contracts, `eccode task rescope … --contract <id|none>` must name the contract it changes; a contract changed twice opens a blocking ambiguity (Part A), stopping further work until the interface is confirmed.
- **Progress evidence.** The final report shows planned vs delivered tasks and every rescope.

Config (`.eccode/config.json` "plan"): `{maxFilesPerTask, maxLinesPerTask, checkpointEvery}`. The budget and checkpoints do not apply to the `quick` and `debug` tracks.

## Limits
- The budget counts the task's own declared files (ownership-checked) and the lean line stats; with lean off, only the file count is enforced.
- A checkpoint records that the cited checks passed; it does not re-run them. The orchestrator runs the narrowed check set and cites the evidence.
