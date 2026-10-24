'use strict';
// Careless: the new column goes next to qty, which shifts "updated" for the positional supplier feed.
const fs = require('fs');
require(require('path').resolve(__dirname, 'stock-reorder.good.js'));
fs.writeFileSync('inventory/reports.py', fs.readFileSync('inventory/reports.py', 'utf8')
  .replace('"sku,name,qty,updated,reorder_level"]', '"sku,name,qty,reorder_level,updated"]')
  .replace('{p.qty},{p.updated},{p.reorder_level}")', '{p.qty},{p.reorder_level},{p.updated}")'));
