'use strict';
// Data access for members.

function getMember(db, id) {
  return db.get('members', id);
}

function openLoanCount(db, memberId) {
  return db.all('loans', { member_id: Number(memberId), returned_on: null }).length;
}

module.exports = { getMember, openLoanCount };
