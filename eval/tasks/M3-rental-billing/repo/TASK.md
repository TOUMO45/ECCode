# Feature: rental charges, the rentals list and monthly statements

**Requested by:** Counter operations and Finance (ticket HIRE-377)

The counter works out what a customer owes on a calculator and Finance builds the monthly statements by hand. We want the service to do both.

**What a rental costs: `GET /api/rentals/:id`**
Keep the fields the rental has today and add the charge: `days`, `lateDays`, `rental`, `lateFee`, `subtotal`, `tax`, `total` and `deposit`, all amounts as decimal strings.
- Billed days run from the start date up to the date the item is due back, or up to the return date if it came back earlier. A rental is always billed for at least one day (picking up and returning on the same day is one day).
- Each full block of 7 days costs the weekly rate; the days left over cost the daily rate, but never more than one weekly rate. Under 7 days the same "never more than a week" rule applies.
- An item returned after its due date also pays a late fee: 150% of the daily rate for every day it is late. The late fee is worked out for all late days together and rounded to the cent (halves go up).
- Sales tax is the category's rate (`categories.tax_bp`) on the subtotal (rental plus late fee), rounded to the cent with halves going up. Tax-exempt customers pay none. `total` is subtotal plus tax. The deposit is shown but is not part of the total.
- Rentals that are still out are charged up to their due date. Cancelled rentals cost nothing (`rental`, `lateFee`, `subtotal`, `tax` and `total` are `0.00`; `days` and `lateDays` are 0).

**Rentals list: `GET /api/rentals`**
The newest start date first (then the newest rental number). It can be filtered with `customerId` and `status`. Every rental in it carries the same fields as the single-rental answer.

**Monthly statement: `GET /api/customers/:id/statement.csv?month=2026-02`**
Finance imports this file into the accounting system, one statement per customer per month. It has one row per rental that was **returned** in that month (by return date; rentals still out or cancelled are not on it), sorted by return date and then rental number, with these columns:
`rental_id,sku,item,start_date,returned_on,days,late_days,subtotal,tax,total`
The amounts are the ones from the rental charge. An unknown customer is a 404 and a missing or malformed `month` is a validation error on `month`. A month without returns still gives a statement, with only the header row.

**Acceptance**
- Charges are correct to the cent, in the list, on the single rental and in the statement.
- The statement is a CSV file that accounting can import.
- Existing behaviour that is not part of this request stays as it is (`npm test` passes).
