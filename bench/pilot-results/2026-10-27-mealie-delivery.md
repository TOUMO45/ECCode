# The delivery run: do large changes deliver once the multi-file run's stops are removed?

Protocol: [bench/protocols/2026-10-27-mealie-delivery.md](../protocols/2026-10-27-mealie-delivery.md), registered at commit `67a5db4` (2026-10-27T22:25:10Z) before any measured run. It has four amendments, each committed before the runs it governs:
- amendment 1, `71f2137`, corrected in `0d352ad`: a container restart;
- amendment 2, `a685eab`: a second restart;
- amendment 3, `65e17a4`: an expired credential;
- amendment 4, `f7ff618`: a third restart, and a correction to amendment 3.

Design: [docs/specs/2026-10-27-delivery-run-design.md](../../docs/specs/2026-10-27-delivery-run-design.md). Saved runs: [2026-10-27-mealie-delivery.runs.jsonl](2026-10-27-mealie-delivery.runs.jsonl) (the continued reading) and [2026-10-27-mealie-delivery.registered.jsonl](2026-10-27-mealie-delivery.registered.jsonl). Labels: [failures.json](../pilot/mealie/labels-delivery/failures.json), [failures-registered.json](../pilot/mealie/labels-delivery/failures-registered.json) and [refusals.json](../pilot/mealie/labels-delivery/refusals.json). The batch before it: [the multi-file run](2026-10-27-mealie-multifile.md).

## In short

The multi-file run delivered 9 of 18 engine runs on large changes (row 138). This run removed the stops it found, then ran all 16 of its items twice through the engine and twice bare.

- **Primary: missed, by one run.** In the continued reading, 25 of 32 planned engine runs (78%) delivered with a clean audit within the 4-hour limit; the rule needs 80%, 26 runs.
  - Keeping item 06's credential-cut run as not delivered gives 24 of 32.
  - The registered reading, frozen at the first container restart, has 3 of 32.
- **The stops it aimed at are gone:**
  - no run reached the time limit (the multi-file run had four);
  - the engine delivered 6 of 6 runs on the three items whose failures shaped its changes;
  - the one run that needed a rescope proposed four, had them approved by the technical reviewer, and delivered.
- **Every undelivered run stopped to ask a user,** and no one answers a headless run. Five of the seven changes pass every hidden check. They stopped for three new reasons:
  - **a project tool rewrote an approved file, three runs:**
    - Mealie's code generator formats the whole project, and ruff formats Markdown code blocks;
    - in the third run, an engineer formatted the whole package;
    - the way back was the user's alone;
  - **Mealie's code generator was not run, two runs:** the tool list refused `uv run` and `task`, and the orchestrator declined the plain `python` command it allowed;
  - **a file move or delete was refused, both runs of item 14:** the bare agent met the request without it.
- **Fixed or mitigated after the batch, none measured:**
  - an approved gate whose files changed is now re-reviewed (row 140);
  - formatters stay on the task's files (row 141);
  - a refused wrapper does not forbid the command it wraps (row 142);
  - a refused move or delete is routed around (row 143).
  
  Closing row 138 needs another registered run.
- **Friction: met.** 2 false refusals in 32 engine runs (0.06 per run) among 605 refusals. One was a guard defect, now fixed (row 139); the other is row 91.
- **Correctness, no criterion:** the engine passed every hidden check in 29 of 32 runs, the bare agent in 28 of 32 (p = 1.0). The bare agent's own mistakes were on items 01 and 05, where the engine passed 1 of 2 and 2 of 2.
- **Cost:** a median engine run cost 8.2× a bare run ($3.45 against $0.42) and took 53.3 minutes against 5.6. The batch recorded $148.84 of a $210 ceiling.
- **Found:** six register rows (139–144), and three defects in the run's own tools. A fresh final review found more in the fixes themselves. They are now fixed, including a guard regression that the first sed fix had introduced.

