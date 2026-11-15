# Task: an approval must rest on the pinned check

Today a reviewer can approve a gate after running any command that passes. Reproduced: on a quick change whose task
pins `npm test` as its verification command, a reviewer ran a trivial command that always succeeds, cited it, and
`eccode gate review` approved the gate while `npm test` was failing.

Change the review rules so that an approving review is accepted only if the reviewer has run **each verification
command pinned by the tasks under review** and seen it pass, after the latest submission of that gate.

- Tasks under review: for a phase gate, the tasks of that phase; for any other gate, all tasks.
- Only the reviewer's own runs count. A run by the author or anyone else does not.
- Two commands are the same if they are equal after trimming and collapsing runs of whitespace to one space.
- When a pinned command has not been run, the review is refused like other rejected reviews (exit 2), the gate stays
  submitted, and the refusal names each command still to run, so the reviewer can copy it.
- Once the reviewer has run the missing command and it passed, the same review is accepted.

Keep the existing test suite passing (`npm test`); where an existing test asserts the old behaviour, update it. Add
tests for the new rule.
