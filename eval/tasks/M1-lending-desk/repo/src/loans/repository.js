'use strict';
// Data access for copies and loans.

function getCopy(db, id) {
  return db.get('copies', id);
}

function openLoanForCopy(db, copyId) {
  return db.all('loans', { copy_id: Number(copyId), returned_on: null })[0] || null;
}

function openLoansForMember(db, memberId) {
  return db.all('loans', { member_id: Number(memberId), returned_on: null });
}

function insertLoan(db, values) {
  return db.insert('loans', values);
}

module.exports = { getCopy, openLoanForCopy, openLoansForMember, insertLoan };
