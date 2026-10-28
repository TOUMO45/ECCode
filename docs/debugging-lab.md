# The Debugging Lab

On the `debug` and `fix` tracks the engine refuses a fix that was found by trying edits until a test passes. A fix needs, in the record:

1. a **reproduction** the engine ran and pinned (`repro.recorded`), which failed;
2. **hypotheses** with the observation each predicts if it holds and if it does not (`hypothesis.opened`);
3. **evidence** for or against each, from commands the engine executed, with the artifact in the log (`hypothesis.evidence`);
4. one hypothesis closed **confirmed** on unchallenged `supports` evidence (`hypothesis.closed`);
5. a **root cause** on that hypothesis: locations, the causal explanation, why the reproduction fails (`rootcause.declared`);
6. the **proof** on the pinned reproduction command: `fix verify` on the debug track, the reproduction pair on the fix track.

Refuted hypotheses stay in the record and in the final handoff: they are evidence too. The orchestrator's `commands/debug.md` puts these steps in the owner's dispatch.

## The gates (engine-enforced; `tests/lab.test.js`, `tests/phase2-bypass.test.js`)

| Rule | Where it refuses | Code |
|---|---|---|
| No fix without a confirmed, evidence-backed root cause | `task complete` of a task that changed code; the last gate's submission | `INVALID_HANDOFF` (`lab: no root cause declared`), `TRACK_RULE` |
| A hypothesis is not confirmed from prose | `debug hypothesis close --status confirmed` without executed, unchallenged `supports` evidence | `EVIDENCE_REQUIRED` |
| Evidence is a command the engine ran for that hypothesis | a `hypothesis.evidence` naming a pinned file, another run, a missing or edited log | `EVIDENCE_NOT_EXECUTED`; `audit` fails on the edited log |
| The reproduction is pinned | `fix verify --test <other>`; a second `debug repro` by the owner; the fix track's pair on another command | `REPRO_PINNED`, `TRACK_RULE` |
| A passing command reproduces nothing | `debug repro` with exit 0 (the run stays recorded as a check) | `REPRO_PASSED` |
| Existing tests are not the fix | completion with lines changed or removed in a test file that existed at the claim base, undeclared; approval without the reviewer's acknowledgement | `INVALID_HANDOFF` (`handoff.testChanges`), `REVIEW_REJECTED` (`review.acknowledgedTestChanges`) |
| Budget | `debug hypothesis add` after `lab.hypothesisBudget` refuted or withdrawn hypotheses (default 5) or `lab.timeBudgetMinutes` (default 240) without an escalation | `LAB_BUDGET`; `debug escalate --kind rescope\|ask-user` records it |
| No probe ships | completion, the last gate and `deliver` with an `eccode-trace-probe` marker in a changed file | `INVALID_HANDOFF`, `TRACK_RULE`, `DELIVERY_BLOCKED` |

A new test file, or a test appended to an existing file, needs no declaration: only changed or removed lines of a pre-existing test do. Two more rules close the ways around that:

- **The test-outcome invariant.** At the claim on these tracks the engine runs the pinned command on the claim base, in a detached worktree, and records every collected test with its outcome (`tests.baseline`; per-test outcomes are captured for pytest runs through `PYTEST_ADDOPTS`, so the command text never changes). At completion, the cited passing run of the pinned command is compared with it: a test that passed on the baseline and is now **missing** (deselected, not collected), **skipped**, **xfail** or **failing** refuses the completion unless declared in `handoff.testChanges` by test (`"<module>::<name>"`) or by file, and the reviewer acknowledges it. Test infrastructure (`conftest.py`, `pytest.ini`, `tox.ini`, `setup.cfg`, `pyproject.toml` when the changed lines concern pytest, `fixtures/` directories) is under the same gate for any change, additions included.
- **A test that patches the fixed module** (`monkeypatch.setattr`, `mock.patch`, `sys.modules[...] =` on a symbol of a changed source file) is refused unless declared and acknowledged: a regression test runs the real fixed code.

Bypasses refused by `tests/test-invariant.test.js`: a skip added through `conftest.py`, a `--deselect` added to the pytest configuration, an xfail marker added to an existing test, and a new test file that monkeypatches the fixed function.

## Tools

```
eccode debug repro --actor <owner> --task fix -- <command>        # runs it (must fail), pins it
eccode debug hypothesis add "<statement>" --if-true "<obs>" --if-false "<obs>" --actor <owner>
eccode debug hypothesis test h1 [--supports|--refutes] --actor <owner> -- <command>
eccode debug hypothesis mark he-… --supports|--refutes|--inconclusive --actor <owner>
eccode debug hypothesis close h1 --status confirmed|refuted|withdrawn --actor <owner>
eccode debug hypothesis challenge h1 --evidence he-… --reason "<why>" --actor technical-reviewer
eccode debug localize --sbfl [--tests tests/] [--top 5] --actor <owner>
eccode debug bisect --good <ref> [--bad HEAD] --actor <owner>
eccode debug trace h1 --at shop/pricing.py:34 --expr "(page, start)" --actor <owner>
eccode debug rootcause --hypothesis h1 --at shop/pricing.py:34 --explain "<cause>" --why-repro-fails "<link>" --actor <owner>
eccode debug escalate --kind ask-user --reason "<question>" --actor <owner|orchestrator>
eccode debug show
```

