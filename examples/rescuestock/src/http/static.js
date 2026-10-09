// Static file handler confined to one directory (public/).
// A request path is decoded, checked for NUL, backslash, dot-segments and
// dotfiles, joined to the root, then resolved with realpath. The real path
// must still lie inside the real root, so symlinks cannot lead out. Only
// regular files are served. Assets are sent with Cache-Control: no-cache + ETag.
import { createReadStream } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { sep, join, extname } from 'node:path';
import { createHash } from 'node:crypto';

const TYPES = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.woff2': 'font/woff2',
});

// Returns the absolute path inside root for a request pathname, or null.
export async function resolveInside(rootReal, pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (decoded.includes('\u0000') || decoded.includes('\\')) return null;
  const parts = decoded.split('/').filter((p) => p.length > 0);
  for (const part of parts) {
    if (part === '.' || part === '..' || part.startsWith('.')) return null;
  }
  let candidate = join(rootReal, ...parts);
  let real;
  try {
    real = await realpath(candidate);
    const info = await stat(real);
    if (info.isDirectory()) {
      candidate = join(real, 'index.html');
      real = await realpath(candidate);
    }
  } catch {
    return null;
  }
  if (real !== rootReal && !real.startsWith(rootReal + sep)) return null;
  return real;
}

// createStaticHandler({root}) -> async (req, res, pathname) => boolean (true when it answered).
export function createStaticHandler({ root, extraHeaders = () => ({}) }) {
  let cached = null;
  const rootReal = async () => {
    if (cached) return cached;
    try {
      cached = await realpath(root);
    } catch {
      return null; // not built yet; try again on the next request
    }
    return cached;
  };

  return async function serveStatic(req, res, pathname) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return false;
    const base = await rootReal();
    if (!base) return false;
    const file = await resolveInside(base, pathname);
    if (!file) return false;
    let info;
    try {
      info = await stat(file);
    } catch {
      return false;
    }
    if (!info.isFile()) return false;

    const etag = `"${createHash('sha1').update(`${info.size}:${info.mtimeMs}`).digest('hex').slice(0, 20)}"`;
    for (const [name, value] of Object.entries(extraHeaders())) res.setHeader(name, value);
    res.setHeader('Content-Type', TYPES[extname(file).toLowerCase()] || 'application/octet-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('ETag', etag);
    if (req.headers['if-none-match'] === etag) {
      res.statusCode = 304;
      res.end();
      return true;
    }
    res.statusCode = 200;
    res.setHeader('Content-Length', info.size);
    if (req.method === 'HEAD') {
      res.end();
      return true;
    }
    await new Promise((resolve) => {
      const stream = createReadStream(file);
      stream.on('error', () => {
        res.destroy();
        resolve();
      });
      res.on('close', resolve);
      stream.pipe(res);
    });
    return true;
  };
}
