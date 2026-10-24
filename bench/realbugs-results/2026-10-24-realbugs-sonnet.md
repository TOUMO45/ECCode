# ECCode paired benchmark

Agent command: `cat PROMPT.md | claude -p --model sonnet --output-format json --allowedTools "Read Grep Glob Edit Write Agent Task Bash(python*) Bash(pytest*) Bash(node .claude/eccode/bin/eccode.js*) Bash(git diff*) Bash(git status*)"`. "with" prepends the lean-change skill text to the prompt; "without" is the bare prompt; "engine" installs the toolkit and asks for delivery through the quick track; "debug" installs the toolkit and asks for the fix through the debug track; "method" prepends the debug-investigation skill text (no toolkit installed). Hidden checks never exist in the sandbox while the agent works. Small n means a demonstration, not a statistic — read the raw rows, not just the medians.

| Task | Variant | n | Hidden checks | Median lines added | Median code lines added (tests excluded) | Runs adding a dependency | Runs changing a test | Median seconds |
|---|---|---|---|---|---|---|---|---|
| black-10 | without | 3 | 6/6 | 2 | 2 | 0/3 | 0/3 | 45 |
| black-10 | method | 3 | 6/6 | 13 | 2 | 0/3 | 3/3 | 54 |
| black-10 | engine | 3 | 6/6 | 13 | 2 | 0/3 | 3/3 | 194 |
| black-10 | debug | 3 | 6/6 | 39 | 3 | 0/3 | 3/3 | 178 |
| black-17 | without | 3 | 6/6 | 2 | 2 | 0/3 | 0/3 | 36 |
| black-17 | method | 3 | 6/6 | 15 | 4 | 0/3 | 2/3 | 66 |
| black-17 | engine | 3 | 6/6 | 15 | 2 | 0/3 | 3/3 | 163 |
| black-17 | debug | 3 | 6/6 | 23 | 2 | 0/3 | 3/3 | 197 |
| black-19 | without | 3 | 6/6 | 23 | 23 | 0/3 | 1/3 | 58 |
| black-19 | method | 3 | 6/6 | 20 | 8 | 0/3 | 3/3 | 93 |
| black-19 | engine | 3 | 6/6 | 29 | 13 | 0/3 | 3/3 | 198 |
| black-19 | debug | 3 | 6/6 | 63 | 13 | 0/3 | 3/3 | 337 |
| black-20 | without | 3 | 6/6 | 3 | 2 | 0/3 | 3/3 | 37 |
| black-20 | method | 3 | 6/6 | 19 | 2 | 0/3 | 3/3 | 42 |
| black-20 | engine | 3 | 6/6 | 14 | 2 | 0/3 | 3/3 | 171 |
| black-20 | debug | 3 | 6/6 | 40 | 2 | 0/3 | 3/3 | 209 |
| thefuck-2 | without | 3 | 6/6 | 1 | 1 | 0/3 | 0/3 | 26 |
| thefuck-2 | method | 3 | 6/6 | 14 | 1 | 0/3 | 3/3 | 38 |
| thefuck-2 | engine | 3 | 6/6 | 11 | 1 | 0/3 | 3/3 | 161 |
| thefuck-2 | debug | 3 | 6/6 | 17 | 1 | 0/3 | 3/3 | 121 |
| thefuck-22 | without | 3 | 6/6 | 4 | 4 | 0/3 | 0/3 | 22 |
| thefuck-22 | method | 3 | 6/6 | 8 | 3 | 0/3 | 2/3 | 32 |
| thefuck-22 | engine | 3 | 6/6 | 10 | 4 | 0/3 | 3/3 | 170 |
| thefuck-22 | debug | 3 | 6/6 | 35 | 5 | 0/3 | 3/3 | 143 |
| thefuck-24 | without | 3 | 6/6 | 17 | 17 | 0/3 | 0/3 | 21 |
| thefuck-24 | method | 3 | 6/6 | 30 | 17 | 0/3 | 2/3 | 38 |
| thefuck-24 | engine | 3 | 6/6 | 38 | 20 | 0/3 | 3/3 | 172 |
| thefuck-24 | debug | 3 | 6/6 | 60 | 19 | 0/3 | 3/3 | 150 |
| thefuck-31 | without | 3 | 6/6 | 4 | 2 | 0/3 | 3/3 | 14 |
| thefuck-31 | method | 3 | 6/6 | 4 | 1 | 0/3 | 3/3 | 26 |
| thefuck-31 | engine | 3 | 6/6 | 4 | 1 | 0/3 | 3/3 | 121 |
| thefuck-31 | debug | 3 | 6/6 | 11 | 3 | 0/3 | 3/3 | 100 |
| tornado-10 | without | 3 | 6/6 | 29 | 11 | 0/3 | 3/3 | 52 |
| tornado-10 | method | 3 | 6/6 | 29 | 11 | 0/3 | 3/3 | 73 |
| tornado-10 | engine | 3 | 6/6 | 31 | 10 | 0/3 | 3/3 | 173 |
| tornado-10 | debug | 3 | 6/6 | 38 | 10 | 0/3 | 3/3 | 139 |
| tornado-13 | without | 3 | 3/6 | 1 | 1 | 0/3 | 0/3 | 46 |
| tornado-13 | method | 3 | 3/6 | 36 | 1 | 0/3 | 3/3 | 67 |
| tornado-13 | engine | 3 | 3/6 | 51 | 2 | 0/3 | 3/3 | 155 |
| tornado-13 | debug | 3 | 3/6 | 82 | 2 | 0/3 | 3/3 | 237 |
| tornado-15 | without | 3 | 6/6 | 12 | 4 | 0/3 | 2/3 | 44 |
| tornado-15 | method | 3 | 6/6 | 37 | 4 | 0/3 | 3/3 | 55 |
| tornado-15 | engine | 3 | 6/6 | 31 | 2 | 0/3 | 3/3 | 161 |
| tornado-15 | debug | 3 | 5/6 | 55 | 5 | 0/3 | 3/3 | 128 |
| tornado-7 | without | 3 | 6/6 | 7 | 7 | 0/3 | 0/3 | 32 |
| tornado-7 | method | 3 | 6/6 | 15 | 7 | 0/3 | 3/3 | 50 |
| tornado-7 | engine | 3 | 6/6 | 13 | 10 | 0/3 | 1/3 | 146 |
| tornado-7 | debug | 3 | 6/6 | 44 | 7 | 0/3 | 3/3 | 130 |
| tqdm-1 | without | 3 | 6/6 | 2 | 1 | 0/3 | 2/3 | 21 |
| tqdm-1 | method | 3 | 6/6 | 8 | 1 | 0/3 | 3/3 | 26 |
| tqdm-1 | engine | 3 | 6/6 | 4 | 1 | 0/3 | 3/3 | 132 |
| tqdm-1 | debug | 3 | 6/6 | 13 | 1 | 0/3 | 3/3 | 118 |
| tqdm-4 | without | 3 | 6/6 | 2 | 2 | 0/3 | 1/3 | 17 |
| tqdm-4 | method | 3 | 6/6 | 10 | 2 | 0/3 | 2/3 | 38 |
| tqdm-4 | engine | 3 | 6/6 | 12 | 2 | 0/3 | 3/3 | 140 |
| tqdm-4 | debug | 3 | 6/6 | 29 | 2 | 0/3 | 3/3 | 149 |
| tqdm-6 | without | 3 | 6/6 | 7 | 1 | 0/3 | 3/3 | 32 |
| tqdm-6 | method | 3 | 6/6 | 9 | 1 | 0/3 | 3/3 | 43 |
| tqdm-6 | engine | 3 | 6/6 | 13 | 1 | 0/3 | 3/3 | 145 |
| tqdm-6 | debug | 3 | 6/6 | 32 | 1 | 0/3 | 3/3 | 146 |
| tqdm-9 | without | 3 | 6/6 | 6 | 6 | 0/3 | 0/3 | 22 |
| tqdm-9 | method | 3 | 6/6 | 29 | 6 | 0/3 | 3/3 | 48 |
| tqdm-9 | engine | 3 | 6/6 | 28 | 7 | 0/3 | 3/3 | 134 |
| tqdm-9 | debug | 3 | 6/6 | 49 | 7 | 0/3 | 3/3 | 152 |
| youtube-dl-16 | without | 3 | 6/6 | 18 | 7 | 0/3 | 3/3 | 46 |
| youtube-dl-16 | method | 3 | 6/6 | 24 | 24 | 0/3 | 2/3 | 752 |
| youtube-dl-16 | engine | 3 | 6/6 | 50 | 27 | 0/3 | 3/3 | 206 |
| youtube-dl-16 | debug | 3 | 6/6 | 66 | 7 | 0/3 | 3/3 | 203 |
| youtube-dl-4 | without | 3 | 6/6 | 2 | 2 | 0/3 | 0/3 | 21 |
| youtube-dl-4 | method | 3 | 6/6 | 11 | 2 | 0/3 | 3/3 | 55 |
| youtube-dl-4 | engine | 3 | 6/6 | 10 | 2 | 0/3 | 3/3 | 141 |
| youtube-dl-4 | debug | 3 | 6/6 | 33 | 6 | 0/3 | 3/3 | 169 |
| youtube-dl-41 | without | 3 | 6/6 | 9 | 9 | 0/3 | 0/3 | 22 |
| youtube-dl-41 | method | 3 | 6/6 | 6 | 2 | 0/3 | 3/3 | 37 |
| youtube-dl-41 | engine | 3 | 6/6 | 8 | 3 | 0/3 | 3/3 | 141 |
| youtube-dl-41 | debug | 3 | 6/6 | 30 | 8 | 0/3 | 3/3 | 341 |
| youtube-dl-9 | without | 3 | 6/6 | 7 | 7 | 0/3 | 0/3 | 52 |
| youtube-dl-9 | method | 3 | 6/6 | 32 | 7 | 0/3 | 3/3 | 87 |
| youtube-dl-9 | engine | 3 | 6/6 | 31 | 9 | 0/3 | 3/3 | 208 |
| youtube-dl-9 | debug | 3 | 6/6 | 51 | 9 | 0/3 | 3/3 | 253 |

## Engine vs without

"engine" installs the toolkit in the sandbox and asks for delivery through the quick track: claim, pinned check, independent review, verification and a hash-chained record; every subagent inherits the session's model. A run passes when it passes every hidden check. Tokens and cost are what the agent command reported for the whole session, subagents included ("—" when it reported none).

