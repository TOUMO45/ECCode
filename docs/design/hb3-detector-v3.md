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

## 7. Amendment 1 (2026-11-03, written while implementing S1 to S4; no seed exists, nothing has been measured)

Recorded here, before the noise controls and before the freeze, because it departs from section 1.B as first written.

**S1 as written is replaced.** A global counter on `uuid.uuid4` gives each entity a distinct id (…0017 for one recipe, …0023 for one food), so the list `exampleIds` would name one entity of one kind and every other id would be a 404 on every route of the other kinds. What a probe needs is that *the same three ids exist in every table*. The setup therefore ends with a step (`rekey` in `mealie_setup.py`) that renumbers, in every table whose `id` is a GUID, the rows in creation order to `00000000-0000-4000-8000-000000000001`, `…2`, `…3`, …, and follows every foreign key (read from the SQLite catalogue, not from a list). It runs on the closed database file after the application has shut down and checks `PRAGMA foreign_key_check`; a problem fails the setup. `exampleIds` is `[…0001, …0002, …0003]`, a constant of the configuration, and the test asserts that the first three rows of 19 entity tables are exactly those three on two fresh setups.

**What else the same step makes deterministic**, found by running two fresh setups and comparing every non-time column (the test `setup: two fresh setups give the same ids and the same data, column by column` has an empty list of tolerated columns):
- the references of ingredient lines and notes (`reference_id`, random per line, not a key) are numbered in order of first appearance;
- the invitation tokens and the API tokens, which the application writes at random, are replaced by constants (`invite-<id>`, `api-token-<n>`);
- the calendar token of the default household is `alpha`, the first string example of the generator, so the public feed `/api/households/mealplans/ical/{token}` answers 200 (a token any developer might use in a development database; chosen from the generator, not from a seed).

**The probe identities are kept out of the example ids (a design addition).** The users the roles authenticate as have reserved ids `…00a1` to `…00a4` (the default administrator `…00a0`), and their API-token rows have integer ids of 1000 and above, while the other API tokens are numbered from 1. Reason: with ids that exist, a DELETE probe on `exampleIds[0]` would otherwise delete the user, or the token row, that later probes of the same role authenticate as, and every later probe of that role would be a 401 on both sides, hiding what follows. (In v2 this happened to the `user` role through integer token ids; v2 is not changed.) Three plain, non-administrator users (`member-one` to `member-three`) take the example ids in `users`, so the user routes resolve.

**The dataset of section 3 as built** (all through the API as the admin probe, fail-soft, every status printed, the test requires "0 not accepted"): 3 labels, 3 units, 5 foods (`alpha`, `alphabet` a near match, `flour`, `milk`, `sugar`; `alpha` updated after the others were created), 3 categories, 3 tags, 3 tools, 3 recipes (`alpha`, `beta`, `gamma`) with fractional quantities (0.0625, 0.03125, 0.25, 0.5, 1.5), rating, nutrition, categories, tags and tools, 3 comments, 3 timeline events, 3 share tokens, 3 meal plan entries (three dates, three types, one without a recipe), 3 meal plan rules, 3 shopping lists (the first with four items, one checked, with foods, units, labels and a free-text note), 3 cookbooks, 3 webhooks, 3 recipe actions, 3 API tokens, 2 invitation tokens, 3 group reports (written through the repository: the application has no create route), a second and a third group, a second and a third household, 3 plain users. Added to the list of section 3, as the same kind of data: recipe actions, meal plan rules, share tokens, the calendar token.

**Still not provided (limits, to the register):** the public `explore` routes (they need a group *slug* that exists and a public household), AI providers and prompt overrides, event notifiers, password-reset tokens, recipe assets and images (no file), the data a background job would create, a second *probe* user in another group.

**Tests for this amendment:** `tests/hb3-mealie-setup.test.js` (6 tests; against the setup of v2 five were red and one green, because the old setup also exited cleanly), `tests/fixtures/phase2/inspect_setup.py` (the helper that reads the resulting database, not part of the measured pipeline).
