# phase:rework-7: security review, iteration 1 (FINAL)

**Verdict (security): APPROVE.**
- All three SEC-F2-C conditions are met, each confirmed with my own probes.
- FU-55 and FU-57 work as disclosed.
- Every security-relevant change is pinned by the rework's own tests: five of my mutants, each in a fresh copy, are all killed.
- There is no finding above info.
- The closed phase F info items: SEC-F-I3, I4, I5, I6 and I7, and SEC-F-I1(a)/(c).

Reviewer: security-reviewer, run run-mv4bfkwi-01f1ca1f. Gate: `phase:rework-7`. Submission: `sub-mv4bez91-0173458d`.
- **Handoffs:** ho-mv4aker9-014c05a3 (round 1, `f4dbe92`) and ho-mv4b2qcu-01d596a2 (round 2, `1f4e430`).
- **Read:**
  - `.eccode/artifacts/rework-7/submission.md`;
  - the full diff `1996afa..1f4e430` of `src/` and `package.json`;
  - `package-lock.json`;
  - the `.env.example` diff;
  - `test/api/followups-g-rework.test.js`;
  - g1's `public/js/isolate.js` and its call sites.
- **Who records:** the technical-reviewer records the gate after this FINAL. I did not run `gate review`.

## Evidence (security-reviewer, gate phase:rework-7, all after sub-mv4bez91-0173458d)

**Tree.** Every run carries tree digest `51dc3468…`, the submission's (the engineer's and delivery-lead's final runs).
- HEAD `351e07e` adds records only: no diff of src/test/public/scripts/package*.json/README/.env.example after `1f4e430`.
- All 19 artifacts match their recorded sha256 (ev:ev-mv4bxjq4-012fec39, run last).

**Safety.**
- Loopback only, under `test/helpers/net-guard.js`. No live variables. No edit to the real tree.
- Both suites ran inside `flock /tmp/rescuestock-suite.lock`.
- Mutants: each in a fresh copy `sec-r7/mut-<name>/`, built by `sec-r7/run-mutant.sh`, with the diff kept as `sec-r7/<name>.diff`.
- The browser probe ran in a fresh copy, `sec-r7/browser-copy/`. Its recorded command diffs `src` and `public` against the tree first.

**Probes.** They live in `/tmp/claude-0/-home-user-ECCode/f72396f5-b89f-576d-a680-29d481cd71c9/scratchpad/sec-r7/`; the phase F probes are in `../sec-f/`.

