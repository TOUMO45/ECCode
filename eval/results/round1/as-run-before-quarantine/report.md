# ECCode evaluation results (R7)

Generated 2026-10-08T15:03:55.845Z from `../../../srv/eccode-eval/official`. Toolkits: ECCode `e5f4d497e123`, ECC `ef648e01899b`. Targets were predeclared in `eval/suite/targets.json`.

## Target verdicts

| Target | Met | Detail |
|---|---|---|
| L1 | ✅ met | orgPassRate REL: C2 86.7% vs C1 40% (need +40 pp) |
| L2 | ✅ met | repeated mistakes REL: C2 2 vs C1 9 (need C2 <= half, C1 >= 3) |
| L3 | ✅ met | success REL: C2 75% vs C1 16.7% (need +25 pp) |
| L4 | ✅ met | decoy successes: C2 4/6 vs C1 4/6 (need C2 >= C1 - 1) |
| L5 | ✅ met | mean cost REL: C2 $1.10 vs C1 $0.94 (need <= 1.5x) |
| E1 | ❌ not met | success ALL: C2 72.2% vs C0 88.9% (need +20 pp) |
| E2 | ✅ met | regression trials ALL: C2 0 vs C0 0 |
| E3 | ❌ not met | interventions ALL: C2 1 vs C0 0 (need <= C0 and <= 2) |
| E4 | ❌ not met | cost per success ALL: C2 $1.28 vs C0 $0.28 (need <= 3x) |

**Claims (orchestration alone, C1 vs C0):**

| Claim | Holds | Detail |
|---|---|---|
| O1 | no | discoverable AC pass ALL: C1 83.8% vs C0 88.9% (claim needs +5 pp) |
| O2 | yes | regression trials ALL: C1 0 vs C0 0 |
| O3 | n/a | mean cost C1/C0 = 3.22x; mean wall time C1/C0 = 6.97x |

All mandatory targets met: **NO**

## Aggregates

### ALL

| Condition | n | Success (95% CI) | Org-rule checks | Discoverable AC | Regression trials | Repeated mistakes | Interventions | Mean cost | Cost/success | Mean wall min | Mean dispatches |
|---|---|---|---|---|---|---|---|---|---|---|---|
| C0 | 18 | 16/18 = 88.9% (67.2%–96.9%) | 30/30 | 88.9% | 0 | 0 | 0 | $0.25 | $0.28 | 0.8 | 0.0 |
| C1 | 18 | 6/18 = 33.3% (16.3%–56.3%) | 12/30 | 83.8% | 0 | 9 | 0 | $0.81 | $2.42 | 5.6 | 3.6 |
| C2 | 18 | 13/18 = 72.2% (49.1%–87.5%) | 26/30 | 83.8% | 0 | 2 | 1 | $0.92 | $1.28 | 7.0 | 4.1 |

### REL

| Condition | n | Success (95% CI) | Org-rule checks | Discoverable AC | Regression trials | Repeated mistakes | Interventions | Mean cost | Cost/success | Mean wall min | Mean dispatches |
|---|---|---|---|---|---|---|---|---|---|---|---|
| C0 | 12 | 12/12 = 100% (75.7%–100%) | 30/30 | 100% | 0 | 0 | 0 | $0.29 | $0.29 | 1.0 | 0.0 |
| C1 | 12 | 2/12 = 16.7% (4.7%–44.8%) | 12/30 | 92.1% | 0 | 9 | 0 | $0.94 | $5.63 | 6.0 | 4.1 |
| C2 | 12 | 9/12 = 75% (46.8%–91.1%) | 26/30 | 92.1% | 0 | 2 | 1 | $1.10 | $1.46 | 8.7 | 4.8 |

### DEC

| Condition | n | Success (95% CI) | Org-rule checks | Discoverable AC | Regression trials | Repeated mistakes | Interventions | Mean cost | Cost/success | Mean wall min | Mean dispatches |
|---|---|---|---|---|---|---|---|---|---|---|---|
| C0 | 6 | 4/6 = 66.7% (30%–90.3%) | – | 69.4% | 0 | 0 | 0 | $0.17 | $0.25 | 0.5 | 0.0 |
| C1 | 6 | 4/6 = 66.7% (30%–90.3%) | – | 69.4% | 0 | 0 | 0 | $0.54 | $0.81 | 4.7 | 2.7 |
| C2 | 6 | 4/6 = 66.7% (30%–90.3%) | – | 69.4% | 0 | 0 | 0 | $0.57 | $0.86 | 3.6 | 2.7 |

