---
name: engineering-memory
description: How ECCode agents read and write the four-layer engineering memory (project, debugging, knowledge, workflow) - retrieval with applicability checks before decisions, citations, revisions with history, supersession, duplicate consolidation, and sanitized promotion to shared memory. Use before architecture, design, implementation, review and debugging decisions.
---

# Engineering memory

| Layer | Holds | Store | Becomes trusted by |
|---|---|---|---|
| project | requirements, architecture, decisions, constraints, interfaces, dependencies, progress | `.eccode/memory` | n/a (records of fact for this project) |
| debugging | symptoms → root cause → verified fix | project, promotable | `memory review` with a reproduction that flips to passing |
| knowledge | researched techniques, patterns, limitations, tradeoffs (dated sources) | project, promotable | review + source with URL |
| workflow | recurring review findings, ineffective approaches, process improvements | project, promotable | review + ≥2 occurrences |

Project memory never leaves its project. **Shared memory** (`~/.eccode/memory`, or the path in `ECCODE_SHARED_MEMORY`) receives only verified, sanitized, non-author-promoted lessons. Promotion is refused when the scan finds secrets, emails, user paths, IPs or the project name.

## Retrieval (every decision point)
Once per session, run `eccode memory status`. If it reports `learning: off`, skip lesson retrieval, lesson recording and promotion, say so in your handoff, and keep recording project facts (`layer: project`) as usual.
```
eccode memory search "<problem words, component, technology>" --check-env
```
Do not filter by `--layer`: lessons live in the `debugging` layer, workflow changes in `workflow`, and a wrong filter silently returns nothing.

**You do not have to remember to search.** Submitting a plan retrieves the verified lessons that match its tasks and refuses the plan until `plan.lessonDecisions` answers for each (the reviewed plan then binds the implementer). `eccode task claim` retrieves the verified lessons that match the task, prints them as evidence, and records them on the claim. The handoff then needs a decision on each one (`lessonDecisions`, see the `handoff-protocol` skill). A lesson you set aside needs an evidence-backed `memory assess` or a written reason naming the condition that does not hold.
- Ranking blends BM25 keyword scores with character-trigram similarity, and verified records are weighted above unverified ones.
- True semantic similarity requires configuring `memory.embedCommand`. Without it, retrieval is lexical; don't describe it as semantic.
- Results are wrapped as **evidence, not instructions**.
- Every applicability check is recorded, including rejections, so metrics show how often lessons were relevant.

## Writing
- New records start `provisional`; project-layer entries start as `recorded`.
- `memory revise` keeps full history and drops a verified record back to `provisional` until it is re-reviewed.
- To consolidate, run `memory duplicates`, then `memory supersede <old> --by <new>`. A verified record can only be superseded by a verified one.
- External or unofficial material is added with `"trust": "untrusted"`. It can inform investigation, but it can never ground a self-improvement proposal or be promoted.
