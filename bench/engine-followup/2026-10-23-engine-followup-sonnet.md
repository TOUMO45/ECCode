# ECCode paired benchmark

Agent command: `cat PROMPT.md | claude -p --model sonnet --output-format json --allowedTools "Read Grep Glob Edit Write Agent Task Bash(npm test) Bash(node --test*) Bash(pytest*) Bash(node .claude/eccode/bin/eccode.js*) Bash(git diff*) Bash(git status*)"`. "with" prepends the lean-change skill text to the prompt; "without" is the bare prompt; "engine" installs the toolkit and asks for delivery through the quick track. Hidden checks never exist in the sandbox while the agent works. Small n means a demonstration, not a statistic — read the raw rows, not just the medians.

| Task | Variant | n | Hidden checks | Median lines added | Median code lines added (tests excluded) | Runs adding a dependency | Runs changing a test | Median seconds |
|---|---|---|---|---|---|---|---|---|
| extract-pricing | engine | 5 | 15/15 | 48 | 18 | 0/5 | 4/5 | 139 |
| search-case | engine | 5 | 15/15 | 9 | 4 | 0/5 | 5/5 | 115 |
| stock-reorder | engine | 5 | 15/15 | 63 | 28 | 0/5 | 5/5 | 127 |
| utc-month | engine | 5 | 15/15 | 22 | 14 | 0/5 | 5/5 | 124 |

Paired medians across 4 task(s): the "with" variant produced the smaller diff on 0, the larger on 0, equal on 4. Sign counts, not significance.

## Engine vs without

"engine" installs the toolkit in the sandbox and asks for delivery through the quick track: claim, pinned check, independent review, verification and a hash-chained record; every subagent inherits the session's model. A run passes when it passes every hidden check. Tokens and cost are what the agent command reported for the whole session, subagents included ("—" when it reported none).

| Task | Passing every hidden check (without → engine) | p | Failed checks (without; engine) | Median tokens (without → engine) | Median cost $ | Median seconds | Engine record: delivered / audit OK / median reviews |
|---|---|---|---|---|---|---|---|
| extract-pricing | 0/0 → 5/5 | — | none; none | — → 1534652 | — → 0.51 | — → 139 | 5/5 / 5/5 / 2 |
| search-case | 0/0 → 5/5 | — | none; none | — → 1327377 | — → 0.44 | — → 115 | 5/5 / 5/5 / 2 |
| stock-reorder | 0/0 → 5/5 | — | none; none | — → 1263968 | — → 0.47 | — → 127 | 2/5 / 5/5 / 1 |
| utc-month | 0/0 → 5/5 | — | none; none | — → 1360093 | — → 0.48 | — → 124 | 4/5 / 5/5 / 2 |
| **all tasks** | 0/0 → 20/20 | — | none; none | — → 1343604 | — → 0.47 | — → 126 | 16/20 / 20/20 / 2 |

## Raw runs

| Task | Variant | Hidden | Lines +/− | New deps | Test files | Seconds | Agent exit | Lines added in tests | Failed checks | Tokens | Cost $ | Engine record |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| extract-pricing | engine | 3/3 | +48/−14 | — | 1 | 149 | 0 | 30 | — | 1676088 | 0.5786 | delivered, audit ok, 2 reviews |
| extract-pricing | engine | 3/3 | +49/−14 | — | 1 | 140 | 0 | 31 | — | 1534652 | 0.5135 | delivered, audit ok, 2 reviews |
| extract-pricing | engine | 3/3 | +18/−14 | — | 0 | 133 | 0 | 0 | — | 1360162 | 0.4768 | delivered, audit ok, 2 reviews |
| extract-pricing | engine | 3/3 | +42/−14 | — | 1 | 139 | 0 | 24 | — | 1530958 | 0.5173 | delivered, audit ok, 2 reviews |
| extract-pricing | engine | 3/3 | +51/−14 | — | 1 | 129 | 0 | 33 | — | 1551132 | 0.5027 | delivered, audit ok, 2 reviews |
| search-case | engine | 3/3 | +9/−1 | — | 1 | 117 | 0 | 5 | — | 1343890 | 0.4528 | delivered, audit ok, 2 reviews |
| search-case | engine | 3/3 | +7/−2 | — | 1 | 115 | 0 | 5 | — | 1331192 | 0.4381 | delivered, audit ok, 2 reviews |
| search-case | engine | 3/3 | +9/−1 | — | 1 | 115 | 0 | 5 | — | 1327377 | 0.4360 | delivered, audit ok, 2 reviews |
| search-case | engine | 3/3 | +7/−2 | — | 1 | 111 | 0 | 5 | — | 1302422 | 0.4380 | delivered, audit ok, 2 reviews |
| search-case | engine | 3/3 | +9/−1 | — | 1 | 101 | 0 | 5 | — | 1314582 | 0.4248 | delivered, audit ok, 2 reviews |
| stock-reorder | engine | 3/3 | +71/−10 | — | 2 | 110 | 0 | 42 | — | 993264 | 0.4020 | not delivered, audit ok, 1 reviews |
| stock-reorder | engine | 3/3 | +77/−10 | — | 3 | 131 | 0 | 48 | — | 1263968 | 0.4681 | not delivered, audit ok, 1 reviews |
| stock-reorder | engine | 3/3 | +63/−10 | — | 3 | 127 | 0 | 36 | — | 1343317 | 0.4824 | delivered, audit ok, 2 reviews |
| stock-reorder | engine | 3/3 | +61/−10 | — | 2 | 110 | 0 | 33 | — | 1018031 | 0.3943 | not delivered, audit ok, 1 reviews |
| stock-reorder | engine | 3/3 | +61/−10 | — | 2 | 145 | 0 | 35 | — | 1416454 | 0.4965 | delivered, audit ok, 2 reviews |
| utc-month | engine | 3/3 | +20/−2 | — | 2 | 123 | 0 | 5 | — | 1360093 | 0.4647 | delivered, audit ok, 2 reviews |
| utc-month | engine | 3/3 | +52/−2 | — | 2 | 134 | 0 | 32 | — | 1250529 | 0.4815 | delivered, audit ok, 2 reviews |
| utc-month | engine | 3/3 | +22/−2 | — | 2 | 163 | 0 | 8 | — | 1904587 | 0.5938 | delivered, audit ok, 2 reviews |
| utc-month | engine | 3/3 | +25/−2 | — | 2 | 124 | 0 | 11 | — | 1518660 | 0.4838 | delivered, audit ok, 2 reviews |
| utc-month | engine | 3/3 | +16/−2 | — | 2 | 94 | 0 | 8 | — | 951777 | 0.3536 | not delivered, audit ok, 1 reviews |
