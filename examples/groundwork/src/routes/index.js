// Auto-registers every other src/routes/*.js. Each module default-exports
// `register(router, ctx)`; later tasks add files here without editing app.js.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));

export async function registerRoutes(router, ctx) {
  const files = fs.readdirSync(DIR).filter((f) => f.endsWith('.js') && f !== 'index.js').sort();
  for (const f of files) {
    const mod = await import(pathToFileURL(path.join(DIR, f)).href);
    if (typeof mod.default !== 'function') throw new TypeError(`routes/${f} must default-export register(router, ctx)`);
    await mod.default(router, ctx);
  }
  return files;
}
