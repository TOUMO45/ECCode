# ECCode paired benchmark

Agent command: `cat PROMPT.md | claude -p --model opus --output-format json --allowedTools "Read Grep Glob Edit Write Agent Task Bash(npm test) Bash(node --test*) Bash(pytest*) Bash(node .claude/eccode/bin/eccode.js*) Bash(git diff*) Bash(git status*)"`. "with" prepends the lean-change skill text to the prompt; "without" is the bare prompt; "engine" installs the toolkit and asks for delivery through the quick track. Hidden checks never exist in the sandbox while the agent works. Small n means a demonstration, not a statistic — read the raw rows, not just the medians.

| Task | Variant | n | Hidden checks | Median lines added | Median code lines added (tests excluded) | Runs adding a dependency | Runs changing a test | Median seconds |
|---|---|---|---|---|---|---|---|---|
| extract-pricing | without | 5 | 15/15 | 20 | 20 | 0/5 | 0/5 | 26 |
| extract-pricing | engine | 5 | 15/15 | 55 | 19 | 0/5 | 5/5 | 295 |
| search-case | without | 5 | 15/15 | 20 | 7 | 0/5 | 5/5 | 28 |
| search-case | engine | 5 | 15/15 | 23 | 9 | 0/5 | 5/5 | 251 |
| stock-reorder | without | 5 | 15/15 | 54 | 25 | 0/5 | 5/5 | 40 |
| stock-reorder | engine | 5 | 15/15 | 97 | 31 | 0/5 | 5/5 | 279 |
| utc-month | without | 5 | 15/15 | 21 | 8 | 0/5 | 5/5 | 31 |
| utc-month | engine | 5 | 15/15 | 58 | 13 | 0/5 | 5/5 | 259 |

Paired medians across 4 task(s): the "with" variant produced the smaller diff on 0, the larger on 0, equal on 4. Sign counts, not significance.

## Engine vs without

"engine" installs the toolkit in the sandbox and asks for delivery through the quick track: claim, pinned check, independent review, verification and a hash-chained record; every subagent inherits the session's model. A run passes when it passes every hidden check. Tokens and cost are what the agent command reported for the whole session, subagents included ("—" when it reported none).

| Task | Passing every hidden check (without → engine) | p | Failed checks (without; engine) | Median tokens (without → engine) | Median cost $ | Median seconds | Engine record: delivered / audit OK / median reviews |
|---|---|---|---|---|---|---|---|
| extract-pricing | 5/5 → 5/5 | Fisher 1.000 | none; none | 278604 → 1601346 | 0.24 → 1.43 | 26 → 295 | 5/5 / 5/5 / 2 |
| search-case | 5/5 → 5/5 | Fisher 1.000 | none; none | 280932 → 1529365 | 0.27 → 1.24 | 28 → 251 | 5/5 / 5/5 / 2 |
| stock-reorder | 5/5 → 5/5 | Fisher 1.000 | none; none | 422491 → 1561326 | 0.33 → 1.44 | 40 → 279 | 0/5 / 5/5 / 1 |
| utc-month | 5/5 → 5/5 | Fisher 1.000 | none; none | 326997 → 1263581 | 0.27 → 1.22 | 31 → 259 | 2/5 / 5/5 / 1 |
| **all tasks** | 20/20 → 20/20 | stratified =1.000 | none; none | 281133 → 1542683 | 0.27 → 1.35 | 29 → 263 | 12/20 / 20/20 / 2 |

## Raw runs