| Task | Passing every hidden check (without → engine) | p | Failed checks (without; engine) | Median tokens (without → engine) | Median cost $ | Median seconds | Engine record (engine): delivered / audit OK / median reviews |
|---|---|---|---|---|---|---|---|
| black-10 | 3/3 → 3/3 | Fisher 1.000 | none; none | 400519 → 1428773 | 0.15 → 0.50 | 45 → 194 | 3/3 / 3/3 / 2 |
| black-17 | 3/3 → 3/3 | Fisher 1.000 | none; none | 333193 → 1372148 | 0.13 → 0.45 | 36 → 163 | 3/3 / 3/3 / 2 |
| black-19 | 3/3 → 3/3 | Fisher 1.000 | none; none | 659773 → 1512191 | 0.21 → 0.51 | 58 → 198 | 3/3 / 3/3 / 2 |
| black-20 | 3/3 → 3/3 | Fisher 1.000 | none; none | 327759 → 1422538 | 0.13 → 0.47 | 37 → 171 | 2/3 / 3/3 / 2 |
| thefuck-2 | 3/3 → 3/3 | Fisher 1.000 | none; none | 181396 → 1317547 | 0.09 → 0.44 | 26 → 161 | 3/3 / 3/3 / 2 |
| thefuck-22 | 3/3 → 3/3 | Fisher 1.000 | none; none | 184565 → 1357222 | 0.10 → 0.46 | 22 → 170 | 3/3 / 3/3 / 2 |
| thefuck-24 | 3/3 → 3/3 | Fisher 1.000 | none; none | 229308 → 1381048 | 0.10 → 0.47 | 21 → 172 | 3/3 / 3/3 / 2 |
| thefuck-31 | 3/3 → 3/3 | Fisher 1.000 | none; none | 135769 → 1352462 | 0.09 → 0.44 | 14 → 121 | 3/3 / 3/3 / 2 |
| tornado-10 | 3/3 → 3/3 | Fisher 1.000 | none; none | 713460 → 1709950 | 0.25 → 0.58 | 52 → 173 | 3/3 / 3/3 / 2 |
| tornado-13 | 0/3 → 0/3 | Fisher 1.000 | regression 3; regression 3 | 528017 → 1492302 | 0.17 → 0.51 | 46 → 155 | 3/3 / 3/3 / 2 |
| tornado-15 | 3/3 → 3/3 | Fisher 1.000 | none; none | 433763 → 1493014 | 0.16 → 0.52 | 44 → 161 | 3/3 / 3/3 / 2 |
| tornado-7 | 3/3 → 3/3 | Fisher 1.000 | none; none | 387372 → 1445783 | 0.15 → 0.50 | 32 → 146 | 3/3 / 3/3 / 2 |
| tqdm-1 | 3/3 → 3/3 | Fisher 1.000 | none; none | 230256 → 1434299 | 0.11 → 0.50 | 21 → 132 | 3/3 / 3/3 / 2 |
| tqdm-4 | 3/3 → 3/3 | Fisher 1.000 | none; none | 183043 → 1350207 | 0.10 → 0.44 | 17 → 140 | 3/3 / 3/3 / 2 |
| tqdm-6 | 3/3 → 3/3 | Fisher 1.000 | none; none | 382346 → 1524274 | 0.15 → 0.49 | 32 → 145 | 3/3 / 3/3 / 2 |
| tqdm-9 | 3/3 → 3/3 | Fisher 1.000 | none; none | 141148 → 1379892 | 0.11 → 0.47 | 22 → 134 | 3/3 / 3/3 / 2 |
| youtube-dl-16 | 3/3 → 3/3 | Fisher 1.000 | none; none | 501843 → 1844599 | 0.20 → 0.67 | 46 → 206 | 3/3 / 3/3 / 2 |
| youtube-dl-4 | 3/3 → 3/3 | Fisher 1.000 | none; none | 230860 → 1458933 | 0.11 → 0.49 | 21 → 141 | 3/3 / 3/3 / 2 |
| youtube-dl-41 | 3/3 → 3/3 | Fisher 1.000 | none; none | 137880 → 1453462 | 0.10 → 0.49 | 22 → 141 | 3/3 / 3/3 / 2 |
| youtube-dl-9 | 3/3 → 3/3 | Fisher 1.000 | none; none | 347230 → 1544144 | 0.18 → 0.53 | 52 → 208 | 3/3 / 3/3 / 2 |
| **all tasks** | 57/60 → 57/60 | stratified =1.000 | regression 3; regression 3 | 302976 → 1435283 | 0.13 → 0.49 | 30 → 159 | 59/60 / 60/60 / 2 |

## Debug track vs without

"debug" installs the toolkit in the sandbox and asks for the fix through the debug track: claim, a regression test reproduced before the fix, fix verify proving it fails on the pre-fix code and passes with the fix, a mutation run on the changed lines, one independent review and a hash-chained record, with no verification gate; every subagent inherits the session's model. A run passes when it passes every hidden check. Tokens and cost are what the agent command reported for the whole session, subagents included ("—" when it reported none).

| Task | Passing every hidden check (without → debug) | p | Failed checks (without; debug) | Median tokens (without → debug) | Median cost $ | Median seconds | Engine record (debug): delivered / audit OK / median reviews |
|---|---|---|---|---|---|---|---|
| black-10 | 3/3 → 3/3 | Fisher 1.000 | none; none | 400519 → 1085904 | 0.15 → 0.43 | 45 → 178 | 3/3 / 3/3 / 1 |
| black-17 | 3/3 → 3/3 | Fisher 1.000 | none; none | 333193 → 1063940 | 0.13 → 0.39 | 36 → 197 | 3/3 / 3/3 / 1 |
| black-19 | 3/3 → 3/3 | Fisher 1.000 | none; none | 659773 → 1364789 | 0.21 → 0.50 | 58 → 337 | 3/3 / 3/3 / 1 |
| black-20 | 3/3 → 3/3 | Fisher 1.000 | none; none | 327759 → 1612614 | 0.13 → 0.53 | 37 → 209 | 2/3 / 3/3 / 1 |
| thefuck-2 | 3/3 → 3/3 | Fisher 1.000 | none; none | 181396 → 882478 | 0.09 → 0.35 | 26 → 121 | 3/3 / 3/3 / 1 |
| thefuck-22 | 3/3 → 3/3 | Fisher 1.000 | none; none | 184565 → 1020407 | 0.10 → 0.41 | 22 → 143 | 3/3 / 3/3 / 1 |
| thefuck-24 | 3/3 → 3/3 | Fisher 1.000 | none; none | 229308 → 1097408 | 0.10 → 0.43 | 21 → 150 | 3/3 / 3/3 / 1 |
| thefuck-31 | 3/3 → 3/3 | Fisher 1.000 | none; none | 135769 → 884531 | 0.09 → 0.34 | 14 → 100 | 3/3 / 3/3 / 1 |
| tornado-10 | 3/3 → 3/3 | Fisher 1.000 | none; none | 713460 → 1186155 | 0.25 → 0.44 | 52 → 139 | 3/3 / 3/3 / 1 |
| tornado-13 | 0/3 → 0/3 | Fisher 1.000 | regression 3; regression 3 | 528017 → 1651156 | 0.17 → 0.62 | 46 → 237 | 3/3 / 3/3 / 1 |
| tornado-15 | 3/3 → 2/3 | Fisher 1.000 | none; bug 1 | 433763 → 1107128 | 0.16 → 0.44 | 44 → 128 | 3/3 / 3/3 / 1 |
| tornado-7 | 3/3 → 3/3 | Fisher 1.000 | none; none | 387372 → 1053714 | 0.15 → 0.43 | 32 → 130 | 3/3 / 3/3 / 1 |
| tqdm-1 | 3/3 → 3/3 | Fisher 1.000 | none; none | 230256 → 954969 | 0.11 → 0.39 | 21 → 118 | 3/3 / 3/3 / 1 |
| tqdm-4 | 3/3 → 3/3 | Fisher 1.000 | none; none | 183043 → 1158712 | 0.10 → 0.46 | 17 → 149 | 3/3 / 3/3 / 1 |
| tqdm-6 | 3/3 → 3/3 | Fisher 1.000 | none; none | 382346 → 1270777 | 0.15 → 0.49 | 32 → 146 | 3/3 / 3/3 / 1 |
| tqdm-9 | 3/3 → 3/3 | Fisher 1.000 | none; none | 141148 → 1097541 | 0.11 → 0.47 | 22 → 152 | 3/3 / 3/3 / 1 |
| youtube-dl-16 | 3/3 → 3/3 | Fisher 1.000 | none; none | 501843 → 1415900 | 0.20 → 0.56 | 46 → 203 | 3/3 / 3/3 / 1 |
| youtube-dl-4 | 3/3 → 3/3 | Fisher 1.000 | none; none | 230860 → 1180030 | 0.11 → 0.47 | 21 → 169 | 3/3 / 3/3 / 1 |
| youtube-dl-41 | 3/3 → 3/3 | Fisher 1.000 | none; none | 137880 → 2341729 | 0.10 → 0.99 | 22 → 341 | 3/3 / 3/3 / 2 |
| youtube-dl-9 | 3/3 → 3/3 | Fisher 1.000 | none; none | 347230 → 1343272 | 0.18 → 0.54 | 52 → 253 | 3/3 / 3/3 / 1 |
| **all tasks** | 57/60 → 56/60 | stratified =1.000 | regression 3; regression 3, bug 1 | 302976 → 1152022 | 0.13 → 0.44 | 30 → 158 | 59/60 / 60/60 / 1 |

## Method text vs without

"method" prepends the debug-investigation skill text (reproduce first, isolate, root cause, prove the fix) to the prompt; nothing is installed, so there is no record. A run passes when it passes every hidden check. Tokens and cost are what the agent command reported for the whole session, subagents included ("—" when it reported none).

