# S4 Stage 1 runbook (operator view, 2026-11-11)

This file changes nothing in the plan or its addenda. It lists what is ready, what is not, and the commands.
Live status and open questions: `.supervisor/MEMORY.md`.

## Owner decisions recorded on 2026-11-11

- I-1 and I-2 are confirmed as written in addendum 3, lines 112-119.
- Stage 1 is approved with the plan's ceiling: 500M all-processed tokens, pause at 400M (plan 9.2).
- Stage 1 runs on the owner's machine or a rented VM with a Docker daemon, not in the Claude cloud environment.
- The hidden acceptance suite is written by a separate fresh session that builds no arm (Appendix A).
- Test A1 may skip when bubblewrap is absent (done; the limit stays registered as L-GF-83).
- RescueStock is dropped for the 12 Nov 2026 deadline; its branch is kept.

## Ready

| Item | Where | Check |
|---|---|---|
| Arm order from a committed seed | `node tools/s4-operator.js order --seed "<seed>"` | `tests/s4-operator.test.js` |
| Arm workspaces a, b, c with the frozen inputs verified by sha256, `init`, and the config switches | `node tools/s4-operator.js prepare --arm a --out <run dir>` | same test file, 6 pass |
| ECCode-side intervention count | `tools/count-interventions.js` | existing |

## Found by the first dry run: the plan's `init` command fails as written

The export "`git archive a530ae1` excluding `docs/`" contains the repository's own `.eccode/` record (18 files).
With it present, `eccode-gf init` is refused: `GF-INIT-1: an ECCode project already exists here`. The operator tool
therefore also leaves out `.eccode/` and writes this deviation into every `run.json`. This is a change to the arm
definition and waits for the owner's confirmation (question Q8 in `.supervisor/MEMORY.md`).

## Not ready (each must be closed before any arm starts)

1. The sandbox and launch wrapper (plan 3.1). It needs bubblewrap, which this cloud host lacks, so it is written
   and tested on the Stage 1 host. `run.json` records the launch arguments; nothing here starts a model.
2. Hidden acceptance suite, manifest, rubric and review brief (Appendices A, C, F). They are stored outside the
   repository on the Stage 1 host. A cloud container is deleted after the session, so they cannot be written here.
3. P-4, bare arm: the transcript intervention counter and its test on the S3 record.
4. P-8: `criteria.py`, `repro-union.py`, the adapter checklist and smoke, the contamination scan list.
5. The seed for the arm order, committed before Stage 1.
6. `claude --version` recorded on the Stage 1 host and identical for all arms.

## On the Stage 1 host

```bash
git fetch origin && git checkout claude/happy-lamport-u5fr7k
npm run check                                   # expect 0 failures
node tools/s4-operator.js order --seed "<the committed seed>"
node tools/s4-operator.js prepare --arm a --out ~/s4-stage1
node tools/s4-operator.js prepare --arm b --out ~/s4-stage1
node tools/s4-operator.js prepare --arm c --out ~/s4-stage1
```
