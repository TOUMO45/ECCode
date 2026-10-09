// SEC-B-3 verification, same scenario as the reviewer's probe (section H): a 20,000-deep JSON body
// under the 64 KiB cap goes to a route that fingerprints it with canonicalJson. Before the fix the
// route answered 500 (RangeError); after it, 422 VALIDATION_FAILED. Exit 1 if the status is not 422.
import { mkdtempSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const ROOT = resolve(process.argv[1], '../../..');
const imp = (p) => import(join(ROOT, p));
const { createApp } = await imp('src/app.js');
const { loadConfig } = await imp('src/config.js');
const { openDb } = await imp('src/db/connection.js');
const { migrate } = await imp('src/db/migrate.js');
const { canonicalJson } = await imp('src/http/body.js');
const { silentLogger } = await imp('src/log.js');

const dir = mkdtempSync(join(tmpdir(), 'b1-secb3-'));
const db = openDb(join(dir, 'app.db'));
migrate(db);
const config = loadConfig({ PORT: '0', RS_TEST_OFFLINE: '1' });
const routes = [(router) => router.add('POST', '/api/probe/fp', async (ctx) => ({ body: { fp: canonicalJson(await ctx.body()).length } }), { policy: 'public' })];
const app = createApp({ db, config, log: silentLogger(), routes });
const port = await app.listen(0, '127.0.0.1');

const body = `{"a":${'['.repeat(20000)}${']'.repeat(20000)}}`;
const send = (path, method, payload) => new Promise((res, rej) => {
  const req = request({ host: '127.0.0.1', port, path, method, headers: { 'Content-Type': 'application/json' }, agent: false }, (r) => {
    let text = '';
    r.on('data', (c) => (text += c));
    r.on('end', () => res({ status: r.statusCode, text }));
  });
  req.on('error', rej);
  req.end(payload);
});

const deep = await send('/api/probe/fp', 'POST', body);
const health = await send('/api/health', 'GET');
console.log(`body ${Buffer.byteLength(body)} bytes: status ${deep.status} ${deep.text.slice(0, 120)}`);
console.log(`health after: ${health.status}`);
await app.close();
db.close();
process.exit(deep.status === 422 && health.status === 200 ? 0 : 1);