| Task | Passing every hidden check (without → method) | p | Failed checks (without; method) | Median tokens (without → method) | Median cost $ | Median seconds | Engine record (method): delivered / audit OK / median reviews |
|---|---|---|---|---|---|---|---|
| black-10 | 3/3 → 3/3 | Fisher 1.000 | none; none | 400519 → 581274 | 0.15 → 0.18 | 45 → 54 | — |
| black-17 | 3/3 → 3/3 | Fisher 1.000 | none; none | 333193 → 602797 | 0.13 → 0.17 | 36 → 66 | — |
| black-19 | 3/3 → 3/3 | Fisher 1.000 | none; none | 659773 → 1060231 | 0.21 → 0.26 | 58 → 93 | — |
| black-20 | 3/3 → 3/3 | Fisher 1.000 | none; none | 327759 → 434295 | 0.13 → 0.18 | 37 → 42 | — |
| thefuck-2 | 3/3 → 3/3 | Fisher 1.000 | none; none | 181396 → 321467 | 0.09 → 0.17 | 26 → 38 | — |
| thefuck-22 | 3/3 → 3/3 | Fisher 1.000 | none; none | 184565 → 395640 | 0.10 → 0.14 | 22 → 32 | — |
| thefuck-24 | 3/3 → 3/3 | Fisher 1.000 | none; none | 229308 → 349638 | 0.10 → 0.15 | 21 → 38 | — |
| thefuck-31 | 3/3 → 3/3 | Fisher 1.000 | none; none | 135769 → 241170 | 0.09 → 0.12 | 14 → 26 | — |
| tornado-10 | 3/3 → 3/3 | Fisher 1.000 | none; none | 713460 → 1008457 | 0.25 → 0.29 | 52 → 73 | — |
| tornado-13 | 0/3 → 0/3 | Fisher 1.000 | regression 3; regression 3 | 528017 → 746366 | 0.17 → 0.23 | 46 → 67 | — |
| tornado-15 | 3/3 → 3/3 | Fisher 1.000 | none; none | 433763 → 693028 | 0.16 → 0.22 | 44 → 55 | — |
| tornado-7 | 3/3 → 3/3 | Fisher 1.000 | none; none | 387372 → 618777 | 0.15 → 0.20 | 32 → 50 | — |
| tqdm-1 | 3/3 → 3/3 | Fisher 1.000 | none; none | 230256 → 290331 | 0.11 → 0.13 | 21 → 26 | — |
| tqdm-4 | 3/3 → 3/3 | Fisher 1.000 | none; none | 183043 → 497763 | 0.10 → 0.17 | 17 → 38 | — |
| tqdm-6 | 3/3 → 3/3 | Fisher 1.000 | none; none | 382346 → 531687 | 0.15 → 0.19 | 32 → 43 | — |
| tqdm-9 | 3/3 → 3/3 | Fisher 1.000 | none; none | 141148 → 539776 | 0.11 → 0.22 | 22 → 48 | — |
| youtube-dl-16 | 3/3 → 3/3 | Fisher 1.000 | none; none | 501843 → 958331 | 0.20 → 0.28 | 46 → 752 | — |
| youtube-dl-4 | 3/3 → 3/3 | Fisher 1.000 | none; none | 230860 → 715182 | 0.11 → 0.22 | 21 → 55 | — |
| youtube-dl-41 | 3/3 → 3/3 | Fisher 1.000 | none; none | 137880 → 371818 | 0.10 → 0.15 | 22 → 37 | — |
| youtube-dl-9 | 3/3 → 3/3 | Fisher 1.000 | none; none | 347230 → 736142 | 0.18 → 0.26 | 52 → 87 | — |
| **all tasks** | 57/60 → 57/60 | stratified =1.000 | regression 3; regression 3 | 302976 → 522702 | 0.13 → 0.19 | 30 → 49 | — |

## Debug track vs engine (quick track)

"debug" installs the toolkit in the sandbox and asks for the fix through the debug track: claim, a regression test reproduced before the fix, fix verify proving it fails on the pre-fix code and passes with the fix, a mutation run on the changed lines, one independent review and a hash-chained record, with no verification gate; every subagent inherits the session's model. A run passes when it passes every hidden check. Tokens and cost are what the agent command reported for the whole session, subagents included ("—" when it reported none).

| Task | Passing every hidden check (engine → debug) | p | Failed checks (engine; debug) | Median tokens (engine → debug) | Median cost $ | Median seconds | Engine record (debug): delivered / audit OK / median reviews |
|---|---|---|---|---|---|---|---|
| black-10 | 3/3 → 3/3 | Fisher 1.000 | none; none | 1428773 → 1085904 | 0.50 → 0.43 | 194 → 178 | 3/3 / 3/3 / 1 |
| black-17 | 3/3 → 3/3 | Fisher 1.000 | none; none | 1372148 → 1063940 | 0.45 → 0.39 | 163 → 197 | 3/3 / 3/3 / 1 |
| black-19 | 3/3 → 3/3 | Fisher 1.000 | none; none | 1512191 → 1364789 | 0.51 → 0.50 | 198 → 337 | 3/3 / 3/3 / 1 |
| black-20 | 3/3 → 3/3 | Fisher 1.000 | none; none | 1422538 → 1612614 | 0.47 → 0.53 | 171 → 209 | 2/3 / 3/3 / 1 |
| thefuck-2 | 3/3 → 3/3 | Fisher 1.000 | none; none | 1317547 → 882478 | 0.44 → 0.35 | 161 → 121 | 3/3 / 3/3 / 1 |
| thefuck-22 | 3/3 → 3/3 | Fisher 1.000 | none; none | 1357222 → 1020407 | 0.46 → 0.41 | 170 → 143 | 3/3 / 3/3 / 1 |
| thefuck-24 | 3/3 → 3/3 | Fisher 1.000 | none; none | 1381048 → 1097408 | 0.47 → 0.43 | 172 → 150 | 3/3 / 3/3 / 1 |
| thefuck-31 | 3/3 → 3/3 | Fisher 1.000 | none; none | 1352462 → 884531 | 0.44 → 0.34 | 121 → 100 | 3/3 / 3/3 / 1 |
| tornado-10 | 3/3 → 3/3 | Fisher 1.000 | none; none | 1709950 → 1186155 | 0.58 → 0.44 | 173 → 139 | 3/3 / 3/3 / 1 |
| tornado-13 | 0/3 → 0/3 | Fisher 1.000 | regression 3; regression 3 | 1492302 → 1651156 | 0.51 → 0.62 | 155 → 237 | 3/3 / 3/3 / 1 |
| tornado-15 | 3/3 → 2/3 | Fisher 1.000 | none; bug 1 | 1493014 → 1107128 | 0.52 → 0.44 | 161 → 128 | 3/3 / 3/3 / 1 |
| tornado-7 | 3/3 → 3/3 | Fisher 1.000 | none; none | 1445783 → 1053714 | 0.50 → 0.43 | 146 → 130 | 3/3 / 3/3 / 1 |
| tqdm-1 | 3/3 → 3/3 | Fisher 1.000 | none; none | 1434299 → 954969 | 0.50 → 0.39 | 132 → 118 | 3/3 / 3/3 / 1 |
| tqdm-4 | 3/3 → 3/3 | Fisher 1.000 | none; none | 1350207 → 1158712 | 0.44 → 0.46 | 140 → 149 | 3/3 / 3/3 / 1 |
| tqdm-6 | 3/3 → 3/3 | Fisher 1.000 | none; none | 1524274 → 1270777 | 0.49 → 0.49 | 145 → 146 | 3/3 / 3/3 / 1 |
| tqdm-9 | 3/3 → 3/3 | Fisher 1.000 | none; none | 1379892 → 1097541 | 0.47 → 0.47 | 134 → 152 | 3/3 / 3/3 / 1 |
| youtube-dl-16 | 3/3 → 3/3 | Fisher 1.000 | none; none | 1844599 → 1415900 | 0.67 → 0.56 | 206 → 203 | 3/3 / 3/3 / 1 |
| youtube-dl-4 | 3/3 → 3/3 | Fisher 1.000 | none; none | 1458933 → 1180030 | 0.49 → 0.47 | 141 → 169 | 3/3 / 3/3 / 1 |
| youtube-dl-41 | 3/3 → 3/3 | Fisher 1.000 | none; none | 1453462 → 2341729 | 0.49 → 0.99 | 141 → 341 | 3/3 / 3/3 / 2 |
| youtube-dl-9 | 3/3 → 3/3 | Fisher 1.000 | none; none | 1544144 → 1343272 | 0.53 → 0.54 | 208 → 253 | 3/3 / 3/3 / 1 |
| **all tasks** | 57/60 → 56/60 | stratified =1.000 | regression 3; regression 3, bug 1 | 1435283 → 1152022 | 0.49 → 0.44 | 159 → 158 | 59/60 / 60/60 / 1 |

## Raw runs

