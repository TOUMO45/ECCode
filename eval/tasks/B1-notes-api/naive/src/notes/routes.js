'use strict';
const { json, problem, readJson, validate } = require('../../vendor/acme-kit/http');
const repo = require('./repository');

const SCHEMA = {
  title: { type: 'string', required: true, min: 1, max: 120 },
  body: { type: 'string', max: 5000 },
};

function invalidFields(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return ['title'];
  const { fields } = validate({ ...body, title: typeof body.title === 'string' ? body.title.trim() : body.title }, SCHEMA);
  const tags = body.tags;
  if (tags !== undefined && tags !== null && !(Array.isArray(tags) && tags.length <= 10 && tags.every((t) => typeof t === 'string' && t.trim() !== '' && t.length <= 30))) fields.push('tags');
  return fields;
}

function register(router, db) {
  router.add('GET', '/api/notes', async (req, res, { query }) => {
    json(res, 200, repo.listNotes(db, { tag: query.get('tag') || undefined }));
  });

  router.add('POST', '/api/notes', async (req, res) => {
    const body = await readJson(req);
    const fields = invalidFields(body);
    if (fields.length) return problem(res, 422, 'validation_failed', 'Request body is invalid', { fields });
    const note = repo.insertNote(db, { title: body.title.trim(), body: body.body || '', tags: body.tags || [] });
    json(res, 201, note);
  });

  router.add('GET', '/api/notes/:id', async (req, res, { params }) => {
    const note = repo.getNote(db, params.id);
    if (!note) return problem(res, 404, 'not_found', `Note ${params.id} not found`);
    json(res, 200, note);
  });
}

module.exports = { register };
