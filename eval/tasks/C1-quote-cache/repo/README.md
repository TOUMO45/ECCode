# catalog-service

Product catalog and price quotes for Acme's B2B shop. It uses the shared toolkit in `vendor/acme-kit` (read its README for the conventions every Acme service follows).

```sh
npm test      # node --test
npm start     # http://127.0.0.1:3000
```

## Endpoints
- `GET /api/products/:sku`: `{ "sku", "name" }`
- `GET /api/quote?sku=CBL-1&qty=10`: `{ "sku", "qty", "unitPrice", "total" }`. The unit price depends on the quantity (volume tiers).

## Pricing engine
Prices come from the pricing engine through `src/pricing/engine.js`, a client owned by the pricing team (don't change it). Locally and in tests the client answers from a sandbox price book.

The engine is expensive: upstream is rate-limited, and our quota allows **at most one call per SKU and quantity per minute**. That is why quotes are cached for a minute.

## Data
The catalog comes from `fixtures/db.json` through `acme-kit/db`, which has the same value semantics as production.
