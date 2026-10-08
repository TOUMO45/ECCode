# Feature: accept donations, with fee cover and sponsor matching

**Requested by:** Fundraising team and Finance (ticket GIVE-142)

Until now donations were loaded by a nightly import. We want donors to give through the API, with the platform fee shown and optionally covered by the donor, and with the sponsor's match applied. Finance also needs the receipts for a campaign.

**Give: `POST /api/campaigns/:id/donations`** with `{"donorId": 5, "amount": "25.00", "coverFees": false, "anonymous": false}`
- `amount` is a gift between 5.00 and 10,000.00 (two decimals at most). `coverFees` and `anonymous` are optional and default to false. An unknown donor is a validation error on `donorId`.
- A campaign only takes donations while its status is `live` and today is between its start and end date, both days included (UTC days). Otherwise the request is a 409.
- The platform fee is 2.9% of the amount plus 0.30, rounded to the cent (halves go up).
- If the donor covers the fees they are charged amount + fee and the campaign receives the full amount. Otherwise they are charged the amount and the campaign receives the amount minus the fee.
- If the campaign has a matching pool (`match_cap`), the sponsor matches what the campaign receives, dollar for dollar, until the pool is used up: the donation that crosses the limit is matched only for what is left, and later ones get no match.
- The answer (201) is `{ id, campaignId, donorId, amount, fee, covered, charged, credited, matched, anonymous, createdAt }` with the money as decimal strings.

**Campaign page: `GET /api/campaigns/:id`**
`raised` is what the campaign actually received: the credited amounts plus the matches. `percent` keeps meaning the whole-number share of the goal, and `donorCount` the number of different donors. Add `matchRemaining` (what is left in the pool) and `recent`: the five latest donations, newest first, as `{ "donor", "amount", "at" }`. Donors who gave anonymously show as "Anonymous" there. The campaign list shows the same `raised` as the page does.

**Receipts: `GET /api/campaigns/:id/receipts.csv?year=2026`**
Finance imports this file into the accounting system to issue tax receipts. One row per donation made in that calendar year (UTC), oldest first, with the columns:
`donation_id,date,donor,email,amount,fee,charged,matched`
Finance needs the real donor on every row, including anonymous gifts (anonymous only applies to the public pages). `charged` is what the donor paid. An unknown campaign is a 404 and a missing or malformed `year` is a validation error on `year`.

**Acceptance**
- Donations, the campaign page and the receipts behave as described, with the same error format as the rest of the service.
- Existing behaviour that is not part of this request stays as it is (`npm test` passes).