| Task | Variant | Hidden | Lines +/− | New deps | Test files | Seconds | Agent exit | Lines added in tests | Failed checks | Tokens | Cost $ | Engine record |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| black-10 | without | 2/2 | +2/−1 | — | 0 | 39 | 0 | 0 | — | 297056 | 0.1419 | — |
| black-10 | without | 2/2 | +1/−1 | — | 0 | 45 | 0 | 0 | — | 505055 | 0.1680 | — |
| black-10 | without | 2/2 | +2/−1 | — | 0 | 45 | 0 | 0 | — | 400519 | 0.1524 | — |
| black-17 | without | 2/2 | +2/−2 | — | 0 | 33 | 0 | 0 | — | 290768 | 0.1343 | — |
| black-17 | without | 2/2 | +2/−2 | — | 0 | 37 | 0 | 0 | — | 393281 | 0.1470 | — |
| black-17 | without | 2/2 | +4/−1 | — | 0 | 36 | 0 | 0 | — | 333193 | 0.1344 | — |
| black-19 | without | 2/2 | +23/−0 | — | 0 | 58 | 0 | 0 | — | 659773 | 0.2054 | — |
| black-19 | without | 2/2 | +55/−0 | — | 4 | 89 | 0 | 32 | — | 1085307 | 0.2787 | — |
| black-19 | without | 2/2 | +11/−2 | — | 0 | 35 | 0 | 0 | — | 328678 | 0.1339 | — |
| black-20 | without | 2/2 | +3/−3 | — | 1 | 37 | 0 | 1 | — | 327759 | 0.1307 | — |
| black-20 | without | 2/2 | +3/−3 | — | 1 | 51 | 0 | 1 | — | 537212 | 0.1733 | — |
| black-20 | without | 2/2 | +3/−3 | — | 1 | 37 | 0 | 1 | — | 324691 | 0.1260 | — |
| thefuck-2 | without | 2/2 | +1/−1 | — | 0 | 26 | 0 | 0 | — | 181723 | 0.0963 | — |
| thefuck-2 | without | 2/2 | +1/−1 | — | 0 | 25 | 0 | 0 | — | 181396 | 0.0925 | — |
| thefuck-2 | without | 2/2 | +1/−1 | — | 0 | 26 | 0 | 0 | — | 181165 | 0.0923 | — |
| thefuck-22 | without | 2/2 | +4/−0 | — | 0 | 22 | 0 | 0 | — | 184565 | 0.1029 | — |
| thefuck-22 | without | 2/2 | +3/−0 | — | 0 | 20 | 0 | 0 | — | 138194 | 0.0931 | — |
| thefuck-22 | without | 2/2 | +4/−0 | — | 0 | 23 | 0 | 0 | — | 184566 | 0.0998 | — |
| thefuck-24 | without | 2/2 | +21/−1 | — | 0 | 26 | 0 | 0 | — | 247067 | 0.1503 | — |
| thefuck-24 | without | 2/2 | +17/−1 | — | 0 | 20 | 0 | 0 | — | 229308 | 0.1037 | — |
| thefuck-24 | without | 2/2 | +17/−1 | — | 0 | 21 | 0 | 0 | — | 228270 | 0.1033 | — |
| thefuck-31 | without | 2/2 | +4/−2 | — | 1 | 14 | 0 | 2 | — | 135612 | 0.0863 | — |
| thefuck-31 | without | 2/2 | +6/−3 | — | 1 | 15 | 0 | 2 | — | 135769 | 0.0851 | — |
| thefuck-31 | without | 2/2 | +4/−2 | — | 1 | 13 | 0 | 2 | — | 136310 | 0.0864 | — |
| tornado-10 | without | 2/2 | +29/−1 | — | 1 | 70 | 0 | 18 | — | 966386 | 0.2993 | — |
| tornado-10 | without | 2/2 | +29/−1 | — | 1 | 51 | 0 | 18 | — | 713460 | 0.2464 | — |
| tornado-10 | without | 2/2 | +27/−1 | — | 1 | 52 | 0 | 17 | — | 642559 | 0.2370 | — |
| tornado-13 | without | 1/2 | +32/−3 | — | 0 | 46 | 0 | 0 | regression | 665314 | 0.2109 | — |
| tornado-13 | without | 1/2 | +1/−1 | — | 0 | 50 | 0 | 0 | regression | 528017 | 0.1699 | — |
| tornado-13 | without | 1/2 | +1/−1 | — | 0 | 43 | 0 | 0 | regression | 446691 | 0.1660 | — |
| tornado-15 | without | 2/2 | +4/−3 | — | 0 | 20 | 0 | 0 | — | 184386 | 0.1056 | — |
| tornado-15 | without | 2/2 | +12/−0 | — | 1 | 59 | 0 | 7 | — | 631519 | 0.1971 | — |
| tornado-15 | without | 2/2 | +12/−1 | — | 1 | 44 | 0 | 8 | — | 433763 | 0.1618 | — |
| tornado-7 | without | 2/2 | +7/−2 | — | 0 | 27 | 0 | 0 | — | 234250 | 0.1192 | — |
| tornado-7 | without | 2/2 | +19/−2 | — | 0 | 43 | 0 | 0 | — | 489946 | 0.1743 | — |
| tornado-7 | without | 2/2 | +7/−2 | — | 0 | 32 | 0 | 0 | — | 387372 | 0.1466 | — |
| tqdm-1 | without | 2/2 | +2/−1 | — | 1 | 21 | 0 | 1 | — | 230256 | 0.1119 | — |
| tqdm-1 | without | 2/2 | +1/−1 | — | 0 | 17 | 0 | 0 | — | 182055 | 0.0968 | — |
| tqdm-1 | without | 2/2 | +2/−1 | — | 1 | 27 | 0 | 1 | — | 423503 | 0.1359 | — |
| tqdm-4 | without | 2/2 | +2/−1 | — | 0 | 17 | 0 | 0 | — | 183043 | 0.0999 | — |
| tqdm-4 | without | 2/2 | +2/−1 | — | 0 | 17 | 0 | 0 | — | 181958 | 0.0947 | — |
| tqdm-4 | without | 2/2 | +7/−1 | — | 1 | 24 | 0 | 5 | — | 300005 | 0.1364 | — |
| tqdm-6 | without | 2/2 | +7/−0 | — | 1 | 32 | 0 | 6 | — | 382346 | 0.1483 | — |
| tqdm-6 | without | 2/2 | +6/−0 | — | 1 | 27 | 0 | 5 | — | 305946 | 0.1455 | — |
| tqdm-6 | without | 2/2 | +15/−1 | — | 1 | 35 | 0 | 13 | — | 409565 | 0.1683 | — |
| tqdm-9 | without | 2/2 | +6/−7 | — | 0 | 21 | 0 | 0 | — | 140175 | 0.1049 | — |
| tqdm-9 | without | 2/2 | +8/−7 | — | 0 | 22 | 0 | 0 | — | 141148 | 0.1069 | — |
| tqdm-9 | without | 2/2 | +6/−4 | — | 0 | 22 | 0 | 0 | — | 184759 | 0.1070 | — |
| youtube-dl-16 | without | 2/2 | +16/−6 | — | 1 | 46 | 0 | 9 | — | 400490 | 0.1921 | — |
| youtube-dl-16 | without | 2/2 | +18/−4 | — | 1 | 45 | 0 | 14 | — | 501843 | 0.1970 | — |
| youtube-dl-16 | without | 2/2 | +18/−6 | — | 1 | 48 | 0 | 11 | — | 564776 | 0.2106 | — |
| youtube-dl-4 | without | 2/2 | +2/−2 | — | 0 | 19 | 0 | 0 | — | 230860 | 0.1075 | — |
| youtube-dl-4 | without | 2/2 | +2/−2 | — | 0 | 22 | 0 | 0 | — | 244438 | 0.1210 | — |
| youtube-dl-4 | without | 2/2 | +3/−3 | — | 0 | 21 | 0 | 0 | — | 184321 | 0.1010 | — |
| youtube-dl-41 | without | 2/2 | +9/−5 | — | 0 | 21 | 0 | 0 | — | 137880 | 0.1008 | — |
| youtube-dl-41 | without | 2/2 | +11/−5 | — | 0 | 22 | 0 | 0 | — | 137552 | 0.0972 | — |
| youtube-dl-41 | without | 2/2 | +3/−1 | — | 0 | 27 | 0 | 0 | — | 184929 | 0.1095 | — |
| youtube-dl-9 | without | 2/2 | +17/−13 | — | 0 | 52 | 0 | 0 | — | 347230 | 0.1785 | — |
| youtube-dl-9 | without | 2/2 | +7/−4 | — | 0 | 54 | 0 | 0 | — | 445971 | 0.1932 | — |
| youtube-dl-9 | without | 2/2 | +6/−4 | — | 0 | 48 | 0 | 0 | — | 346728 | 0.1733 | — |
| black-10 | method | 2/2 | +10/−1 | — | 1 | 54 | 0 | 8 | — | 485377 | 0.1825 | — |
| black-10 | method | 2/2 | +20/−1 | — | 1 | 84 | 0 | 11 | — | 827739 | 0.2284 | — |
| black-10 | method | 2/2 | +13/−1 | — | 1 | 49 | 0 | 11 | — | 581274 | 0.1839 | — |
| black-17 | method | 2/2 | +2/−2 | — | 0 | 51 | 0 | 0 | — | 446881 | 0.1577 | — |
| black-17 | method | 2/2 | +15/−1 | — | 1 | 66 | 0 | 11 | — | 655144 | 0.2068 | — |
| black-17 | method | 2/2 | +16/−2 | — | 1 | 68 | 0 | 12 | — | 602797 | 0.1720 | — |
| black-19 | method | 2/2 | +24/−2 | — | 2 | 100 | 0 | 16 | — | 1130638 | 0.3082 | — |
| black-19 | method | 2/2 | +18/−2 | — | 1 | 68 | 0 | 11 | — | 720559 | 0.2379 | — |
| black-19 | method | 2/2 | +20/−2 | — | 1 | 93 | 0 | 10 | — | 1060231 | 0.2616 | — |
| black-20 | method | 2/2 | +15/−3 | — | 1 | 50 | 0 | 13 | — | 486820 | 0.1925 | — |
| black-20 | method | 2/2 | +20/−3 | — | 1 | 38 | 0 | 18 | — | 370699 | 0.1571 | — |
| black-20 | method | 2/2 | +19/−3 | — | 1 | 42 | 0 | 17 | — | 434295 | 0.1832 | — |
| thefuck-2 | method | 2/2 | +15/−1 | — | 1 | 38 | 0 | 14 | — | 321467 | 0.1660 | — |
| thefuck-2 | method | 2/2 | +14/−1 | — | 1 | 45 | 0 | 13 | — | 473108 | 0.1672 | — |
| thefuck-2 | method | 2/2 | +14/−1 | — | 1 | 38 | 0 | 13 | — | 313301 | 0.1472 | — |
| thefuck-22 | method | 2/2 | +8/−1 | — | 1 | 26 | 0 | 6 | — | 244845 | 0.1276 | — |
| thefuck-22 | method | 2/2 | +10/−0 | — | 1 | 35 | 0 | 6 | — | 401065 | 0.1506 | — |
| thefuck-22 | method | 2/2 | +3/−0 | — | 0 | 32 | 0 | 0 | — | 395640 | 0.1419 | — |
| thefuck-24 | method | 2/2 | +17/−1 | — | 0 | 30 | 0 | 0 | — | 341496 | 0.1420 | — |
| thefuck-24 | method | 2/2 | +30/−43 | — | 1 | 38 | 0 | 14 | — | 401343 | 0.1588 | — |
| thefuck-24 | method | 2/2 | +31/−1 | — | 1 | 39 | 0 | 14 | — | 349638 | 0.1518 | — |
| thefuck-31 | method | 2/2 | +5/−2 | — | 1 | 26 | 0 | 2 | — | 241170 | 0.1217 | — |
| thefuck-31 | method | 2/2 | +3/−2 | — | 1 | 24 | 0 | 2 | — | 240444 | 0.1083 | — |
| thefuck-31 | method | 2/2 | +4/−2 | — | 1 | 32 | 0 | 3 | — | 242444 | 0.1160 | — |
| tornado-10 | method | 2/2 | +29/−1 | — | 1 | 59 | 0 | 18 | — | 682280 | 0.2608 | — |
| tornado-10 | method | 2/2 | +33/−0 | — | 1 | 73 | 0 | 22 | — | 1008457 | 0.2898 | — |
| tornado-10 | method | 2/2 | +29/−1 | — | 1 | 188 | 0 | 18 | — | 1323412 | 0.3480 | — |
| tornado-13 | method | 1/2 | +35/−1 | — | 1 | 83 | 0 | 34 | regression | 1038471 | 0.3099 | — |
| tornado-13 | method | 1/2 | +36/−1 | — | 1 | 54 | 0 | 35 | regression | 562008 | 0.1906 | — |
| tornado-13 | method | 1/2 | +60/−1 | — | 2 | 67 | 0 | 59 | regression | 746366 | 0.2330 | — |
| tornado-15 | method | 2/2 | +38/−1 | — | 1 | 55 | 0 | 35 | — | 693028 | 0.2294 | — |
| tornado-15 | method | 2/2 | +34/−1 | — | 1 | 56 | 0 | 30 | — | 823153 | 0.2249 | — |
| tornado-15 | method | 2/2 | +37/−0 | — | 1 | 52 | 0 | 33 | — | 508667 | 0.1785 | — |
| tornado-7 | method | 2/2 | +15/−2 | — | 1 | 45 | 0 | 8 | — | 513717 | 0.1860 | — |
| tornado-7 | method | 2/2 | +16/−2 | — | 1 | 57 | 0 | 9 | — | 801129 | 0.2214 | — |
| tornado-7 | method | 2/2 | +15/−2 | — | 1 | 50 | 0 | 8 | — | 618777 | 0.1963 | — |
| tqdm-1 | method | 2/2 | +8/−1 | — | 1 | 26 | 0 | 7 | — | 290331 | 0.1304 | — |
| tqdm-1 | method | 2/2 | +2/−1 | — | 1 | 26 | 0 | 1 | — | 341896 | 0.1277 | — |
| tqdm-1 | method | 2/2 | +9/−1 | — | 1 | 22 | 0 | 8 | — | 243152 | 0.1145 | — |
| tqdm-4 | method | 2/2 | +2/−1 | — | 0 | 29 | 0 | 0 | — | 390152 | 0.1476 | — |
| tqdm-4 | method | 2/2 | +10/−1 | — | 1 | 38 | 0 | 8 | — | 595120 | 0.1910 | — |
| tqdm-4 | method | 2/2 | +12/−1 | — | 1 | 41 | 0 | 10 | — | 497763 | 0.1678 | — |
| tqdm-6 | method | 2/2 | +11/−0 | — | 1 | 40 | 0 | 10 | — | 531687 | 0.1900 | — |
| tqdm-6 | method | 2/2 | +9/−0 | — | 1 | 46 | 0 | 8 | — | 700538 | 0.2211 | — |
| tqdm-6 | method | 2/2 | +6/−0 | — | 1 | 43 | 0 | 5 | — | 499504 | 0.1703 | — |
| tqdm-9 | method | 2/2 | +29/−3 | — | 1 | 48 | 0 | 23 | — | 539776 | 0.2178 | — |
| tqdm-9 | method | 2/2 | +30/−4 | — | 1 | 65 | 0 | 24 | — | 833824 | 0.2601 | — |
| tqdm-9 | method | 2/2 | +27/−7 | — | 1 | 36 | 0 | 18 | — | 320858 | 0.1629 | — |
| youtube-dl-16 | method | 2/2 | +13/−6 | — | 1 | 53 | 0 | 6 | — | 532991 | 0.2247 | — |
| youtube-dl-16 | method | 2/2 | +24/−6 | — | 0 | 759 | 0 | 0 | — | 1451183 | 0.3677 | — |
| youtube-dl-16 | method | 2/2 | +38/−8 | — | 1 | 752 | 0 | 14 | — | 958331 | 0.2807 | — |
| youtube-dl-4 | method | 2/2 | +11/−2 | — | 1 | 55 | 0 | 9 | — | 715182 | 0.2171 | — |
| youtube-dl-4 | method | 2/2 | +16/−3 | — | 1 | 70 | 0 | 8 | — | 802259 | 0.2290 | — |
| youtube-dl-4 | method | 2/2 | +10/−2 | — | 1 | 51 | 0 | 8 | — | 692397 | 0.2045 | — |
| youtube-dl-41 | method | 2/2 | +2/−1 | — | 1 | 27 | 0 | 1 | — | 204344 | 0.1393 | — |
| youtube-dl-41 | method | 2/2 | +6/−1 | — | 1 | 39 | 0 | 4 | — | 371818 | 0.1718 | — |
| youtube-dl-41 | method | 2/2 | +13/−7 | — | 1 | 37 | 0 | 1 | — | 397705 | 0.1487 | — |
| youtube-dl-9 | method | 2/2 | +36/−12 | — | 1 | 125 | 0 | 21 | — | 1339509 | 0.3887 | — |
| youtube-dl-9 | method | 2/2 | +32/−4 | — | 1 | 87 | 0 | 25 | — | 736142 | 0.2568 | — |
| youtube-dl-9 | method | 2/2 | +15/−4 | — | 1 | 48 | 0 | 8 | — | 434921 | 0.1857 | — |
| black-10 | debug | 2/2 | +42/−1 | — | 1 | 239 | 0 | 37 | — | 1150077 | 0.4581 | delivered, audit ok, 1 reviews, fix proven, mutants 1/1 killed |
| black-10 | debug | 2/2 | +39/−1 | — | 1 | 178 | 0 | 36 | — | 957213 | 0.4109 | delivered, audit ok, 1 reviews, fix proven, mutants 0/0 killed |
| black-10 | debug | 2/2 | +12/−1 | — | 1 | 176 | 0 | 10 | — | 1085904 | 0.4341 | delivered, audit ok, 1 reviews, fix proven, mutants 0/0 killed |
| black-17 | debug | 2/2 | +23/−2 | — | 1 | 229 | 0 | 21 | — | 1140907 | 0.4447 | delivered, audit ok, 1 reviews, fix proven, mutants 2/2 killed |
| black-17 | debug | 2/2 | +18/−2 | — | 1 | 195 | 0 | 16 | — | 1047436 | 0.3949 | delivered, audit ok, 1 reviews, fix proven, mutants 3/3 killed |
| black-17 | debug | 2/2 | +23/−2 | — | 1 | 197 | 0 | 20 | — | 1063940 | 0.3840 | delivered, audit ok, 1 reviews, fix proven, mutants 3/3 killed |
| black-19 | debug | 2/2 | +58/−4 | — | 2 | 337 | 0 | 40 | — | 1364789 | 0.4963 | delivered, audit ok, 1 reviews, fix proven, mutants 4/4 killed |
| black-19 | debug | 2/2 | +84/−0 | — | 2 | 353 | 0 | 71 | — | 1247784 | 0.4886 | delivered, audit ok, 1 reviews, fix proven, mutants 7/7 killed |
| black-19 | debug | 2/2 | +63/−2 | — | 2 | 300 | 0 | 54 | — | 1372355 | 0.5054 | delivered, audit ok, 1 reviews, fix proven, mutants 3/3 killed |
| black-20 | debug | 2/2 | +40/−3 | — | 1 | 146 | 0 | 38 | — | 1026802 | 0.3925 | not delivered, audit ok, 0 reviews, fix proven, mutants 0/0 killed |
| black-20 | debug | 2/2 | +40/−3 | — | 1 | 237 | 0 | 38 | — | 1696842 | 0.5890 | delivered, audit ok, 1 reviews, fix proven, mutants 0/0 killed |
| black-20 | debug | 2/2 | +36/−3 | — | 1 | 209 | 0 | 34 | — | 1612614 | 0.5318 | delivered, audit ok, 1 reviews, fix proven, mutants 0/0 killed |
| thefuck-2 | debug | 2/2 | +15/−1 | — | 1 | 121 | 0 | 14 | — | 859951 | 0.3465 | delivered, audit ok, 1 reviews, fix proven, mutants 0/0 killed |
| thefuck-2 | debug | 2/2 | +17/−2 | — | 1 | 132 | 0 | 16 | — | 957858 | 0.3707 | delivered, audit ok, 1 reviews, fix proven, mutants 0/0 killed |
| thefuck-2 | debug | 2/2 | +21/−1 | — | 1 | 119 | 0 | 20 | — | 882478 | 0.3298 | delivered, audit ok, 1 reviews, fix proven, mutants 0/0 killed |
| thefuck-22 | debug | 2/2 | +35/−0 | — | 1 | 139 | 0 | 30 | — | 987386 | 0.3836 | delivered, audit ok, 1 reviews, fix proven, mutants 1/2 killed |
| thefuck-22 | debug | 2/2 | +25/−0 | — | 1 | 143 | 0 | 20 | — | 1020407 | 0.4062 | delivered, audit ok, 1 reviews, fix proven, mutants 1/2 killed |
| thefuck-22 | debug | 2/2 | +42/−0 | — | 1 | 154 | 0 | 39 | — | 1020581 | 0.4065 | delivered, audit ok, 1 reviews, fix proven, mutants 1/1 killed |
| thefuck-24 | debug | 2/2 | +64/−1 | — | 1 | 163 | 0 | 45 | — | 1155773 | 0.4355 | delivered, audit ok, 1 reviews, fix proven, mutants 5/5 killed |
| thefuck-24 | debug | 2/2 | +51/−1 | — | 1 | 147 | 0 | 34 | — | 1084173 | 0.4040 | delivered, audit ok, 1 reviews, fix proven, mutants 5/5 killed |
| thefuck-24 | debug | 2/2 | +60/−1 | — | 1 | 150 | 0 | 28 | — | 1097408 | 0.4252 | delivered, audit ok, 1 reviews, fix proven, mutants 2/2 killed |
| thefuck-31 | debug | 2/2 | +9/−2 | — | 1 | 97 | 0 | 6 | — | 899689 | 0.3365 | delivered, audit ok, 1 reviews, fix proven, mutants 0/0 killed |
| thefuck-31 | debug | 2/2 | +16/−3 | — | 1 | 100 | 0 | 13 | — | 879801 | 0.3314 | delivered, audit ok, 1 reviews, fix proven, mutants 0/0 killed |
| thefuck-31 | debug | 2/2 | +11/−2 | — | 1 | 116 | 0 | 6 | — | 884531 | 0.3551 | delivered, audit ok, 1 reviews, fix proven, mutants 4/4 killed |
| tornado-10 | debug | 2/2 | +29/−1 | — | 1 | 139 | 0 | 19 | — | 1144401 | 0.4425 | delivered, audit ok, 1 reviews, fix proven, mutants 0/0 killed |
| tornado-10 | debug | 2/2 | +53/−1 | — | 1 | 167 | 0 | 43 | — | 1311476 | 0.5278 | delivered, audit ok, 1 reviews, fix proven, mutants 0/0 killed |
| tornado-10 | debug | 2/2 | +38/−0 | — | 1 | 134 | 0 | 28 | — | 1186155 | 0.4415 | delivered, audit ok, 1 reviews, fix proven, mutants 0/0 killed |
| tornado-13 | debug | 1/2 | +144/−1 | — | 1 | 237 | 0 | 143 | regression | 1651156 | 0.6234 | delivered, audit ok, 1 reviews, fix proven, mutants 1/1 killed |
| tornado-13 | debug | 1/2 | +82/−1 | — | 1 | 180 | 0 | 80 | regression | 1348665 | 0.5019 | delivered, audit ok, 1 reviews, fix proven, mutants 1/1 killed |
| tornado-13 | debug | 1/2 | +64/−1 | — | 1 | 331 | 0 | 61 | regression | 2107365 | 0.7529 | delivered, audit ok, 1 reviews, fix proven, mutants 1/1 killed |
| tornado-15 | debug | 1/2 | +55/−3 | — | 1 | 158 | 0 | 48 | bug | 1322188 | 0.5048 | delivered, audit ok, 1 reviews, fix proven, mutants 1/1 killed |
| tornado-15 | debug | 2/2 | +55/−0 | — | 1 | 128 | 0 | 51 | — | 1061078 | 0.4237 | delivered, audit ok, 1 reviews, fix proven, mutants 1/1 killed |
| tornado-15 | debug | 2/2 | +17/−3 | — | 1 | 128 | 0 | 12 | — | 1107128 | 0.4379 | delivered, audit ok, 1 reviews, fix proven, mutants 0/0 killed |
| tornado-7 | debug | 2/2 | +44/−2 | — | 1 | 130 | 0 | 37 | — | 1053714 | 0.4252 | delivered, audit ok, 1 reviews, fix proven, mutants 0/0 killed |
| tornado-7 | debug | 2/2 | +54/−2 | — | 1 | 132 | 0 | 47 | — | 1094559 | 0.4395 | delivered, audit ok, 1 reviews, fix proven, mutants 0/0 killed |
| tornado-7 | debug | 2/2 | +30/−2 | — | 1 | 118 | 0 | 22 | — | 889330 | 0.3888 | delivered, audit ok, 1 reviews, fix proven, mutants 0/0 killed |
| tqdm-1 | debug | 2/2 | +32/−1 | — | 1 | 120 | 0 | 31 | — | 964789 | 0.4121 | delivered, audit ok, 1 reviews, fix proven, mutants 0/0 killed |
| tqdm-1 | debug | 2/2 | +12/−1 | — | 1 | 118 | 0 | 11 | — | 954969 | 0.3880 | delivered, audit ok, 1 reviews, fix proven, mutants 0/0 killed |
| tqdm-1 | debug | 2/2 | +13/−1 | — | 1 | 104 | 0 | 12 | — | 915442 | 0.3652 | delivered, audit ok, 1 reviews, fix proven, mutants 0/0 killed |
| tqdm-4 | debug | 2/2 | +27/−1 | — | 1 | 149 | 0 | 25 | — | 1298558 | 0.4915 | delivered, audit ok, 1 reviews, fix proven, mutants 0/0 killed |
| tqdm-4 | debug | 2/2 | +29/−1 | — | 1 | 149 | 0 | 27 | — | 1158712 | 0.4598 | delivered, audit ok, 1 reviews, fix proven, mutants 0/0 killed |
| tqdm-4 | debug | 2/2 | +31/−1 | — | 1 | 148 | 0 | 29 | — | 1153966 | 0.4635 | delivered, audit ok, 1 reviews, fix proven, mutants 0/0 killed |
| tqdm-6 | debug | 2/2 | +41/−0 | — | 1 | 127 | 0 | 40 | — | 1168850 | 0.4330 | delivered, audit ok, 1 reviews, fix proven, mutants 0/0 killed |
| tqdm-6 | debug | 2/2 | +28/−0 | — | 1 | 146 | 0 | 27 | — | 1270777 | 0.4981 | delivered, audit ok, 1 reviews, fix proven, mutants 0/0 killed |
| tqdm-6 | debug | 2/2 | +32/−0 | — | 1 | 158 | 0 | 31 | — | 1304272 | 0.4895 | delivered, audit ok, 1 reviews, fix proven, mutants 0/0 killed |
| tqdm-9 | debug | 2/2 | +56/−3 | — | 1 | 167 | 0 | 49 | — | 1167203 | 0.4804 | delivered, audit ok, 1 reviews, fix proven, mutants 3/3 killed |
| tqdm-9 | debug | 2/2 | +29/−3 | — | 1 | 152 | 0 | 23 | — | 1097541 | 0.4678 | delivered, audit ok, 1 reviews, fix proven, mutants 3/3 killed |
| tqdm-9 | debug | 2/2 | +49/−6 | — | 1 | 132 | 0 | 40 | — | 1052804 | 0.4214 | delivered, audit ok, 1 reviews, fix proven, mutants 4/4 killed |
| youtube-dl-16 | debug | 2/2 | +66/−9 | — | 1 | 203 | 0 | 45 | — | 1415900 | 0.5645 | delivered, audit ok, 1 reviews, fix proven, mutants 2/2 killed |
| youtube-dl-16 | debug | 2/2 | +72/−6 | — | 1 | 271 | 0 | 65 | — | 1765513 | 0.6679 | delivered, audit ok, 1 reviews, fix proven, mutants 0/0 killed |
| youtube-dl-16 | debug | 2/2 | +36/−6 | — | 1 | 186 | 0 | 29 | — | 1287512 | 0.5002 | delivered, audit ok, 1 reviews, fix proven, mutants 0/0 killed |
| youtube-dl-4 | debug | 2/2 | +38/−3 | — | 1 | 196 | 0 | 32 | — | 1422385 | 0.5201 | delivered, audit ok, 1 reviews, fix proven, mutants 0/0 killed |
| youtube-dl-4 | debug | 2/2 | +30/−3 | — | 1 | 159 | 0 | 26 | — | 1134298 | 0.4354 | delivered, audit ok, 1 reviews, fix proven, mutants 0/0 killed |
| youtube-dl-4 | debug | 2/2 | +33/−5 | — | 1 | 169 | 0 | 25 | — | 1180030 | 0.4651 | delivered, audit ok, 1 reviews, fix proven, mutants 0/0 killed |
| youtube-dl-41 | debug | 2/2 | +30/−1 | — | 1 | 980 | 0 | 27 | — | 4274158 | 1.5707 | delivered, audit ok, 3 reviews, fix proven, mutants 1/1 killed |
| youtube-dl-41 | debug | 2/2 | +34/−7 | — | 1 | 341 | 0 | 19 | — | 2341729 | 0.9878 | delivered, audit ok, 2 reviews, fix proven, mutants 0/0 killed |
| youtube-dl-41 | debug | 2/2 | +26/−1 | — | 1 | 272 | 0 | 18 | — | 2280368 | 0.8022 | delivered, audit ok, 2 reviews, fix proven, mutants 3/3 killed |
| youtube-dl-9 | debug | 2/2 | +41/−4 | — | 1 | 219 | 0 | 34 | — | 1256349 | 0.5064 | delivered, audit ok, 1 reviews, fix proven, mutants 3/3 killed |
| youtube-dl-9 | debug | 2/2 | +63/−7 | — | 1 | 257 | 0 | 46 | — | 1343272 | 0.5381 | delivered, audit ok, 1 reviews, fix proven, mutants 7/7 killed |
| youtube-dl-9 | debug | 2/2 | +51/−7 | — | 1 | 253 | 0 | 42 | — | 1434517 | 0.5719 | delivered, audit ok, 1 reviews, fix proven, mutants 5/5 killed |
| black-10 | engine | 2/2 | +13/−1 | — | 1 | 194 | 0 | 11 | — | 1428773 | 0.4953 | delivered, audit ok, 2 reviews |
| black-10 | engine | 2/2 | +13/−1 | — | 1 | 187 | 0 | 10 | — | 1397318 | 0.4772 | delivered, audit ok, 2 reviews |
| black-10 | engine | 2/2 | +12/−1 | — | 1 | 219 | 0 | 10 | — | 1530937 | 0.5287 | delivered, audit ok, 2 reviews |
| black-17 | engine | 2/2 | +13/−2 | — | 1 | 165 | 0 | 11 | — | 1372148 | 0.4559 | delivered, audit ok, 2 reviews |
| black-17 | engine | 2/2 | +15/−2 | — | 1 | 163 | 0 | 13 | — | 1352342 | 0.4459 | delivered, audit ok, 2 reviews |
| black-17 | engine | 2/2 | +15/−2 | — | 1 | 161 | 0 | 13 | — | 1373817 | 0.4525 | delivered, audit ok, 2 reviews |
| black-19 | engine | 2/2 | +29/−0 | — | 2 | 172 | 0 | 16 | — | 1459387 | 0.4942 | delivered, audit ok, 2 reviews |
| black-19 | engine | 2/2 | +32/−0 | — | 2 | 252 | 0 | 16 | — | 1579545 | 0.5893 | delivered, audit ok, 2 reviews |
| black-19 | engine | 2/2 | +27/−2 | — | 2 | 198 | 0 | 16 | — | 1512191 | 0.5115 | delivered, audit ok, 2 reviews |
| black-20 | engine | 2/2 | +14/−3 | — | 1 | 171 | 0 | 12 | — | 1422538 | 0.4705 | delivered, audit ok, 2 reviews |
| black-20 | engine | 2/2 | +14/−3 | — | 1 | 145 | 0 | 12 | — | 983501 | 0.3741 | not delivered, audit ok, 1 reviews |
| black-20 | engine | 2/2 | +22/−3 | — | 1 | 180 | 0 | 20 | — | 1436686 | 0.4833 | delivered, audit ok, 2 reviews |
| thefuck-2 | engine | 2/2 | +15/−1 | — | 1 | 161 | 0 | 14 | — | 1360996 | 0.4555 | delivered, audit ok, 2 reviews |
| thefuck-2 | engine | 2/2 | +11/−1 | — | 1 | 141 | 0 | 10 | — | 1317547 | 0.4275 | delivered, audit ok, 2 reviews |
| thefuck-2 | engine | 2/2 | +11/−1 | — | 1 | 184 | 0 | 10 | — | 1293678 | 0.4406 | delivered, audit ok, 2 reviews |
| thefuck-22 | engine | 2/2 | +13/−0 | — | 1 | 180 | 0 | 9 | — | 1357723 | 0.4632 | delivered, audit ok, 2 reviews |
| thefuck-22 | engine | 2/2 | +10/−0 | — | 1 | 170 | 0 | 6 | — | 1357222 | 0.4630 | delivered, audit ok, 2 reviews |
| thefuck-22 | engine | 2/2 | +10/−0 | — | 1 | 157 | 0 | 6 | — | 1356933 | 0.4532 | delivered, audit ok, 2 reviews |
| thefuck-24 | engine | 2/2 | +40/−1 | — | 1 | 182 | 0 | 20 | — | 1450308 | 0.5154 | delivered, audit ok, 2 reviews |
| thefuck-24 | engine | 2/2 | +33/−1 | — | 1 | 145 | 0 | 16 | — | 1320476 | 0.4406 | delivered, audit ok, 2 reviews |
| thefuck-24 | engine | 2/2 | +38/−1 | — | 1 | 172 | 0 | 18 | — | 1381048 | 0.4736 | delivered, audit ok, 2 reviews |
| thefuck-31 | engine | 2/2 | +6/−3 | — | 1 | 131 | 0 | 5 | — | 1352462 | 0.5049 | delivered, audit ok, 2 reviews |
| thefuck-31 | engine | 2/2 | +3/−2 | — | 1 | 121 | 0 | 2 | — | 1369036 | 0.4377 | delivered, audit ok, 2 reviews |
| thefuck-31 | engine | 2/2 | +4/−2 | — | 1 | 117 | 0 | 3 | — | 1290628 | 0.4167 | delivered, audit ok, 2 reviews |
| tornado-10 | engine | 2/2 | +31/−1 | — | 1 | 284 | 0 | 21 | — | 2873312 | 0.9407 | delivered, audit ok, 3 reviews |
| tornado-10 | engine | 2/2 | +27/−1 | — | 1 | 173 | 0 | 17 | — | 1709950 | 0.5811 | delivered, audit ok, 2 reviews |
| tornado-10 | engine | 2/2 | +31/−1 | — | 1 | 155 | 0 | 19 | — | 1604371 | 0.5410 | delivered, audit ok, 2 reviews |
| tornado-13 | engine | 1/2 | +50/−1 | — | 1 | 128 | 0 | 49 | regression | 1407347 | 0.4651 | delivered, audit ok, 2 reviews |
| tornado-13 | engine | 1/2 | +51/−1 | — | 1 | 155 | 0 | 49 | regression | 1492302 | 0.5149 | delivered, audit ok, 2 reviews |
| tornado-13 | engine | 1/2 | +67/−3 | — | 1 | 181 | 0 | 57 | regression | 1665273 | 0.5770 | delivered, audit ok, 2 reviews |
| tornado-15 | engine | 2/2 | +35/−1 | — | 1 | 150 | 0 | 34 | — | 1493014 | 0.5055 | delivered, audit ok, 2 reviews |
| tornado-15 | engine | 2/2 | +31/−1 | — | 1 | 161 | 0 | 29 | — | 1436266 | 0.5206 | delivered, audit ok, 2 reviews |
| tornado-15 | engine | 2/2 | +15/−1 | — | 1 | 162 | 0 | 13 | — | 1555404 | 0.5228 | delivered, audit ok, 2 reviews |
| tornado-7 | engine | 2/2 | +17/−1 | — | 0 | 140 | 0 | 0 | — | 1446151 | 0.4795 | delivered, audit ok, 2 reviews |
| tornado-7 | engine | 2/2 | +10/−2 | — | 0 | 161 | 0 | 0 | — | 1423024 | 0.5214 | delivered, audit ok, 2 reviews |
| tornado-7 | engine | 2/2 | +13/−6 | — | 1 | 146 | 0 | 4 | — | 1445783 | 0.5011 | delivered, audit ok, 2 reviews |
| tqdm-1 | engine | 2/2 | +4/−1 | — | 1 | 132 | 0 | 3 | — | 1434299 | 0.4983 | delivered, audit ok, 2 reviews |
| tqdm-1 | engine | 2/2 | +6/−1 | — | 1 | 109 | 0 | 3 | — | 1299147 | 0.4299 | delivered, audit ok, 2 reviews |
| tqdm-1 | engine | 2/2 | +2/−1 | — | 1 | 153 | 0 | 1 | — | 1455806 | 0.5128 | delivered, audit ok, 2 reviews |
| tqdm-4 | engine | 2/2 | +12/−1 | — | 1 | 140 | 0 | 10 | — | 1355441 | 0.4507 | delivered, audit ok, 2 reviews |
| tqdm-4 | engine | 2/2 | +12/−1 | — | 1 | 143 | 0 | 10 | — | 1350207 | 0.4378 | delivered, audit ok, 2 reviews |
| tqdm-4 | engine | 2/2 | +11/−1 | — | 1 | 139 | 0 | 9 | — | 1337949 | 0.4434 | delivered, audit ok, 2 reviews |
| tqdm-6 | engine | 2/2 | +13/−0 | — | 1 | 134 | 0 | 12 | — | 1524274 | 0.4861 | delivered, audit ok, 2 reviews |
| tqdm-6 | engine | 2/2 | +8/−0 | — | 1 | 172 | 0 | 7 | — | 1660913 | 0.5780 | delivered, audit ok, 2 reviews |
| tqdm-6 | engine | 2/2 | +17/−0 | — | 1 | 145 | 0 | 16 | — | 1468850 | 0.4909 | delivered, audit ok, 2 reviews |
| tqdm-9 | engine | 2/2 | +27/−6 | — | 1 | 134 | 0 | 19 | — | 1349456 | 0.4664 | delivered, audit ok, 2 reviews |
| tqdm-9 | engine | 2/2 | +32/−3 | — | 1 | 142 | 0 | 25 | — | 1544468 | 0.5146 | delivered, audit ok, 2 reviews |
| tqdm-9 | engine | 2/2 | +28/−5 | — | 1 | 134 | 0 | 21 | — | 1379892 | 0.4729 | delivered, audit ok, 2 reviews |
| youtube-dl-16 | engine | 2/2 | +50/−6 | — | 1 | 160 | 0 | 23 | — | 1630001 | 0.5689 | delivered, audit ok, 2 reviews |
| youtube-dl-16 | engine | 2/2 | +40/−9 | — | 1 | 814 | 0 | 18 | — | 3548098 | 1.2476 | delivered, audit ok, 2 reviews |
| youtube-dl-16 | engine | 2/2 | +50/−9 | — | 1 | 206 | 0 | 22 | — | 1844599 | 0.6658 | delivered, audit ok, 2 reviews |
| youtube-dl-4 | engine | 2/2 | +10/−2 | — | 1 | 139 | 0 | 8 | — | 1537489 | 0.4907 | delivered, audit ok, 2 reviews |
| youtube-dl-4 | engine | 2/2 | +10/−2 | — | 1 | 141 | 0 | 8 | — | 1458933 | 0.4873 | delivered, audit ok, 2 reviews |
| youtube-dl-4 | engine | 2/2 | +11/−2 | — | 1 | 150 | 0 | 8 | — | 1404082 | 0.4685 | delivered, audit ok, 2 reviews |
| youtube-dl-41 | engine | 2/2 | +5/−1 | — | 1 | 135 | 0 | 3 | — | 1511870 | 0.4890 | delivered, audit ok, 2 reviews |
| youtube-dl-41 | engine | 2/2 | +8/−1 | — | 1 | 141 | 0 | 5 | — | 1423638 | 0.4836 | delivered, audit ok, 2 reviews |
| youtube-dl-41 | engine | 2/2 | +15/−5 | — | 1 | 157 | 0 | 4 | — | 1453462 | 0.4967 | delivered, audit ok, 2 reviews |
| youtube-dl-9 | engine | 2/2 | +38/−4 | — | 1 | 208 | 0 | 31 | — | 1409707 | 0.5107 | delivered, audit ok, 2 reviews |
| youtube-dl-9 | engine | 2/2 | +31/−9 | — | 1 | 211 | 0 | 18 | — | 1544144 | 0.5278 | delivered, audit ok, 2 reviews |
| youtube-dl-9 | engine | 2/2 | +27/−4 | — | 1 | 206 | 0 | 18 | — | 1597722 | 0.5620 | delivered, audit ok, 2 reviews |

