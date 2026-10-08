# Acme organisation rules (evaluation ground truth, never shown to trial sessions)

These rules model real organisational knowledge that is **not written down in any service repository**. In a real org it lives in a wiki, an interface spec or past review comments. Here, a session can only learn a rule from QA feedback: during training, a hidden check fails and the failure message states the rule.

Hidden checks that enforce a rule are tagged `[org:<id>]`. A holdout check tagged with a rule whose feedback the condition received in training counts as a **repeated mistake** when it fails.

| id | Rule (exact wording used in QA feedback) | Applies to |
|---|---|---|
| `list-envelope` | **Acme API guideline AG-7:** collection endpoints return `{"items": [...], "total": <number of matching records>}`. They accept `?limit` (default 50, max 100; invalid values are rejected with 422 `validation_failed`, `fields: ["limit"]`) and `?offset` (default 0). Bare JSON arrays are allowed only on legacy endpoints that already return them. | New or changed **collection** (list) endpoints |
| `audit-log` | **Acme compliance rule SEC-12:** every request that creates, changes or deletes data writes exactly one row to the service's `audit_log` table: `actor` (the `X-Acme-Actor` request header, or `"anonymous"` if absent), `action` (`create`, `update` or `delete`), `entity` (the table name), `entity_id` (the affected row id) and `at` (ISO-8601 timestamp). Rejected requests write nothing. | New or changed endpoints that **write data** |
| `idempotency` | **Acme payments rule PAY-3:** a POST endpoint that moves money (refunds, payouts, credits, charges) honours the `Idempotency-Key` request header. A repeated request with the same key returns the original status and body, and creates nothing new. A request without the header behaves normally. | New or changed endpoints that **move money** |
| `csv-crlf` | **Acme accounting interface spec ACC-2:** CSV files for accounting use CRLF (`\r\n`) line endings, start with a header row, wrap every text field in double quotes (doubling embedded quotes), and write amounts as plain decimals with two digits. | CSV files **for accounting**. Other consumers follow their own spec. |

## Decoys

A decoy holdout task looks like a situation where a learned rule or lesson applies, but it does not:
- **`csv-crlf` decoy:** a CSV export for a non-accounting consumer whose spec is stated in the task (for example LF line endings and no quoting). Applying ACC-2 fails the task.
- **Debugging decoy:** a stale or incorrect cached result with a different root cause from the `memo` key lesson (for example a missing `ttlCache` invalidation). Applying the memo-key fix does not repair it.
