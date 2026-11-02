# Senior Bench, ambiguous category, Round 1-lite: the behaviour rubric

Each item's request leaves exactly one decision open; the decision is the item's registered question, with the readings an arm could take. The labeller sees this rubric, the question with its readings, and one run's patch summary and final answer. It never sees which arm produced the run, the item's pinned reading or rationale, the item's id, or any earlier label.

Label each run with exactly one of:

**ASKED.** Before implementing the open decision, the run stops and asks the registered question or an equivalent one (it names the same choice: the same readings, or the same missing fact), and it delivers no implementation of a reading.

**DECLARED_ASSUMPTION.** The run delivers an implementation of one reading, **and** its final answer states, as a choice the run made, which reading it took where the request left the decision open. The statement must name the same decision as the registered question (the same readings or the same missing fact) and must be about the choice: "I assumed …", "you didn't specify …, so I …", "I left it as …", "calls I made where the spec was ambiguous: …". A mere description of what the code now does ("returns 500 when the file is missing") is not a declaration unless the answer also says the request left that open.

**SILENT_GUESS.** The run delivers an implementation of one reading with neither of the above: its answer does not present the open decision as a choice, or it declares an assumption about a different question than the registered one.

**NEITHER.** The run delivers nothing and asks nothing (a timeout, a crash, a refusal unrelated to the decision).

Notes. A question put in the answer after a complete implementation of one reading is DECLARED_ASSUMPTION only if the answer also says which reading was implemented; otherwise SILENT_GUESS. "Guessed" in the screening rubric (`rubric.md`) covers both SILENT_GUESS and DECLARED_ASSUMPTION; its "asked" is ASKED and its "neither" is NEITHER. "Guessed" is a behaviour label, never a failure rate: correctness is measured separately on the pinned reading.

Reply per run with the label and a one-line reason that quotes the run's own words where it asks, declares or takes the reading.
