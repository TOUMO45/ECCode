# Interrupt-and-resume evidence (requirement R5)

`eval/harness/resume-demo.js` runs a real ECCode delivery, kills it in the middle, and continues it in a brand-new session.

1. **Session 1** (`sessions/session1.jsonl.gz`) runs `/eccode:change` on the invoice-totals task. A watcher SIGKILLs the whole process group 20 s after the first task is claimed. `record-at-kill.json` shows the state at the kill: plan approved, `phase:core` in progress, the task **claimed**, one **open run**, and **partial work on disk** (`test/totals.test.js` untracked). The session never finished and never reported usage.
2. **Session 2** (`sessions/session2.jsonl.gz`) is a new process with a **new session id** and a new Claude config directory (no conversation history, no memory of session 1). Its only prompt is `/eccode:resume`. From the persistent record alone it:
   - ran `eccode resume` and `eccode reconcile --verify` (the record was checked against the working tree and recorded checks were re-run; event 19 is `project.reconciled`, 1 blocking item, 2 warnings);
   - ran `eccode recover --all` (event 20: the interrupted run closed as `interrupted`, its claim released);
   - re-dispatched the task owner, which re-claimed the task with the partial test file recorded as *already dirty at claim time* (event 23, `dirtyAtClaim`), finished the work, passed independent phase review and delivered.
3. **Outcome** (`summary.json`): `differentSession: true`, `reconciledInSession2: true`, `recoveredInterruptedRuns: 1`, all gates approved, delivered, `eccode audit` passes (36 events, hash chain intact), and the hidden grader scores **5/5 acceptance checks, no regressions**.

`project-record/` is the complete hash-chained record and `work-tree/` holds the delivered source and tests it approved. `eccode audit` checks the hash chain **and** that approved artifacts still match the files on disk, so re-audit them together:

```sh
mkdir /tmp/r5 && cp -r work-tree/. /tmp/r5/ && cp -r project-record /tmp/r5/.eccode
node bin/eccode.js audit --root /tmp/r5     # Audit OK: 36 events, chain intact, approved artifacts unchanged.
```

(Auditing `project-record` alone reports the approved files as deleted: that is the audit working, not a defect of the record.) The run uses the sandbox of `eval/harness/sandbox.sh`; the model was `claude-sonnet-5-5`.
