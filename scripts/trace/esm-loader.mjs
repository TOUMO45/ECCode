// Runtime ESM import tracer. Registered by esm-register.mjs: every in-project
// ESM resolution — static `import` statements and dynamic import(), including
// specifiers built from variables — is appended as a from→to edge to
// ECCODE_TRACE_FILE. Runs on Node's loader thread; env is shared with the
// traced process.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const out = process.env.ECCODE_TRACE_FILE;
const root = process.env.ECCODE_TRACE_ROOT;
const win = process.platform === 'win32';
const roots = [root, process.env.ECCODE_TRACE_ROOT_ALT].filter(Boolean);
function rel(file) {
  for (const r of roots) {
    if ((win ? file.toLowerCase() : file).startsWith(win ? r.toLowerCase() : r)) return file.slice(r.length).split(path.sep).join('/');
  }
  return null;
}

export async function resolve(specifier, context, nextResolve) {
  const result = await nextResolve(specifier, context);
  try {
    if (out && root && context.parentURL && context.parentURL.startsWith('file:') &&
        result.url && result.url.startsWith('file:')) {
      const fromFile = fileURLToPath(context.parentURL);
      const toFile = fileURLToPath(result.url);
      const from = rel(fromFile);
      const to = rel(toFile);
      if (from && to && !toFile.includes(`${path.sep}node_modules${path.sep}`)) {
        fs.appendFileSync(out, JSON.stringify({ from, to }) + '\n');
      }
    }
  } catch { /* tracing must never break the traced program */ }
  return result;
}
