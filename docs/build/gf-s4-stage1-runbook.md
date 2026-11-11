# S4 Stage 1 runbook (operator view, 2026-11-11)

This file changes nothing in the plan or its addenda. It lists what is ready, what is not, and the commands.
Live status and open questions: `.supervisor/MEMORY.md`.

## Owner decisions recorded on 2026-11-11

- I-1 and I-2 are confirmed as written in addendum 3, lines 112-119.
- Stage 1 is approved with the plan's ceiling: 500M all-processed tokens, pause at 400M (plan 9.2).
- Stage 1 host: first recorded as "the owner's machine or a rented VM", on the untested belief that the cloud
  environment has no Docker. Tested on 2026-11-11: `dockerd` starts there and `docker run hello-world` works, so a
  cloud session can host it. Risk: the container is reclaimed after inactivity; each arm's record is committed as
  soon as the arm exits.
- The hidden acceptance suite is written by a separate fresh session that builds no arm (Appendix A).
- Test A1 may skip when bubblewrap is absent (done; the limit stays registered as L-GF-83).
- RescueStock is dropped for the 12 Nov 2026 deadline; its branch is kept.

## Ready

| Item | Where | Check |
|---|---|---|
| Arm order from a committed seed | `node tools/s4-operator.js order --seed "<seed>"` | `tests/s4-operator.test.js` |
| Arm workspaces a, b, c with the frozen inputs verified by sha256, `init`, and the config switches | `node tools/s4-operator.js prepare --arm a --out <run dir>` | same test file, 6 pass |
| Arm sandbox (plan 3.1): probe, print, start | `node tools/s4-launch.js probe --run <run dir>/arm-a` | `tests/s4-launch.test.js`, 5 pass |
| Bare-arm intervention count and the C5 check against the operator log | `node tools/count-transcript-interventions.js <session.jsonl> --log <operator-log.jsonl>` | `tests/s4-transcript-interventions.test.js`, 5 pass |
| M1 scoring: criteria passed / total, fail-closed, and the two-run stability check (C3) | `python3 tools/criteria.py junit.xml criteria.json --second junit2.xml` | `tests/s4-criteria.test.js`, 4 pass |
| Contamination scan (S3 script, byte-identical copy) | `tools/contamination-scan.py` | sha256 equals the source on `claude/modest-wozniak-mwpzbm` |
| ECCode-side intervention count | `tools/count-interventions.js` | existing |

## Found by the first dry run: the plan's `init` command fails as written

The export "`git archive a530ae1` excluding `docs/`" contains the repository's own `.eccode/` record (18 files).
With it present, `eccode-gf init` is refused: `GF-INIT-1: an ECCode project already exists here`. The operator tool
therefore also leaves out `.eccode/` and writes this deviation into every `run.json`. **The owner confirmed this
change on 2026-11-11** (decision D12 in `.supervisor/MEMORY.md`).

## Dry run on 2026-11-11 (cloud host, bubblewrap 0.9.0, Claude Code 2.1.322; no model started)

- `prepare` for arms a, b and c: all three succeeded.
- `probe` for arms a, b and c: `ok: true`. The arm could write its workspace, could not write `/usr`, and could not
  see the ECCode checkout, `run.json`, `prompt.md`, or the other arms' directories.
- Inside the arm b sandbox: `claude --version` printed 2.1.322 and `node bin/eccode-gf.js status` reported the
  compose profile.
- First smoke start (a one-line prompt, arm sandbox): Claude Code refused `bypassPermissions` as root, so arms now
  run as uid 1000 inside the sandbox. The second attempt reached Claude Code, which answered "Not logged in": the
  arms need a model API key in the operator's environment. Nothing else failed.
- Model access cannot be given to an arm in a Claude cloud session: the platform accepts no user key for Anthropic's
  hosts there (the session authenticates itself), and the session's own token must not be passed to an arm that runs
  with permissions bypassed. **Stage 1 therefore runs on a machine where Claude Code has its own login or
  `ANTHROPIC_API_KEY`**, with Docker and bubblewrap. Everything else in this runbook was rehearsed in the cloud.
- Not exercised: a real model start, network access to the model from inside the sandbox, and Docker (the plan's
  decision D-6 gives arms no Docker socket; the operator's deployability check M7 needs a daemon on the host).
- The sandbox binds `/opt` read-only because Node and Claude Code are installed there on this host. On another
  host, check that `/opt` holds nothing an arm must not read.

## Not ready (each must be closed before any arm starts)

1. Hidden acceptance suite, manifest, rubric and review brief (Appendices A, C, F). They are stored outside the
   repository on the Stage 1 host. A cloud container is deleted after the session, so they cannot be written here.
2. P-8, remaining: `repro-union.py`, the adapter checklist and smoke, the contamination scan list. Their inputs
   (finding format, suite file names, rubric ids) exist only after the suite and the review brief are written.
   The model API key is the one item waiting on the owner (question Q9).
3. (closed) P-4, bare arm: `tools/count-transcript-interventions.js`, 5 tests. It could not be tested on the S3
   record because the S3 bare transcript was never committed; it was checked on one real session transcript.
4. The seed for the arm order, committed before Stage 1.
5. `claude --version` recorded on the Stage 1 host and identical for all arms (each `run.json` records it).

## On the Stage 1 host

```bash
git fetch origin && git checkout claude/happy-lamport-u5fr7k
npm run check                                   # expect 0 failures
node tools/s4-operator.js order --seed "<the committed seed>"
node tools/s4-operator.js prepare --arm a --out ~/s4-stage1
node tools/s4-operator.js prepare --arm b --out ~/s4-stage1
node tools/s4-operator.js prepare --arm c --out ~/s4-stage1
node tools/s4-launch.js probe --run ~/s4-stage1/arm-a --deny /root/.cache/s4-hidden   # repeat for b and c
node tools/s4-launch.js print --run ~/s4-stage1/arm-a                                # the exact command, keys hidden
# Only when every item under "Not ready" is closed, in the committed order, one arm at a time:
node tools/s4-launch.js start --run ~/s4-stage1/arm-a --approved-by-owner
```

`start` refuses without a passing probe, refuses to run an arm twice, and needs the model key in the operator's
environment (`ANTHROPIC_API_KEY`); the key is passed to the arm and never written to a file.
