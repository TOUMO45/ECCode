# phase:rework-7: submission

Author: delivery-lead (run `run-mv4b3bf7-0107b416`). Gate: `phase:rework-7`. Date: 2026-10-11. Iteration 1.

## Why this rework exists

- **What it carries:** the phase F and phase G review follow-ups that sit in files no remaining task owns, plus the date robustness of the pinned test clocks.
- **Decisions:**
  - **`dec-mv46ovt6-01a662af`:** owners for follow-ups outside phase G ownership. It names this backend rework for FU-59, FU-54, FU-55, FU-56/58 and FU-57.
  - **`dec-mv46ovf2-017bf12d`, as corrected by `dec-mv4740d4-015b3589`:**
    - FU-59 blocks handover **per order**, not per plan;
    - FU-58 applies to the supplier route's own `checkRefusalReason`;
    - FU-54's `owedRefund` is true exactly for `captured` with `cancel_requested_at`, and `planStatus` is on every entry.
  - **`dec-mv48g2fj-018e0ca7`:** the spec sentence "All demo suppliers are paid to one Sandbox account" is canonical for the single-credential notice.
- **Review inputs:**
  - the three security conditions **SEC-F2-C** (`.eccode/reviews/drafts/phase-f-security-2.md`, section (4), conditions 1-3);
  - the rework-6 review `rev-mv4954l0-01d87f48`: TR-R6-1 (minor), TR-R6-2 (minor) and TR-R6-4 (info, optional).
- **Date robustness:** the tests pin 2026-10-20, nine days from today. Nothing may break once the real date passes it.

## Scope and how it was committed

- **One task:** `rework-7`, owner backend-engineer, in two rounds.
- **Round 1:** handoff **`ho-mv4aker9-014c05a3`**, committed as **`f4dbe92`**.
  - It changed `src/services/{orders,admin,retention}.js`, `src/config.js`, `test/api/followups-g-rework.test.js` (new), `test/api/uploads-retention.test.js`, `test/timing/planner-sec-b1.test.js`, `test/scan/env-example.test.js`, `package.json`, `package-lock.json` and `README.md`.
  - **Why it was committed before round 2:** the re-claim for round 2 is refused while owned files are dirty (`DIRTY_OWNERSHIP`), so round 1 was committed as the base.
  - **Round 1 left the real tree red by 3 tests in files it did not own:** `admin-basic`, `admin-reset` and `contracts`, through the stranded fixture (ev:ev-mv4ah2do-01029251: 2341/2330/3 fail/8). The cause is FU-54 changing the stranded entry by design. The handoff supplied the patch.
- **Round 2:** handoff **`ho-mv4b2qcu-01d596a2`**, committed in `003b4da` (orchestrator, mid-run) and **`1f4e430`**.
  - It changed `.env.example`, `test/scan/env-example.test.js`, `test/api/admin-basic.test.js`, `test/api/admin-reset.test.js`, `test/api/contracts.test.js`, `test/fixtures/contracts/recovery/admin-reset-forced-stranded.json`, `test/fixtures/contracts/labels/config-sandbox-single-credential.json` and `test/unit/frontend/recovery.test.js`.
- **Union of both rounds:** `git diff --stat 1996afa 1f4e430` (from the commit that opened rework-7) gives **18 project files, +653/-34**. `src/routes/admin.js` needed no change.
- **Working tree:** clean apart from `.eccode` records. HEAD is `1f4e430`.
- **Artifacts:** this file and **all 18 files**, listed explicitly. The engine collects only the round-2 handoff's 8 files, and round 1's 11 files were committed outside that claim. `test/scan/env-example.test.js` is in both rounds.

| File | Round | sha256 (12) |
|---|---|---|
| `src/services/orders.js` | 1 | `19c6daed95dc` |
| `src/services/admin.js` | 1 | `d68aa991c449` |
| `src/services/retention.js` | 1 | `7319fa94b443` |
| `src/config.js` | 1 | `7df61d4a34ae` |
| `package.json` | 1 | `2697e082c471` |
| `package-lock.json` | 1 | `68f510e46be5` |
| `README.md` | 1 | `886928582084` |
| `test/api/followups-g-rework.test.js` | 1 | `03c6efa7b852` |
| `test/api/uploads-retention.test.js` | 1 | `e6e4fbda6067` |
| `test/timing/planner-sec-b1.test.js` | 1 | `5ee8a0950530` |
| `test/scan/env-example.test.js` | 1 and 2 | `07b987acdb89` |
| `.env.example` | 2 | `c831071c7b9d` |
| `test/api/admin-basic.test.js` | 2 | `da4d3967a4db` |
| `test/api/admin-reset.test.js` | 2 | `dc7545d97956` |
| `test/api/contracts.test.js` | 2 | `11ff8f854468` |
| `test/fixtures/contracts/recovery/admin-reset-forced-stranded.json` | 2 | `8fe025262cf0` |
| `test/fixtures/contracts/labels/config-sandbox-single-credential.json` | 2 | `77eec1b0d386` |
| `test/unit/frontend/recovery.test.js` | 2 | `5e8a504b7174` |

