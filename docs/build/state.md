# State

**Branch:** `claude/brave-bardeen-6y5ng9`

## Done (committed)
- W1a: `run end` requires usage (`--no-usage` escape).
- W1b: learning switch (`ECCODE_LEARNING`, `memory.learning`).
- W1c: `eccode reconcile [--verify]`, with read-only reconciliation shown by `resume` and the SessionStart hook.
- Change profile and `/eccode:change`.
- `memory assess`: evidence-backed rejection of a lesson.
- The investigate flow promotes verified lessons to shared memory.
- Eval scaffolding:
  - `eval/kit/acme-kit` and tune tasks A1 and A2;
  - sandboxed trial harness (`eval/harness/*`);
  - org rules and task contract;
  - **R7 targets predeclared** in `eval/suite/targets.json` (commit `38e2ce8`, 2026-10-08T11:20Z).

## In flight (background agents)
- Bug-fix agent, in a worktree: the 22 reproduced findings from the independent bug hunt (`scratchpad/bughunt`). **Merge its branch next**, then run `npm run check` and audit both example records.
- Tune-task builder: B1, E1, F1, C1.
- Sealed holdout author: H1–H6. **Do not read the holdout task contents.**

## Pilot findings (tune task A1, before the sandbox existed: NOT part of the results)
- **C0 (ECC):** 5/5 in 0.7 min, $0.27, 0 subagents. ECC skipped its own review step when unattended.
- **C1 (ECCode change mode):** 5/5 in 8 min, $2.21. Of that, $1.53 was Opus, because ECCode pins reviewers to Opus. This was fixed for the eval by normalizing model pins in both toolkit exports (verified: sonnet only).
- **Sandbox needed:** an unsandboxed C1 reviewer ran `find /` and read `/home/user/ECCode`. Trials now run in a mount+PID namespace (`eval/harness/sandbox.sh`). The only credential directory exposed is `/home/claude/.claude/remote`, read-only, because the CLI needs it.

## Next actions
1. Merge the fixer branch, then tune change mode for efficiency (lib + skills):
   - the orchestrator may submit phases and deliver in change profile;
   - `eccode plan example`;
   - a single-task plan for small changes.
2. Validate all tasks. Write `eval/suite/suite.json`. Pilot the tune tasks. Freeze the toolkit commit, then official training and holdout (`train.js`, `holdout.js`, `report.js`).
3. W3: the demo app (`docs/build/demo-scope.md`) via a headless orchestrator with the plugin installed, interrupted and resumed in a fresh session (R5).
4. W4: the gate challenge (R3), with deliberate defects and blind reviewers.
5. FA: the acceptance report.

## Restart steps
1. `cd /home/user/ECCode && git log --oneline -8 && npm run check`
2. Read `docs/build/plan.md`, this file and `docs/build/evidence.md`.
3. Eval workspace: `/srv/eccode-eval`. Pilot data: `/home/user/eval-work/pilot`. ECC clone: `scratchpad/ecc/ECC`.
