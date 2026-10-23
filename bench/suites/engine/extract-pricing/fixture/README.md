# shop-cart

Cart arithmetic for the shop. Amounts are integer cents.

## Public API

`require('shop-cart')` (src/cart.js) exports:

- `priceOf(item)`: the price of one cart line, after the bulk discount and with tax.
- `cartTotal(items)`: the sum of `priceOf` over the lines.

The storefront and `scripts/quote.js` (used by the sales team) import these. Keep them working.