## The 13 items: change, tests, evidence

The new file `test/api/followups-g-rework.test.js` has 15 tests in 6 suites.

**Failing first.** On the unfixed source the file ran 15 tests: 4 pass, 11 fail (ev:ev-mv49bx9k-01e11c8e). I checked which four pass in its log; all are controls that must pass before the fix:
- FU-59 "the plan-wide rule … stays";
- FU-59 "with no refund both orders are … handed over as before";
- FU-56 "an omitted reason still gets the default text";
- FU-55 "422 on another fault kind is not turned into a refund_order row".

| # | Item | Change (checked against the diff) | Tests | Evidence |
|---|---|---|---|---|
| 1 | **FU-59, per order** (SEC-F2-C 1, `dec-mv4740d4`) | **`orders.js` `handoverAllowed`:** after the executed-plan check, it reads the order's **own** live operation. If that is `refunded`, it returns false, so ready and handover answer 409 `HANDOVER_BLOCKED` and `canMarkReady`/`canHandover` are false. `payment_operations.supplier_order_id` is UNIQUE (`004_payments.sql` L2), so `.get()` sees the only one.<br>**The plan-wide scan is unchanged:** unknown, capture pending, refund requested, refund pending and refund failed still block every order of the plan. | `followups-g-rework` L113, L144, L159, L172:<br>- the refunded order is 409 on ready and handover, and its **sibling is marked ready and handed over**;<br>- an order that was ready before its refund cannot be handed over;<br>- `refund_pending`/`refund_failed` of A still block B;<br>- with no refund, both orders are collected. | ev:ev-mv49bx9k-01e11c8e (red first); ev:ev-mv4aife9-0177979a (71/71); mine: ev:ev-mv4b5i3d-013c7d65 |
| 2 | **FU-58 / FU-56, refusal reasons** (SEC-F2-C 2) | **`orders.js` `checkRefusalReason`** refuses these with the existing rule `characters` (422):<br>- C0 except tab/LF/CR;<br>- DEL and C1 (U+007F-U+009F);<br>- U+2028/2029;<br>- the bidi overrides, embeddings and isolates U+202A-U+202E and U+2066-U+2069.<br>The regex is built from code point ranges, so no invisible character is in the source. LRM and RLM stay valid for Arabic.<br>**`admin.js` `supplier_refusal`** now validates `reason` with the same `checkRefusalReason` (it was `str(1, 300)`). When the reason is omitted, the default text is used. | L186: the unit table.<br>L202: the supplier route answers 422 `VALIDATION_FAILED` on bidi and changes nothing; a clean reason is stored.<br>L220: admin bidi, ESC/BEL, blank, empty, over 300 and non-string are 422 and refuse no order.<br>L239: the default text. | same |
| 3 | **FU-54, stranded entry fields** (SEC-F2-C 3) | **`admin.js` `resetDemo`:** the stranded query joins `supplier_orders` and `plan_versions`. Each entry adds:<br>- `planStatus` (as of the archive);<br>- `owedRefund = status === 'captured' && cancel_requested_at !== null`.<br>The audit event still keeps id and status only.<br>The UI renders both fields (g1, `public/js/views/admin.js` L130-L138: "plan …", "a refund is owed"). | L251: `owedRefund` is true exactly for captured plus `cancel_requested_at`, and `planStatus` is on every entry.<br>L271: captured **without** `cancel_requested_at` gives false.<br>**Round 2**, exact `deepEqual` of the whole entry:<br>- `admin-basic` L204: `non_executable`, false;<br>- `admin-reset` L186: `executing`, false;<br>- `contracts` recovery row: by value, `stranded.0.planStatus` and `stranded.0.owedRefund`;<br>- the fixture;<br>- `recovery.test.js` L777/L853: "Operation 42: unknown, plan non executable". | **Mutant** `owedRefund` always true: killed, 3 red (ev:ev-mv4av3y6-01fbca8e). |
| 4 | **FU-55, audit** | **`admin.js` `refund_order`:**<br>- **404** (unknown or archived order) writes a denied `admin.fault` row (entity_type `fault`, detail `{kind, code: NOT_FOUND, supplierOrderId}`), committed with the transaction.<br>- **422** (malformed body) writes a denied `admin.fault` row with detail `{kind, code: VALIDATION_FAILED}`, code only. The free-form value is never stored. | L285: unknown and archived 404 each write a row with actor and target id.<br>L304: 422 writes a row; so does the 409 of the same call; nothing else changes.<br>L325: 422 of another kind is not a `refund_order` row. | ev:ev-mv49bx9k-01e11c8e; mine: ev:ev-mv4b5i3d-013c7d65 |
| 5 | **FU-57, metrics** | **`admin.js` `buildMetrics`:** `refund_failed` is added to the statuses counted in `reconciler.unresolved`. | L335 | same |
| 6 | **Canonical sentence** (`dec-mv48g2fj`) | **`src/config.js` `buildLabels`:** in single-credential Sandbox mode it sends exactly `All demo suppliers are paid to one Sandbox account`, and null otherwise. | L352 (unit).<br>**Round 2:**<br>- the `config-sandbox-test-mode.json` contract row pins `labels.singleCredentialNotice` by value (`sameValues`);<br>- the labels fixture holds the sentence. | **Mutant** "old sentence restored": killed, 1 red (ev:ev-mv4avigw-01fa6a05). |
| 7 | **FU-21, live-only variables** | **The four names** `RS_LIVE_MODEL_CEILING_USD`, `RS_LIVE_PAYPAL_HEADED`, `RS_LIVE_PAYPAL_WEBHOOK_SAMPLE` and `RS_PAYPAL_WEBHOOK_ALGOS`:<br>- are listed in `.env.example` as **commented, empty** lines under a comment saying that only the live suites and the webhook route read them;<br>- are explained in the prose block below;<br>- are named by the README.<br>**`env-example.test.js`:**<br>- requires them listed, commented and empty;<br>- checks each one's real reader file;<br>- exempts them only from "`src/config.js` reads it". | `env-example.test.js`, the NFR4/FU-21 test | Red first, without the lines: 3 red (ev:ev-mv4avxqb-016f0a1e).<br>Green with them: 27/27 (ev:ev-mv4awgg6-0190ea90). |
| 8 | **FU-12, lockfile and description** | **`package-lock.json`** (v3) was generated with `npm install --package-lock-only` through the configured proxy (ev:ev-mv4aijx8-01ecceb2, "audited 4 packages, found 0 vulnerabilities").<br>I checked the lockfile: three `registry.npmjs.org` entries with sha512 integrity, `@playwright/test`/`playwright`/`playwright-core` 1.56.1, all `dev`. This matches the one devDependency, `@playwright/test` 1.56.1.<br>**`package.json` `description`:** "emergency purchasing of matching cups and lids for cafes …". | `env-example.test.js` FU-12 test | Red first: ev:ev-mv49ho1l-01dbb4c6 |
| 9 | **README** | **"Refunded orders"** now states the delivered rule: the order itself is blocked with 409 `HANDOVER_BLOCKED`, siblings are unaffected, and the other blocking states still block the plan. This replaces "treat it as not delivered".<br>A new paragraph explains the four live-only variables. | docs scan (with item 7) | ev:ev-mv4awgg6-0190ea90 |
| 10 | **TR-R6-1, planner re-timing** | **`planner-sec-b1.test.js`:**<br>- each call keeps its pre-rework-6 bound: 50 ms headline, 100 ms per sweep call, 250 ms per 12-offer catalog;<br>- a call over its bound is **timed twice more** on the same input and fails only if the **minimum of three** still exceeds it (`assertUnderBound`);<br>- the 1000 ms ceiling stays on the first timing, and the sweep p95 stays below 20 ms;<br>- new: a p95 below 100 ms over the 150 catalogs, computed from the re-timed minima. | the three SEC-B-1 tests | **TR-R6-1's three resolution conditions:**<br>- **`pl-delay` survives the old file:** ev:ev-mv4ak50t-01127e9d.<br>- **The new file kills it:** kill-check ev:ev-mv49y4jx-019255a9, "the minimum of three, 299.8 ms, still exceeds the per-call bound 100 ms". It exits 0 only when the mutant is killed.<br>- **Green 3/3 under 3 × nproc busy loops:** ev:ev-mv4aeunc-01f4d496.<br>- **A locked npm test is green:** ev:ev-mv4ayse3-01219089 (engineer) and **ev:ev-mv4b8bge-01a646bb (mine)**.<br>Mine alone: ev:ev-mv4b5j99-01428a39 (3/3). |
| 11 | **TR-R6-2, comment** | **`uploads-retention.test.js`:** the comment now cites `src/services/retention.js` L35 for the row-then-file ordering, and spec "Retention and deletion" L773 only for what that section says. | n/a | the diff |
| 12 | **TR-R6-4, unlink assertion** | **The "kept at 6 d 23 h, deleted at 7 d + 1 min" test:**<br>- stamps the image file with the pinned upload time (`utimes`);<br>- asserts `imageFilesLeft === 0`, `orphans === 0`, no new `image.orphan_delete` event, and that no file of the image is left. | `uploads-retention.test.js` | The one-line no-unlink mutant:<br>- **survives the old test today:** ev:ev-mv4ak5zf-01832ede;<br>- **is killed by the new one:** ev:ev-mv49opld-0190c44d.<br>**Date matrix** ev:ev-mv4ajsjq-01e0ae52 at real-clock shifts +0/+14/+30/+400 days:<br>- the old test **survives at +0 and +14** and is killed only from +30;<br>- the new test is **killed at every date**. |
| 13 | **Date robustness** | **Audit of every place where real time meets the injected clock** (handoff round 1). The one mix of file-system time and the injected clock is the orphan age in `retention.js` (`clock.now() - mtimeMs`). It is correct in production, where they are the same clock, but under a pinned clock a freshly written file carries the real date.<br>**Fixes:**<br>- a comment at `retention.js` L79-L82;<br>- a boundary test: exactly 1 day is removed, 1 ms younger is kept, and a file stamped **after** the pinned clock is kept;<br>- explicit `utimes` stamping in item 12's test.<br>**Everything else uses the injected clock or durations:** sessions, CSRF, rate limits, the token cache, the webhook window, leases and reservations. Cookies use Max-Age, which is relative. There is no TLS. | `uploads-retention.test.js`, the RS-39 date-robustness test | **Mutant** orphan age as `|clock - mtime|`: killed, 42/41/1 (ev:ev-mv49xotr-01551c66).<br>**The method:** see "The clock-shift method" below. |

