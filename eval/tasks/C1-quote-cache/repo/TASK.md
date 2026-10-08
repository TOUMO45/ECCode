# Bug: quotes sometimes use the wrong volume price

**Reported by:** support (ticket CAT-417), after a call with Brightline Electrical

Brightline asked for a quote for 10 × `CBL-1` (Cat6 patch cable, 1 m) and got 4.20 per unit. That is our single-unit price; from 10 units it should be 3.80. A colleague had quoted a single `CBL-1` for another customer a few minutes earlier.

It also happens the other way round: we have seen single cables quoted at the volume price. It looks random, and it goes away after a while or after a restart.

```
GET /api/quote?sku=CBL-1&qty=10
{"sku":"CBL-1","qty":10,"unitPrice":"4.20","total":"42.00"}     expected 3.80 / 38.00
```

**Acceptance**
- Every quote uses the price for the requested SKU and quantity, whatever was quoted before.
- Existing behaviour stays as it is (`npm test` passes).