## Failed hidden checks

- tornado-13 (without): `node .bench-hidden/place.js && python -m pytest -q -p no:cacheprovider tornado/test/httpserver_test.py --deselect tornado/test/httpserver_test.py::BodyLimitsTest::test_body_size_override_reset --deselect tornado/test/httpserver_test.py::BodyLimitsTest::test_large_body_buffered --deselect tornado/test/httpserver_test.py::BodyLimitsTest::test_large_body_buffered_chunked --deselect tornado/test/httpserver_test.py::BodyLimitsTest::test_large_body_streaming --deselect tornado/test/httpserver_test.py::BodyLimitsTest::test_large_body_streaming_chunked --deselect tornado/test/httpserver_test.py::BodyLimitsTest::test_timeout --deselect tornado/test/httpserver_test.py::HTTPServerRawTest::test_malformed_first_line --deselect tornado/test/httpserver_test.py::HTTPServerRawTest::test_malformed_headers --deselect tornado/test/httpserver_test.py::UnixSocketTest::test_unix_socket_bad_request`
  ```
-- Docs: https://docs.pytest.org/en/stable/how-to/capture-warnings.html
=========================== short test summary info ============================
FAILED tornado/test/httpserver_test.py::UnixSocketTest::test_unix_socket - OS...
1 failed, 57 passed, 11 deselected, 7 warnings in 0.82s
  ```
