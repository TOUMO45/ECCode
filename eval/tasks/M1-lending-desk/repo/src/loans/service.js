'use strict';
// Loan rules.
const { loanDays } = require('../config');
const { addDays } = require('../lib/dates');

/** Due day for a loan that starts on `fromDay`. */
function dueDateFor(fromDay) {
  return addDays(fromDay, loanDays);
}

function viewLoan(loan, copy) {
  return {
    id: loan.id,
    memberId: loan.member_id,
    copyId: loan.copy_id,
    bookId: copy.book_id,
    checkedOutOn: loan.checked_out_on,
    dueOn: loan.due_on,
    returnedOn: loan.returned_on,
    renewals: loan.renewals,
  };
}

module.exports = { dueDateFor, viewLoan };
