'use strict';
// Data access for the catalogue.

function listBooks(db) {
  return db.all('books');
}

function getBook(db, id) {
  return db.get('books', id);
}

function copiesOf(db, bookId) {
  return db.all('copies', { book_id: Number(bookId) });
}

function isOnLoan(db, copyId) {
  return db.all('loans', { copy_id: copyId, returned_on: null }).length > 0;
}

module.exports = { listBooks, getBook, copiesOf, isOnLoan };
