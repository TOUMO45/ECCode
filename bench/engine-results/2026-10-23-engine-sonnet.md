# ECCode paired benchmark

Agent command: `cat PROMPT.md | claude -p --model sonnet --output-format json --allowedTools "Read Grep Glob Edit Write Agent Task Bash(npm test) Bash(node --test*) Bash(pytest*) Bash(node .claude/eccode/bin/eccode.js*) Bash(git diff*) Bash(git status*)"`. "with" prepends the lean-change skill text to the prompt; "without" is the bare prompt; "engine" installs the toolkit and asks for delivery through the quick track. Hidden checks never exist in the sandbox while the agent works. Small n means a demonstration, not a statistic — read the raw rows, not just the medians.

| Task | Variant | n | Hidden checks | Median lines added | Median code lines added (tests excluded) | Runs adding a dependency | Runs changing a test | Median seconds |
|---|---|---|---|---|---|---|---|---|
| extract-pricing | without | 5 | 15/15 | 19 | 19 | 0/5 | 0/5 | 15 |
| extract-pricing | engine | 5 | 15/15 | 41 | 18 | 0/5 | 4/5 | 137 |
| search-case | without | 5 | 15/15 | 2 | 2 | 0/5 | 0/5 | 15 |
| search-case | engine | 5 | 15/15 | 9 | 4 | 0/5 | 5/5 | 58 |
| stock-reorder | without | 5 | 15/15 | 40 | 22 | 0/5 | 5/5 | 29 |
| stock-reorder | engine | 5 | 14/15 | 49 | 25 | 0/5 | 4/5 | 114 |
| utc-month | without | 5 | 15/15 | 19 | 6 | 0/5 | 5/5 | 20 |
| utc-month | engine | 5 | 15/15 | 24 | 14 | 0/5 | 5/5 | 125 |

Paired medians across 4 task(s): the "with" variant produced the smaller diff on 0, the larger on 0, equal on 4. Sign counts, not significance.

## Engine vs without

"engine" installs the toolkit in the sandbox and asks for delivery through the quick track: claim, pinned check, independent review, verification and a hash-chained record; every subagent inherits the session's model. A run passes when it passes every hidden check. Tokens and cost are what the agent command reported for the whole session, subagents included ("—" when it reported none).

| Task | Passing every hidden check (without → engine) | p | Failed checks (without; engine) | Median tokens (without → engine) | Median cost $ | Median seconds | Engine record: delivered / audit OK / median reviews |
|---|---|---|---|---|---|---|---|
| extract-pricing | 5/5 → 5/5 | Fisher 1.000 | none; none | 182685 → 1681176 | 0.10 → 0.54 | 15 → 137 | 4/5 / 5/5 / 2 |
| search-case | 5/5 → 5/5 | Fisher 1.000 | none; none | 271731 → 546571 | 0.10 → 0.22 | 15 → 58 | 1/5 / 5/5 / 0 |
| stock-reorder | 5/5 → 4/5 | Fisher 1.000 | none; feature 1 | 332396 → 1041480 | 0.15 → 0.41 | 29 → 114 | 0/5 / 5/5 / 1 |
| utc-month | 5/5 → 5/5 | Fisher 1.000 | none; none | 292365 → 1382186 | 0.13 → 0.45 | 20 → 125 | 1/5 / 5/5 / 1 |
| **all tasks** | 20/20 → 19/20 | stratified =1.000 | none; feature 1 | 272748 → 1051300 | 0.12 → 0.42 | 18 → 116 | 6/20 / 20/20 / 1 |

## Raw runs

