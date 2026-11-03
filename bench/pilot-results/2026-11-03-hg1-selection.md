# H-G1 selection: no candidate passes the registered gates

Protocol `bench/protocols/2026-11-03-hg1.md` (registered 2026-11-03T22:42:44Z, commit `e577c13`, before any candidate was browsed). Record: `2026-11-03-hg1-selection.json`. Tool: `bench/pilot/hg1/select-gates.py`. The query ran once at 2026-11-03T22:45:31Z and returned 258 matches; the first 40 in star order were examined, as registered.

## Outcome

**None of the 40 candidates passes every gate.** Protocol section 4.2 item 4 applies: I stop and report. No gate is relaxed, the list is not extended, and no candidate is skipped or preferred; only an owner decision can do any of those. No setup, population step, configuration, control, key or seed has been built, and no candidate has been run through any ECCode detector.

First failing gate, over the 40: **M5 size 17** (11 above 60,000 lines, from 72,079 to 363,213; 6 below 10,000, from 3,072 to 9,848), **M3 not an application 9**, **M2 activity 8**, **M1 licence 5**, **E2 green suite 1**, passes 0.

The nine that cleared M1, M2, M4 and M5 were judged on M3 by the repository's own words and structure: eight are libraries, SDKs, frameworks, an ORM, or have no application or persisted entity of their own (ranks 6, 7, 11, 20, 21, 22, 35, 40, each with its rejecting sentence in the record). The ninth, **rank 36 `fastapi-practices/fastapi-best-architecture`** (pinned `6edcadc7919cd4e285079d506a23f665b64a344c`, 21,291 lines), has none of the rejecting words, a FastAPI app and SQLAlchemy models, so it passed M3 and went to the execution gates. It fails **E2**: one test function in the whole repository (`test_logout`), no pytest configuration, and no test job in its CI (the workflows are lint, changelog and version). The registered floor is 100 passing tests. E1 (install) was not evaluated, because E2 rejects whatever E1 shows.

## Calibration of "medium"

The reference app measured with the registered M5 command is 36,927 lines in 410 files (203 test files), inside the band, so the numeric reading of the owner's "medium" is centred on Mealie and is not what is rejecting candidates: the rejected ones are genuinely far outside it.

## All 40, first failing gate

