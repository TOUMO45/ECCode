# Bug: menu costs go stale and sometimes change by themselves

**Reported by:** Kitchen operations (ticket KOPS-219)

The head chef has stopped trusting the costing screens. What we see:

1. On Monday purchasing raised the price of plum tomatoes (4.80 to 6.00 per kg). Tomato sauce, Lasagne and Pizza margherita still show the old costs, hours later. The same happened when mozzarella went up.
2. After we reworked the béchamel recipe (less butter) the Lasagne cost did not change. Changing how many portions the tomato sauce yields did nothing to the Lasagne or the pizza either.
3. The cost for a banquet (`covers=40`) is right the first time. Ask again and the numbers are bigger, and a normal view of the same dish afterwards shows banquet-size figures.
4. The Lunch menu report shows food-cost percentages that don't match the dishes on it, especially after any of the above.

Costs are cached because costing nested recipes is slow. Please keep that, but whatever a cost or a report shows must match the current prices, recipes and portions. The cost for a number of covers must depend only on that number, whatever was asked for before.

**Acceptance**
- Dish costs and menu reports reflect every price, recipe and portion change straight away, including for recipes that use the changed recipe or ingredient indirectly.
- Asking for the cost of a dish for some number of covers never changes what is shown later for that dish, for a normal view, for other covers, for recipes that use it, or on the menu report.
- Response shapes and validation stay as they are (`npm test` passes).
