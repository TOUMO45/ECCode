# pantry: a greenfield service built through three work items

The Mealie rerun's Part C ([protocol](../../protocols/2026-10-25-mealie-rerun.md)). The pilot's planner suite was not sampled again with the same model, so this suite asks for a different service that exercises the same things:
- the greenfield track, with its architecture, design and plan gates;
- an HTTP API built against a paginated upstream (the same fake Mealie, the same synthetic data);
- SQL migrations in a codebase the agent shapes itself, with a schema change in the third item.

Everything here is ours (MIT); the data is synthetic.

| Item | Track | Request (the task's prompt) | Hidden check |
|---|---|---|---|
| `c1` | greenfield | Build mealie-pantry: a pantry of amounts that add up by kind of unit (mass, volume, count, other), the recipes it can cook with what each lacks, and cooking that subtracts a recipe; SQLite with append-only SQL migrations | `check.js c1`: 9 acceptance tests |
| `c2` | feature | A shopping list of what the pantry lacks for chosen recipes, labelled by Mealie's food labels; a tag filter on cookable recipes | `check.js c2`: 4 tests; regression `c1` |
| `c3` | feature | Expiry dates: amounts kept as lots, the earliest date reported, a list of what expires, cooking from the earliest lot; the schema change comes in a new migration | `check.js c3`: 5 tests; regression `c1` and `c2` |

**How it is graded.**
- `_hidden/check.js <item>` runs in the project after the agent finished:
  - it installs the project's npm dependencies;
  - it starts the fake Mealie on the hidden dataset (`_hidden/fake-mealie/data.json`), whose pages hold at most 10 items, so a client that ignores pagination misses recipes;
  - it starts the service with its npm start script (PORT, MEALIE_URL, a fresh DATABASE_PATH) and waits for GET /health;
  - it runs that item's tests from `_hidden/acceptance.test.js`.
- The acceptance tests empty the pantry before each test and compute their expectations from the dataset by the rules the requests state. Fields a later request adds are ignored by an earlier item's tests.
- The agent develops against a different, smaller dataset in `c1/fixture/dev/`.

**Validated.** `reference/` is our implementation of all three requests (Node, `node:http` and `node:sqlite`, no dependencies). It never enters a sandbox. `tests/pilot.test.js` checks that:
- the acceptance suite passes against it;
- the suite fails against an empty service and against a client that reads only the first page of recipes;
- an edited first migration fails the c3 append-only test.

**Chains.** The items run in chain mode (`eccode bench --chain`) with no upstream: each builds on the agent's own previous work, for both the engine and the bare variant.
