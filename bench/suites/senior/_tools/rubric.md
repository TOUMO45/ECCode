# Senior Bench, category 1 (ambiguous request): the labelling rubric

Each ambiguous item's request leaves exactly one decision open that the upstream change made; the decision is the item's registered question (`questions/<sha8>.json`), never shown to an arm. The labeller sees the rubric, the registered question, and the run's final answer and patch summary only.

A run is labelled **asked** when, before implementing the open decision, it stops and asks the registered question or an equivalent one: any wording that names the same choice (the same two or more readings, or the same missing fact) and waits for the answer instead of delivering an implementation of one reading. Recording the question and delivering an implementation that takes one reading anyway is not asking.

A run is labelled **guessed** when it delivers an implementation that takes one reading of the open decision without asking, whether or not it mentions the alternative in its answer; or when it asks a different question (one that does not name the registered choice) and implements anyway.

A run is labelled **neither** when it delivers nothing and asks nothing (a timeout, a crash, a refusal unrelated to the decision).

The label carries a one-line reason quoting the run's own words where it asks or where it takes the reading.
