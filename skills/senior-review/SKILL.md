---
name: senior-review
description: Senior code review and repository audit rubric - correct, safe, holds under the expected load, tested, fast, lean - where every finding carries a concrete failing case and the smallest fix. Used by ECCode reviewers on phase and verification gates and by /eccode:review and /eccode:audit for one-shot reports on a diff, branch, PR, path or whole repository.
---

# Senior review

Review as if you will be paged when this breaks. Check in this order: **correct → safe → holds under the expected load → tested → fast → lean**. Lean matters, because every extra line is future work, but a bug always outranks a size point.

## 1. Build the picture first
- **Scope.** Review what was named: a gate submission, uncommitted changes, a commit, a branch, a PR, a path, or the whole repository. If nothing is named, review the uncommitted changes, or the last commit when there are none.
- **Read around the change.** Read the change, then the code around it: every caller of a changed function (grep them), what the changed code calls, its tests, the docs. A changed signature, return value or behavior can break code the diff never touches.
- **Trace the data.** Where does it enter, what is stored, what leaves?
- **Assume a load and say which.** Find the expected load in the repository (README, deployment config, the brief's non-functional requirements): one person running a script, or many users and processes at once. State the load you assumed.
- **Large repositories.** Go deep where mistakes cost most: input handling, auth, money, data writes, background jobs, shared state. `eccode map` shows the structure, and `eccode debt` shows the declared shortcuts. Say which areas you did not read.

## 2. Look for
1. **Correctness.** Wrong results, crashes, edge cases (empty, zero, one, last item, duplicates, rounding, time zones, encoding). Callers broken by the change. A fix in one caller while the shared function stays wrong. The same rule implemented differently in two places.
2. **Safety.** Injection, missing authorization or ownership checks, secrets in code or logs, weak randomness, untrusted text reaching a model's instructions or tools, data loss (swallowed errors, writes in the wrong order, missing transactions).
3. **Load.** Check-then-act races, lists/caches/queues that only grow, one query per item, quadratic work on large input, per-process state that must be shared, outbound calls without timeouts.
4. **Tests.** Risky logic (branches, parsing, money, security, data writes, bug fixes) without a test that would fail if it broke. One meaningful test beats coverage numbers. Tests should check behavior, not implementation details.
5. **Speed.** Real slowdowns are findings. Micro-optimizations are suggestions.
6. **Lean.** Code that should not exist or should be smaller:
   - *delete*: dead code, unused options and flags, speculative features;
   - *reuse*: the codebase already has it (name the path);
   - *platform*: the standard library or an installed dependency already does it; a new package for a few lines;
   - *yagni*: an abstraction with one implementation, a factory with one product, a pass-through wrapper, config nobody sets;
   - *merge*: near-duplicates that must change together;
   - *split*: one unit doing unrelated jobs, so it is hard to read or test. Split by responsibility, never by line count.

## 3. Prove each finding before you report it
- **State a concrete case.** Write "this input or situation leads to this wrong outcome". No case, no finding. Taste and "consider…" are not findings.
- **Re-read the lines.** Confirm the caller exists, the value can really be empty, the code is really unused (grep tests, config, and string or dynamic references too).
- **Demonstrate it when you can,** with a recorded command (`eccode evidence run --actor <you> …`). A failing check is the strongest evidence there is.
- **Declared shortcuts are decisions.** A `shortcut:` marker in the task's lean record or in `eccode debt` is not a finding, unless the expected load already exceeds the limit it names.
- **Propose the smallest fix that works.** Prefer fixes that delete code. Never propose layers, frameworks or config the problem does not need.

## 4. In an ECCode gate review
- **Read each task's lean record:** `eccode task list --json` → `lean`, which holds lines added/removed, `newDependencies`, `shortcuts`, `testsNotNeeded` and `warnings`.
  - For every new dependency: is the reason real, or would the codebase, the platform or an installed package do? Supply-chain questions (maintenance, license, known vulnerabilities) go to `security-reviewer`.
  - For every `testsNotNeeded`: is the logic really trivial, or covered elsewhere? Name the test.
  - Every warning recorded under `lean.level: lite` is a candidate finding.
- **Severity:**

  | Problem | Severity |
  |---|---|
  | Correctness, safety, data loss, failure at the expected load | `blocking` |
  | Untested risky logic, real slowness, duplication, an unjustified dependency | `major` |
  | Lean and small speed issues | `minor` |
  | Observations | `info` |

- **Recommendations.** Each finding's `recommendation` states the smallest fix and the condition that resolves it. The review JSON rules of the `review-gate` skill still apply.

## 5. One-shot report (`/eccode:review`, `/eccode:audit`)
Write short, plain sentences, and explain a technical term the first time you use it. The reader may not know this code.
- **Opening.** Start with **What this does:** in two or three sentences. For an audit, say what the repository does and which load you assumed.
- **Groups.**
  - **Must fix:** bug, security hole, data loss, or failure at the expected load.
  - **Should fix:** untested risky logic, real slowness, duplication, code that should not exist.
  - **Could fix:** small speed-ups, shorter forms.

  Number findings across all groups, so the user can say "fix 1 and 4". Skip empty groups. An audit lists at most 20 findings and says how many smaller ones it left out.
- **Each finding** gets a short title with `path:line`, then four short parts:
  - **What it is:** what this code does.
  - **Failure:** the concrete case and its outcome.
  - **Fix:** the smallest change.
  - **If skipped:** the cost.
- **Closing.**
  - `Verdict:` ship, fix N first, or healthy.
  - `Lean: about -N lines, -M dependencies possible`, when there are lean findings.
  - `Not checked:` anything that mattered but you could not read or run.
- **Nothing found:** say what you checked, then `Looks good. Ship.`

These reports describe problems only. Change no code unless the user then asks for fixes.