## What changed since the multi-file run

The multi-file run delivered 9 of 18 engine runs on large changes (row 138). This run removed the stops it found, then ran every item of the same suite twice through the engine.

**The engine and its agents** (spec section 3):
- **Reviewed rescope.** When a planned check cannot run as written, or a file that must change belongs to no task, the delivery lead proposes a rescope and the technical reviewer decides it. Before, only the user could change an approved plan's task.
- **A 30-minute evidence default,** up from 10 minutes.
- **Checks sized to the step.** Engineers and reviewers run the task's planned check, not whole test directories, and set an environment variable with `env NAME=value`.

**The harness, the same for both variants** (spec section 4):
- **Mealie's dev environment:** `PRODUCTION=false` and `PYTHONPATH=.`. Every item was validated live again.
- **The tool list** (`$AGENT_D`) also allows deleting Mealie's test temp directory, `tests/.temp`.
- **The run limit** is 4 hours, up from 2. Delivery within 2 hours is reported beside it.

## What ran

- **Items:** the multi-file run's 16 mealie4 items, 121 to 1,355 changed lines in 6 to 30 files. The engine had run on items 01, 05 and 07 before (in-sample); the other 13 it had never seen.
- **Runs:**
  - 2 engine runs per item, 32 in all, on the guard profile and the item's track (fix or feature), in processes e1 (items 01–06), e2 (07–11) and e3 (12–16);
  - 2 bare runs per item, 32 in all, in process w.
  - Sonnet in every session, through `claude -p` with the tool list above.
- **The batch** started at 22:26:22Z on 2026-10-27, from a worktree pinned at the protocol commit.
- **Two container restarts** stopped all four processes, at about 23:34Z and 23:56Z. Each time the processes resumed with `bench/pilot/resume.js` from a pinned worktree (amendments 1 and 2).
  - The first restart cut four runs and kept 51 from starting.
  - The second cut four more.
  - The registered reading is the batch as the first restart left it.
- **Replacement runs:** each cut run was run once more after its process ended:
  - w's from 03:29Z;
  - e3's from 03:24Z;
  - e2's from 06:20Z;
  - e1's from 14:24Z.
- **e1's last runs took three attempts:**
  - An expired credential ended e1's second run of item 06 at 13:04Z (amendment 3). The continued reading drops that run and replaces it, and is also reported with it kept.
  - At 13:06Z, the operator tried to stop the replacement run that had started into that 401. The stop failed: the run's agent worked on until 13:09Z, in a sandbox the operator had already removed for the next attempt, and its harness then crashed. It wrote no result (amendment 4).
  - A third restart, at about 13:14Z, cut the next attempt. The container was down until 14:13Z, and the memory log shows no load before it (amendment 4).
  - The three runs then ran as three processes at once and ended at 15:01Z (item 01), 15:46Z (item 02) and 17:28Z (item 06).
- **Cost:** $148.84 recorded over the 68 runs that wrote a result: engine $130.81, bare $18.03. The registered ceiling was $210. The eight cut runs and e1's two abandoned attempts recorded no cost.

## Labels

Every failed run was labelled before any figure was computed. Each was replayed on a clean tree with [bench/pilot/mealie/proof-replay.js](../pilot/mealie/proof-replay.js): the item's parent exported, the saved patch applied, the hidden tests placed and each check run. The label then came from the failing check's full output, the run's patch and the request.

**The continued reading's seven failed runs:**

