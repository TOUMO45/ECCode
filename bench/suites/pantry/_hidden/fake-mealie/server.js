'use strict';
// A stand-in for a Mealie instance's REST API, serving synthetic data in the
// shapes Mealie documents (paginated lists with items/page/per_page/total/
// total_pages; recipes with tags, totalTime and recipeIngredient; foods with
// labels). Pages hold at most 10 items whatever perPage asks, so a client
// that never follows pagination misses data.
// CLI: node server.js <data.json> [port]   prints its base URL
const fs = require('fs');
const http = require('http');

const PAGE_CAP = 10;

function page(items, query) {
  const perPage = Math.max(1, Math.min(PAGE_CAP, Number(query.get('perPage')) || PAGE_CAP));
  const totalPages = Math.max(1, Math.ceil(items.length / perPage));
  const p = Math.max(1, Number(query.get('page')) || 1);
  return { page: p, per_page: perPage, total: items.length, total_pages: totalPages, items: items.slice((p - 1) * perPage, p * perPage) };
}

function start({ port = 0, data }) {
  const recipes = data.recipes;
  const summary = (r) => ({ id: r.id, slug: r.slug, name: r.name, tags: r.tags, totalTime: r.totalTime });
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const send = (code, body) => {
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (req.method !== 'GET') return send(405, { detail: 'Method Not Allowed' });
    if (url.pathname === '/api/recipes') return send(200, page(recipes.map(summary), url.searchParams));
    const m = url.pathname.match(/^\/api\/recipes\/([\w-]+)$/);
    if (m) {
      const r = recipes.find((x) => x.slug === m[1]);
      return r ? send(200, r) : send(404, { detail: 'Not found' });
    }
    if (url.pathname === '/api/foods') return send(200, page(data.foods, url.searchParams));
    return send(404, { detail: 'Not Found' });
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) })));
}

module.exports = { start, PAGE_CAP };

if (require.main === module) {
  const [file, port] = process.argv.slice(2);
  start({ port: Number(port) || 0, data: JSON.parse(fs.readFileSync(file, 'utf8')) }).then(({ url }) => process.stdout.write(`${url}\n`));
}
