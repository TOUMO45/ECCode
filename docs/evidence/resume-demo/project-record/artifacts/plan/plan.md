# Plan: BILL-311

One phase, one task (small, single-module change in src/invoices). Reproduce first with a failing test, then fix.

Root causes:
1. DECIMAL values are strings; subtotal - discount + "15.00" concatenates to "12015.00".
2. Float math with an unrounded discount causes cent errors (2.01 * 50% = 1.005, 60.47 * 10% = 6.047).
3. The CSV route duplicates the total logic instead of sharing computeTotals.

Critical path: reproduction, service fix, CSV reuse, regression tests.

Risks: the rounding rule is assumed to be the acme-kit convention (half away from zero); confirm against accounting's spreadsheet.

Release checklist draft: npm test green; no config changes; rollback is a commit revert; no new monitoring.