| Run | Hidden checks | Label | What failed |
|---|---|---|---|
| e1, item 01, run 1 | 1 of 2 | agent-error | The enum's members are `ALWAYS` and `FALLBACK` where the request says `always` and `fallback`, so the target file fails at import. The run delivered with a clean audit: its reviews missed it. |
| e3, item 14, run 1 | 1 of 2 | agent-error | It stopped in its first task to ask for `mkdir` and `git mv`, and never built the rest. Both bare runs passed by writing the new files and leaving the old ones. The refusal was the trigger. |
| e3, item 14, run 2 | 1 of 2 | agent-error | As run 1, stopping to ask for `git rm`. |
| w, item 01, runs 1 and 2 | 1 of 2 each | agent-error | The same enum naming as the engine's run 1. |
| w, item 03, run 2 | 1 of 2 | spec-gap | It rewrote the axios plugin as `defineNuxtPlugin({ setup })`, and the hidden spec calls the plugin as a function; the request does not say which form. The multi-file run labelled the same failure spec-gap. |
| w, item 05, run 2 | 1 of 2 | agent-error | It never sets `CurlOpt.NOPROXY`, which the request states. |

None is labelled harness: no run was cut by the time limit, and no check failed on the environment.

The registered reading's labels are the continued reading's for the runs both readings share. Each of its 55 cut and never-started runs is labelled harness.

## The criteria

| Reading | Delivered (primary, rule ≥ 80% of 32) | Friction (secondary, rule ≤ 1 per run) |
|---|---|---|
| **Continued** (cut runs replaced) | **25 of 32 (78%): missed** | 2 false in 32 runs (0.06): met |
| Continued, item 06's credential-cut run kept | 24 of 32 (75%): missed | 1 false (0.03): met |
| Registered (the batch as the first restart left it) | 3 of 32 (9%): missed | 0 false: met |

The registered reading counts 51 never-started and 4 cut runs as not delivered, so it says little about the engine. Its medians count the never-started runs as zero minutes and are not reported.

**Reported with no criterion, continued reading:**
- **Within 2 hours:** 22 of 32. Three delivered runs took longer: item 05's first (133.7 minutes) and both of item 06 (183.2 and 179.0). None was cut by the 4-hour limit, so there is no delivered-then-cut run to name.
- **In-sample** (items 01, 05 and 07): 6 of 6 delivered. **Out-of-sample:** 19 of 26 (73%).
- **Hidden checks:** engine 29 of 32, bare 28 of 32. The stratified permutation test gives a difference of 0.031 and p = 1.0, over 16 items and 64 runs.

| Item | Engine delivered | Engine passed | Bare passed |
|---|---|---|---|
| 01 (in-sample) | 2/2 | 1/2 | 0/2 |
| 02 | 1/2 | 2/2 | 2/2 |
| 03 | 2/2 | 2/2 | 1/2 |
| 04 | 1/2 | 2/2 | 2/2 |
| 05 (in-sample) | 2/2 | 2/2 | 1/2 |
| 06 | 2/2 | 2/2 | 2/2 |
| 07 (in-sample) | 2/2 | 2/2 | 2/2 |
| 08 | 2/2 | 2/2 | 2/2 |
| 09 | 0/2 | 2/2 | 2/2 |
| 10 | 2/2 | 2/2 | 2/2 |
| 11 | 1/2 | 2/2 | 2/2 |
| 12 | 2/2 | 2/2 | 2/2 |
| 13 | 2/2 | 2/2 | 2/2 |
| 14 | 0/2 | 0/2 | 2/2 |
| 15 | 2/2 | 2/2 | 2/2 |
| 16 | 2/2 | 2/2 | 2/2 |

## Why engine runs did not deliver

