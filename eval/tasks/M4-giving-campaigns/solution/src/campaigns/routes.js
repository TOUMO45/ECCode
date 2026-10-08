'use strict';
const { json, problem } = require('../../vendor/acme-kit/http');
const repo = require('./repository');
const { viewCampaign } = require('./service');

function register(router, { db }) {
  // The list of campaigns is short; the website reads the whole array.
  router.add('GET', '/api/campaigns', async (req, res) => {
    json(res, 200, repo.listCampaigns(db).map((c) => {
      const v = viewCampaign(c, repo.donationsFor(db, c.id));
      return { id: v.id, slug: v.slug, title: v.title, status: v.status, goal: v.goal, raised: v.raised };
    }));
  });

  router.add('GET', '/api/campaigns/:id', async (req, res, { params }) => {
    const c = repo.getCampaign(db, params.id);
    if (!c) return problem(res, 404, 'not_found', `Campaign ${params.id} not found`);
    const donorName = (id) => repo.getDonor(db, id).name;
    json(res, 200, viewCampaign(c, repo.donationsFor(db, c.id), donorName));
  });
}

module.exports = { register };