- **`localize --sbfl`** runs the pinned pytest reproduction and the passing tests once under `coverage.py` with one dynamic context per test function (`scripts/lab/sbfl.py`, in a temporary directory, nothing written into the project), then scores every line with **Ochiai**: `ef / sqrt((ef + nf) · (ef + ep))`, where `ef`/`ep` are the failing/passing tests that execute the line and `nf` the failing tests that do not. Ties go to the line more failing tests reach, then to the one fewer passing tests reach. The ranking is an artifact under `.eccode/lab/`, hashed into `localization.result`. Python only; the interpreter comes from `ECCODE_PYTHON`, the project's `.venv`, or `python3`.
- **`bisect`** runs `git bisect run` with the pinned reproduction in a detached worktree (uncommitted test files copied in, dependency directories linked), after checking that the reproduction passes at `--good` and fails at `--bad` and that it is runnable at all (exit 126/127 is reported, not treated as "bad"). The working tree is never touched; the worktree is removed in `finally`; the first bad commit's diff is the artifact.
- **`trace`** inserts one probe line before the statement at `--at` (`__import__("sys").stderr.write("ECCODE_TRACE <id> " + repr(<expr>))` in Python, `process.stderr.write(...)` in JavaScript), checks the file still parses, runs the pinned reproduction, records the observed values as hypothesis evidence, and restores the file byte for byte (a recovery file under `.eccode/cache/` covers a killed run). The marker `eccode-trace-probe` is what the gates look for afterwards.

## Worked example (the fixture `tests/fixtures/phase2`, bug `off-by-one`)

```
$ eccode debug "page 2 of /items skips its first item" --actor orchestrator --command "python -m pytest tests"
$ eccode task claim fix --actor backend-engineer
# write tests/test_bug_offbyone.py: assert page_bounds(1, 3) == (3, 6)
$ eccode debug repro --actor backend-engineer --task fix -- python -m pytest tests/test_bug_offbyone.py
Reproduction pinned: rp-… — python -m pytest tests/test_bug_offbyone.py failed with exit 1 (ev:ev-…)
$ eccode debug localize --sbfl --actor backend-engineer
SBFL (Ochiai) over 1 failing and 15 passing test(s), 5 line(s) scored:
  1. shop/pricing.py:35  score 1  (failing 1, passing 0)
  2. shop/pricing.py:33  score 0.577  (failing 1, passing 2)
  …
$ eccode debug hypothesis add "page_bounds adds one to start on every page after the first" \
    --if-true "page_bounds(1, 3) returns (4, 6)" --if-false "page_bounds(1, 3) returns (3, 6)" --actor backend-engineer
$ eccode debug trace h1 --at shop/pricing.py:36 --expr "(page, start)" --actor backend-engineer
Trace he-… for h1 at shop/pricing.py:36 (probe reverted): (page, start) observed 1 time(s)
  (1, 4)
$ eccode debug hypothesis mark he-… --supports --actor backend-engineer
$ eccode debug hypothesis close h1 --status confirmed --actor backend-engineer
$ eccode debug rootcause --hypothesis h1 --at shop/pricing.py:34,shop/pricing.py:35 \
    --explain "The bounds add 1 to start when page > 0, so every page after the first drops its first item." \
    --why-repro-fails "page_bounds(1, 3) returns (4, 6) instead of (3, 6)" --actor backend-engineer
# fix shop/pricing.py, then the usual debug-track path: evidence run, fix verify (on the pinned command), mutate, handoff, lesson, submit, review, deliver
```

The final handoff's **Debugging Lab** section lists the reproduction, every hypothesis with its status and evidence, the localizations, the root cause and any escalation, all from events.

## MCP

`lab_repro`, `lab_hypothesis_add`, `lab_hypothesis_test`, `lab_hypothesis_mark`, `lab_hypothesis_close`, `lab_hypothesis_challenge`, `lab_localize`, `lab_bisect`, `lab_trace`, `lab_rootcause`, `lab_escalate`, `lab_show`. Over MCP a command is an approved one (planned checks, stack checks) or the pinned reproduction; the engine's role rules decide who may call what (investigators: the implementation roles; challenges: the reviewers).

## Limits

See `docs/limits.md` rows 139–144, 152 and 153: Python-only SBFL; bugs at import time or by omission that SBFL cannot rank; bisect needs a known good commit; probes before a block header or inside an expression do not parse; the budget counts refutations, not effort; a reviewer's challenge is judgment, not proof.
