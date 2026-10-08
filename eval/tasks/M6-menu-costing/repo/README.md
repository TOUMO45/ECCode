# menu-service

Recipe and menu costing for Acme's restaurant kitchens. It uses the shared toolkit in `vendor/acme-kit` (read its README for the conventions every Acme service follows).

```sh
npm test      # node --test
npm start     # http://127.0.0.1:3000
```

## Endpoints
- `PUT /api/ingredients/:id` with `{"price": "4.80"}`: set an ingredient's current price (per kg, per litre or each, see `unit`)
- `PATCH /api/dishes/:id` with `{"portions": 8}`: set how many portions the recipe yields
- `PUT /api/dishes/:id/lines` with `{"lines": [{"ingredientId": 1, "quantity": 500}, {"subDishId": 2, "quantity": 3}]}`: replace the recipe. Ingredient quantities are in grams, millilitres or pieces (by unit); a sub-recipe line counts portions of that sub-recipe.
- `GET /api/dishes/:id/cost?covers=40`: what the recipe costs, scaled to a number of covers (default: the recipe's own yield)
- `GET /api/menus/:id/report`: food cost of every dish on a menu against its selling price

## Notes
- A recipe can use other recipes (sauces, bases) as sub-recipes. Costing nested recipes is slow, so costs are cached in memory (`src/costing`).
- Amounts are DECIMAL columns, converted to integer cents at the repository boundary.
- `createApp({ db, now })` takes an optional clock so tests can fix the time.
- Data comes from `fixtures/db.json` through `acme-kit/db`, which has the same value semantics as production.
