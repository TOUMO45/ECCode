// A2's frontend ground truth (ours, not Mealie's): added to vitest's setup
// files by a wrapper config, it appends one JSON line per spec file with the
// modules vitest's module runner evaluated for it. Mealie's own coverage
// provider cannot run at the pin (vitest 4 with @vitest/coverage-v8 3).
import { afterAll } from 'vitest';
import fs from 'node:fs';

afterAll(() => {
  const state = globalThis.__vitest_worker__;
  const modules = state && state.evaluatedModules && state.evaluatedModules.fileToModulesMap;
  fs.appendFileSync(process.env.ECCODE_A2_LOADED, `${JSON.stringify(modules ? [...modules.keys()] : null)}\n`);
});
