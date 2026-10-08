# ECCode evaluation results (R7)

> **SENSITIVITY ANALYSIS, not the official verdict.** Excluded hidden checks: M2-plan-changes AC3, M1-lending-desk AC7.

Generated 2026-10-08T22:02:26.592Z from `../../../srv/eccode-eval/round2`. Toolkits: ECCode `57f186fa2763`, ECC `ef648e01899b`. Targets were predeclared in `eval/suite/targets.json`.

## Target verdicts

| Target | Met | Detail |
|---|---|---|
| L1 | ✅ met | orgPassRate REL: C2 100% vs C1 12.5% (need +40 pp) |
| L2 | ✅ met | repeated mistakes REL: C2 0 vs C1 12 (need C2 <= half, C1 >= 3) |
| L3 | ✅ met | success REL: C2 91.7% vs C1 0% (need +25 pp) |
| L4 | ✅ met | decoy successes: C2 6/6 vs C1 6/6 (need C2 >= C1 - 1) |
| L5 | ✅ met | mean cost REL: C2 $1.29 vs C1 $1.05 (need <= 1.5x) |
| E1 | ❌ not met | success ALL: C2 94.4% vs C0 83.3% (need +20 pp) |
| E2 | ✅ met | regression trials ALL: C2 0 vs C0 1 |
| E3 | ❌ not met | interventions ALL: C2 1 vs C0 0 (need <= C0 and <= 2) |
| E4 | ✅ met | cost per success ALL: C2 $1.23 vs C0 $0.49 (need <= 3x) |

**Claims (orchestration alone, C1 vs C0):**

| Claim | Holds | Detail |
|---|---|---|
| O1 | no | discoverable AC pass ALL: C1 97.2% vs C0 98.6% (claim needs +5 pp) |
| O2 | no | regression trials ALL: C1 2 vs C0 1 |
| O3 | n/a | mean cost C1/C0 = 2.48x; mean wall time C1/C0 = 3.89x |

All mandatory targets met: **NO**

## Aggregates

### ALL

| Condition | n | Success (95% CI) | Org-rule checks | Discoverable AC | Regression trials | Repeated mistakes | Interventions | Mean cost | Cost/success | Mean wall min | Mean dispatches |
|---|---|---|---|---|---|---|---|---|---|---|---|
| C0 | 18 | 15/18 = 83.3% (60.8%–94.2%) | 48/48 | 98.6% | 1 | 0 | 0 | $0.40 | $0.49 | 1.2 | 0.0 |
| C1 | 18 | 6/18 = 33.3% (16.3%–56.3%) | 6/48 | 97.2% | 2 | 12 | 0 | $1.00 | $3.01 | 4.5 | 5.3 |
| C2 | 18 | 17/18 = 94.4% (74.2%–99%) | 48/48 | 99.3% | 0 | 0 | 1 | $1.16 | $1.23 | 8.6 | 4.8 |

### REL

| Condition | n | Success (95% CI) | Org-rule checks | Discoverable AC | Regression trials | Repeated mistakes | Interventions | Mean cost | Cost/success | Mean wall min | Mean dispatches |
|---|---|---|---|---|---|---|---|---|---|---|---|
| C0 | 12 | 9/12 = 75% (46.8%–91.1%) | 48/48 | 97.7% | 1 | 0 | 0 | $0.43 | $0.58 | 1.3 | 0.0 |
| C1 | 12 | 0/12 = 0% (0%–24.3%) | 6/48 | 95.4% | 2 | 12 | 0 | $1.05 | ∞ | 4.7 | 5.5 |
| C2 | 12 | 11/12 = 91.7% (64.6%–98.5%) | 48/48 | 98.9% | 0 | 0 | 1 | $1.29 | $1.41 | 9.3 | 5.2 |

### DEC

