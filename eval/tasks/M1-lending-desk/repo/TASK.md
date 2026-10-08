# Feature: apply the lending policy at the desk

**Requested by:** Branch operations (ticket LIB-204)

Staff apply our lending policy by hand because the desk system only knows one rule (14 days for everyone). Please implement the policy below. Branch staff use the desk system all day, so please keep the existing behaviour of checkout, the catalogue and the member page intact.

**Loan periods**
Adults borrow for 21 days, juniors for 14 days and seniors for 28 days. This applies to new checkouts and to renewals.

**Unpaid fines**
A member whose unpaid fines add up to $5.00 or more cannot borrow until they pay: checkout answers 409. Fines that have already been paid don't count.

**Renewals: `POST /api/loans/:id/renew`**
- A renewal adds one more loan period to the loan's current due date (not to today's date).
- A loan can be renewed twice at most.
- A loan that is overdue can't be renewed. A loan that is due today is not overdue yet.
- A title can't be renewed while another member has a hold waiting on it. Holds that were cancelled or already fulfilled don't count.
- A loan that has already been returned can't be renewed.
- Anything that stops a renewal is a 409. The response of a successful renewal is the loan.

**Returns: `POST /api/loans/:id/return`**
Records the return as of today and the fine for the late days:
- $0.25 per overdue day for books and $1.00 per overdue day for DVDs. Days the branch was closed (the `closures` table) are not counted.
- A fine is never more than the item's replacement price. That cap applies to the full fine, before any junior discount.
- Juniors pay half of the fine, rounded to the nearest cent with halves going up.
- Returning on or before the due date costs nothing. Returning a loan twice is a 409.
- The response is the loan, with its `fine` (e.g. `"2.75"`) and the number of overdue days.

**Loan history: `GET /api/members/:id/loans`**
A member's loans, newest checkout first. It can be narrowed with `status=open|overdue|returned` (`open` means still out, overdue or not). Each loan shows its title, `status`, `overdueDays` and `fine`; for a loan that is still out and overdue, the fine is what it would cost if it were returned today. Unknown members are a 404.

**Acceptance**
- The rules above work through the API, with the same error format as the rest of the service.
- Existing behaviour that is not part of this request stays as it is (`npm test` passes).
