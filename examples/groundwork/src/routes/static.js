// Static file server for public/ (spec 9): whitelisted extensions, no dotfiles,
// no directory listing, traversal rejected, symlinks cannot escape the root.
import fs from 'node:fs';
import path from 'node:path';
import { ApiError } from '../http/envelope.js';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.woff2': 'font/woff2',
};

export function resolveStatic(root, rawPath) {
  let decoded;
  try { decoded = decodeURIComponent(rawPath); } catch { return null; }
  if (decoded.includes('\0') || decoded.includes('\\')) return null;
  const segs = decoded.split('/').filter(Boolean);
  if (segs.some((s) => s === '..' || s === '.' || s.startsWith('.'))) return null;
  const rel = segs.length === 0 ? 'index.html' : segs.join('/');
  if (!Object.hasOwn(TYPES, path.extname(rel).toLowerCase())) return null;
  const full = path.resolve(root, rel);
  if (!full.startsWith(root + path.sep)) return null;
  return full;
}

export default function register(router, ctx) {
  const root = ctx.publicDir;
  router.fallback = async (req, res, rc) => {
    const rawPath = req.url.split('?')[0].split('#')[0]; // not URL-normalised, so %2e%2e stays visible
    const full = resolveStatic(root, rawPath);
    if (!full) throw new ApiError('NOT_FOUND');
    let real;
    let st;
    try {
      real = await fs.promises.realpath(full);
      const realRoot = await fs.promises.realpath(root);
      if (!real.startsWith(realRoot + path.sep)) throw new ApiError('NOT_FOUND');
      st = await fs.promises.stat(real);
    } catch (e) {
      if (e instanceof ApiError) throw e;
      throw new ApiError('NOT_FOUND');
    }
    if (!st.isFile()) throw new ApiError('NOT_FOUND');
    res.statusCode = 200;
    res.setHeader('Content-Type', TYPES[path.extname(real).toLowerCase()]);
    res.setHeader('Content-Length', st.size);
    res.setHeader('Cache-Control', 'no-cache');
    if (req.method === 'HEAD') return res.end();
    await new Promise((resolve) => {
      const rs = fs.createReadStream(real);
      rs.on('error', () => { res.destroy(); resolve(); });
      res.on('close', resolve);
      rs.pipe(res);
    });
    return undefined;
  };
}
