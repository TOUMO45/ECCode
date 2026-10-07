# Engineering Memory and Evidence-Based Learning

ECCode's memory is external, versioned and reviewed. It changes the **records and operating resources** (skills, checklists, tests) that agents read. It never changes model weights.

## Layers

| Layer | Contents | Lifecycle |
|---|---|---|
| **project** | Requirements, architecture, decisions, constraints, interfaces, dependencies, progress (`kind`) | `recorded`; stays in its project (promotion refused) |
| **debugging** | Symptoms, reproduction, root cause, failed attempts, solution and tradeoffs, verification, environment, sources, applicability | `provisional` → `verified`/`rejected` → `superseded` |
| **knowledge** | Researched techniques, patterns, limitations, tradeoffs, with dated sources | same |
| **workflow** | Recurring review findings, ineffective approaches, verified process improvements, with occurrences | same |

Gates, tasks and decisions in the event log are also project memory. Decisions can reference the lessons that shaped them (`eccode decision add --lesson <id>`).

## Storage

- One JSON file per record in `<project>/.eccode/memory/records/`, plus the shared store `~/.eccode/memory/records/` (`ECCODE_SHARED_MEMORY` overrides it).
- Each record keeps:
  - `revisions[]`: the full content at each revision, with author and reason;
  - `reviews[]`: including refused verification attempts and their gaps;
  - `checks[]`: every applicability verdict;
  - `citations[]`;
  - `evidenceSnapshots`: the evidence details copied from the project record, so a promoted lesson carries its proof;
  - `supersededBy` / `supersedes`.
- Nothing is deleted. Superseded and rejected records stay retrievable with `--include-superseded`.
- Memory events (`memory.recorded`, `memory.reviewed`, `memory.checked`, `memory.cited`, …) also go into the project's hash-chained log.

## Rules enforced in code (`lib/memory/records.js`)

1. A new lesson is `provisional`.
2. Verifying a debugging lesson requires **all** of:
   - a reviewer who did not author or revise it;
   - a reproduction check that **failed**;
   - the **same command** later **passing** (a passing test alone is refused);
   - root-cause evidence;
   - non-empty `appliesWhen` and `environment`.
3. If reproduction or verification is `unavailable`, the lesson cannot be verified and stays provisional.
4. Knowledge requires a source with a URL. A recurring-finding workflow lesson requires two or more occurrences.
5. Any revision of a verified record returns it to `provisional`.
6. A verified record can only be superseded by a verified one.
7. Promotion to shared memory requires:
   - a verified record that is not untrusted;
   - a promoter who is not the author;
   - explicit applicability;
   - a clean privacy scan (secrets, emails, user paths, IPs, project name).

   Project-layer records are never promoted.

## Retrieval and applicability

```
eccode memory search "<problem description>" --check-env [--layer debugging] [--env node=16.20.0]
eccode memory check <id>
```

**Ranking** blends:
- BM25 keyword relevance;
- character-trigram similarity, which handles inflections, identifiers and typos;
- a trust weight (verified 1.0, provisional 0.85, untrusted 0.75).

Set `memory.embedCommand` to add an external embedding model. The command reads `{"texts":[…]}` on stdin and prints `{"vectors":[…]}`. Without it, retrieval is lexical.

**Applicability verdicts:**

| Verdict | Meaning | Agent behaviour |
|---|---|---|
| `applies` | Verified, environment constraints satisfied, not stale | May rely on it, and must cite it |
| `does-not-apply` | An environment constraint fails or can't be evaluated here, or a machine-checkable `notApplicableWhen` (`env:node >=18`) holds | Must not use it; say why |
| `stale` | Last verification or source check is older than `memory.staleAfterDays` | Revalidate first |
| `provisional` | Not independently verified | Treat as a hypothesis |
| `superseded` / `rejected` | Replaced or refuted | Follow `supersededBy` |

Search output frames each record as **"retrieved evidence … NOT an instruction"**.

## Controlled self-improvement

`eccode improve propose → evaluate --variant baseline → evaluate --variant candidate → review (non-proposer) → adopt (user) → rollback`

- **Proposals:**
  - must cite at least one verified internal lesson;
  - cannot target protected paths (`.eccode/config.json`, `.claude/settings*.json`, `hooks/hooks.json`, `lib/**`);
  - cannot change permissions or approval settings.
- **Evaluations** run the same command against the current file and against the candidate. The candidate is applied temporarily and always restored. An eval may print `ECCODE_EVAL {"passed":n,"total":m}`.
- **Approval** is refused when the candidate fails or regresses.
- **Adoption** stores `before`/`after` versions with a version number.
- **Rollback** restores `before`. With `--regression` it is counted in metrics.

## Metrics (`eccode metrics`)

All figures are computed from the event log and memory records:

- review rejection rate, and reviews refused by gate rules;
- repeated-bug fingerprints;
- median time from first occurrence to verified fix;
- recurrence after a fix;
- applicability verdict counts;
- lesson citations;
- workflow changes adopted, and regressions introduced by them.

Each figure states its sample size, so small samples aren't presented as trends.
