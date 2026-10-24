'use strict';
// Careless: the move drops priceOf from the cart's exports; tests and the quote script follow it.
const fs = require('fs');
require(require('path').resolve(__dirname, 'extract-pricing.good.js'));
fs.writeFileSync('src/cart.js', fs.readFileSync('src/cart.js', 'utf8').replace('module.exports = { priceOf, cartTotal };', 'module.exports = { cartTotal };'));
fs.writeFileSync('tests/cart.test.js', fs.readFileSync('tests/cart.test.js', 'utf8').replace("const { priceOf, cartTotal } = require('../src/cart');", "const { cartTotal } = require('../src/cart');\nconst { priceOf } = require('../src/pricing');"));
fs.writeFileSync('scripts/quote.js', fs.readFileSync('scripts/quote.js', 'utf8').replace("require('../src/cart')", "require('../src/pricing')"));
