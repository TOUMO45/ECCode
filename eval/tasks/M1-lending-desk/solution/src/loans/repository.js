'use strict';
// Data access for copies, loans, holds and closures. DECIMAL fines are converted to cents here.
const money = require('../../vendor/acme-kit/money');

const toLoan = (r) => r && { ...r, fineCents: r.fine_amount === null ? 0 : money.fromDecimal(r.fine_amount) };
const toBook = (r) => r && { ...r, replacementCents: money.fromDecimal(r.replacement_price) };

function getCopy(db, id) {
  return db.get('copies', id);
}

function getBook(db, id) {
  return toBook(db.get('books', id));
}

function getLoan(db, id) {
  return toLoan(db.get('loans', id));
}

function openLoanForCopy(db, copyId) {
  return db.all('loans', { copy_id: Number(copyId), returned_on: null })[0] || null;
}

function openLoansForMember(db, memberId) {
  return db.all('loans', { member_id: Number(memberId), returned_on: null });
}

function loansForMember(db, memberId) {
  return db.all('loans', { member_id: Number(memberId) }).map(toLoan);
}

/** Sum of the fines a member has not paid yet, in cents. */
function unpaidFinesCents(db, memberId) {
  return money.sum(loansForMember(db, memberId).filter((l) => !l.fine_paid).map((l) => l.fineCents));
}

function waitingHolds(db, bookId) {
  return db.all('holds', { book_id: Number(bookId), status: 'waiting' });
}

function closureDays(db) {
  return new Set(db.all('closures').map((c) => c.date));
}

function insertLoan(db, values) {
  return toLoan(db.insert('loans', values));
}

function updateLoan(db, id, patch) {
  return toLoan(db.update('loans', id, patch));
}

module.exports = {
  getCopy,
  getBook,
  getLoan,
  openLoanForCopy,
  openLoansForMember,
  loansForMember,
  unpaidFinesCents,
  waitingHolds,
  closureDays,
  insertLoan,
  updateLoan,
};
