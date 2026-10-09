// GET /api/health: 200 {status: "ok", requestId} when SELECT 1 succeeds, else 503 DB_BUSY.
import { AppError } from '../http/envelope.js';

export function register(router, { db }) {
  router.add(
    'GET',
    '/api/health',
    () => {
      try {
        db.prepare('SELECT 1 AS ok').get();
      } catch {
        throw new AppError(503, 'DB_BUSY', { headers: { 'Retry-After': '1' } });
      }
      return { status: 200, body: { status: 'ok' } };
    },
    { policy: 'public' },
  );
}
