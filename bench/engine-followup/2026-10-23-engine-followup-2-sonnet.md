# ECCode paired benchmark

Agent command: `cat PROMPT.md | claude -p --model sonnet --output-format json --allowedTools "Read Grep Glob Edit Write Agent Task Bash(npm test) Bash(node --test*) Bash(pytest*) Bash(node .claude/eccode/bin/eccode.js*) Bash(git diff*) Bash(git status*)"`. "with" prepends the lean-change skill text to the prompt; "without" is the bare prompt; "engine" installs the toolkit and asks for delivery through the quick track. Hidden checks never exist in the sandbox while the agent works. Small n means a demonstration, not a statistic — read the raw rows, not just the medians.

| Task | Variant | n | Hidden checks | Median lines added | Median code lines added (tests excluded) | Runs adding a dependency | Runs changing a test | Median seconds |
|---|---|---|---|---|---|---|---|---|
| extract-pricing | engine | 5 | 15/15 | 46 | 18 | 0/5 | 4/5 | 134 |
| search-case | engine | 5 | 15/15 | 9 | 4 | 0/5 | 5/5 | 117 |
| stock-reorder | engine | 5 | 15/15 | 50 | 28 | 0/5 | 5/5 | 137 |
| utc-month | engine | 5 | 15/15 | 26 | 13 | 0/5 | 5/5 | 127 |

## Engine vs without

"engine" installs the toolkit in the sandbox and asks for delivery through the quick track: claim, pinned check, independent review, verification and a hash-chained record; every subagent inherits the session's model. A run passes when it passes every hidden check. Tokens and cost are what the agent command reported for the whole session, subagents included ("—" when it reported none).

| Task | Passing every hidden check (without → engine) | p | Failed checks (without; engine) | Median tokens (without → engine) | Median cost $ | Median seconds | Engine record: delivered / audit OK / median reviews |
|---|---|---|---|---|---|---|---|
| extract-pricing | 0/0 → 5/5 | — | none; none | — → 1410103 | — → 0.49 | — → 134 | 4/5 / 5/5 / 2 |
| search-case | 0/0 → 5/5 | — | none; none | — → 1335530 | — → 0.44 | — → 117 | 5/5 / 5/5 / 2 |
| stock-reorder | 0/0 → 5/5 | — | none; none | — → 1396634 | — → 0.51 | — → 137 | 5/5 / 5/5 / 2 |
| utc-month | 0/0 → 5/5 | — | none; none | — → 1349555 | — → 0.46 | — → 127 | 5/5 / 5/5 / 2 |
| **all tasks** | 0/0 → 20/20 | — | none; none | — → 1368637 | — → 0.49 | — → 128 | 19/20 / 20/20 / 2 |

## Raw runs

| Task | Variant | Hidden | Lines +/− | New deps | Test files | Seconds | Agent exit | Lines added in tests | Failed checks | Tokens | Cost $ | Engine record |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| extract-pricing | engine | 3/3 | +44/−14 | — | 1 | 153 | 0 | 26 | — | 1589861 | 0.5956 | delivered, audit ok, 2 reviews |
| extract-pricing | engine | 3/3 | +18/−14 | — | 0 | 128 | 0 | 0 | — | 1347198 | 0.4759 | delivered, audit ok, 2 reviews |
| extract-pricing | engine | 3/3 | +51/−14 | — | 1 | 165 | 0 | 33 | — | 995859 | 0.3040 | not delivered, audit ok, 1 reviews |
| extract-pricing | engine | 3/3 | +47/−14 | — | 1 | 128 | 0 | 29 | — | 1410103 | 0.4903 | delivered, audit ok, 2 reviews |
| extract-pricing | engine | 3/3 | +46/−14 | — | 1 | 134 | 0 | 28 | — | 1588066 | 0.5097 | delivered, audit ok, 2 reviews |
| search-case | engine | 3/3 | +9/−1 | — | 1 | 118 | 0 | 5 | — | 1373615 | 0.4455 | delivered, audit ok, 2 reviews |
| search-case | engine | 3/3 | +9/−1 | — | 1 | 117 | 0 | 5 | — | 1330698 | 0.4447 | delivered, audit ok, 2 reviews |
| search-case | engine | 3/3 | +9/−1 | — | 1 | 122 | 0 | 5 | — | 1541304 | 0.4809 | delivered, audit ok, 2 reviews |
| search-case | engine | 3/3 | +9/−1 | — | 1 | 100 | 0 | 5 | — | 1282774 | 0.4102 | delivered, audit ok, 2 reviews |
| search-case | engine | 3/3 | +12/−4 | — | 1 | 112 | 0 | 5 | — | 1335530 | 0.4397 | delivered, audit ok, 2 reviews |
| stock-reorder | engine | 3/3 | +43/−10 | — | 2 | 134 | 0 | 21 | — | 1555620 | 0.5079 | delivered, audit ok, 2 reviews |
| stock-reorder | engine | 3/3 | +63/−10 | — | 2 | 137 | 0 | 35 | — | 1396634 | 0.5123 | delivered, audit ok, 2 reviews |
| stock-reorder | engine | 3/3 | +66/−11 | — | 2 | 129 | 0 | 37 | — | 1363658 | 0.4914 | delivered, audit ok, 2 reviews |
| stock-reorder | engine | 3/3 | +50/−12 | — | 2 | 147 | 0 | 20 | — | 1508267 | 0.5413 | delivered, audit ok, 2 reviews |
| stock-reorder | engine | 3/3 | +46/−10 | — | 2 | 138 | 0 | 20 | — | 1355279 | 0.4965 | delivered, audit ok, 2 reviews |
| utc-month | engine | 3/3 | +26/−2 | — | 2 | 127 | 0 | 8 | — | 1345943 | 0.4622 | delivered, audit ok, 2 reviews |
| utc-month | engine | 3/3 | +21/−2 | — | 2 | 225 | 0 | 8 | — | 1339532 | 0.4541 | delivered, audit ok, 2 reviews |
| utc-month | engine | 3/3 | +26/−2 | — | 2 | 120 | 0 | 14 | — | 1349555 | 0.4565 | delivered, audit ok, 2 reviews |
| utc-month | engine | 3/3 | +55/−2 | — | 3 | 132 | 0 | 35 | — | 1394575 | 0.4981 | delivered, audit ok, 2 reviews |
| utc-month | engine | 3/3 | +21/−2 | — | 2 | 126 | 0 | 8 | — | 1530221 | 0.4953 | delivered, audit ok, 2 reviews |
