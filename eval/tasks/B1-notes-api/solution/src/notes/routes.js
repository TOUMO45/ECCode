'use strict';
const { json, problem, readJson, validate } = require('../../vendor/acme-kit/http');
const { parsePaging, page } = require('../paging');
const { recordAudit } = require('../audit');
const repo = require('./repository');

const SCHEMA = {
  title: { type: 'string', required: true, min: 1, max: 120 },
  body: { type: 'string', max: 5000 },
};
const MAX_TAGS = 10;
const MAX_TAG_LENGTH = 30;

const validTags = (tags) => tags === undefined || tags === null || (Array.isArray(tags) && tags.length <= MAX_TAGS && tags.every((t) => typeof t === 'string' && t.trim().length >= 1 && t.length <= MAX_TAG_LENGTH));

function checkNote(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false, fields: ['title'] };
  const input = { ...body, title: typeof body.title === 'string' ? body.title.trim() : body.title };
  const { fields } = validate(input, SCHEMA);
  if (!validTags(body.tags)) fields.push('tags');
  return { ok: fields.length === 0, fields, input };
}

function register(router, db) {
  router.add('GET', '/api/notes', async (req, res, { query }) => {
    const paging = parsePaging(query);
    const tag = query.has('tag') ? query.get('tag') : undefined;
    json(res, 200, page(repo.listNotes(db, { tag }), paging));
  });

  router.add('POST', '/api/notes', async (req, res) => {
    const check = checkNote(await readJson(req));
    if (!check.ok) return problem(res, 422, 'validation_failed', 'Request body is invalid', { fields: check.fields });
    const { title, body = '', tags = [] } = check.input;
    const note = repo.insertNote(db, { title, body: body || '', tags: tags || [] });
    recordAudit(db, req, { action: 'create', entity: 'notes', entityId: note.id });
    json(res, 201, note);
  });

  router.add('GET', '/api/notes/:id', async (req, res, { params }) => {
    const note = repo.getNote(db, params.id);
    if (!note) return problem(res, 404, 'not_found', `Note ${params.id} not found`);
    json(res, 200, note);
  });
}

module.exports = { register };