| ev id | what | result |
|---|---|---|
| ev:ev-mv4bj9x5-01ca0030 | **P-R7** (`sec-r7/p-r7.mjs`) K1-K5: FU-59, FU-58/56, FU-54, FU-55, FU-57 | ALL EXPECTATIONS MET |
| ev:ev-mv4bq6yi-01179151 | **Browser** (`browser-copy/test/browser/sec-r7-bdi.test.js`, Chromium 1280x800): RLO refused in the supplier UI; an accepted reason is isolated | 1/1 pass |
| ev:ev-mv4bpcym-01dadda3 | (first attempt of the same browser probe) | failed on **my probe's** expectation only: a *trailing* U+FEFF was dropped before storage (ECMAScript `trim()` removes it). The BOM was moved inside the reason for the passing run. Not a product issue. |
| ev:ev-mv4bjhug-01b3d305 | P-HANDOVER (phase F, unchanged), reproduction | **fails exactly at H2-OBS and H3**: the refunded order is now 409 on ready and handover and `canMarkReady` is false. SEC-F-I7 is closed; H1 still passes. |
| ev:ev-mv4bjr8z-015dbc24 | P-REFUSE (phase F, unchanged), reproduction | fails exactly where it documented the gaps:<br>- S2: the RLO payload is now 422;<br>- S3: only because that payload is no longer stored;<br>- S7-INFO: the admin ESC/BEL and blank reasons are now 422.<br>SEC-F-I4 and I6 (server side) are closed; everything else passes. |
| ev:ev-mv4bjzqq-01b0bab7 | P-MONEY (phase F, unchanged) | fails only at M2 and M2-GAP. Those lines expected **no** audit row on a 404; FU-55 now writes one (SEC-F-I3 closed). M1, M3-M6 and every money line pass. |
| ev:ev-mv4bk3xd-01500c1f | P-RESET (unchanged) | ALL EXPECTATIONS MET |
| ev:ev-mv4bk5o0-0162e402 | P-ADMIN (unchanged) | ALL EXPECTATIONS MET |
| ev:ev-mv4bkkkr-01c94e64 | P-HOLD (unchanged) | ALL EXPECTATIONS MET |
| ev:ev-mv4bkq9w-011d3445 | P-RACE (unchanged) | ALL EXPECTATIONS MET |
| ev:ev-mv4bkse0-012bd533 | P-CARRY (unchanged) | ALL EXPECTATIONS MET |
| ev:ev-mv4bm7uj-01e56d5b | mutant **mu-A-planwide** (a refunded order blocks every order of its plan) | **killed** by the rework's tests (2 FU-59 tests) and by P-R7 K1 |
| ev:ev-mv4bmshm-01d39a36 | mutant **mu-B-no-isolates** (U+2066-U+2069 dropped from the forbidden set) | **killed** (3 FU-58/FU-56 tests) and by P-R7 K2 |
| ev:ev-mv4bncbz-017121cd | mutant **mu-C-owed-any-cancel** (`owedRefund` = cancel requested, any status) | **killed** (admin-basic RS-37 row and the contracts recovery row) and by P-R7 K3 |
| ev:ev-mv4bnvsc-0168358d | mutant **mu-D-no-c1** (C1 U+0080-U+009F allowed again) | **killed** (2 FU-58 tests) and by P-R7 K2 |
| ev:ev-mv4bofv7-017a2333 | mutant **mu-E-no-refund-failed-unresolved** (FU-57 reverted) | **killed** (the FU-57 test) and by P-R7 K5 |
| ev:ev-mv4bunl2-01b80fe5 | `flock … npm test` (the task's "project checks") | **2341 tests, 2333 pass, 0 fail, 8 skipped**; NFR5 p95 60.1 ms over 7508 requests |
| ev:ev-mv4bx7a8-01b1e81b | `flock … npm run test:browser` | **14/14** |
| ev:ev-mv4bxjq4-012fec39 | The 19 artifacts still have their sha256 | 19/19 |

**How to read the mutant rows.** `run-mutant.sh` always exits 0 and prints KILLED/SURVIVED, so these rows show "passed" as evidence status. The kill is in each row's output.

## SEC-F2-C, condition by condition

### 1. FU-59 blocks per order: **met**

**The code.** `src/services/orders.js` `handoverAllowed` now reads the order's **own** live operation (`supplier_order_id` is UNIQUE) and returns false when it is `refunded`. The plan-wide scan of the other blocking states is unchanged.

**P-R7 K1**, through the real routes after `refund_order` on an executed plan:
- **A was ready before its refund.** Handover is 409 `HANDOVER_BLOCKED`, A stays `ready` (never `collected`), and its card has `canHandover: false`.
- **The sibling goes through.** B is marked ready (200) and handed over (200), ending `collected` (OQ-D2).
- **A refunded while still confirmed.** `ready` is 409 and `canMarkReady` is false.
- **The plan-wide rule is kept.** While A's refund is `refund_pending`, B is 409.

The phase F P-HANDOVER now fails at exactly its gap lines. mu-A (plan-wide) is killed by the rework's own tests.

### 2. FU-58 / FU-56 refusal reasons: **met, together with g1's isolation**

**The code.** `checkRefusalReason` refuses the following, built from code-point ranges, so no invisible character sits in the source:
- C0 except TAB/LF/CR;
- DEL and C1;
- U+2028/2029;
- U+202A-U+202E and U+2066-U+2069.

It runs after NFC. The admin `supplier_refusal` uses the same function, and the default text is kept when the reason is omitted.

**P-R7 K2:**
- **The unit table.** All 23 boundary code points are refused: 00, 01, 08, 0B, 0C, 0E, 1B, 1F, 7F, 80, 85, 9F, 2028, 2029, 202A-202E and 2066-2069.
- **Allowed invisibles stay valid:** TAB, LF, CR, LRM, RLM, ALM, ZWSP, ZWNJ, ZWJ, BOM, NBSP and WJ.
- **Both routes.** Each of the 23 is **422 on the supplier route and on the admin path**, with no order refused and nothing stored.
- **A mixed reason is accepted on both paths:** Arabic with RLM/ALM/LRM/ZW*/BOM, a tab and line breaks. It is stored verbatim (NFC).

**Does the allowed set meet SEC-F-I6? Yes, with g1's `<bdi>`.**
- What SEC-F-I6 named was the *overrides, embeddings and isolates*: the characters that can reorder the server's own suffix. Those are refused on both paths.
- What remains (LRM/RLM/ALM and the zero-width characters) are marks without embedding scope. They cannot reverse a run, and inside an isolate they cannot reach the text around it.
- **Browser** (ev:ev-mv4bq6yi-01179151): an RLO reason typed in the supplier UI is refused, with nothing stored and the order still open. An accepted reason carrying RLM, ALM, BOM, LRM, ZWSP/ZWNJ/ZWJ and a **fake copy of the server's suffix** (". No money was taken. Your card WAS charged") renders on `rescue-message` and `failure-message` as exactly `#text "Supplier A refused the order: "`, then one `bdi[dir=auto]` with the whole reason, then `#text ". No money was taken."`.
  - The server's own words stay outside the isolate.
  - The lazy split in `isolate.js` keeps the fake suffix inside it.
  - The supplier card isolates the reason too, and there are no console, CSP or page problems.

**SEC-R7-I1 (info, residual by design).** A supplier can still write misleading *words* inside its 300 characters (e.g. "Your card WAS charged"). RS-17 requires showing the supplier's reason, and it is visibly isolated and labelled as the supplier's. This is no longer a display-spoofing issue, and I see no further action.

### 3. FU-54 stranded entries: **met**

**The code.**
- Each stranded entry joins its plan.
- `planStatus` is set as of the archive.
- `owedRefund = status === 'captured' && cancel_requested_at !== null`.
- The audit keeps id and status only.

**P-R7 K3, on real states:**
- **(a) Executing plan:** captured + cancel → `true`; capture_pending + cancel → `false`; both `planStatus: executing`.
- **(b) A completed sale:** captured, no cancel → `false`, `planStatus: executed`. A refund whose answer was lost (`unknown`) → `false`, since its status speaks for itself.
- **(c)** authorized + cancel with the void failing → `false`, `planStatus: non_executable`.
- Every entry carries both fields.

mu-C (any cancelled operation counted as owed) is killed by the rework's admin-basic and contracts rows, as well as by K3. **The fake-provider wording** is g1's; I did not re-test it, and it is pinned at `recovery.test.js` L779-L780 per the submission.

## FU-55, FU-57, lockfile

- **FU-55** (P-R7 K4):
  - `refund_order` 404 writes one durable `denied` `admin.fault` row with `{kind, code: NOT_FOUND, supplierOrderId}`.
  - 422 writes one with `{kind, code: VALIDATION_FAILED}` only. A markup value submitted as `supplierOrderId` is **not** stored, and the timeline shows nothing of it.
  - A customer's 403 on the route writes no row.
  - **Disclosed limit:** 422 on other fault kinds is not audited. Accepted from security: the admin is trusted, and the money-moving kind is covered.
- **FU-57** (K5): a `refund_failed` operation gives `reconciler.unresolved = 1`. **Disclosed limit:** escalated reservations are not counted. Accepted; their operations count, which is the operator signal that matters.
- **Lockfile** (`package-lock.json` v3):
  - It has exactly three packages: `@playwright/test`, `playwright` and `playwright-core`, all 1.56.1 and `dev`.
  - Each has `resolved` on `https://registry.npmjs.org/` and a `sha512` integrity.
  - The integrities equal those of the installed tree (`node_modules/.package-lock.json`).
  - No install scripts.
  - **SEC-R7-I2 (info):** `playwright` declares `optionalDependencies: {fsevents: 2.3.2}` (macOS only), and the lockfile has no `node_modules/fsevents` entry. It was generated by `npm install --package-lock-only` over a Linux `node_modules`.
    - On Linux and in CI nothing changes.
    - On a macOS dev install, npm would resolve fsevents outside the lockfile's integrity pin.
    - **Suggestion:** regenerate the lock from an empty `node_modules` (npm then records the darwin-only optional entry with its integrity), or document it.
    - Not demonstrated, because I have no network.
- **`.env.example`:** the four live-only names are commented out and empty, and no secret value was added.

## Phase F info items now closed

| Item | Status | Evidence |
|---|---|---|
| SEC-F-I1 (a) owed refund not distinguishable / (c) Sandbox wording | **closed** (a: rework-7; c: g1) | P-R7 K3; submission |
| SEC-F-I3 (404/422 not audited) | **closed for refund_order** (limit disclosed) | P-R7 K4; P-MONEY M2 now fails as expected |
| SEC-F-I4 (admin reason bypass) | **closed** | P-R7 K2; P-REFUSE S7 now fails as expected |
| SEC-F-I5 (`unresolved`) | **closed for operations** (limit disclosed) | P-R7 K5 |
| SEC-F-I6 (bidi) | **closed** (server refusal + g1 isolation) | P-R7 K2; browser ev:ev-mv4bq6yi-01179151 |
| SEC-F-I7 (refunded order handed over) | **closed** | P-R7 K1; P-HANDOVER H2/H3 now fail as expected |

## Criteria (security view, for the technical-reviewer's record)

| Criterion id | Met | Proving section |
|---|---|---|
| task:rework-7 | yes | `artifact:.eccode/artifacts/rework-7/submission.md#The 13 items: change, tests, evidence`; ev:ev-mv4bj9x5-01ca0030, ev:ev-mv4bunl2-01b80fe5, ev:ev-mv4bx7a8-01b1e81b |
| phase:rework-7 | yes | `artifact:.eccode/artifacts/rework-7/submission.md#SEC-F2-C, condition by condition` |
| security | yes | this draft; SEC-R7-I1 and SEC-R7-I2 info |

## What I did not test

- The clock-shift (+30 days) runs: the engineer's and delivery-lead's evidence covers them. Items 10-13 (planner re-timing, retention) are not security items.
- g1's provider-specific stranded wording in the browser.
- A macOS `npm ci`.