- tornado-13 (without): `node .bench-hidden/place.js && python -m pytest -q -p no:cacheprovider tornado/test/httpserver_test.py --deselect tornado/test/httpserver_test.py::BodyLimitsTest::test_body_size_override_reset --deselect tornado/test/httpserver_test.py::BodyLimitsTest::test_large_body_buffered --deselect tornado/test/httpserver_test.py::BodyLimitsTest::test_large_body_buffered_chunked --deselect tornado/test/httpserver_test.py::BodyLimitsTest::test_large_body_streaming --deselect tornado/test/httpserver_test.py::BodyLimitsTest::test_large_body_streaming_chunked --deselect tornado/test/httpserver_test.py::BodyLimitsTest::test_timeout --deselect tornado/test/httpserver_test.py::HTTPServerRawTest::test_malformed_first_line --deselect tornado/test/httpserver_test.py::HTTPServerRawTest::test_malformed_headers --deselect tornado/test/httpserver_test.py::UnixSocketTest::test_unix_socket_bad_request`
  ```
-- Docs: https://docs.pytest.org/en/stable/how-to/capture-warnings.html
=========================== short test summary info ============================
FAILED tornado/test/httpserver_test.py::UnixSocketTest::test_unix_socket - OS...
1 failed, 57 passed, 11 deselected, 7 warnings in 0.98s
  ```