### SEC-F2-C, condition by condition

1. **Per order, not per plan:** item 1. The refunded order gets 409, and its sibling is marked ready and handed over (L113).
2. **The supplier route's own `checkRefusalReason`:** item 2. The bidi controls are refused, with an RLO reason giving 422 on the supplier route (L202). The admin path shares the function.
3. **FU-54:** item 3.
   - `owedRefund` is exact (L251, L271), and `planStatus` is on every entry.
   - **The fake-provider wording** ("must not mention the Sandbox dashboard") was delivered by **g1** in `public/js/views/admin.js`, **not** by this rework. It is pinned at `recovery.test.js` L779-L780: the Sandbox config matches "PayPal Sandbox dashboard", and the fake config does not. That file is in this submission only for its round-2 line changes at L777/L853.

## The clock-shift method (item 13)

- **The preload:** `scratchpad/rework7-tools/shift-clock.mjs`, sha256 `e1686fdb…`. It is **not in the repository**. It is loaded through `NODE_OPTIONS=--import …`, which every spawned Node child inherits, with `CLOCK_SHIFT_DAYS=N`.
  - **What it shifts:** `Date.now()` and `new Date()` (no argument) return the real time plus N days. The `stat`/`lstat`/`fstat` results (sync, callback and promises) report all file times plus N days. `utimes`/`lutimes`/`futimes` subtract N days, so a time a test sets explicitly reads back unchanged. This behaves like a system clock that moved.
  - **What it does not move:** monotonic timers (`performance.now`, `setTimeout`), SQLite (the application uses no SQL clock), and Chromium.
