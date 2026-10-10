# phase:rework-1 — submission

Author: delivery-lead. Gate: `phase:rework-1`. Date: 2026-10-10.
- Opened by the orchestrator after the phase C review `rev-mv2zb2wy-019ac65d`, which approved phase C with TR-C-2, SEC-C-2 and SEC-C-3 open.
- One task, `rework-1` (backend-engineer), handoff `ho-mv2zloa4-0168f7f1`.
- Ownership: `src/config.js`, `.env.example`, `src/auth/**`, `src/services/requests.js`, `test/unit/config/**`, `test/unit/auth/**`, and four named test files.

## Delivery-lead run on the final tree

`npm test`: **821 tests, 805 pass, 0 fail, 10 skipped, 6 todo**; NFR5 p95 55.2 ms over 2,578 API calls; suite 34.1 s (**ev:ev-mv2znsts-01786823**).
- The skipped and todo results are the same as in phase C: contract scenarios for routes of phases D and E (FU-18), and known fixture defects (FU-13).
- The browser suite was run by the engineer after the rework: 3/3 (ev:ev-mv2zl4mn-01560653).

## Finding → change → test → evidence

| Finding (resolution condition) | Change | Tests | Evidence |
|---|---|---|---|
| **TR-C-2:** both planning-limit names parsed with bounds (1–1000, 1–1440, defaults 10/10) into `planRateLimit`/`planRateWindowMin`, listed in `.env.example`, covered by a RISK-19 test, env-example scan green | `src/config.js` parses `RS_PLAN_RATE_LIMIT` and `RS_PLAN_RATE_WINDOW_MIN`; out-of-range values are refused by variable name. Both are in `.env.example` with their defaults. `src/app.js` already read these config fields (c2). | `TR-C-2: …` ×2 in `test/unit/config/limits.test.js` (bounds, defaults, refusal by name); env-example scan with the new defaults; c2's existing `RISK-19: …` tests (11th plan refused, configurable limit). **Note:** the new env tests are named `TR-C-2`, not `RISK-19`. The RISK-19 tests cover the limit itself, not the env names. The reviewer may accept the TR-C-2 naming or ask for the prefix. | failing first ev:ev-mv2zhs1c-019dd6ab; passing ev:ev-mv2zk7pm-01750b17; my npm test ev:ev-mv2znsts-01786823 |
| **SEC-C-3 (1):** the access hook counts every signed-in call per user (kind `general`, key `u:<id>`, one `BEGIN IMMEDIATE`), 429 `RATE_LIMITED` `details.limit: "general"` with `Retry-After`, never counts `plan:u:<id>`; the 301st call in a minute refused; p95 < 300 ms | New `src/auth/general-limit.js`, built by `createAuth` from config. `createAccess` (`src/auth/rbac.js`) calls it right after authentication.<br>- **Counted:** every non-public, authenticated call.<br>- **Not counted:** anonymous 401s and the signature-authenticated webhook route.<br>- Expired rows of that user are deleted in the same transaction.<br>- A refused call is not inserted.<br>- `src/app.js` and `src/routes/**` are untouched. | `SEC-C-3: …` in `test/api/rate-limits.test.js` (301st call refused with `Retry-After`, p95 measured; plan and general keys separate both ways; public and anonymous uncounted; configurable), `test/unit/auth/general-limit.test.js` (limit edge, window expiry, one-transaction check, bad limits, position in the access hook) and limits.test.js (config). 15 `SEC-C-3` results in my run | ev:ev-mv2zk7pm-01750b17, ev:ev-mv2znsts-01786823 |
| **SEC-C-3 (2):** a confirm whose values equal the latest version returns it without inserting a row | `confirmRequirements` (`src/services/requests.js`) returns the latest version when the values **and the derived field provenance and wording** equal it. Nothing is inserted (no requirements, audit or re-plan row); still HTTP 201; `intake_status` stays `confirmed`. | `SEC-C-3: a confirm with the same values as the latest version returns that version and inserts no requirements row, audit row or re-plan` (`test/api/requests-plans.test.js`) | same |
| **SEC-C-2:** IPv6 sign-in and register throttle keys are the /64 (IPv4 and `::ffff:` unchanged); 5 failures over 5 addresses of one /64 make the 6th get 429 | `src/auth/client-ip.js` gains `throttleKey()`:<br>- IPv6 becomes its /64, e.g. `2001:db8:1:1::/64`;<br>- IPv4 and `::ffff:`-mapped addresses (dotted or hex form) collapse to IPv4;<br>- used for the socket address and for the trusted last `X-Forwarded-For` hop. | `SEC-C-2: …` ×4: unit (same key for one /64, other prefixes differ; IPv4 and mapped forms), API (5 failures over 5 addresses of one /64 → 6th gets 429; another /64 and an IPv4 address separate; register counts one /64 as one address) | same |

