'use strict';
const { json, problem } = require('../../vendor/acme-kit/http');
const repo = require('./repository');

function view(db, b) {
  const copies = repo.copiesOf(db, b.id);
  return {
    id: b.id,
    title: b.title,
    author: b.author,
    media: b.media,
    copies: copies.length,
    available: copies.filter((c) => !repo.isOnLoan(db, c.id)).length,
  };
}

function register(router, { db }) {
  // The catalogue is small; desk clients read the whole array.
  router.add('GET', '/api/books', async (req, res) => {
    json(res, 200, repo.listBooks(db).map((b) => view(db, b)));
  });

  router.add('GET', '/api/books/:id', async (req, res, { params }) => {
    const b = repo.getBook(db, params.id);
    if (!b) return problem(res, 404, 'not_found', `Book ${params.id} not found`);
    json(res, 200, view(db, b));
  });
}

module.exports = { register };
