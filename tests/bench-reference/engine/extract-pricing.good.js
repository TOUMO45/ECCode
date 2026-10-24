'use strict';
// Good: the rules move to src/pricing.js; the cart re-exports priceOf, so its public API holds.
const fs = require('fs');
const cart = fs.readFileSync('src/cart.js', 'utf8');
const start = cart.indexOf('const TAX_RATE');
const end = cart.indexOf('function cartTotal');
fs.writeFileSync('src/pricing.js', `'use strict';\nconst catalog = require('./catalog');\n\n${cart.slice(start, end).trimEnd()}\n\nmodule.exports = { priceOf };\n`);
fs.writeFileSync('src/cart.js', `'use strict';\nconst { priceOf } = require('./pricing');\n\n${cart.slice(end)}`);
fs.writeFileSync('tests/pricing.test.js', "'use strict';\nconst test = require('node:test');\nconst assert = require('node:assert');\nconst { priceOf } = require('../src/pricing');\n\ntest('pricing prices a line on its own', () => {\n  assert.strictEqual(priceOf({ sku: 'pen', qty: 10 }), 1620);\n});\n");
