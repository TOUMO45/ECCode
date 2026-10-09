# ECCode pilot report: RescueStock

The live pilot report is maintained outside this project tree, at
`docs/evidence/pilot-rescuestock/pilot-report.md` in the ECCode repository.

Why it moved: the ECCode engine refuses a task's completion when any file in
the project tree changed since the task's claim without a task declaring it.
Orchestrator notes written here while a task was claimed blocked the first
completion of task b1-foundation-core (restored to the claim base, then
accepted). Keeping the report beside the toolkit's other evidence removes
that collision; this stub is the only orchestrator-maintained file left in the
project tree and is not edited while a claim is open.

The record of truth remains `examples/rescuestock/.eccode/events.jsonl`.