| Condition | n | Success (95% CI) | Org-rule checks | Discoverable AC | Regression trials | Repeated mistakes | Interventions | Mean cost | Cost/success | Mean wall min | Mean dispatches |
|---|---|---|---|---|---|---|---|---|---|---|---|
| C0 | 6 | 6/6 = 100% (61%–100%) | – | 100% | 0 | 0 | 0 | $0.35 | $0.35 | 0.9 | 0.0 |
| C1 | 6 | 6/6 = 100% (61%–100%) | – | 100% | 0 | 0 | 0 | $0.92 | $0.92 | 4.2 | 5.0 |
| C2 | 6 | 6/6 = 100% (61%–100%) | – | 100% | 0 | 0 | 0 | $0.89 | $0.89 | 7.2 | 4.0 |

## Per task (successes / repeats, mean cost)

| Task | Relation | C0 | C1 | C2 |
|---|---|---|---|---|
| M1-lending-desk | related | 3/3 · $0.46 | 0/3 · $1.06 | 3/3 · $1.25 |
| M2-plan-changes | related | 1/3 · $0.41 | 0/3 · $1.11 | 3/3 · $1.23 |
| M3-rental-billing | related | 2/3 · $0.42 | 0/3 · $0.87 | 2/3 · $1.08 |
| M4-giving-campaigns | related | 3/3 · $0.44 | 0/3 · $1.15 | 3/3 · $1.61 |
| M5-timetable-feeds | decoy | 3/3 · $0.39 | 3/3 · $1.00 | 3/3 · $0.98 |
| M6-menu-costing | decoy | 3/3 · $0.30 | 3/3 · $0.84 | 3/3 · $0.81 |

## Unsuccessful trials

- **M1-lending-desk · C1 · r1**: failed `AC9`, `AC11`, `AC12`
- **M1-lending-desk · C1 · r2**: failed `AC9`, `AC11`, `AC12`
- **M1-lending-desk · C1 · r3**: failed `AC9`, `AC11`, `AC12`
- **M2-plan-changes · C0 · r2**: failed `AC8`
- **M2-plan-changes · C0 · r3**: failed `REG1`; regressions REG1
- **M2-plan-changes · C1 · r1**: failed `AC9`, `AC10`, `AC11`, `AC12`
- **M2-plan-changes · C1 · r2**: failed `AC9`, `AC10`, `AC11`, `AC12`, `REG1`; regressions REG1
- **M2-plan-changes · C1 · r3**: failed `AC7`, `AC9`, `AC10`, `AC11`, `AC12`, `REG1`; regressions REG1
- **M3-rental-billing · C0 · r3**: failed `AC7`
- **M3-rental-billing · C1 · r1**: failed `AC5`, `AC6`, `AC7`, `AC9`
- **M3-rental-billing · C1 · r2**: failed `AC5`, `AC6`, `AC7`, `AC9`
- **M3-rental-billing · C1 · r3**: failed `AC5`, `AC6`, `AC9`
- **M3-rental-billing · C2 · r3**: failed `AC7`
- **M4-giving-campaigns · C1 · r1**: failed `AC7`, `AC8`, `AC9`, `AC11`
- **M4-giving-campaigns · C1 · r2**: failed `AC7`, `AC8`, `AC9`, `AC11`
- **M4-giving-campaigns · C1 · r3**: failed `AC7`, `AC8`, `AC9`, `AC11`, `AC12`

## Training

- **C0:** A1-invoice-total passed first time; A2-refund-limit passed first time; B1-notes-api feedback on org:list-envelope, org:audit-log → fixed; C1-quote-cache passed first time; E1-store-credit feedback on org:idempotency → fixed; F1-sales-export feedback on org:csv-crlf → fixed
- **C1:** A1-invoice-total passed first time; A2-refund-limit passed first time; B1-notes-api feedback on org:list-envelope, org:audit-log → fixed; C1-quote-cache passed first time; E1-store-credit feedback on org:idempotency → fixed; F1-sales-export feedback on org:csv-crlf → fixed
- **C2:** A1-invoice-total passed first time; A2-refund-limit passed first time; B1-notes-api feedback on org:list-envelope, org:audit-log → fixed; C1-quote-cache passed first time; E1-store-credit feedback on org:idempotency → fixed; F1-sales-export feedback on org:csv-crlf → fixed
