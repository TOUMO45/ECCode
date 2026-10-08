# acme-kit

Acme's shared service toolkit. It is vendored into every service under `vendor/acme-kit` and has zero dependencies (Node ≥ 18). All Acme services are expected to use it and follow the conventions below. Code review enforces them.

## Modules

| Module | Purpose |
|---|---|
| `db` | Table store with the production SQL driver's value semantics |
| `money` | Exact money arithmetic in integer cents |
| `http` | Router, JSON bodies, validation, the error envelope |
| `cache` | `memo` and `ttlCache` |

## db

`createDb({ tables })` returns a store with `all(table, where)`, `get(table, id)`, `insert`, `update` and `remove`. Every table has an integer `id`.

### Column types

| Type | JavaScript value returned |
|---|---|
| `INTEGER` | number |
| `TEXT` | string |
| `BOOLEAN` | boolean |
| `TIMESTAMP` | ISO-8601 string |
| `DECIMAL(p,s)` | **string** with exactly `s` decimals, e.g. `"12.50"` |

`DECIMAL` is returned as a string on purpose. The production driver does the same so that no precision is lost. Treat these values as text until they are converted at the repository boundary (see Money).

## money

Acme services never do money arithmetic with JavaScript floats.

- **Repository boundary:** convert `DECIMAL` strings with `money.fromDecimal("12.50")` → `1250` (integer cents) where rows are read. Everything above the repository layer works in integer cents.
- **Arithmetic:** use `money.sum([...cents])` and `money.percent(cents, basisPoints)` (825 = 8.25%, rounded half away from zero).
- **Output:** `money.toDecimal(cents)` → `"12.50"` for API fields, and `money.format(cents)` → `"$12.50"` for display text.
- **Comparisons and sorting:** compare cents (numbers), never the `DECIMAL` strings.

## http

```js
const { createRouter, createServer, json, problem, readJson, validate, HttpError } = require('../vendor/acme-kit/http');
const router = createRouter().add('GET', '/api/items/:id', async (req, res, { params, query }) => { … });
createServer(router).listen(3000);
```

### Error envelope

Every error response uses `problem(res, status, code, detail, extra)`, which produces:

```json
{ "error": { "code": "validation_failed", "detail": "Request body is invalid", "fields": ["title"] } }
```

| Status | `code` | When |
|---|---|---|
| 400 | `bad_request` | Malformed request, e.g. invalid JSON (`readJson` throws it) |
| 404 | `not_found` | Unknown route or resource |
| 405 | `method_not_allowed` | Route exists, method does not |
| 409 | `conflict` | The request conflicts with current state (duplicate, overlap, …) |
| 413 | `payload_too_large` | Body over the limit (`readJson` throws it) |
| 415 | `unsupported_media_type` | Body is not `application/json` (`readJson` throws it) |
| 422 | `validation_failed` | Well-formed JSON that fails validation. `extra = { fields: [<invalid field names>] }` |
| 500 | `internal_error` | Unexpected failure. Never include exception messages or stacks |

Throwing `new HttpError(status, code, detail, extra)` inside a handler is equivalent to calling `problem()`. The router converts it, and it converts any other exception into a generic 500.

### Validation

`validate(body, schema)` returns `{ ok, fields }`. Schema rules: `type` (`string|number|integer|boolean`), `required`, `min`/`max` (length for strings after trim for `min`, value for numbers) and `pattern`. A validation failure is answered with `problem(res, 422, 'validation_failed', 'Request body is invalid', { fields })`. Do not use 400 for it.

## cache

- `memo(fn, { ttlMs, key })` caches `fn`'s results for `ttlMs`, keyed by `key(...args)`.
- `ttlCache({ ttlMs })` is a plain cache with `get`, `set`, `invalidate` and `clear`.

## Caveats

- **`memo` keys on the first argument by default.** The default `key` is `JSON.stringify(args[0])`. If more than one argument affects the result, pass an explicit key, e.g. `memo(fn, { key: (a, b) => `${a}|${b}` })`. Otherwise calls that differ only in later arguments return the first cached result.
- **`ttlCache` is not invalidated automatically.** Code that writes data cached in a `ttlCache` must call `invalidate(key)` for the affected key.
- **`DECIMAL` values are strings.** `"9.50" > "10.00"` is `true` and `"5.00" + "2.50"` is `"5.002.50"`. Convert with `money.fromDecimal` first.
