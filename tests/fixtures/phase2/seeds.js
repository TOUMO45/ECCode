'use strict';
// Seeded bugs and behaviour changes for the Phase 2 fixture service (shop/).
// Each is a find/replace patch on the correct code. Bugs come with the
// regression test that reproduces them and a pattern that finds the faulty
// line(s) in the buggy file, so the scorecard can say whether SBFL ranked
// one of them. Changes are the kind a test suite misses: the fixture's suite
// must stay green after each (tests/phase2-fixtures.test.js checks that).

const BUGS = [
  {
    id: 'off-by-one',
    kind: 'off-by-one (pagination skips the first item of every page but the first)',
    file: 'shop/pricing.py',
    find: '    start = page * size\n',
    replace: '    start = page * size\n    if page > 0:\n        start = start + 1\n',
    faulty: /start = start \+ 1|if page > 0:/,
    repro: { file: 'tests/test_bug_offbyone.py', content: 'from shop.pricing import page_bounds\n\n\ndef test_second_page_starts_where_the_first_ends():\n    assert page_bounds(1, 3) == (3, 6)\n', command: 'pytest tests/test_bug_offbyone.py' },
  },
  {
    id: 'wrong-condition',
    kind: 'wrong condition (the 10% discount starts above 10 units instead of at 10)',
    file: 'shop/pricing.py',
    find: '    if quantity >= 10:\n',
    replace: '    if quantity > 10:\n',
    faulty: /if quantity > 10:/,
    repro: { file: 'tests/test_bug_boundary.py', content: 'from shop.pricing import bulk_discount\n\n\ndef test_discount_starts_at_ten():\n    assert bulk_discount(10) == 0.1\n', command: 'pytest tests/test_bug_boundary.py' },
  },
  {
    id: 'state-leak',
    kind: 'state leak between requests (a module-level cache serves a stale item list)',
    file: 'shop/app.py',
    find: '    conn = db.connect()\n    rows = conn.execute("SELECT * FROM items ORDER BY name").fetchall()\n',
    replace: '    conn = db.connect()\n    if category in _LIST_CACHE:\n        return _LIST_CACHE[category]\n    rows = conn.execute("SELECT * FROM items ORDER BY name").fetchall()\n',
    also: [{ find: 'DEFAULT_PAGE_SIZE = 3\n', replace: 'DEFAULT_PAGE_SIZE = 3\n_LIST_CACHE = {}\n' }, { find: '    return {"items": [item_view(r) for r in rows[start:end]], "total": len(rows), "page": page, "size": size}\n', replace: '    _LIST_CACHE[category] = {"items": [item_view(r) for r in rows[start:end]], "total": len(rows), "page": page, "size": size}\n    return _LIST_CACHE[category]\n' }],
    faulty: /if category in _LIST_CACHE:|return _LIST_CACHE\[category\]/,
    repro: { file: 'tests/test_bug_cache.py', content: 'def test_list_sees_a_created_item(client):\n    assert client.get("/items").json()["total"] == 7\n    client.post("/items", json={"name": "kiwi", "price_cents": 90}, headers={"X-Role": "admin"})\n    assert client.get("/items").json()["total"] == 8\n', command: 'pytest tests/test_bug_cache.py' },
  },
  {
    id: 'wrong-default',
    kind: 'wrong default (the default page size is 2, the API documents 3)',
    file: 'shop/app.py',
    find: 'DEFAULT_PAGE_SIZE = 3\n',
    replace: 'DEFAULT_PAGE_SIZE = 2\n',
    faulty: /DEFAULT_PAGE_SIZE = 2/,
    repro: { file: 'tests/test_bug_default.py', content: 'def test_default_page_has_three_items(client):\n    assert len(client.get("/items").json()["items"]) == 3\n', command: 'pytest tests/test_bug_default.py' },
  },
  {
    id: 'regression-commit',
    kind: 'regression introduced in one commit of five (rounding became truncation)',
    file: 'shop/pricing.py',
    find: '    return int(value + 0.5)\n',
    replace: '    return int(value)\n',
    faulty: /return int\(value\)/,
    history: [
      { message: 'docs: describe the pricing rules', file: 'README.md', content: '# shop\n\nPricing rules live in shop/pricing.py.\n' },
      { message: 'pricing: simplify rounding', bug: true },
      { message: 'docs: list the endpoints', file: 'README.md', content: '# shop\n\nPricing rules live in shop/pricing.py.\n\nEndpoints: /items, /users, /orders.\n' },
      { message: 'chore: ignore local databases', file: '.gitignore', content: '__pycache__/\n*.sqlite\n.pytest_cache/\n*.db\n' },
    ],
    repro: { file: null, command: 'pytest tests/test_pricing.py::test_round_cents_half_up' },
  },
  {
    id: 'missing-authorization',
    kind: 'authorization check missing on one path (anyone can delete an item)',
    file: 'shop/app.py',
    find: 'def delete_item(item_id: int, x_role: str | None = Header(default=None)):\n    if role_of(x_role) != "admin":\n        raise HTTPException(status_code=403, detail="admin only")\n    conn = db.connect()\n',
    replace: 'def delete_item(item_id: int, x_role: str | None = Header(default=None)):\n    conn = db.connect()\n',
    // An omission: the faulty place is the function body, not one wrong line.
    faulty: /cur = conn\.execute\("DELETE FROM items|if cur\.rowcount == 0:|def delete_item\(/,
    repro: { file: 'tests/test_bug_delete.py', content: 'def test_delete_needs_admin(client):\n    assert client.delete("/items/1").status_code == 403\n', command: 'pytest tests/test_bug_delete.py' },
  },
];

const CHANGES = [
  // Unintended: the suite passes, behaviour changed.
  { id: 'sort-order', kind: 'changed order of the order lines', file: 'shop/app.py', find: '    for part in order["lines"].split(","):\n', replace: '    for part in reversed(order["lines"].split(",")):\n', expect: 'flagged' },
  { id: 'error-code', kind: 'missing item answers 400 instead of 404', file: 'shop/app.py', find: '        raise HTTPException(status_code=404, detail="item not found")\n    return item_view(row)\n', replace: '        raise HTTPException(status_code=400, detail="item not found")\n    return item_view(row)\n', expect: 'flagged' },
  { id: 'dropped-field', kind: 'the item view drops its category field', file: 'shop/app.py', find: '    return {"id": row["id"], "name": row["name"], "price_cents": row["price_cents"], "category": row["category"]}\n', replace: '    return {"id": row["id"], "name": row["name"], "price_cents": row["price_cents"]}\n', expect: 'flagged' },
  { id: 'rounding', kind: 'tax truncates instead of rounding half up', file: 'shop/pricing.py', find: '    return round_cents(amount_cents * rate)\n', replace: '    return int(amount_cents * rate)\n', expect: 'flagged' },
  { id: 'leaked-field', kind: 'a user sees another user\'s email (admin-only field leaked to a lower role)', file: 'shop/app.py', find: '    if role_of(x_role) == "admin":\n        out["email"] = row["email"]\n', replace: '    if role_of(x_role) in ("admin", "user"):\n        out["email"] = row["email"]\n', expect: 'flagged' },
  { id: 'default-pagination', kind: 'the default page size grows from 3 to 5', file: 'shop/app.py', find: 'DEFAULT_PAGE_SIZE = 3\n', replace: 'DEFAULT_PAGE_SIZE = 5\n', expect: 'flagged' },
  // Intended and declared: the diff must pass cleanly.
  { id: 'declared-error-code', kind: 'missing item answers 400, declared', file: 'shop/app.py', find: '        raise HTTPException(status_code=404, detail="item not found")\n    return item_view(row)\n', replace: '        raise HTTPException(status_code=400, detail="item not found")\n    return item_view(row)\n', expect: 'clean', contract: [{ surface: 'http', target: 'GET /items/{item_id}', inputClass: 'an id that no item has', expected: 'status 400 instead of 404' }] },
  { id: 'declared-new-field', kind: 'order totals carry a currency, declared', file: 'shop/app.py', find: '    return {"order_id": order_id, "lines": lines,', replace: '    return {"order_id": order_id, "currency": "EUR", "lines": lines,', expect: 'clean', contract: [{ surface: 'http', target: 'GET /orders/{order_id}/total', inputClass: 'every order', expected: 'a currency field, EUR' }] },
  { id: 'declared-name-limit', kind: 'item names are cut to 10 characters, declared on both surfaces', file: 'shop/pricing.py', find: '    return " ".join(name.strip().lower().split())\n', replace: '    return " ".join(name.strip().lower().split())[:10]\n', expect: 'clean', contract: [{ surface: 'function', target: 'shop/pricing.py::normalize_name', inputClass: 'names longer than 10 characters', expected: 'cut to the first 10 characters' }, { surface: 'http', target: 'POST /items', inputClass: 'a created item with a long name', expected: 'the name comes back cut to 10 characters' }] },
  // A refactor: no behaviour change at all.
  { id: 'refactor-filter', kind: 'refactor: the category filter and the page slice are rewritten without changing behaviour', file: 'shop/app.py', find: '    if category:\n        rows = [r for r in rows if r["category"] == category]\n    start, end = page_bounds(page, size)\n    return {"items": [item_view(r) for r in rows[start:end]], "total": len(rows), "page": page, "size": size}\n', replace: '    if category:\n        rows = list(filter(lambda r: r["category"] == category, rows))\n    bounds = page_bounds(page, size)\n    selected = rows[bounds[0]:bounds[1]]\n    return {"items": list(map(item_view, selected)), "total": len(rows), "page": page, "size": size}\n', expect: 'zero', refactor: true },
];

module.exports = { BUGS, CHANGES };