- tornado-13 (without): `node .bench-hidden/place.js && python -m pytest -q -p no:cacheprovider tornado/test/httpserver_test.py --deselect tornado/test/httpserver_test.py::BodyLimitsTest::test_body_size_override_reset --deselect tornado/test/httpserver_test.py::BodyLimitsTest::test_large_body_buffered --deselect tornado/test/httpserver_test.py::BodyLimitsTest::test_large_body_buffered_chunked --deselect tornado/test/httpserver_test.py::BodyLimitsTest::test_large_body_streaming --deselect tornado/test/httpserver_test.py::BodyLimitsTest::test_large_body_streaming_chunked --deselect tornado/test/httpserver_test.py::BodyLimitsTest::test_timeout --deselect tornado/test/httpserver_test.py::HTTPServerRawTest::test_malformed_first_line --deselect tornado/test/httpserver_test.py::HTTPServerRawTest::test_malformed_headers --deselect tornado/test/httpserver_test.py::UnixSocketTest::test_unix_socket_bad_request`
  ```
-- Docs: https://docs.pytest.org/en/stable/how-to/capture-warnings.html
=========================== short test summary info ============================
FAILED tornado/test/httpserver_test.py::UnixSocketTest::test_unix_socket - OS...
1 failed, 57 passed, 11 deselected, 7 warnings in 1.31s
  ```
- tornado-13 (method): `node .bench-hidden/place.js && python -m pytest -q -p no:cacheprovider tornado/test/httpserver_test.py --deselect tornado/test/httpserver_test.py::BodyLimitsTest::test_body_size_override_reset --deselect tornado/test/httpserver_test.py::BodyLimitsTest::test_large_body_buffered --deselect tornado/test/httpserver_test.py::BodyLimitsTest::test_large_body_buffered_chunked --deselect tornado/test/httpserver_test.py::BodyLimitsTest::test_large_body_streaming --deselect tornado/test/httpserver_test.py::BodyLimitsTest::test_large_body_streaming_chunked --deselect tornado/test/httpserver_test.py::BodyLimitsTest::test_timeout --deselect tornado/test/httpserver_test.py::HTTPServerRawTest::test_malformed_first_line --deselect tornado/test/httpserver_test.py::HTTPServerRawTest::test_malformed_headers --deselect tornado/test/httpserver_test.py::UnixSocketTest::test_unix_socket_bad_request`
  ```
-- Docs: https://docs.pytest.org/en/stable/how-to/capture-warnings.html
=========================== short test summary info ============================
FAILED tornado/test/httpserver_test.py::UnixSocketTest::test_unix_socket - OS...
1 failed, 58 passed, 11 deselected, 7 warnings in 0.93s
  ```
