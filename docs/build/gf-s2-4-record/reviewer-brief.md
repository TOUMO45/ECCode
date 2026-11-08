# Independent review of S2.4 (one reviewer, fresh context, briefed with the adversary rows)

You are a zero-context security reviewer. You did not build this and must not ask the builder. You attack the kernel-isolation layer S2.4 of the ECCode engine on the commit `f32b82a` of branch `claude/wonderful-goldberg-o6u7m6`, inside a checkout given to you. Your job: find a way a group role's command, or project code it runs, writes a file of ANOTHER group (or `.git`, or the record `.eccode/`) into the shared real tree, or gets the engine to commit such a change, WITHOUT the engine refusing it. Report what you find; do not fix anything, do not create a pull request.

## The system

A multi-agent engine gives each implementer "group" its own git worktree and runs the group's commands inside a kernel sandbox. Read these, in this order:
- `docs/design/greenfield-senior.md` section 21 (the design) and section 18.0 (the threat model) and 18.2 (the ownership map).
- `docs/build/gf-s2-4-evidence.md` (what was built, the P2 class-by-class answers, the residual limits L-GF-74 to L-GF-78).
- The code: `lib/greenfield/sandbox.js` (GF-ISO-0/1/4, the self-test canary, the write set, the mechanism choice, the scrubbed environment), `lib/greenfield/isolate.js` (the sandboxed run, the commit step GF-ISO-2, the merge GF-ISO-3, the dependency install, the audit replay), `scripts/sandbox/landlock_run.py` (the Landlock helper).
- The adversary's pre-build rows: `docs/build/gf-s2-4-adversary.json` (54 rows). These are HYPOTHESES written before the build; your job is to check whether the build actually answers them, and to find rows the adversary missed.

Threat model (18.0, unchanged): the sandbox prevents accidental and LLM-plausible cross-group writes on the managed path; deliberate same-uid attacks on the engine process are a named residual (L-GF-76), OS-level isolation is not claimed (L-GF-40), and a forged event appended by a writer the hook does not see is out of scope (detected by audit, not prevented). Attacks INSIDE the model — a group's command or project code writing another group's files through the filesystem, or the commit step committing such a change — are in scope and must be refused. Rows OUTSIDE the model (ptrace/process_vm_writev on the engine where no pid namespace exists, reading another process's memory or environment, a forged event) you list in your summary as outside-the-model, not as findings.

## This machine

Linux 6.18, Landlock ABI 7, bubblewrap 0.9.0, a pid namespace, running as root. So both mechanisms are available; the pid namespace is available, so the same-uid residual (L-GF-76) is mitigated here. Run the suite from the checkout: `node --test tests/gf-iso-*.test.js` (about 60 s), and `TMPDIR=<scratch> node --test <one file>` for a single file. The sandbox tests skip with a reason where a mechanism is missing; here nothing should skip.

## What to attack, concretely

1. **The sandbox (GF-ISO-1).** Can a command inside the sandbox write a file the write set does not include? Try: a path the write set's prefix logic mis-derives (a glob that is not `<dir>/**`); a carve-out (a denied sub-glob) that Landlock cannot enforce (the design says bubblewrap is chosen then — check it actually is, and that Landlock is NOT used with a carve-out); a device in `/dev`; a write through a symlink the command creates inside its own path; the private tmp as a channel. Write a probe under your scratch dir and run it through `gf_run` (a plan-pinned command) or directly via `lib/greenfield/isolate.js run`.
2. **The commit step (GF-ISO-2).** Can you get the engine to commit a file of another group, or outside the claimed task, or a non-regular file, or through a symlinked path, or with a tampered git config? The validate-and-commit must be one read of the bytes — check for a TOCTOU between the hash used to validate and the blob committed. Check the compare-and-swap ref update. Check that a file another group legitimately committed is ignored, not committed under this group.
3. **The merge step (GF-ISO-3).** Can a merge apply out of dependency order, or merge a branch that was never checked, or treat a real conflict as clean?
4. **The self-test (GF-ISO-0).** Can group mode proceed when the kernel does NOT contain the canary (a canary that is too weak, a verdict that passes on a leaked write)? Is the self-test required before every sandboxed run by the audit?
5. **The write set (GF-ISO-4).** A glob that widens the write set to another group's directory without being recorded; a widening the audit does not catch.

For each finding write a failing test or a probe under your scratch directory and name it. A finding is {id: "R-<n>", severity: blocking|major|minor, title, inModel: true, steps, what-lands-where, which-rule-should-have-stopped-it}. Classify severity: blocking = a cross-group or `.git`/`.eccode` write reaches the real tree or the engine commits it; major = an engine defect in scope that does not itself defeat isolation; minor otherwise.

When done, reply with: the count of findings, each finding (id, severity, one line, the reproduction path), the adversary rows you confirmed are actually blocked, the rows you could NOT confirm, your outside-the-model list, and whether you would give the build a GO or NO-GO for closing S2.4.
