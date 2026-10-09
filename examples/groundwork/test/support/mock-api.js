// Minimal in-memory mock of the Groundwork API contract (spec section 3) for UI development
// and tests that need no database. Serves public/ plus a canned incident, notes and draft.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const TYPES = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript' };
const PUBLIC = path.resolve(import.meta.dirname, '../../public');

export function fixtures() {
  const lines = [
    { n: 1, time: '03:30', ts: null, author: 'alice', text: 'Paged for elevated 500 errors' },
    { n: 2, time: '03:33', ts: null, author: 'carol', text: 'Restarted the cache' },
  ];
  const st = (id, text, cites, ok) => ({
    id, text, cites, status: ok ? 'verified' : 'flagged', reasons: ok ? [] : [{ code: 'NAME_NOT_IN_SOURCE', detail: 'Bob' }], edited: false,
  });
  const draft = {
    id: 1, incidentId: 1, version: 1, state: 'draft', provider: 'fake', model: null, isFallback: false, generatedAt: '2026-10-08T00:00:00.000Z',
    publishedAt: null, publishedBy: null, flaggedCount: 1,
    sections: {
      summary: [st(1, 'Alice was paged at 03:30', [1], true)],
      impact: [],
      timeline: [st(2, 'Bob restarted the cache at 03:33', [2], false)],
      contributingFactors: [],
      actionItems: [],
    },
  };
  return { lines, draft };
}

export async function startMockApi({ port = 0 } = {}) {
  const user = { id: 1, username: 'mock', displayName: 'Mock Responder', role: 'responder', teamId: 1, teamName: 'Team' };
  const { lines, draft } = fixtures();
  const incident = {
    id: 1, title: 'Cache outage', severity: 'SEV2', startedAt: '2026-10-08T03:30:00.000Z', description: 'x',
    createdBy: { id: 1, displayName: 'Mock' }, createdAt: '2026-10-08T03:31:00.000Z', noteCount: lines.length, draft: null,
  };
  let signedIn = false;
  const send = (res, status, obj) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
  const err = (res, status, code, message) => send(res, status, { error: { code, message, requestId: 'mockreq-0001' } });
  const server = http.createServer((req, res) => {
    const p = new URL(req.url, 'http://x').pathname;
    if (!p.startsWith('/api/')) {
      const rel = p === '/' ? 'index.html' : p.slice(1);
      const file = path.resolve(PUBLIC, rel);
      if (!file.startsWith(PUBLIC + path.sep) || !fs.existsSync(file) || !TYPES[path.extname(file)]) return err(res, 404, 'NOT_FOUND', 'Not found');
      res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] });
      return res.end(fs.readFileSync(file));
    }
    if (p === '/api/csrf') return send(res, 200, { csrfToken: 'mock-csrf' });
    if (req.method === 'POST' && p === '/api/auth/login') {
      let b = '';
      req.on('data', (d) => { b += d; });
      req.on('end', () => {
        if (req.headers['x-csrf-token'] !== 'mock-csrf') return err(res, 403, 'CSRF_FAILED', 'CSRF validation failed');
        if (JSON.parse(b).password !== 'correct-horse-1') return err(res, 401, 'INVALID_CREDENTIALS', 'Invalid username or password');
        signedIn = true;
        return send(res, 200, { user, csrfToken: 'mock-csrf' });
      });
      return undefined;
    }
    if (!signedIn) return err(res, 401, 'UNAUTHENTICATED', 'Authentication required');
    if (p === '/api/me') return send(res, 200, { user, csrfToken: 'mock-csrf' });
    if (p === '/api/providers') {
      return send(res, 200, { providers: [{ id: 'fake', label: 'Fake', available: true, isFallback: false, sendsNotesOffHost: false }], default: 'fake' });
    }
    if (p === '/api/incidents') return send(res, 200, { incidents: [incident] });
    if (p === '/api/incidents/1') return send(res, 200, { incident });
    if (p === '/api/incidents/1/notes') return send(res, 200, { lines });
    if (p === '/api/incidents/1/draft') return send(res, 200, { draft });
    return err(res, 404, 'NOT_FOUND', 'Not found');
  });
  await new Promise((r) => { server.listen(port, '127.0.0.1', r); });
  const url = `http://127.0.0.1:${server.address().port}`;
  return { url, close: () => new Promise((r) => { server.close(r); server.closeAllConnections?.(); }) };
}
