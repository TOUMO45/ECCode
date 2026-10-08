# ECCode evaluation suite (requirement R7)

This suite measures whether ECCode's orchestration and its verified learning each add value compared with the original ECC toolkit. It uses real headless Claude Code sessions on small but realistic engineering tasks, and the results are graded by hidden checks.

## Conditions

| Id | Toolkit | Learning |
|---|---|---|
| C0 | Original ECC (`affaan-m/ECC` @ `ef648e01`), unmodified, loaded as a plugin | ECC's own mechanisms (`/ecc:learn`, session memory, instincts) |
| C1 | ECCode at the frozen commit | Off (`ECCODE_LEARNING=off`) |
| C2 | ECCode at the frozen commit | On: verified lessons in shared memory |

All three conditions are held equal in these respects:
- **Model:** the same model (`claude-sonnet-5-5`; subagents inherit it).
- **Tools:** the same Claude Code built-in tools.
- **Limits:** the same per-session `--max-budget-usd` and timeout.
- **Prompt:** the same prompt wording, except for each toolkit's native entry command:
  - C0: `/ecc:orch-fix-defect` or `/ecc:orch-add-feature`;
  - C1 and C2: `/eccode:change`;
  - feedback sessions: `/ecc:orch-fix-defect` or `/eccode:investigate`.
- **Run mode:** the same unattended-run note, appended to the system prompt.

## Isolation (`harness/sandbox.sh`)

Each session runs in its own mount and PID namespace. It can see only:
- its own working copy;
- its condition's state (HOME, config directory, ECCode shared memory);
- its toolkit, read-only;
- system directories.

The evaluation suite, graders, other trials, the operator's session data and the host's processes and credentials are not visible to it. Operator secrets are stripped from the environment, and each session gets a neutral git identity. Grading runs in the same sandbox after the session has exited. The graders are mounted read-only only at that point.

## Tasks (`tasks/`, contract in `suite/task-contract.md`)

Each task is an Acme service that vendors `kit/acme-kit`. It comes with a `TASK.md` request, visible tests and a hidden grader. Hidden checks are of three kinds:
- **Discoverable** (`AC`, sometimes tagged `[trap:x]`): the information is in the task, the repo or the kit docs.
- **Org rules** (`[org:x]`, see `suite/org-rules.md`): organisational expectations that are written down nowhere in the repo. A session can learn them only from QA feedback during training.
- **Regression** (`REG`): behaviour that existed before the change.

| Split | Purpose |
|---|---|
| `tune` | Training experience, and the only split used to tune the toolkit |
| `holdout` | Unfamiliar services, used once for the final comparison. They were written by an independent author agent and sealed: the toolkit maintainer did not read them before the final run. Holdout tasks are either *related* (the training knowledge applies) or *decoys* (it looks applicable but must not be applied). |

`harness/validate-tasks.js` proves every task has three properties:
- the original fails at least one hidden acceptance check;
- the reference solution passes everything;
- a plausible naive solution fails a tagged check.

## Protocol

1. **Predeclare** (`suite/targets.json`, committed before any tuning) the metrics and numerical targets.
2. **Tune** ECCode only on the tune split (pilots).
3. **Freeze** the ECCode commit and export both toolkits (`harness/export-toolkits.js`).
4. **Train.** For each condition and tune task, run an attempt session. If hidden checks fail, run one feedback session that lists the failing checks and their messages, in the same working copy. Then snapshot the condition's state. Harness-level session transcripts are removed from the snapshot; toolkit memory stays.
5. **Holdout.** For each condition × holdout task × repeat, run one attempt session from a fresh copy of that condition's snapshot.
6. **Report** (`harness/report.js`): per-trial results, aggregates with Wilson intervals, target verdicts, and every failure listed.

Reproduce: see `suite/run-commands.md`.