- **Gaps I found reading it (not the engineer's claims):**
  - the `stat` of a promises `FileHandle` is not patched;
  - a string time passed to `utimes` is not adjusted.
  - The full suite is green at +30 with the shift active, so neither gap is exercised in a way that matters. They would matter only to a future test that uses those paths.
- **My +30-day run proves the shift was active.** ev:ev-mv4bbd3o-01eed3dc first prints the preload's sha256 (`e1686fdbb3b6…`), then `real-date: 2026-10-11T21:03:53Z` and, under the preload, `shifted-date: 2026-11-10T21:03:53.953Z`, 21 days past the 2026-10-20 pin.
- **An earlier probe is not valid.** The engineer's earlier +14 probe ev:ev-mv49rblt-01dcc7be used a variable named `RS_SHIFT_DAYS`, which `server-proc.js` blanks for child servers (the `RS_` prefix). It was renamed `CLOCK_SHIFT_DAYS`, and the probe is not cited.

## Evidence

### Engineer, final tree (round 2, tree `51dc3468…`)

| Evidence | Command | Result |
|---|---|---|
| ev:ev-mv4ayse3-01219089 | `flock … npm test` (+0 days) | passed: 2341 tests, 2333 pass, 0 fail, 8 skipped |
| ev:ev-mv4azp6h-01093a99 | `flock … npm run test:browser` | passed: 14/14 |
| ev:ev-mv4b20c3-01dd3314 | `flock … npm test` with the preload, +30 days | passed: 2341 / 2333 / 0 fail / 8 skipped |
| ev:ev-mv4awgg6-0190ea90 | env-example and docs scan tests | passed: 27/27 |

### Engineer, round 1, on a scratch copy of the round-1 tree plus the foreign-file patch (tree `83e05343…`)

The patch was applied in the real tree in round 2.

| Evidence | Command | Result |
|---|---|---|
| ev:ev-mv4a8wvv-0178c772 | full suite, +0 days | 2341 / 2333 / 0 / 8 |
| ev:ev-mv4ab3q6-0166b77a | full suite, +14 days | 2341 / 2333 / 0 / 8 |
| ev:ev-mv4ade0v-01ca2bd5 | full suite, +30 days | 2341 / 2333 / 0 / 8 |
| ev:ev-mv4aea7f-01c08c76 | browser, with the Node side at +30 days | 14/14 |

### Delivery-lead, on `1f4e430` (tree `51dc3468…`, the same tree as the engineer's round-2 runs)

| Evidence | Command | Result |
|---|---|---|
| **ev:ev-mv4b5i3d-013c7d65** | `test/api/followups-g-rework.test.js` alone (`node --disable-warning=ExperimentalWarning --import ./test/helpers/net-guard.js --test …`) | **passed: 15 tests, 15 pass, 0 fail; 9.4 s** |
| **ev:ev-mv4b5j99-01428a39** | `test/timing/planner-sec-b1.test.js` alone (same form) | **passed: 3 tests, 3 pass, 0 fail; 1.0 s** (load average 0.5) |
| **ev:ev-mv4b8bge-01a646bb** | `flock /tmp/rescuestock-suite.lock npm test` (`dec-mv43s14b-01addb18`, `--timeout 1800`) | **passed: 2341 tests, 2333 pass, 0 fail, 8 skipped, 0 todo; suite 103.4 s.** NFR5: 7508 requests, p50 2.9 ms, p95 58.6 ms, ok. |
| **ev:ev-mv4b9840-015cf7e4** | `flock /tmp/rescuestock-suite.lock npm run test:browser` | **passed: 14 tests, 14 pass, 0 fail; 41.6 s** |
| **ev:ev-mv4bbd3o-01eed3dc** | `flock … sh -c "sha256sum <preload> && date && <shifted-date probe> && env NODE_OPTIONS='--import <preload>' CLOCK_SHIFT_DAYS=30 npm test"` | **passed: 2341 tests, 2333 pass, 0 fail, 8 skipped, 0 todo; suite 99.0 s.** NFR5 p95 58.1 ms, ok. Shift verified in the log (lines 4-6). |

- **No lock waits:** none of my runs waited on the lock; each duration matches its suite time.
- **The 8 skips** are the existing fake-harness provider-contract cases.

## Disclosures and open limits (for both reviewers)

1. **FU-55 covers `refund_order` only.**
   - Its 404 and 422 write audit rows. A 422 on the **other** fault kinds (for example a malformed `supplier_refusal` or `stock_depletion` body) still writes **no** audit row.
   - FU-55's wording was "every 422 on the fault routes", so this is narrower. L325 pins the narrower behaviour.
2. **FU-57 counts operations only.** `refund_failed` **operations** count in `unresolved`. Reservations with an escalation do not, although SEC-F-I5 also named them.
3. **Not time-shifted in the +30-day runs:** Chromium (a separate process; the app's cookies use Max-Age, which is relative) and SQLite (the app uses no SQL clock; every time is written from the injected clock). The browser suite ran on the real clock; in round 1 it also ran with only the Node side at +30 days.
4. **The refusal-reason rule is wider than bidi.** The supplier route now also refuses C1 controls (U+0080-U+009F) and U+2028/2029, which it previously accepted. The admin path previously used the generic `str(1, 300)`. It now applies the supplier rule exactly: the bounds after NFC, blank refused, and the character set above.
   - **Not refused:** other invisible format characters such as U+200B-U+200D, U+FEFF and U+061C (Arabic letter mark). LRM and RLM stay valid by design.
   - The security reviewer should confirm that this set meets SEC-F-I6.
5. **What the FU-55 rows store:**
   - The 404 row stores the requested `supplierOrderId` in the detail. It has been validated as an integer from 1 to 1e12 before this point.
   - The 422 row stores only the code.
   - Both use `entity_type 'fault'` with a null entity id, so the existing count of `supplier_order` rows for the 409 path is unchanged.
6. **How the 18 files were committed:**
   - Round 1 was committed as a base (`f4dbe92`) because the re-claim is refused on dirty owned files (`DIRTY_OWNERSHIP`).
   - Part of round 2 was committed mid-run by the orchestrator (`003b4da`).
   - The final state of every file is `1f4e430`, and all 18 are artifacts here.
7. **The preload is outside the repository** (scratchpad). It is identified by its sha256 in my +30-day log. If it should become a reviewed project tool, it needs a task that owns a path for it.

## Acceptance criteria

| Criterion | Met | Evidence |
|---|---|---|
| `task:rework-7`: all 13 items delivered with tests (round-1 acceptance criteria) | yes | the item table above |
| `task:rework-7`: round 2. `planStatus`/`owedRefund` and the canonical sentence are pinned exactly in the foreign tests; the four live-only lines are in `.env.example`, the scan test requires them, and a run fails without them | yes | items 3, 6 and 7; ev:ev-mv4av3y6-01fbca8e, ev:ev-mv4avigw-01fa6a05, ev:ev-mv4avxqb-016f0a1e, ev:ev-mv4awgg6-0190ea90 |
| `phase:rework-7`: FU-59 per order; FU-58/56; FU-54; FU-55; FU-57; the canonical sentence; FU-21; FU-12; TR-R6-1/2/4; date robustness; security reviews before delivery | yes, with disclosures 1-4 | items 1-13; security review requested below |
| Full npm test at +0 and +30 days and the browser suite are green on the real tree under the lock | yes | engineer: ev:ev-mv4ayse3-01219089, ev:ev-mv4b20c3-01dd3314, ev:ev-mv4azp6h-01093a99. Mine: ev:ev-mv4b8bge-01a646bb, ev:ev-mv4bbd3o-01eed3dc, ev:ev-mv4b9840-015cf7e4 |
| A regression test fails before the fix and passes after it | yes | ev:ev-mv49bx9k-01e11c8e (11 red, 4 controls green), then ev:ev-mv4aife9-0177979a and ev:ev-mv4b5i3d-013c7d65; the mutants in items 3, 6, 10, 12 and 13 |

## Lessons

- **`mem-sd-mv1audrd-013b7102`** (root resolution of a tool-call guard): both handoffs recorded it as **not-applicable**, because this rework builds no hook or guard that maps file writes to a record. I agree.
- `memory search` for this change returns no other verified lesson.

## Review

**A technical review and a security review are both needed.** This rework changes:
- refusal validation on the supplier route and the admin fault path;
- the handover rule (who can release goods after a refund);
- the admin reset response;
- audit rows.

The security reviewer asked to review it before delivery (SEC-F2-C).

- **Technical reviewer:** the 13 items against the diffs; the round-2 pins; TR-R6-1/2/4 against `rev-mv4954l0-01d87f48`; and the clock-shift method.
- **Security reviewer:** SEC-F2-C conditions 1-3; disclosures 1, 4 and 5; and the date audit (item 13).

## Live suites and network

- **No live suite was run.** My evidence commands ran under `env -u RS_LIVE_MODEL -u RS_LIVE_PAYPAL`.
- **Network:** 127.0.0.1 only, through `test/helpers/net-guard.js`. The only outbound call in this rework is the engineer's `npm install --package-lock-only` to `registry.npmjs.org` through the configured proxy (item 8). I made no network call.
- **No commits by me.** The only file I wrote is this one.