## Per task (successes / repeats, mean cost)

| Task | Relation | C0 | C1 | C2 |
|---|---|---|---|---|
| H1-fleet-fuel-export | related | 3/3 · $0.27 | 0/3 · $0.91 | 3/3 · $1.15 |
| H2-courier-instant-payouts | related | 3/3 · $0.31 | 0/3 · $1.12 | 3/3 · $1.34 |
| H3-lab-instrument-bookings | related | 3/3 · $0.35 | 0/3 · $1.22 | 1/3 · $1.35 |
| H4-workorder-access | related | 3/3 · $0.23 | 2/3 · $0.50 | 2/3 · $0.55 |
| H5-parking-occupancy | decoy | 2/3 · $0.17 | 2/3 · $0.51 | 2/3 · $0.49 |
| H6-ticket-gate-export | decoy | 2/3 · $0.17 | 2/3 · $0.58 | 2/3 · $0.65 |

## Unsuccessful trials

- **H1-fleet-fuel-export · C1 · r1**: failed `AC7`
- **H1-fleet-fuel-export · C1 · r2**: failed `AC7`
- **H1-fleet-fuel-export · C1 · r3**: failed `AC7`
- **H2-courier-instant-payouts · C1 · r1**: failed `AC6`, `AC8`
- **H2-courier-instant-payouts · C1 · r2**: failed `AC6`, `AC8`
- **H2-courier-instant-payouts · C1 · r3**: failed `AC6`, `AC8`
- **H3-lab-instrument-bookings · C1 · r1**: failed `AC7`, `AC8`, `AC9`
- **H3-lab-instrument-bookings · C1 · r2**: failed `AC7`, `AC8`, `AC9`
- **H3-lab-instrument-bookings · C1 · r3**: failed `AC7`, `AC8`, `AC9`
- **H3-lab-instrument-bookings · C2 · r1**: failed `AC7`, `AC8`
- **H3-lab-instrument-bookings · C2 · r2**: failed `AC7`, `AC8`
- **H4-workorder-access · C1 · r3**: failed `AC1`, `AC2`, `AC3`, `AC4`, `AC5`
- **H4-workorder-access · C2 · r3**: failed `AC1`, `AC2`, `AC3`, `AC4`, `AC5`
- **H5-parking-occupancy · C0 · r3**: failed `AC1`, `AC2`, `AC3`, `AC4`
- **H5-parking-occupancy · C1 · r3**: failed `AC1`, `AC2`, `AC3`, `AC4`
- **H5-parking-occupancy · C2 · r3**: failed `AC1`, `AC2`, `AC3`, `AC4`
- **H6-ticket-gate-export · C0 · r3**: failed `AC1`, `AC2`, `AC3`, `AC4`, `AC5`, `AC6`, `AC7`
- **H6-ticket-gate-export · C1 · r3**: failed `AC1`, `AC2`, `AC3`, `AC4`, `AC5`, `AC6`, `AC7`
- **H6-ticket-gate-export · C2 · r3**: failed `AC1`, `AC2`, `AC3`, `AC4`, `AC5`, `AC6`, `AC7`

## Training

- **C0:** A1-invoice-total passed first time; A2-refund-limit passed first time; B1-notes-api feedback on org:list-envelope, org:audit-log → fixed; C1-quote-cache passed first time; E1-store-credit feedback on org:idempotency → fixed; F1-sales-export feedback on org:csv-crlf → fixed
- **C1:** A1-invoice-total passed first time; A2-refund-limit passed first time; B1-notes-api feedback on org:list-envelope, org:audit-log → fixed; C1-quote-cache passed first time; E1-store-credit feedback on org:idempotency → fixed; F1-sales-export feedback on org:csv-crlf → fixed
- **C2:** A1-invoice-total passed first time; A2-refund-limit passed first time; B1-notes-api feedback on org:list-envelope, org:audit-log → fixed; C1-quote-cache passed first time; E1-store-credit feedback on org:idempotency → fixed; F1-sales-export feedback on org:csv-crlf → fixed
