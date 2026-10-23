'use strict';
// Good: the field defaults to 10 for saved data; the CSV appends the new column, so positions hold.
const fs = require('fs');
const edit = (f, pairs) => fs.writeFileSync(f, pairs.reduce((s, [a, b]) => { if (!s.includes(a)) throw new Error(`${f}: ${a}`); return s.replace(a, b); }, fs.readFileSync(f, 'utf8')));
edit('inventory/models.py', [
  ['    updated: str\n', '    updated: str\n    reorder_level: int = 10\n'],
  ['updated=d["updated"])', 'updated=d["updated"],\n                       reorder_level=int(d.get("reorder_level", 10)))'],
  ['"updated": self.updated}', '"updated": self.updated,\n                "reorder_level": self.reorder_level}'],
]);
edit('inventory/reports.py', [
  ['LOW_STOCK_THRESHOLD = 10\n\n\n', ''],
  ['if p.qty < LOW_STOCK_THRESHOLD)', 'if p.qty < p.reorder_level)'],
  ['sku,name,qty,updated."""', 'sku,name,qty,updated,reorder_level."""'],
  ['"sku,name,qty,updated"]', '"sku,name,qty,updated,reorder_level"]'],
  ['{p.qty},{p.updated}")', '{p.qty},{p.updated},{p.reorder_level}")'],
]);
fs.appendFileSync('tests/test_reports.py', '\n\ndef test_own_level():\n    assert low_stock([Product("C", "c", 15, "x", 20)]) == ["C"]\n');