Seven of the 32 planned engine runs did not deliver in the continued reading. Every one stopped to ask a user, and no one answers a headless run. No run reached the 4-hour limit, and every record passed its chain check (the harness's audit, `store.audit`). Delivery itself also requires every approved file to be unchanged, which `deliver` checks.

- **An approved file changed after approval: three runs** (item 02's first, and the second runs of items 09 and 11).
  - What happened: `deliver` refused the changed file, and the only way back was `gate reopen`, which only the user may run, so the orchestrator stopped to ask.
  - **Items 09 and 11:** Mealie's code generator (`dev/code-generation/main.py`) ends in `gen_py_schema_exports.py`.
    - That script builds its file list as a generator and uses it up on `ruff check --fix`. It then runs `ruff format` with no paths, which formats the whole project.
    - ruff 0.16 formats the Python blocks in Markdown files, and nothing excludes `.eccode/`, so it rewrote the approved design spec.
    - Reproduced on item 11's source: running the generator turns the approved spec (sha `45452f2b`) into the run's final file (`80f9fba2`).
  - **Item 02:** a backend engineer ran `ruff format mealie tests/…`. That rewrote the whole package, including a file another task owned and a phase gate had approved four minutes before.
  - All three changes pass both hidden checks.
  - Now fixed: the gate's author resubmits with the current files and its reviewer reviews again (row 140). Engineers run formatters only on their own files (row 141).
- **Mealie's code generator was not run: two runs** (the first runs of items 04 and 09).
  - `uv run python dev/code-generation/main.py` and `task dev:generate` were refused, because the tool list allows neither `uv` nor `task`.
  - The plain `python dev/code-generation/main.py` was allowed, and `PYTHONPATH=.` (spec 4.1) made it importable. The orchestrator declined it as a way round the refusal and stopped to ask.
  - Both changes pass both hidden checks.
  - Now mitigated by guidance for the orchestrator and the engineers (row 142).
- **A file move or delete was refused: both runs of item 14.**
  - Run 1 stopped in its first task to ask the user to run `mkdir` and `git mv`. Run 2 stopped to ask for `git rm` of three old prompt files.
  - Both bare runs passed every hidden check under the same tool list, by writing the new files and leaving the old ones, so the item is solvable as given.
  - Labelled agent-error, with the refusal as its trigger. Each engine run passes 1 of 2 hidden checks: the rest of the change was never built.
  - Now mitigated by guidance (row 143).
- **The credential:** item 06's second run was ended by the 401 at 13:04Z. It did not deliver, and both its hidden checks pass. The continued reading replaces it with a run that delivered; the reading that keeps it has 24 of 32.

## What the engine did (reported, no criterion)

- **Time:** no run reached the 4-hour limit. The multi-file run's four timeouts were all on item 07; here both of item 07's runs delivered, in 60.5 and 103.3 minutes.
- **Reviewed rescope:** one run used it, item 05's first. Its delivery lead proposed four changes, and the technical reviewer approved all four:
  - two checks narrowed from a repo-wide `ruff` that failed on findings in files no task owned;
  - two test files that no task owned, which patched calls the change removed.

  The run delivered. In the multi-file run, the same kind of stop waited for the user.
- **Tests:** every engine patch adds or changes tests (32 of 32), against 21 of 32 bare.
- **Cost:** a median engine run cost $3.45 and a bare run $0.42 (8.2×). They took 53.3 and 5.6 minutes.

## Refusals

The continued reading's 32 engine runs met 605 refusals:
- **399 harness:** the benchmark's tool list refused the command. The guard profile adds no permission rules.
- **122 correct:** an engine rule held as designed, for example the main session acting as another role, or identity built through shell expansion.
- **82 agent-error:** the CLI called wrongly, or a review file that broke its schema.
- **2 false:**
  - the guard read `sed -n …p` as an in-place edit because a sandbox path held `-i` (row 139, fixed);
  - `git worktree list; ls .eccode | head` was refused, though each part alone is allowed. That is row 91's rule against a program and a record path on one line, which stands.

All 689 refusals in the batch's engine transcripts are labelled. That includes those of runs no reading counts: cut, dropped and abandoned runs.

## Defects found

**Fixed, each with a test that failed first:**
- **Engine: an approved file that changed had no way back but the user's** (row 140). Three of the run's undelivered engine runs stopped there.
- **Guard: `sed` read as writing in place** when any word in the command held `-i`, such as a sandbox path ending `-engine-iPIAtW` (row 139). This was the run's only false refusal.
- **Harness: an agent's leftovers in sessions of their own** (row 144, mitigated).
  - Claude Code runs each tool command with `setsid`, so the harness's process-group kill missed a timed-out agent's running command. That command could write on into the sandbox while the hidden checks ran.
  - On Linux the harness now also stops every process working in the sandbox.
  - No run of this batch reached its limit, so no result was affected.

**Guidance, not yet measured** (each pinned by a test):
- formatters run on the task's own files, and a generator's output is named in the handoff (row 141);
- a refused wrapper does not forbid the command it wraps (row 142).
  - The first version reached only the engineers. A re-read of the transcripts showed that the orchestrator declined in both runs, so it now carries the rule too.
- a refused file move or delete is routed around, not a question, unless the request needs it (row 143). The orchestrator still asks the user before deleting data.

**A limit, named:** completing a task checks ownership against the files its handoff lists, so a formatter's rewrite of another task's file is found at audit, not at completion (row 141).

**The run's own tools,** each fixed with a test that failed first before the figures it affects:
- `resume.js` refused a file it had already resumed (`2571d5d`, amendment 2);
- the continued reading could not drop a run that an infrastructure failure stopped after it wrote a result (`76a6666`, amendment 3);
- friction counted the transcripts of runs outside the reading: cut runs, the abandoned run and the dropped one (`da6d546`).
  - Both readings showed the same 638 refusals.
  - The earlier runs' figures are unchanged: none of the 299 refusals the proof run labelled, or the 348 the multi-file run labelled, lies outside a run of its reading.

## Disclosures

- **Three container restarts and an expired credential** cut or ended runs. Every amendment was committed before the runs it governs. The registered reading counts every cut and never-started run as not delivered.
- **The operator's failed stop.** At 13:06Z the operator signalled the process of a run the credential had cut, saw it gone, and removed its sandbox to start the next attempt.
  - The run went on. Its agent worked in the removed sandbox until 13:09Z, and its harness then crashed in the git step. Why the signal missed is not known.
  - In this shell, a background `setsid` forks, so the recorded pid is a parent that has already exited. The three final processes were watched by their real pids.
  - The run wrote no result and is in no reading.
- **e1's last three runs ran at once,** as three processes (amendment 4), not one after another. The batch ran four processes at once.
- **Replacement runs ran after their process ended,** as amendments 1 and 2 allow, under the load of the processes still running. Failed runs were replayed for labels once at most three batch processes remained.
- **What the runs measured:** every run used the protocol commit's engine, agents and suite. The replacement runs ran from a worktree whose only differences are the resume tool and the protocol text. None of the fixes above was in any run.
- **In-sample items.** The engine's changes were shaped by the multi-file run's failures on items 01, 05 and 07, so their six runs are reported apart.
- **A clean audit** in the criteria is the record's chain check. A delivered run also passed `deliver`'s check that every approved file is unchanged.

## What this means

- **The changes did what they aimed at, and delivery still missed by one run.**
  - No run timed out, the in-sample items delivered 6 of 6, and a rescope that once needed the user was reviewed and applied.
  - The misses came from places the multi-file run never reached: Mealie's own tools rewriting reviewed files, a generator behind refused wrappers, and file moves the tool list refused.
  - The undelivered changes were mostly right, 5 of 7 passing every hidden check, and the record of each was intact. What failed was the way forward, not the work.
- **The fixes are not measured.** Rows 140–143 change exactly what stopped these runs, but no run has used them. Row 138 stays open. Closing it needs a registered run with them in place, ideally on other projects as well as Mealie: two of the three new stops came from Mealie's own tooling.
- **Correctness: no difference shown.** Engine 29 of 32 and bare 28 of 32. The bare agent made its own mistakes on items 01 and 05. The engine fixed item 05 in both runs and item 01 in one, and lost item 14 by stopping. Row 59 stays open.
- **Cost:** the engine costs about eight times a bare run on these changes. For that, it adds tests to every change and a reviewed record of every step.
