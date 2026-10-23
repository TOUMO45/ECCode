// Registers the ESM import tracer where Node supports module.register
// (>= 18.19 / >= 20.6). Loaded via NODE_OPTIONS=--import by
// `eccode impact --trace`; on a Node without module.register this is a
// silent no-op rather than a failure of the traced command.
import * as mod from 'node:module';

if (typeof mod.register === 'function') {
  try {
    mod.register(new URL('./esm-loader.mjs', import.meta.url));
  } catch { /* tracing must never break the traced program */ }
}
