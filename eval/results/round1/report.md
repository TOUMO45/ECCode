# ECCode evaluation results (R7)

Generated 2026-10-08T15:30:54.150Z from `../../../srv/eccode-eval/official`. Toolkits: ECCode `e5f4d497e123`, ECC `ef648e01899b`. Targets were predeclared in `eval/suite/targets.json`.

## Target verdicts

| Target | Met | Detail |
|---|---|---|
| L1 | ✅ met | orgPassRate REL: C2 83.3% vs C1 40% (need +40 pp) |
| L2 | ✅ met | repeated mistakes REL: C2 3 vs C1 9 (need C2 <= half, C1 >= 3) |
| L3 | ✅ met | success REL: C2 75% vs C1 25% (need +25 pp) |
| L4 | ✅ met | decoy successes: C2 6/6 vs C1 6/6 (need C2 >= C1 - 1) |
| L5 | ✅ met | mean cost REL: C2 $1.18 vs C1 $0.99 (need <= 1.5x) |
| E1 | ❌ not met | success ALL: C2 83.3% vs C0 100% (need +20 pp) |
| E2 | ✅ met | regression trials ALL: C2 0 vs C0 0 |
| E3 | ✅ met | interventions ALL: C2 0 vs C0 0 (need <= C0 and <= 2) |
| E4 | ❌ not met | cost per success ALL: C2 $1.30 vs C0 $0.28 (need <= 3x) |

**Claims (orchestration alone, C1 vs C0):**

| Claim | Holds | Detail |
|---|---|---|
| O1 | no | discoverable AC pass ALL: C1 100% vs C0 100% (claim needs +5 pp) |
| O2 | yes | regression trials ALL: C1 0 vs C0 0 |
| O3 | n/a | mean cost C1/C0 = 3.40x; mean wall time C1/C0 = 6.67x |

All mandatory targets met: **NO**

## Aggregates

### ALL

| Condition | n | Success (95% CI) | Org-rule checks | Discoverable AC | Regression trials | Repeated mistakes | Interventions | Mean cost | Cost/success | Mean wall min | Mean dispatches |
|---|---|---|---|---|---|---|---|---|---|---|---|
| C0 | 18 | 18/18 = 100% (82.4%–100%) | 30/30 | 100% | 0 | 0 | 0 | $0.28 | $0.28 | 0.9 | 0.0 |
| C1 | 18 | 9/18 = 50% (29%–71%) | 12/30 | 100% | 0 | 9 | 0 | $0.95 | $1.89 | 5.8 | 4.2 |
| C2 | 18 | 15/18 = 83.3% (60.8%–94.2%) | 25/30 | 100% | 0 | 3 | 0 | $1.08 | $1.30 | 7.9 | 4.8 |

### REL

| Condition | n | Success (95% CI) | Org-rule checks | Discoverable AC | Regression trials | Repeated mistakes | Interventions | Mean cost | Cost/success | Mean wall min | Mean dispatches |
|---|---|---|---|---|---|---|---|---|---|---|---|
| C0 | 12 | 12/12 = 100% (75.7%–100%) | 30/30 | 100% | 0 | 0 | 0 | $0.29 | $0.29 | 1.0 | 0.0 |
| C1 | 12 | 3/12 = 25% (8.9%–53.2%) | 12/30 | 100% | 0 | 9 | 0 | $0.99 | $3.97 | 6.1 | 4.3 |
| C2 | 12 | 9/12 = 75% (46.8%–91.1%) | 25/30 | 100% | 0 | 3 | 0 | $1.18 | $1.57 | 9.3 | 5.3 |

### DEC

| Condition | n | Success (95% CI) | Org-rule checks | Discoverable AC | Regression trials | Repeated mistakes | Interventions | Mean cost | Cost/success | Mean wall min | Mean dispatches |
|---|---|---|---|---|---|---|---|---|---|---|---|
| C0 | 6 | 6/6 = 100% (61%–100%) | – | 100% | 0 | 0 | 0 | $0.25 | $0.25 | 0.7 | 0.0 |
| C1 | 6 | 6/6 = 100% (61%–100%) | – | 100% | 0 | 0 | 0 | $0.85 | $0.85 | 5.2 | 4.0 |
| C2 | 6 | 6/6 = 100% (61%–100%) | – | 100% | 0 | 0 | 0 | $0.88 | $0.88 | 5.1 | 4.0 |

## Per task (successes / repeats, mean cost)

| Task | Relation | C0 | C1 | C2 |
|---|---|---|---|---|
| H1-fleet-fuel-export | related | 3/3 · $0.27 | 0/3 · $0.91 | 3/3 · $1.25 |
| H2-courier-instant-payouts | related | 3/3 · $0.31 | 0/3 · $1.12 | 2/3 · $1.27 |
| H3-lab-instrument-bookings | related | 3/3 · $0.35 | 0/3 · $1.19 | 1/3 · $1.41 |
| H4-workorder-access | related | 3/3 · $0.23 | 3/3 · $0.75 | 3/3 · $0.79 |
| H5-parking-occupancy | decoy | 3/3 · $0.25 | 3/3 · $0.79 | 3/3 · $0.79 |
| H6-ticket-gate-export | decoy | 3/3 · $0.25 | 3/3 · $0.92 | 3/3 · $0.96 |

## Unsuccessful trials

- **H1-fleet-fuel-export · C1 · r1**: failed `AC7`
- **H1-fleet-fuel-export · C1 · r2**: failed `AC7`
- **H1-fleet-fuel-export · C1 · r3**: failed `AC7`
- **H2-courier-instant-payouts · C1 · r1**: failed `AC6`, `AC8`
- **H2-courier-instant-payouts · C1 · r2**: failed `AC6`, `AC8`
- **H2-courier-instant-payouts · C1 · r3**: failed `AC6`, `AC8`
- **H2-courier-instant-payouts · C2 · r3**: failed `AC6`
- **H3-lab-instrument-bookings · C1 · r1**: failed `AC7`, `AC8`, `AC9`
- **H3-lab-instrument-bookings · C1 · r2**: failed `AC7`, `AC8`, `AC9`
- **H3-lab-instrument-bookings · C1 · r3**: failed `AC7`, `AC8`, `AC9`
- **H3-lab-instrument-bookings · C2 · r1**: failed `AC7`, `AC8`
- **H3-lab-instrument-bookings · C2 · r2**: failed `AC7`, `AC8`

## Training

- **C0:** A1-invoice-total passed first time; A2-refund-limit passed first time; B1-notes-api feedback on org:list-envelope, org:audit-log → fixed; C1-quote-cache passed first time; E1-store-credit feedback on org:idempotency → fixed; F1-sales-export feedback on org:csv-crlf → fixed
- **C1:** A1-invoice-total passed first time; A2-refund-limit passed first time; B1-notes-api feedback on org:list-envelope, org:audit-log → fixed; C1-quote-cache passed first time; E1-store-credit feedback on org:idempotency → fixed; F1-sales-export feedback on org:csv-crlf → fixed
- **C2:** A1-invoice-total passed first time; A2-refund-limit passed first time; B1-notes-api feedback on org:list-envelope, org:audit-log → fixed; C1-quote-cache passed first time; E1-store-credit feedback on org:idempotency → fixed; F1-sales-export feedback on org:csv-crlf → fixed
