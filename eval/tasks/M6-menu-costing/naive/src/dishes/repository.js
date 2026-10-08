'use strict';
// Data access for recipes and their lines.

function getDish(db, id) {
  return db.get('dishes', id);
}

function linesOf(db, dishId) {
  return db.all('dish_lines', { dish_id: Number(dishId) });
}

function setPortions(db, id, portions) {
  return db.update('dishes', id, { portions });
}

/** Replace a recipe's lines. Each line is { ingredientId } or { subDishId } plus a quantity. */
function replaceLines(db, dishId, lines) {
  for (const old of linesOf(db, dishId)) db.remove('dish_lines', old.id);
  for (const l of lines) {
    db.insert('dish_lines', {
      dish_id: Number(dishId),
      ingredient_id: l.ingredientId === undefined ? null : l.ingredientId,
      sub_dish_id: l.subDishId === undefined ? null : l.subDishId,
      quantity: l.quantity,
    });
  }
  return linesOf(db, dishId);
}

/** True if `target` is `dishId` itself or used somewhere inside it. */
function contains(db, dishId, target, seen = new Set()) {
  if (dishId === target) return true;
  if (seen.has(dishId)) return false;
  seen.add(dishId);
  return linesOf(db, dishId).some((l) => l.sub_dish_id !== null && contains(db, l.sub_dish_id, target, seen));
}

/** Recipes that have a line for this ingredient. */
function dishesUsingIngredient(db, ingredientId) {
  return [...new Set(db.all('dish_lines', { ingredient_id: Number(ingredientId) }).map((l) => l.dish_id))];
}

/** Recipes that have this recipe as a sub-recipe. */
function dishesUsingDish(db, dishId) {
  return [...new Set(db.all('dish_lines', { sub_dish_id: Number(dishId) }).map((l) => l.dish_id))];
}

module.exports = { getDish, linesOf, setPortions, replaceLines, contains, dishesUsingIngredient, dishesUsingDish };