| Task | Variant | Hidden | Lines +/− | New deps | Test files | Seconds | Agent exit | Lines added in tests | Failed checks | Tokens | Cost $ | Engine record |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| extract-pricing | without | 3/3 | +19/−14 | — | 0 | 26 | 0 | 0 | — | 279706 | 0.2474 | — |
| extract-pricing | without | 3/3 | +20/−15 | — | 0 | 26 | 0 | 0 | — | 278599 | 0.2414 | — |
| extract-pricing | without | 3/3 | +19/−14 | — | 0 | 25 | 0 | 0 | — | 277962 | 0.2382 | — |
| extract-pricing | without | 3/3 | +20/−15 | — | 0 | 28 | 0 | 0 | — | 278604 | 0.2448 | — |
| extract-pricing | without | 3/3 | +21/−14 | — | 0 | 29 | 0 | 0 | — | 280472 | 0.2521 | — |
| extract-pricing | engine | 3/3 | +56/−14 | — | 1 | 295 | 0 | 38 | — | 1556000 | 1.4840 | delivered, audit ok, 2 reviews |
| extract-pricing | engine | 3/3 | +59/−14 | — | 1 | 300 | 0 | 41 | — | 1680361 | 1.4284 | delivered, audit ok, 2 reviews |
| extract-pricing | engine | 3/3 | +54/−14 | — | 1 | 263 | 0 | 33 | — | 1601346 | 1.3139 | delivered, audit ok, 2 reviews |
| extract-pricing | engine | 3/3 | +54/−14 | — | 1 | 274 | 0 | 35 | — | 1506660 | 1.3299 | delivered, audit ok, 2 reviews |
| extract-pricing | engine | 3/3 | +55/−14 | — | 1 | 327 | 0 | 32 | — | 2000721 | 1.5552 | delivered, audit ok, 2 reviews |
| search-case | without | 3/3 | +20/−2 | — | 1 | 28 | 0 | 13 | — | 280932 | 0.2697 | — |
| search-case | without | 3/3 | +17/−1 | — | 1 | 19 | 0 | 11 | — | 227840 | 0.2147 | — |
| search-case | without | 3/3 | +20/−4 | — | 1 | 28 | 0 | 11 | — | 281334 | 0.2678 | — |
| search-case | without | 3/3 | +18/−1 | — | 1 | 26 | 0 | 12 | — | 280284 | 0.2529 | — |
| search-case | without | 3/3 | +21/−4 | — | 1 | 30 | 0 | 12 | — | 282483 | 0.2722 | — |
| search-case | engine | 3/3 | +22/−2 | — | 1 | 263 | 0 | 15 | — | 1722160 | 1.3884 | delivered, audit ok, 2 reviews |
| search-case | engine | 3/3 | +18/−4 | — | 1 | 240 | 0 | 9 | — | 1529365 | 1.2252 | delivered, audit ok, 2 reviews |
| search-case | engine | 3/3 | +27/−4 | — | 1 | 262 | 0 | 18 | — | 1556975 | 1.2517 | delivered, audit ok, 2 reviews |
| search-case | engine | 3/3 | +23/−2 | — | 1 | 251 | 0 | 15 | — | 1491923 | 1.2357 | delivered, audit ok, 2 reviews |
| search-case | engine | 3/3 | +27/−4 | — | 1 | 242 | 0 | 18 | — | 1468263 | 1.1923 | delivered, audit ok, 2 reviews |
| stock-reorder | without | 3/3 | +46/−10 | — | 2 | 38 | 0 | 21 | — | 375240 | 0.3170 | — |
| stock-reorder | without | 3/3 | +60/−8 | — | 2 | 46 | 0 | 31 | — | 377588 | 0.3305 | — |
| stock-reorder | without | 3/3 | +56/−10 | — | 2 | 40 | 0 | 31 | — | 423860 | 0.3325 | — |
| stock-reorder | without | 3/3 | +53/−10 | — | 2 | 40 | 0 | 28 | — | 425524 | 0.3278 | — |
| stock-reorder | without | 3/3 | +54/−10 | — | 2 | 38 | 0 | 29 | — | 422491 | 0.3174 | — |
| stock-reorder | engine | 3/3 | +97/−12 | — | 2 | 254 | 0 | 67 | — | 1507809 | 1.3736 | not delivered, audit ok, 1 reviews |
| stock-reorder | engine | 3/3 | +112/−9 | — | 4 | 366 | 0 | 69 | — | 2389791 | 1.8455 | not delivered, audit ok, 2 reviews |
| stock-reorder | engine | 3/3 | +62/−10 | — | 2 | 254 | 0 | 37 | — | 1426558 | 1.2362 | not delivered, audit ok, 1 reviews |
| stock-reorder | engine | 3/3 | +90/−9 | — | 4 | 279 | 0 | 59 | — | 1561326 | 1.4381 | not delivered, audit ok, 0 reviews |
| stock-reorder | engine | 3/3 | +168/−8 | — | 3 | 419 | 0 | 116 | — | 2742996 | 2.1047 | not delivered, audit ok, 2 reviews |
| utc-month | without | 3/3 | +20/−2 | — | 2 | 33 | 0 | 12 | — | 370897 | 0.2818 | — |
| utc-month | without | 3/3 | +21/−2 | — | 2 | 29 | 0 | 13 | — | 278802 | 0.2524 | — |
| utc-month | without | 3/3 | +26/−2 | — | 2 | 44 | 0 | 13 | — | 514588 | 0.3271 | — |
| utc-month | without | 3/3 | +20/−2 | — | 2 | 31 | 0 | 12 | — | 326997 | 0.2677 | — |
| utc-month | without | 3/3 | +26/−2 | — | 2 | 25 | 0 | 13 | — | 231229 | 0.2296 | — |
| utc-month | engine | 3/3 | +42/−2 | — | 2 | 268 | 0 | 34 | — | 1509597 | 1.3803 | delivered, audit ok, 2 reviews |
| utc-month | engine | 3/3 | +64/−2 | — | 3 | 285 | 0 | 46 | — | 1564341 | 1.3847 | delivered, audit ok, 2 reviews |
| utc-month | engine | 3/3 | +85/−2 | — | 3 | 259 | 0 | 61 | — | 1257355 | 1.2204 | not delivered, audit ok, 0 reviews |
| utc-month | engine | 3/3 | +58/−2 | — | 3 | 184 | 0 | 45 | — | 997736 | 0.9344 | not delivered, audit ok, 1 reviews |
| utc-month | engine | 3/3 | +30/−2 | — | 2 | 220 | 0 | 22 | — | 1263581 | 1.0833 | not delivered, audit ok, 1 reviews |
