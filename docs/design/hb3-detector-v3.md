# Detector v3: design (H-B3)

Written 2026-11-03, **before any v3 code**. Owner decision of 2026-11-03: v3 approved, scoped. Pre-registration: `bench/protocols/2026-11-03-hb3.md`. Starting point: the H-B2 result (`bench/pilot-results/2026-11-03-hb2-*.json`, register rows 180 and 181): the frozen v2 flagged 9 of 41 unintended seeds; 32 misses were classified, after the result and not re-tested, as 23 capability and 9 configuration.

**H-B2 is a new seed set written after v2 was frozen; it is spent as a blind set (the implementer read its descriptions); the original sealed set remains unopened (key unavailable); the old 26 seeds are never cited as measured.** v3 is therefore *informed by* the H-B2 post-mortem and is **not** measured on the H-B2 set. It is measured on a new set written by an independent agent after the v3 freeze (H-B3).

## 1. What v3 changes (the complete list; nothing else changes)

### A. The example generator (`scripts/behavior/probe_runner.py`)

| # | Change | Why (H-B2 evidence) |
|---|---|---|
| G1 | The UUID formats `uuid`, `uuid1`, `uuid3`, `uuid4`, `uuid5` are all recognised and produce a valid UUID. | Mealie declares 347 string fields as `uuid4`; v2 recognised `uuid` only, so every such id became the string "alpha" and the request was rejected with 422 before the logic (13 of 32 misses) |
| G2 | `behavior.json` may declare `exampleIds`, a list of ids that exist in the application after `setup`. An operation with uuid inputs gets one variant per id (at most 8): the first uuid field of the operation takes `exampleIds[v]`, the next `exampleIds[v+1]`, and so on (modulo the list). Without `exampleIds` the synthetic pattern of v2 is used. | A valid-looking id that matches no entity answers 404; to reach the logic the id has to exist, and the same id has to exist on both sides |
| G3 | `email` examples: variant 2 is mixed case (`Probe2@Example.test`). | an email-case change was invisible because every example was lower case |
| G4 | Strings: variant 1 is a padded, mixed-case value (`"  Beta value  "`) in place of `""` (which v2 turned into `"a"` anyway). | whitespace stripping and case changes were invisible |
| G5 | `minLength` is honoured (the example is padded to it); `maxLength` as before. | passwords and names with a minimum length were rejected by validation |
| G6 | More formats: `time`, `uri`/`url`, `ipv4`, `ipv6`, `hostname`, `duration`. | Mealie declares `time` fields; the same generic gap would block any application that uses the others |
| G7 | In an object, a confirmation field (`passwordConfirm`, `password_confirm`, `confirmPassword`, `confirm_password`, `passwordConfirmation`) takes the value of its sibling (`password`). | registration payloads were rejected because the two differed |

The generator stays OpenAPI-driven and generic: nothing in it names Mealie, an endpoint or a seed.

### B. The Mealie configuration (`bench/pilot/phase2-hb/config.js`, `mealie_setup.py`)

| # | Change | Why |
|---|---|---|
| S1 | The setup patches `uuid.uuid4` with a counter **before** Mealie is imported, so every entity created during setup gets a deterministic id, identical on both sides (verified by a spike: two fresh databases gave identical ids). | `exampleIds` must exist on baseline and candidate alike |
| S2 | The setup creates, through Mealie's API and repositories, a richer generic dataset (section 3) and the configuration lists the ids of its fixtures in `exampleIds`. A test asserts that the ids a fresh setup produces equal the ids in the configuration. | G2 |
| S3 | Two more roles: `inviter` (a user with the invite permission only) and `organizer` (a user with the organize permission only), with fixed-id users and constant tokens like the two probe users of 0.C. Five roles in all. | misses that needed a permission combination the configuration did not have |
| S4 | `ignoreFields` grows only for fields a six-baseline-run census (as in H-B2) shows to be random per run, listed with the census output. | the new data must not add noise |

### C. The report (`bench/pilot/hb2/report.js`, not frozen, computes no diff result)

Intended seeds are split into four outcomes: **accepted and observed** (the declared change appeared as an expected difference and nothing unexplained), **accepted but unobserved** (no difference at all: reported apart and not counted as confirmation), **false positive** (an unexplained difference on a declared change), **not verifiable** (routing skip, coverage, error). Only the first counts as acceptance.

## 2. What v3 does not change (stated limits, carried into the register)

Request chaining (an effect visible only in a later request that depends on an earlier write); multipart and binary bodies; form-encoded bodies; response-header and file-name capture; non-code files (translation JSON) as surfaces; a network fetch (closed by design); the database engine (the run uses sqlite; an effect that needs credentials in a database URL stays invisible); the lenient coverage verdict (row 176); specific numeric pairs. These are the blockers behind the H-B2 misses that v3 does not touch. Any seed that depends on one is expected to be missed and will be classified capability.

## 3. The dataset the setup creates (generic, not seed-shaped)

Chosen as the data a developer would put in a development database for this application, covering the entity kinds the H-B2 post-mortem showed to be missing, **not** as the particular values of any H-B2 seed:

- recipes: several, with fractional and integer ingredient quantities, units and foods, instructions, tags, categories, tools, nutrition, a rating, a comment and a timeline event;
- foods and units, including names that are near matches of each other; at least one item updated after a newer one was created;
- labels (at least two) and shopping lists with items, some checked, with quantities and notes;
- meal plan entries (at least two, on different dates and of different types) and a cookbook;
- group reports (at least two), a webhook, an API token, an invitation token;
- a second group and household;
- users for the five roles.

The size is bounded by the ids the generator can use (at most 8 per operation); fixtures are chosen so that each major entity kind has one id in the list.

## 4. Cost, and the rule that bounds it

More roles and more id variants mean more probes. The H-B2 widest runs executed about 2,500 probes. **Registered bound:** a v3 run on the widest module of the H-B2 controls (`mealie/core/settings/static.py`, whose dependents cover essentially the whole API) must finish in at most 15 minutes of wall time; if it does not, the number of id variants is reduced before the freeze, not after.

## 5. Tests (written first, red before green)

- a fixture application with `uuid4`-typed ids in paths and bodies, a mixed-case email, a padded name, a password with confirmation, a `minLength`, a `time` field: the same changes are invisible to the frozen v2 tree and visible to v3 (the v2 tree is materialized from git, as in `behavior-routers.test.js`);
- the generator's examples for every format, for `exampleIds` with one, two and more ids, and with none;
- `exampleIds` equal the ids a fresh Mealie setup creates (the determinism test), and two fresh setups are identical;
- the six comment-only controls of H-B2, on v3: **zero unexplained differences each** (a requirement of the freeze), plus a six-baseline-run census.

## 6. Order

Design and pre-registration committed; tests red; code; tests green; controls and census; the v3 freeze by hash committed **before any new seed exists**; a new key; the independent agent; validation; measurement of v3 (primary) and v2 (comparison) on the same new set; results hashed before any seed is read; classification; a second blind labeller; the report.
