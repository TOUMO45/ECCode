# Feature: mid-cycle plan changes and cancellations

**Requested by:** Customer success (ticket SUB-512)

Customers keep asking us to move to another plan, or add and remove seats, in the middle of a billing cycle. Today support does it by hand in a spreadsheet. We want the API to do it, with a quote first so support can tell the customer what will happen.

**Quote: `GET /api/subscriptions/:id/change-preview?planCode=business&seats=10`**
`seats` is optional and defaults to the current number of seats. The answer shows the proration for a change made today:
`{ "effectiveOn", "planCode", "seats", "remainingDays", "cycleDays", "credit", "charge", "net" }`, with the amounts as decimal strings. It changes nothing.

**Change: `POST /api/subscriptions/:id/change-plan` with `{"planCode": "business", "seats": 10}`**
Applies the change today and answers with the updated subscription (same shape as `GET /api/subscriptions/:id`) plus `effectiveOn` and a `proration` object with the same fields as the quote.

How the money works:
- The customer gets credit for the unused part of what they have now, and is charged for the new plan and seats for the same remaining days. Each amount is price × seats × remaining days ÷ days in the cycle: exact, rounded to the nearest cent with halves going up. Credit and charge are each rounded on their own, and `net` is charge minus credit.
- "Remaining days" are counted from today (included) up to the end of the cycle (not included). "Today" is the account's own calendar day. The cycle length is the real number of days in this cycle.
- A positive net is added to the subscription's `pendingCharge` (it goes on the next invoice). A negative net is added to `creditBalance` as credit.
- While a subscription is `trialing`, a change costs nothing: the plan and seats change, no credit, no charge.
- The seats must fit the new plan's seat limit, otherwise 409. A change that changes nothing (same plan, same seats) is also a 409, and so is changing a cancelled subscription. An unknown `planCode` or invalid `seats` is a validation error on that field.

**Cancel: `POST /api/subscriptions/:id/cancel`**
Cancels today. The unused part of the current plan (same calculation as above) is given back as account credit, the status becomes `cancelled` and `cancelledOn` is today's date. A trial gets no credit. Cancelling twice is a 409. The answer is the subscription plus `refund` (decimal string).

**Acceptance**
- The quote, the change and the cancellation behave as described, with the same error format as the rest of the service.
- Amounts are exact to the cent.
- Existing behaviour that is not part of this request stays as it is (`npm test` passes).
