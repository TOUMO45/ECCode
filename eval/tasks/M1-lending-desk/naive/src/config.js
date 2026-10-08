'use strict';
// Branch policy constants.
module.exports = {
  // Every date in this service is a calendar day in this time zone.
  timezone: 'America/Chicago',
  maxOpenLoans: 5,
  maxRenewals: 2,
  // Loan period in days, by membership tier.
  loanDays: { adult: 21, junior: 14, senior: 28 },
  // Checkout is refused once unpaid fines reach this amount.
  unpaidFinesBlockCents: 500,
  // Overdue fine per open day, by media type.
  fineCentsPerDay: { book: 25, dvd: 100 },
};
