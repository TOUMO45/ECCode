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

export async function resolve(specifier, context, nextResolve) {
  const result = await nextResolve(specifier, context);
  try {
    if (out && root && context.parentURL && context.parentURL.startsWith('file:') &&
        result.url && result.url.startsWith('file:')) {
      const from = fileURLToPath(context.parentURL);
      const to = fileURLToPath(result.url);
      if (from.startsWith(root) && to.startsWith(root) && !to.includes(`${path.sep}node_modules${path.sep}`)) {
        fs.appendFileSync(out, JSON.stringify({
          from: path.relative(root, from).split(path.sep).join('/'),
          to: path.relative(root, to).split(path.sep).join('/'),
        }) + '\n');
      }
    }
  } catch { /* tracing must never break the traced program */ }
  return result;
}
