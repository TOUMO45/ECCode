# Round 2 protocol (written and committed before any round-2 trial)

## Why a second round
Round 1 (`eval/results/round1/ANALYSIS.md`) did not meet E1 and E4, and it exposed a defect in ECCode: applicable house rules were set aside with plausible reasons and an independent reviewer approved. Toolkit v2 changes how lessons are handled (see the analysis). Because the round-1 holdout was read for the diagnosis, v2 is evaluated on tasks that did not exist then.

Round 1 stays on record and is reported next to round 2. Round 2 does not replace it.

## What is fixed here
| Item | Value |
|---|---|
| ECCode under test (toolkit v2) | commit `57f186fa2763f07ec8e28c6b6a8b4b42e123d38c` (export in `toolkits.json`; nothing in the toolkit paths changed afterwards) |
| Baseline (C0) | original ECC `ef648e01`, **byte-identical export** to round 1 (`export-toolkits.js --reuse-ecc`) |
| Tasks | six new tasks `M1`–`M6` (`split: holdout2`): four related, two decoys. Written by an independent author agent that was not shown the toolkits, the results or the other holdout tasks. The maintainer has read none of their contents. Hashes: `eval/suite/frozen-round2.json` (committed with this file) |
| Task size | deliberately larger than round 1 (9–14 hidden checks, 2–4 endpoints or a service layer with real rules). Reason: round-1 tasks cost the baseline about $0.28 each, which leaves no room for an independent review process to matter. This choice was made after seeing round-1 results and is disclosed as such. |
| Training experience | none new: the round-1 post-training snapshots are reused for every condition (C0: three saved skills; C1: nothing; C2: four verified lessons in shared memory), so all three conditions bring the same prior experience as in round 1 |
| Conditions, model, tools | unchanged: C0 original ECC, C1 ECCode with learning off, C2 ECCode with learning on; `claude-sonnet-5-5`, same prompts and unattended-run note, `harness/sandbox.sh` isolation |
| Repeats / limits | 3 repeats per task and condition; per-trial `--max-budget-usd 10` and 60 min timeout, the same for all conditions (raised from 6/45 because the tasks are larger) |
| Targets | `eval/suite/targets.json` **unchanged**: L1–L5 and E1–E4, with REL = the four related tasks and DEC = the two decoys |
| Invalid trials | **predeclared this time:** a trial whose transcript contains an account usage-limit message ("hit your session/weekly limit") is set aside whatever its condition and outcome (`quarantine-invalid.js --split holdout2`) and re-run from the same snapshot. Originals are kept and listed in the report. No other trial is excluded or re-run. |

## What I expect, stated before the run
- L1–L5 should hold again; if C2 does not beat C1 on org-rule compliance, v2's lesson handling is not working.
- **E1 is unlikely to be met.** It needs C2 to beat C0 by 20 points of success; round 1 had C0 at 100 %. If C0 is again at or above 80 %, E1 cannot be met whatever C2 does. I am not changing the target.
- E4 (cost per success ≤ 3× the baseline) is the one I expect to move most with task size, since orchestration overhead is mostly fixed.

## What counts
R7 passes only if every mandatory target (L1–L5, E1–E4) is met in round 2 with the rules above. Round 1 is disclosed either way. Failures and trade-offs go into `eval/results/round2/ANALYSIS.md`. No toolkit change is allowed between this commit and the end of round 2; any later change is post-evaluation and labelled so.