| Rank | Repository | Stars | Gate | Measured |
|---|---|---|---|---|
| 1 | fastapi/fastapi | 104,388 | M3 | description: "FastAPI framework, high performance, easy to learn, fast to code, ready for production" |
| 2 | headroomlabs-ai/headroom | 78,742 | M5 | 272,061 lines (above 60,000) |
| 3 | Zeyi-Lin/HivisionIDPhotos | 21,692 | M2 | last commit 2026-07-03, 2 author(s) since 2025-11-03, 446 commits |
| 4 | Evil0ctal/Douyin_TikTok_Download_API | 21,132 | M5 | 72,448 lines (above 60,000) |
| 5 | fastapi/sqlmodel | 18,546 | M5 | 8,985 lines (below 10,000) |
| 6 | coleifer/peewee | 12,006 | M3 | README: "Peewee is a simple and small ORM." No FastAPI app of its own |
| 7 | QuentinFuxa/WhisperLiveKit | 11,210 | M3 | A FastAPI server exists |
| 8 | polarsource/polar | 10,455 | M5 | 363,213 lines (above 60,000) |
| 9 | pycaret/pycaret | 9,859 | M1 | licence NOASSERTION, licence file yes |
| 10 | vastsa/FileCodeBox | 8,735 | M5 | 8,613 lines (below 10,000) |
| 11 | nonebot/nonebot2 | 7,784 | M3 | description: "Asynchronous multi-platform chatbot framework written in Python" |
| 12 | xerrors/Yuxi | 7,584 | M5 | 72,079 lines (above 60,000) |
| 13 | dramaclaw/dramaclaw | 7,070 | M1 | licence NOASSERTION, licence file no |
| 14 | shy3130/tick-stock-panel | 6,985 | M5 | 112,043 lines (above 60,000) |
| 15 | fastapi-users/fastapi-users | 6,260 | M5 | 3,072 lines (below 10,000) |
| 16 | SenteLabsAI/OpenExecutive | 5,739 | M5 | 207,110 lines (above 60,000) |
| 17 | remsky/Kokoro-FastAPI | 5,631 | M5 | 7,837 lines (below 10,000) |
| 18 | AhmadHassan-BTed/AutoSwarm-Shadow-Adapter | 5,210 | M2 | last commit 2026-10-20, 1 author(s) since 2025-11-03, 58 commits |
| 19 | IBM/mcp-context-forge | 4,749 | M5 | 262,225 lines (above 60,000) |
| 20 | strawberry-graphql/strawberry | 4,725 | M3 | description: "A GraphQL library for Python that leverages type annotations" |
| 21 | pydantic/logfire | 4,533 | M3 | README: "This repo contains the Python SDK for `logfire` and documentation; the server application for recordi |
| 22 | dynaconf/dynaconf | 4,338 | M3 | README: "dynaconf - Configuration Management for Python." Its FastAPI apps are functional-test fixtures |
| 23 | arvin341az-glitch/RVG | 4,313 | M1 | licence NOASSERTION, licence file yes |
| 24 | datamodel-code-generator/datamodel-code-generator | 4,049 | M5 | 167,898 lines (above 60,000) |
| 25 | Lightning-AI/LitServe | 3,984 | M5 | 7,667 lines (below 10,000) |
| 26 | TracecatHQ/tracecat | 3,889 | M5 | 339,901 lines (above 60,000) |
| 27 | Soju06/codex-lb | 3,416 | M5 | 204,619 lines (above 60,000) |
| 28 | lxf746/any-auto-register | 3,412 | M2 | last commit 2026-08-25, 5 author(s) since 2025-11-03, 109 commits |
| 29 | ml-tooling/opyrator | 3,137 | M2 | last commit 2021-05-06, 0 author(s) since 2025-11-03, 127 commits |
| 30 | tiangolo/uvicorn-gunicorn-fastapi-docker | 2,915 | M2 | last commit 2026-10-03, 4 author(s) since 2025-11-03, 296 commits |
| 31 | smithyhq/sqladmin | 2,851 | M5 | 9,848 lines (below 10,000) |
| 32 | 3441293738/creatorhub | 2,850 | M1 | licence None, licence file no |
| 33 | the-momentum/open-wearables | 2,753 | M5 | 77,174 lines (above 60,000) |
| 34 | wassim249/fastapi-langgraph-agent-production-ready-template | 2,725 | M2 | last commit 2026-10-17, 13 author(s) since 2025-11-03, 168 commits |
| 35 | supabase/supabase-py | 2,625 | M3 | description: "Python Client for Supabase"; no FastAPI app in the repository |
| 36 | fastapi-practices/fastapi-best-architecture | 2,604 | E2 | 1 test function, no CI test job (needs >= 100 passing tests) |
| 37 | ithtelab/workbuddy-manager | 2,370 | M1 | licence NOASSERTION, licence file yes |
| 38 | jwadow/kiro-gateway | 2,347 | M2 | last commit 2026-05-18, 10 author(s) since 2025-11-03, 206 commits |
| 39 | TNT-Likely/PanWatch | 2,344 | M2 | last commit 2026-11-01, 6 author(s) since 2025-11-03, 285 commits |
| 40 | widgetti/solara | 2,181 | M3 | description: "A Pure Python, React-style Framework for Scaling Your Jupyter and Web Apps" |

(Rank 1 was run in light mode: M3 rejects it on its own description, "FastAPI framework". Batches of 8 computed the cheap gates for all 40 instead of stopping lazily, because no candidate passed; the outcome is the same.)

