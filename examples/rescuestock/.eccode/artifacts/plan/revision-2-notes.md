# Plan revision 2: finding → change

This revision responds to review `rev-mv1eznmd-01d2f5fe`, which reviewed submission `sub-mv1eqk2q-01cc29a2`. The files are `plan.json` (6 phases, 28 tasks) and `plan.md`.

| Finding | Change |
|---|---|
| F-PL-1 (major): 11 of 29 commands pass before the work exists | Every task's command now starts with an existence guard: `ls <files this task creates first> >/dev/null && …`.<br>**Why a guard and not only naming the files:** naming new files in the command, as recommended, is not enough on Node 22.22. `node --test` ignores a missing explicit file whenever any other pattern or file in the same command matches. So `npm test -- <new file>`, `npm run test:browser -- <new file>` and `NG <old file> <new file>` all exit 0 before the work exists. The probe `.eccode/drafts/plan-r2-cmd-probe.mjs` shows this (ev:ev-mv1f3hiv-01a9ae95). It would also have affected e2 and f1 in revision 1, which name pre-existing files next to new ones.<br>**What the guard lists:** b1 and b2 list their named test files. The frontend tasks each create a per-phase unit file (`test/unit/frontend/{dashboards,extraction,payments,recovery,a11y-labels}.test.js`) and no longer share the `test/unit/frontend/**` glob. The test-engineer tasks list their own integration and browser files, own `test/browser/<own>.test.js` plus `test/browser/helpers/**` instead of `test/browser/**`, and keep `npm test && npm run test:browser`, whose globs run those files.<br>**Checks:** the reviewer's `tr-plan-check.mjs` reports 0 pre-passing tasks and 0 hard problems (ev:ev-mv1f9xrb-016eb638). My stricter `.eccode/drafts/plan-r2-guard-check.mjs` reports 28/28 (ev:ev-mv1f9xxn-0119c41e). `plan validate` is clean (ev:ev-mv1f9xgc-01e839a6). It requires each guard file to be owned by the task and by no task in an earlier phase or in the task's dependency closure. |
| F-PL-2 (minor): budget decision before phase B; merge g3 + g4 | plan.md now states, before the phase table, that phase B does not start until the user's budget decision is recorded (raise `maxRuntimeMinutes`, or accept the stated descoping order). g4 is merged into g3, which also owns `docs/evidence-table.md` and `test/scan/evidence-table.test.js` and ends with the clean-checkout run: 28 tasks, a 19-dispatch critical path. |
| F-PL-3 (minor): f1 and f2 coupled through files only f2 owns | f1 keeps running beside f2. A new acceptance criterion of f1 states that it changes no code in `void-rule.js`, `reconciler.js`, `saga.js`, `calls.js`, `admin.js` or `src/routes/admin.js`. It uses the void rule (from e2), the reconciler's expiry and re-plan-drain calls (wired by e4 into `reservations.js` and `supersession.js`, which f1 owns) and the c3 admin faults as built. If a change in an f2-owned file is needed, f1 fails with the named defect and the orchestrator re-sequences it after f2. |
| F-PL-4 (info): name the register-cap test | b1 gains `test/unit/config/limits.test.js` with the case `F-TR-17: …`: default 5, 6 refused outside test mode, 1000 accepted with `RS_TEST_OFFLINE=1`. The file is in b1's guard. |

Other changes, made to support F-PL-1:
- **b1's `.gitignore`** must cover `test/.out/` and `test/browser/out/`, so that screenshots and latency logs never count as task changes.
- **Full-suite timeouts** are raised to `--timeout 1800`, and g3's to 2400.

Unchanged:
- the phase split;
- criterion claims (45/45, ev:ev-mv1f9y39-01a44448);
- ownership boundaries apart from the narrowing above;
- live checks;
- the lesson decision.
