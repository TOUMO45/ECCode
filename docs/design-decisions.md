# Design before code (Phase 3, Part A)

On the `feature`, `refactor` and `greenfield` tracks the engine refuses to let a task be owned until a design decision exists that compared at least two alternatives; the decision becomes an ADR the reviewer must cite; a spike is never delivered; and a blocking ambiguity in the request stops planning until the user answers it or a reasonable reading is recorded as an assumption that the report surfaces. `quick`, `fix` and `debug` are exempt (the small-change track and the Debugging Lab's tracks).

## The flow

```
eccode design alternatives --file options.json --actor technical-designer   # >= 2 options
eccode design decide --file decision.json --actor technical-designer         # chosen, rationale, every other option rejected
eccode design adr --actor technical-designer                                 # render .eccode/design/<id>.md
eccode design amend --decision <id> --file interfaces.json --reason "…" --actor technical-reviewer   # after work started, reviewer only
eccode design spike start --question "…" --paths spikes/** --actor backend-engineer
eccode design spike close <id> --proved "…" --actor backend-engineer
eccode request ambiguity --file questions.json --actor orchestrator          # [{id, text, blocking}]
eccode request clarify <id> --answer "…" --actor user                        # only the user clarifies
eccode request assume <id> --reading "…" --rationale "…" --actor orchestrator # headless: a recorded assumption
```

- `options.json` is `[{id, title, tradeoffs: {complexity, risk, performance, security, reversibility}}]`; every tradeoff must be stated for every option, and there must be at least two options.
- `decision.json` is `{alternatives: "<da id>", chosen: "<option id>", rationale, rejected: [{option, why}], interfaces: [{surface, target}]}`; every option other than the chosen one must be rejected with a reason. Once a task is claimed the decision is locked: a change is a reviewer's `design amend`.
- A spike's files may not appear in the delivered change, by path or by content hash (renamed spike code is still spike code); an open spike blocks task completion.
- The verification review on these tracks must cite `artifact:.eccode/design/<adr>.md`; delivery refuses an interface (a behavior-contract target, or a breaking API diff) the ADR does not declare and no amendment covers.
- A `blocking` question refuses `eccode gate start plan` (and planning on quick/debug is exempt) until the user clarifies it or the orchestrator records an assumption. The assumption is shown in every handoff and in the final report under "Assumptions and open questions", never silently resolved.

## Gates (tests in tests/design.test.js, with bypass cases)

| Rule | Code |
|---|---|
| No ownership on a design track without a decision over >= 2 alternatives | `TRACK_RULE` |
| A decision after implementation started | `DESIGN_LOCKED` |
| A spike's code in the delivered change | `INVALID_HANDOFF`, `DELIVERY_BLOCKED` |
| The verification review does not cite the ADR | `REVIEW_REJECTED` |
| An interface the ADR does not declare | `DELIVERY_BLOCKED` |
| Planning with a blocking question open | `AMBIGUITY_OPEN` |
| Only the user clarifies | `USER_AUTH_REQUIRED` |

## Limits

- The tradeoffs and the rationale are free text the engine checks for presence, not quality; a reviewer judges the content.
- The ambiguity stop fires only on questions someone records; the engine does not detect ambiguity on its own. The orchestrator's prompt is what surfaces the questions; the engine makes a recorded blocking question impossible to walk past.
