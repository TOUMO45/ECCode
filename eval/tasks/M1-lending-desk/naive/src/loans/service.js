'use strict';
// Loan rules: due dates, overdue days, fines and the loan view.
const money = require('../../vendor/acme-kit/money');
const cfg = require('../config');
const { addDays } = require('../lib/dates');

/** Due day for a loan (or renewal) of `member` that starts on `fromDay`. */
function dueDateFor(member, fromDay) {
  return addDays(fromDay, cfg.loanDays[member.tier]);
}

/** Days after `dueOn` up to and including `day` on which the branch was open. */
function overdueDays(dueOn, day, closures) {
  let n = 0;
  for (let d = addDays(dueOn, 1); d <= day; d = addDays(d, 1)) {
    if (!closures.has(d)) n += 1;
  }
  return n;
}

/** Fine in cents: the cap applies to the full fine, then juniors pay half. */
function fineCents({ days, book, member }) {
  const full = Math.min(days * cfg.fineCentsPerDay[book.media], book.replacementCents);
  return member.tier === 'junior' ? money.percent(full, 5000) : full;
}

/** Overdue days and fine of a loan that is returned (or looked at) on `day`. */
function lateness(loan, { book, member, day, closures }) {
  const days = overdueDays(loan.due_on, day, closures);
  return { days, fineCents: days > 0 ? fineCents({ days, book, member }) : 0 };
}

function statusOf(loan, today) {
  if (loan.returned_on) return 'returned';
  return today > loan.due_on ? 'overdue' : 'open';
}

function viewLoan(loan, { copy, book, member, today, closures }) {
  let days;
  let fine;
  if (loan.returned_on) {
    days = overdueDays(loan.due_on, loan.returned_on, closures);
    fine = loan.fineCents;
  } else {
    const l = lateness(loan, { book, member, day: today, closures });
    days = l.days;
    fine = l.fineCents;
  }
  return {
    id: loan.id,
    memberId: loan.member_id,
    copyId: loan.copy_id,
    bookId: copy.book_id,
    title: book.title,
    checkedOutOn: loan.checked_out_on,
    dueOn: loan.due_on,
    returnedOn: loan.returned_on,
    renewals: loan.renewals,
    status: statusOf(loan, today),
    overdueDays: days,
    fine: money.toDecimal(fine),
  };
}

module.exports = { dueDateFor, overdueDays, fineCents, lateness, statusOf, viewLoan };