## What this says, and what it does not

The registered pool, topic `fastapi` ordered by stars, is dominated by libraries, AI tooling and very large repositories: eight of the nine candidates that cleared the numeric gates were libraries or tools, and the one real application among them has no test suite. The experiment needs an application with a green suite, because every seed must keep that suite green. This is a failure of the candidate source, not evidence about the detector, and it was found before any app-specific work (so nothing was wasted). It does not show that no suitable FastAPI codebase exists.

## Options (the decision is yours)

1. **Amend the source, keep every gate (my recommendation).** Add `pytest in:readme` to the registered query (Amendment 1, committed before any new candidate is examined), keep M1 to M5 and E1 to E4, the first-pass-in-rank-order rule and the 40-candidate cap, and examine the new list. The filter selects on what the experiment needs (a project with tests), not on anything the detector responds to (id format, authentication, ORM). It adds one degree of freedom chosen after seeing a null result, which is why I want your approval first.
2. **Extend the unchanged query** to ranks 41 to 120. Smallest deviation from the registration, but given what ranks 1 to 40 contained I expect a low yield; it is the fallback if option 1 also finds nothing.
3. **You nominate a codebase.** The gates still run on it and the record says it was owner-nominated, which departs from "first in rank order".
4. **Relax a gate.** I do not recommend it: M5 is the binding gate but loosening it admits libraries and small tools, and the other gates guard the experiment's validity.

## Setup cost (owner decision 2b): what can and cannot be said now

A grounded estimate needs a selected app (install time, suite time, operations, authentication, entity kinds, a probe-corpus size and a baseline-run time), so **it cannot be made yet and nothing was built**. What I can offer is a prior from the Mealie record, labelled as such and not measured on the new app:

| Component | Mealie evidence (H-B3, 2026-11-03) | Prior for a medium app |
|---|---|---|
| Selection, install, green suite | not applicable | 1 to 3 h per candidate that reaches the execution gates |
| `behavior.json` and population step with deterministic ids | `config.js` 83 lines and `mealie_setup.py` 337 lines, with 179 lines of tests; generator commit 11:36Z, setup commit 11:50Z, refinements 12:05Z, on top of a spike | 4 to 8 h agent work; the risk is the authentication model and non-UUID ids |
| Re-created tooling (the 6 Mealie-coupled tooling files; `bench/pilot/hg1/`) | the originals total 670 lines (`run.js` 185, `phase2-seeds.js` 155, `hb2/seal.js` 109, `phase2-seed-validate.js` 84, `hb3/seal.js` 69, `phase2-reseal.js` 68), plus the log analysis and their tests | 2 to 4 h |
| Noise gate: 12 controls and census | widest control 308 s of 900 s allowed; 12:05Z to 12:58Z including fixes | 2 to 4 h machine time, 1 to 3 rounds |
| Seeding by the independent agent | 67 seeds in 8,407 s, 622,338 tokens | about 1 h and 0.2M tokens for 24 seeds |
| Validation (whole suite per seed) | 67 seeds in about 2 h 5 min | 45 min to 2.4 h, set by the suite time (E2 caps it at 6 min) |
| Measurement (v3 only) | 67 seeds in 2 h 46 min | about 1 h |
| Report, register, ledger | | 2 to 3 h |

By that prior the milestone is about **1 day of agent work (80 percent range 0.6 to 2 days)** once an app is selected, with roughly a 10 to 15 percent chance of exceeding two days, mostly from a hard-to-make-deterministic population step or several failed noise rounds. I will replace this with a measured estimate on the chosen app and stop if that estimate exceeds two days.

## Not done

No second app has been chosen; the setup-cost estimate, the freeze, the key, the brief, the seeding agent and the measurement all wait for your decision. v4 is not started, Round 1-lite is not launched, no paid run was made. v3 (`0323e0b`) and its 48 manifest hashes are unchanged.
