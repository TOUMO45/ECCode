# Reproducing the evaluation

Requirements: Linux with unprivileged-root mount/PID namespaces (`unshare`), Node ≥ 22, the Claude Code CLI (headless `claude -p`) with model access, git. Expect roughly $40–60 of model usage and 1.5–3 hours per round (training included for round 1). Run time depends on the account's usage limits; a trial that hits one is set aside and re-run (`harness/quarantine-invalid.js`).

```sh
git clone https://github.com/affaan-m/ECC /tmp/ecc && git -C /tmp/ecc checkout ef648e01899ba3e8dc6371642deaaf64b4477775   # the unmodified baseline
node eval/harness/freeze.js --verify                       # the suite is unchanged since it was frozen
node eval/harness/validate-tasks.js                         # every task is valid (use --quiet-names for the holdout)
RUN=/srv/eccode-eval/official
node eval/harness/export-toolkits.js --out $RUN/toolkits --ecc-clone /tmp/ecc     # clean copies of both toolkits; model pins normalised
node eval/harness/train.js   --run $RUN --parallel 6        # tune split: attempt, QA feedback, snapshot of each condition's state
node eval/harness/holdout.js --run $RUN --repeats 3 --parallel 6                  # holdout split, each trial from a fresh copy of the snapshot
node eval/harness/report.js  --run $RUN --out eval/results                         # aggregates, targets, every failed trial
```

All three scripts resume: finished steps are skipped. Trials run in `eval/harness/sandbox.sh` (mount + PID namespace).

## Round 2 (new tasks, toolkit v2)
```sh
node eval/harness/freeze.js --split holdout2 --file frozen-round2.json --verify
node eval/harness/export-toolkits.js --out $R2/toolkits --reuse-ecc $RUN/toolkits      # same baseline bytes
cp -r $RUN/snapshots $RUN/training $R2/                                                 # same prior experience
node eval/harness/holdout.js --run $R2 --split holdout2 --repeats 3 --parallel 4 --budget-usd 10 --timeout-min 60
node eval/harness/quarantine-invalid.js --run $R2 --split holdout2                      # then re-run holdout.js if anything was set aside
node eval/harness/report.js --run $R2 --split holdout2 --out eval/results/round2
node eval/harness/report.js --run $R2 --split holdout2 --out <dir> --exclude <task>:<check>   # sensitivity analysis only
```
