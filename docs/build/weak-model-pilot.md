# Weak-model pilot W1: does ECCode lift a weak coding agent? (registered 2026-11-12, before any run)

This file changes nothing in the S4 plan or its addenda. The S4 plan fixes `claude-opus-5-5` for every arm, so it
cannot test the owner's stated goal of 2026-11-12: "upgrade any weak agent ... build projects with almost no
prompting". Every earlier comparison in this repository used Sonnet or Opus. W1 is the first test on a weak model.
It is a small, cheap pilot. It is an indicator, not proof.

## Claim under test
With ECCode installed, a weak coding agent delivers a project from one prompt, with no human interaction, better
than the same weak agent alone.

## Arms (same workspace, same brief, one prompt, no human message after it)

| Arm | Model | ECCode | Prompt |
|---|---|---|---|
| **w** weak alone | `claude-haiku-5-5` | no | `P` |
| **e** weak + ECCode | `claude-haiku-5-5` | plugin loaded with `--plugin-dir` (export of this branch without `docs/`, `.eccode/`, `.supervisor/`) | the text of ECCode's own entry command `commands/start.md`, with `P` as the idea |
| **s** strong alone (cost and quality reference) | `claude-sonnet-5-5` | no | `P` |

`P` = `Deliver the project described in brief.md in this directory. I am unreachable, so do not ask me anything: decide and finish.`

Held equal: Claude Code version, `--setting-sources ""` (no user settings, plugins or skills), `--strict-mcp-config`
(no MCP servers), the same allowed tools, `--max-turns 200`, a 40-minute wall limit. Arm e alone has the plugin.
There are no resumes: a run that stops is scored as it stands.

## Projects (hidden acceptance oracles that are not in this repository)

| Project | Start state | Oracle |
|---|---|---|
| `csvmd` | a small starter package and `brief.md` | 18 checks |
| `textkit` | empty directory and `brief.md` | 21 checks |

Both are small (one session for a strong model). The claim is about medium and large projects; W1 cannot show
that. If W1 shows a gain, the next step is a medium project. If it shows none on small work, that is recorded too.

## Runs
Arms w and e: 3 runs per project (12 runs). Arm s: 1 run per project (2 runs). Order interleaved w, e, w, e, ...

## Measures, per run
- **Q** oracle checks passed (the main measure).
- **H** honesty: did the final message claim the project complete, and was it (Q = max)?
- **C** cost in dollars, **T** turns and wall seconds, as Claude Code reports them.
- **U** whether arm e actually used ECCode (an `eccode` command ran). A run where it did not is reported as such.

## Reading the result (fixed now)
- "Better" on Q means the arm's mean is at least 2 checks higher on a project **and** its worst run is not below the
  other arm's worst run. Anything less is "no difference shown".
- ECCode **lifts the weak agent** on a project if e is better than w on Q.
- ECCode **closes the gap** if e's mean Q is within 1 check of arm s.
- **Worth its cost** needs both: e better than w on Q, and e's cost per run below arm s's cost per run.
- With 3 runs per arm these are indicators. No p-values. Every run is listed.

## Validity checks
- Contamination: each transcript is scanned for the oracle's path and file name. A hit voids the run.
- The arms run outside a sandbox in separate temporary directories (the cloud host cannot give model access
  inside the bubblewrap sandbox). An arm could in principle read other files on the machine; the scan is the check.
- A run that ends on the turn or time limit is scored as it stands and marked.

## Limits known before the run
- Small projects, one model pair, n = 3: no general claim follows.
- ECCode is entered through its documented command text. A different entry (for example `eccode-gf`) may behave
  differently and is not tested here.
- The oracles were written for another repository's benchmark. They were never shown to any arm.

## Status and how to run (added 2026-11-12, after registration; nothing above was changed)

**Not run yet.** In the Claude cloud session two routes were tried and neither is usable: starting unsandboxed
headless agents was refused by the session's safety check, and inside the plugin-eval sandbox the shell cannot write
the project, where ECCode's own CLI cannot keep its record, which would handicap arm e. W1 therefore runs on a
machine where Claude Code is logged in. Use a scratch directory or a throwaway VM: the arms run shell commands.

The two briefs, the starter and the oracles are in the public repository `TOUMO45/Supervisor-Skill` under
`tests/e2e/`. Clone it next to this one, outside any arm's workspace.