## Environment variables (four new names)

| Name | Bounds | Default | In the spec's Deployment table? |
|---|---|---|---|
| `RS_PLAN_RATE_LIMIT` | 1–1000 | 10 | No. FU-8's `plan` limit was approved by `dec-mv1jopyn-01ba1096`, and FU-14 asked for this name. |
| `RS_PLAN_RATE_WINDOW_MIN` | 1–1440 | 10 | No (same as above). |
| **`RS_GENERAL_RATE_LIMIT`** | 1–100000 | 300 | **No.** The spec states the limit (300/min) but no variable; the name, bounds and default were chosen by this rework. |
| **`RS_GENERAL_RATE_WINDOW_SEC`** | 1–3600 | 60 | **No** (same as above). |

All four are in `.env.example`, and the env-example scan asserts them. The approved spec is pinned, so the table update is recorded in `.eccode/artifacts/plan/followups.md` ("Status after rework-1"). It is an item of the release checklist and the verification report, as a documented design delta. g2's README pass must list the four names.

## Items for the reviewers (the engineer's disclosures)

1. **Every signed-in call now writes one `rate_events` row,** up to 300 per user per minute.
   - Expired rows are deleted only on that user's next call.
   - Rows of users who stop calling remain.
   - The admin reset deletes only `request_create` and `plan:%` rows.
   - No housekeeping sweep exists yet. New **FU-20** assigns it to the periodic housekeeping (d3's retention sweep or e4's reconciler step 9), per the spec's 24 h purge of rate events.
2. **Role and CSRF failures of a signed-in user count toward the general limit.** A 403 for the wrong role or a bad CSRF token is counted; only anonymous 401s, public routes and the webhook route are outside the count. This is defensible (it bounds a signed-in client's probing), but it is a choice the spec does not state.
3. **"Unchanged" compares derived fields, not just values.** A confirm with the same values but a different derived provenance (for example after a newer extraction) still writes a version.
   - SEC-C-3 (2) says "values equal". Under that literal wording, such a confirm should return the latest version.
   - The engineer's reading keeps provenance history exact.
   - The reviewer decides. If the literal reading is required, it is a narrow change in `confirmRequirements`.
4. **Three existing assertions changed to follow the new behaviour:**
   - two c2 assertions in `requests-plans.test.js` that counted every `general` row now count only `plan:%` rows;
   - one that expected no `u:<id>` row now asserts at least one, distinct from the planning key;
   - the IPv6 expectations in `client-ip.test.js` and `auth.test.js` now expect the /64.

   None of them weakens a criterion. Each still asserts the separation of the planning count from the general count.
5. **Webhook limit untouched.** The webhook route keeps its own 60 per IP per minute limit, which e3 owns. The general limit does not apply to it.

## Artifact coverage

After submitting, I checked the artifacts against the rework's ownership (from the record) and against the git changes since its claim base `4bfc13a1`, with `.eccode/drafts/phase-artifacts-check.mjs`. The result is in the handoff to the reviewer.

## Lessons

`mem-sd-mv1audrd-013b7102` is recorded as not-applicable by the engineer. The basis is the plan's assessment ev:ev-mv1eo87o-01c933d5.
