# planner: a greenfield service built through three work items

The big-project pilot's Part C ([spec](../../../docs/specs/2026-10-24-big-project-pilot-design.md)). It covers what the Mealie items cannot:
- the greenfield track, with its architecture, design and plan gates;
- Express-style route compatibility;
- SQL migrations in a codebase the agent shapes itself.

Everything here is ours (MIT); the data is synthetic.

| Item | Track | Request (the task's prompt) | Hidden check |
|---|---|---|---|
| `c1` | greenfield | Build mealie-planner: weekly plans from Mealie's recipes, by tag and time rules; a merged shopping list with unit conversion; SQLite with append-only SQL migrations | `check.js c1`: 9 acceptance tests |
| `c2` | feature | Diet filters (vegetarian, vegan, gluten-free, from Mealie's food labels) and a shopping list grouped by label | `check.js c2`: 4 tests; regression `c1` |
| `c3` | feature | Households: plans belong to one; the schema change comes in a new migration | `check.js c3`: 5 tests; regression `c1` and `c2` |

**How it is graded.**
- `_hidden/check.js <item>` runs in the project after the agent finished:
  - it installs the project's npm dependencies;
  - it starts the fake Mealie on the hidden dataset (`_hidden/fake-mealie/data.json`), whose pages hold at most 10 items, so a client that ignores pagination misses recipes;
  - it starts the service with its npm start script (PORT, MEALIE_URL, a fresh DATABASE_PATH) and waits for GET /health;
  - it runs that item's tests from `_hidden/acceptance.test.js`.
- The acceptance tests compute their expectations from the dataset by the rules the requests state.
- The agent develops against a different, smaller dataset in `c1/fixture/dev/`.

**Validated.** `reference/` is our implementation of all three requests (Node, `node:http` and `node:sqlite`, no dependencies). It never enters a sandbox. `tests/pilot.test.js` checks that:
- the acceptance suite passes against it;
- the suite fails against an empty service;
- an edited first migration fails the c3 append-only test.

**Chains.** The items run in chain mode (`eccode bench --chain`) with no upstream: each builds on the agent's own previous work, for both the engine and the bare variant.