```bash
E=../Supervisor-Skill/tests/e2e; OUT=~/w1
node tools/weak-pilot.js run --arm w --project csvmd --run 1 --out $OUT --brief $E/brief.md --starter $E/starter --oracle $E/hidden_acceptance.py
node tools/weak-pilot.js run --arm e --project csvmd --run 1 --out $OUT --brief $E/brief.md --starter $E/starter --oracle $E/hidden_acceptance.py
node tools/weak-pilot.js run --arm w --project textkit --run 1 --out $OUT --brief $E/parallel/brief.md --oracle $E/parallel/hidden_acceptance.py
node tools/weak-pilot.js run --arm e --project textkit --run 1 --out $OUT --brief $E/parallel/brief.md --oracle $E/parallel/hidden_acceptance.py
```

Repeat with `--run 2` and `--run 3`, then once each with `--arm s`. Each call prints one line (oracle score, cost,
turns, seconds, whether ECCode was used) and writes `result.json` and the transcript beside the workspace.

## Result (2026-11-13; run by the owner on Windows; nothing above was changed)

All 14 registered runs were done, plus one uncounted trial (`textkit w0`). ECCode was used in all six arm-e runs
and no transcript was contaminated. The table is copied from the owner's terminal; the raw `result.json` files
and transcripts are on the owner's machine and are not in this repository.

| Run | Q as scored | Cost $ | Turns | Seconds | Timed out |
|---|---|---|---|---|---|
| csvmd w1, w2, w3 | 18/18, 18/18, 18/18 | 0.76, 0.58, 0.64 | 18, 16, 16 | 103, 79, 85 | no |
| csvmd e1, e2, e3 | 17/18, 18/18, 18/18 | not reported | not reported | 2400 each | **yes, all three** |
| csvmd s1 | 18/18 | 0.42 | 14 | 64 | no |
| textkit w1, w2, w3 | 5/21, 5/21, 21/21 | 0.63, 0.81, 0.97 | 17, 21, 17 | 90, 114, 140 | no |
| textkit e1, e2, e3 | 21/21, 21/21, 21/21 | not reported | not reported | 2400 each | **yes, all three** |
| textkit s1 | 21/21 | 0.46 | 8 | 81 | no |

**Read by the registered rule, as scored:** on textkit arm e is "better" than arm w (mean 21 against 10.3, worst
21 against 5), so the rule says ECCode lifts the weak agent on textkit and closes the gap to arm s. On csvmd there
is no difference.

**That reading does not hold: the oracle was wrong on Windows.** The textkit oracle compared program output byte
for byte with text ending in LF. Python on Windows prints CRLF. A correct project that prints CRLF fails every
output check and passes exactly the five that compare no printed text, which is the score 5. Re-scored on the same
workspaces with CRLF accepted, **all eight textkit projects, from every arm, score the same** (20/21 each; the one
shared miss comes from how the patched copy of the oracle was made on Windows, which damaged the accented test
string, and is not a property of any project). The oracles are corrected in `TOUMO45/Supervisor-Skill`.

**What W1 shows**
- **No quality difference between Haiku alone and Haiku with ECCode** on either project, once the oracle is fair.
- **ECCode did not finish in 40 minutes in any of six runs.** Haiku alone took 79 to 140 seconds. The product was
  already passing when the limit cut the run off, so the time went to ECCode's own process.
- **Cost of arm e is unknown**: a run stopped by the limit does not report it. "Worth its cost" cannot be judged.
- **Sonnet alone** matched or beat both Haiku arms, was the fastest, and cost less per run than Haiku alone
  (0.42-0.46 against 0.58-0.97). On these projects the weak model was not the cheap one.
- One observation, not a finding: before the oracle fix, all three arm-e runs and the Sonnet run printed LF and
  three of four Haiku-alone runs printed CRLF. This may reflect more careful output handling. It was not planned
  as a measure and nothing is claimed from it.

**Limits, as registered:** two small projects, one weak model, three runs per arm. Both projects are at the
ceiling for Haiku alone, so W1 could only have shown a lift where the weak agent fails, and it did not fail here.
W1 says nothing about medium or large projects.

**Defects of the pilot itself:** the oracle's line endings (fixed); the runner loses cost and turns when a run
hits the wall limit; the 40-minute limit was too short to see whether ECCode ever finishes.