- tornado-13 (method): `node .bench-hidden/place.js && python -m pytest -q -p no:cacheprovider tornado/test/httpserver_test.py --deselect tornado/test/httpserver_test.py::BodyLimitsTest::test_body_size_override_reset --deselect tornado/test/httpserver_test.py::BodyLimitsTest::test_large_body_buffered --deselect tornado/test/httpserver_test.py::BodyLimitsTest::test_large_body_buffered_chunked --deselect tornado/test/httpserver_test.py::BodyLimitsTest::test_large_body_streaming --deselect tornado/test/httpserver_test.py::BodyLimitsTest::test_large_body_streaming_chunked --deselect tornado/test/httpserver_test.py::BodyLimitsTest::test_timeout --deselect tornado/test/httpserver_test.py::HTTPServerRawTest::test_malformed_first_line --deselect tornado/test/httpserver_test.py::HTTPServerRawTest::test_malformed_headers --deselect tornado/test/httpserver_test.py::UnixSocketTest::test_unix_socket_bad_request`
  ```
-- Docs: https://docs.pytest.org/en/stable/how-to/capture-warnings.html
=========================== short test summary info ============================
FAILED tornado/test/httpserver_test.py::UnixSocketTest::test_unix_socket - OS...
1 failed, 57 passed, 11 deselected, 7 warnings in 1.15s
  ```
- tornado-13 (method): `node .bench-hidden/place.js && python -m pytest -q -p no:cacheprovider tornado/test/httpserver_test.py --deselect tornado/test/httpserver_test.py::BodyLimitsTest::test_body_size_override_reset --deselect tornado/test/httpserver_test.py::BodyLimitsTest::test_large_body_buffered --deselect tornado/test/httpserver_test.py::BodyLimitsTest::test_large_body_buffered_chunked --deselect tornado/test/httpserver_test.py::BodyLimitsTest::test_large_body_streaming --deselect tornado/test/httpserver_test.py::BodyLimitsTest::test_large_body_streaming_chunked --deselect tornado/test/httpserver_test.py::BodyLimitsTest::test_timeout --deselect tornado/test/httpserver_test.py::HTTPServerRawTest::test_malformed_first_line --deselect tornado/test/httpserver_test.py::HTTPServerRawTest::test_malformed_headers --deselect tornado/test/httpserver_test.py::UnixSocketTest::test_unix_socket_bad_request`
  ```
-- Docs: https://docs.pytest.org/en/stable/how-to/capture-warnings.html
=========================== short test summary info ============================
FAILED tornado/test/httpserver_test.py::UnixSocketTest::test_unix_socket - OS...
1 failed, 57 passed, 11 deselected, 7 warnings in 0.97s
  ```
- tornado-13 (debug): `node .bench-hidden/place.js && python -m pytest -q -p no:cacheprovider tornado/test/httpserver_test.py --deselect tornado/test/httpserver_test.py::BodyLimitsTest::test_body_size_override_reset --deselect tornado/test/httpserver_test.py::BodyLimitsTest::test_large_body_buffered --deselect tornado/test/httpserver_test.py::BodyLimitsTest::test_large_body_buffered_chunked --deselect tornado/test/httpserver_test.py::BodyLimitsTest::test_large_body_streaming --deselect tornado/test/httpserver_test.py::BodyLimitsTest::test_large_body_streaming_chunked --deselect tornado/test/httpserver_test.py::BodyLimitsTest::test_timeout --deselect tornado/test/httpserver_test.py::HTTPServerRawTest::test_malformed_first_line --deselect tornado/test/httpserver_test.py::HTTPServerRawTest::test_malformed_headers --deselect tornado/test/httpserver_test.py::UnixSocketTest::test_unix_socket_bad_request`
  ```
-- Docs: https://docs.pytest.org/en/stable/how-to/capture-warnings.html
=========================== short test summary info ============================
FAILED tornado/test/httpserver_test.py::UnixSocketTest::test_unix_socket - OS...
1 failed, 57 passed, 11 deselected, 7 warnings in 1.52s
  ```
- tornado-13 (debug): `node .bench-hidden/place.js && python -m pytest -q -p no:cacheprovider tornado/test/httpserver_test.py --deselect tornado/test/httpserver_test.py::BodyLimitsTest::test_body_size_override_reset --deselect tornado/test/httpserver_test.py::BodyLimitsTest::test_large_body_buffered --deselect tornado/test/httpserver_test.py::BodyLimitsTest::test_large_body_buffered_chunked --deselect tornado/test/httpserver_test.py::BodyLimitsTest::test_large_body_streaming --deselect tornado/test/httpserver_test.py::BodyLimitsTest::test_large_body_streaming_chunked --deselect tornado/test/httpserver_test.py::BodyLimitsTest::test_timeout --deselect tornado/test/httpserver_test.py::HTTPServerRawTest::test_malformed_first_line --deselect tornado/test/httpserver_test.py::HTTPServerRawTest::test_malformed_headers --deselect tornado/test/httpserver_test.py::UnixSocketTest::test_unix_socket_bad_request`
  ```
-- Docs: https://docs.pytest.org/en/stable/how-to/capture-warnings.html
=========================== short test summary info ============================
FAILED tornado/test/httpserver_test.py::UnixSocketTest::test_unix_socket - OS...
1 failed, 57 passed, 11 deselected, 7 warnings in 1.15s
  ```
- tornado-13 (debug): `node .bench-hidden/place.js && python -m pytest -q -p no:cacheprovider tornado/test/httpserver_test.py --deselect tornado/test/httpserver_test.py::BodyLimitsTest::test_body_size_override_reset --deselect tornado/test/httpserver_test.py::BodyLimitsTest::test_large_body_buffered --deselect tornado/test/httpserver_test.py::BodyLimitsTest::test_large_body_buffered_chunked --deselect tornado/test/httpserver_test.py::BodyLimitsTest::test_large_body_streaming --deselect tornado/test/httpserver_test.py::BodyLimitsTest::test_large_body_streaming_chunked --deselect tornado/test/httpserver_test.py::BodyLimitsTest::test_timeout --deselect tornado/test/httpserver_test.py::HTTPServerRawTest::test_malformed_first_line --deselect tornado/test/httpserver_test.py::HTTPServerRawTest::test_malformed_headers --deselect tornado/test/httpserver_test.py::UnixSocketTest::test_unix_socket_bad_request`
  ```
-- Docs: https://docs.pytest.org/en/stable/how-to/capture-warnings.html
=========================== short test summary info ============================
FAILED tornado/test/httpserver_test.py::UnixSocketTest::test_unix_socket - OS...
1 failed, 59 passed, 11 deselected, 7 warnings in 1.09s
  ```
- tornado-15 (debug): `node .bench-hidden/place.js && python -m pytest -q -p no:cacheprovider tornado/test/web_test.py::StaticFileTest::test_path_traversal_protection`
  ```
-- Docs: https://docs.pytest.org/en/stable/how-to/capture-warnings.html
=========================== short test summary info ============================
FAILED tornado/test/web_test.py::StaticFileTest::test_path_traversal_protection
1 failed, 2 warnings in 0.42s
  ```
- tornado-13 (engine): `node .bench-hidden/place.js && python -m pytest -q -p no:cacheprovider tornado/test/httpserver_test.py --deselect tornado/test/httpserver_test.py::BodyLimitsTest::test_body_size_override_reset --deselect tornado/test/httpserver_test.py::BodyLimitsTest::test_large_body_buffered --deselect tornado/test/httpserver_test.py::BodyLimitsTest::test_large_body_buffered_chunked --deselect tornado/test/httpserver_test.py::BodyLimitsTest::test_large_body_streaming --deselect tornado/test/httpserver_test.py::BodyLimitsTest::test_large_body_streaming_chunked --deselect tornado/test/httpserver_test.py::BodyLimitsTest::test_timeout --deselect tornado/test/httpserver_test.py::HTTPServerRawTest::test_malformed_first_line --deselect tornado/test/httpserver_test.py::HTTPServerRawTest::test_malformed_headers --deselect tornado/test/httpserver_test.py::UnixSocketTest::test_unix_socket_bad_request`
  ```
-- Docs: https://docs.pytest.org/en/stable/how-to/capture-warnings.html
=========================== short test summary info ============================
FAILED tornado/test/httpserver_test.py::UnixSocketTest::test_unix_socket - OS...
1 failed, 57 passed, 11 deselected, 7 warnings in 0.88s
  ```
- tornado-13 (engine): `node .bench-hidden/place.js && python -m pytest -q -p no:cacheprovider tornado/test/httpserver_test.py --deselect tornado/test/httpserver_test.py::BodyLimitsTest::test_body_size_override_reset --deselect tornado/test/httpserver_test.py::BodyLimitsTest::test_large_body_buffered --deselect tornado/test/httpserver_test.py::BodyLimitsTest::test_large_body_buffered_chunked --deselect tornado/test/httpserver_test.py::BodyLimitsTest::test_large_body_streaming --deselect tornado/test/httpserver_test.py::BodyLimitsTest::test_large_body_streaming_chunked --deselect tornado/test/httpserver_test.py::BodyLimitsTest::test_timeout --deselect tornado/test/httpserver_test.py::HTTPServerRawTest::test_malformed_first_line --deselect tornado/test/httpserver_test.py::HTTPServerRawTest::test_malformed_headers --deselect tornado/test/httpserver_test.py::UnixSocketTest::test_unix_socket_bad_request`
  ```
-- Docs: https://docs.pytest.org/en/stable/how-to/capture-warnings.html
=========================== short test summary info ============================
FAILED tornado/test/httpserver_test.py::UnixSocketTest::test_unix_socket - OS...
1 failed, 57 passed, 11 deselected, 7 warnings in 0.87s
  ```
- tornado-13 (engine): `node .bench-hidden/place.js && python -m pytest -q -p no:cacheprovider tornado/test/httpserver_test.py --deselect tornado/test/httpserver_test.py::BodyLimitsTest::test_body_size_override_reset --deselect tornado/test/httpserver_test.py::BodyLimitsTest::test_large_body_buffered --deselect tornado/test/httpserver_test.py::BodyLimitsTest::test_large_body_buffered_chunked --deselect tornado/test/httpserver_test.py::BodyLimitsTest::test_large_body_streaming --deselect tornado/test/httpserver_test.py::BodyLimitsTest::test_large_body_streaming_chunked --deselect tornado/test/httpserver_test.py::BodyLimitsTest::test_timeout --deselect tornado/test/httpserver_test.py::HTTPServerRawTest::test_malformed_first_line --deselect tornado/test/httpserver_test.py::HTTPServerRawTest::test_malformed_headers --deselect tornado/test/httpserver_test.py::UnixSocketTest::test_unix_socket_bad_request`
  ```
-- Docs: https://docs.pytest.org/en/stable/how-to/capture-warnings.html
=========================== short test summary info ============================
FAILED tornado/test/httpserver_test.py::UnixSocketTest::test_unix_socket - OS...
1 failed, 57 passed, 11 deselected, 7 warnings in 1.69s
  ```