| Task | Variant | Hidden | Lines +/− | New deps | Test files | Seconds | Agent exit | Lines added in tests | Failed checks | Tokens | Cost $ | Engine record |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| extract-pricing | without | 3/3 | +19/−14 | — | 0 | 13 | 0 | 0 | — | 136783 | 0.0916 | — |
| extract-pricing | without | 3/3 | +18/−14 | — | 0 | 16 | 0 | 0 | — | 182685 | 0.1004 | — |
| extract-pricing | without | 3/3 | +19/−14 | — | 0 | 24 | 0 | 0 | — | 371631 | 0.1326 | — |
| extract-pricing | without | 3/3 | +19/−14 | — | 0 | 15 | 0 | 0 | — | 229099 | 0.1042 | — |
| extract-pricing | without | 3/3 | +18/−14 | — | 0 | 14 | 0 | 0 | — | 137563 | 0.0940 | — |
| extract-pricing | engine | 3/3 | +18/−14 | — | 0 | 88 | 0 | 0 | — | 733461 | 0.3346 | not delivered, audit ok, 0 reviews |
| extract-pricing | engine | 3/3 | +48/−14 | — | 1 | 157 | 0 | 30 | — | 1840572 | 0.5864 | delivered, audit ok, 2 reviews |
| extract-pricing | engine | 3/3 | +40/−14 | — | 1 | 137 | 0 | 21 | — | 1681176 | 0.5399 | delivered, audit ok, 2 reviews |
| extract-pricing | engine | 3/3 | +58/−14 | — | 1 | 167 | 0 | 40 | — | 2177051 | 0.6325 | delivered, audit ok, 2 reviews |
| extract-pricing | engine | 3/3 | +41/−14 | — | 1 | 134 | 0 | 23 | — | 1579144 | 0.5035 | delivered, audit ok, 2 reviews |
| search-case | without | 3/3 | +2/−2 | — | 0 | 15 | 0 | 0 | — | 226860 | 0.0989 | — |
| search-case | without | 3/3 | +2/−2 | — | 0 | 17 | 0 | 0 | — | 271828 | 0.1039 | — |
| search-case | without | 3/3 | +2/−2 | — | 0 | 15 | 0 | 0 | — | 271731 | 0.1037 | — |
| search-case | without | 3/3 | +2/−2 | — | 0 | 14 | 0 | 0 | — | 227241 | 0.0999 | — |
| search-case | without | 3/3 | +6/−1 | — | 0 | 16 | 0 | 0 | — | 273668 | 0.1080 | — |
| search-case | engine | 3/3 | +9/−1 | — | 1 | 36 | 0 | 5 | — | 432163 | 0.1738 | not delivered, audit ok, 0 reviews |
| search-case | engine | 3/3 | +9/−1 | — | 1 | 37 | 0 | 5 | — | 398924 | 0.1860 | not delivered, audit ok, 0 reviews |
| search-case | engine | 3/3 | +9/−1 | — | 1 | 134 | 0 | 5 | — | 1715584 | 0.5218 | delivered, audit ok, 2 reviews |
| search-case | engine | 3/3 | +9/−1 | — | 1 | 58 | 0 | 5 | — | 546571 | 0.2180 | not delivered, audit ok, 0 reviews |
| search-case | engine | 3/3 | +9/−1 | — | 1 | 70 | 0 | 5 | — | 706069 | 0.2685 | not delivered, audit ok, 0 reviews |
| stock-reorder | without | 3/3 | +41/−10 | — | 2 | 28 | 0 | 19 | — | 331978 | 0.1491 | — |
| stock-reorder | without | 3/3 | +37/−10 | — | 2 | 29 | 0 | 15 | — | 331569 | 0.1453 | — |
| stock-reorder | without | 3/3 | +42/−10 | — | 2 | 31 | 0 | 20 | — | 381458 | 0.1541 | — |
| stock-reorder | without | 3/3 | +37/−10 | — | 2 | 29 | 0 | 15 | — | 381012 | 0.1499 | — |
| stock-reorder | without | 3/3 | +40/−10 | — | 2 | 29 | 0 | 18 | — | 332396 | 0.1478 | — |
| stock-reorder | engine | 2/3 | +0/−0 | — | 0 | 54 | 0 | 0 | feature | 406698 | 0.2180 | not delivered, audit ok, 0 reviews |
| stock-reorder | engine | 3/3 | +49/−10 | — | 2 | 114 | 0 | 24 | — | 1061120 | 0.4237 | not delivered, audit ok, 1 reviews |
| stock-reorder | engine | 3/3 | +50/−11 | — | 2 | 103 | 0 | 23 | — | 835653 | 0.3599 | not delivered, audit ok, 0 reviews |
| stock-reorder | engine | 3/3 | +64/−12 | — | 2 | 135 | 0 | 35 | — | 1309258 | 0.4784 | not delivered, audit ok, 1 reviews |
| stock-reorder | engine | 3/3 | +43/−10 | — | 2 | 119 | 0 | 18 | — | 1041480 | 0.4085 | not delivered, audit ok, 1 reviews |
| utc-month | without | 3/3 | +14/−2 | — | 2 | 18 | 0 | 9 | — | 194293 | 0.1195 | — |
| utc-month | without | 3/3 | +19/−2 | — | 2 | 21 | 0 | 13 | — | 294815 | 0.1346 | — |
| utc-month | without | 3/3 | +21/−2 | — | 2 | 20 | 0 | 13 | — | 293606 | 0.1311 | — |
| utc-month | without | 3/3 | +19/−2 | — | 2 | 18 | 0 | 13 | — | 244831 | 0.1279 | — |
| utc-month | without | 3/3 | +20/−2 | — | 2 | 20 | 0 | 9 | — | 292365 | 0.1307 | — |
| utc-month | engine | 3/3 | +47/−2 | — | 3 | 151 | 0 | 30 | — | 1852329 | 0.5595 | not delivered, audit ok, 1 reviews |
| utc-month | engine | 3/3 | +20/−2 | — | 2 | 191 | 0 | 8 | — | 2500977 | 0.7143 | delivered, audit ok, 2 reviews |
| utc-month | engine | 3/3 | +39/−2 | — | 2 | 68 | 0 | 22 | — | 643966 | 0.2681 | not delivered, audit ok, 0 reviews |
| utc-month | engine | 3/3 | +24/−2 | — | 2 | 82 | 0 | 12 | — | 865633 | 0.3137 | not delivered, audit ok, 0 reviews |
| utc-month | engine | 3/3 | +23/−2 | — | 2 | 125 | 0 | 9 | — | 1382186 | 0.4494 | not delivered, audit ok, 2 reviews |

## Failed hidden checks

- stock-reorder (engine): `pytest -q .bench-hidden/test_reorder.py`
  ```
FAILED .bench-hidden/test_reorder.py::test_saved_products_default_to_ten - At...
FAILED .bench-hidden/test_reorder.py::test_own_reorder_level_is_used - Assert...
FAILED .bench-hidden/test_reorder.py::test_round_trip_keeps_the_level - Attri...
FAILED .bench-hidden/test_reorder.py::test_csv_includes_the_reorder_level - A...
4 failed in 0.05s
  ```
