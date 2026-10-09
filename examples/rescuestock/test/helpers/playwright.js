// Resolves the Playwright library for test/browser (npm run test:browser).
// Order: the local devDependency `@playwright/test`, then a global install
// (`@playwright/test` or `playwright` in the global node_modules). It never
// launches a browser by itself: resolvePlaywright() only loads the library, and
// npm test does not import this module's launchChromium().
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, delimiter, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const LOCAL_NAME = '@playwright/test';
const GLOBAL_NAMES = ['@playwright/test', 'playwright'];

// Directories that may hold global node_modules: RS_GLOBAL_NODE_MODULES, NODE_PATH, <node prefix>/lib/node_modules.
export function globalModuleDirs({ env = process.env, execPath = process.execPath } = {}) {
  const dirs = [];
  if (env.RS_GLOBAL_NODE_MODULES) dirs.push(...env.RS_GLOBAL_NODE_MODULES.split(delimiter));
  if (env.NODE_PATH) dirs.push(...env.NODE_PATH.split(delimiter));
  dirs.push(join(dirname(dirname(execPath)), 'lib', 'node_modules'));
  return [...new Set(dirs.filter(Boolean))];
}

async function importFrom(dir, name) {
  const packageDir = join(dir, name);
  if (!existsSync(join(packageDir, 'package.json'))) return null;
  const resolved = createRequire(join(dir, 'noop.js')).resolve(name);
  return import(pathToFileURL(resolved).href);
}

// resolvePlaywright({ importLocal, dirs }) -> { source: 'local' | 'global', name, chromium, module }
// Both arguments are injectable for tests. Throws one Error naming both places that were tried.
export async function resolvePlaywright({ importLocal = (name) => import(name), dirs = globalModuleDirs() } = {}) {
  const tried = [];
  try {
    const mod = await importLocal(LOCAL_NAME);
    return describe('local', LOCAL_NAME, mod);
  } catch (err) {
    tried.push(`local ${LOCAL_NAME}: ${err && err.code ? err.code : err && err.message}`);
  }
  for (const dir of dirs) {
    for (const name of GLOBAL_NAMES) {
      try {
        const mod = await importFrom(dir, name);
        if (mod) return describe('global', name, mod);
      } catch (err) {
        tried.push(`global ${name} in ${dir}: ${err && err.message}`);
      }
    }
  }
  throw new Error(
    `Playwright is not installed. Run "npm install" for the local devDependency ${LOCAL_NAME}, or install it globally. Tried: ${tried.join('; ') || 'nothing'}.`,
  );
}

function describe(source, name, mod) {
  const chromium = mod.chromium ?? mod.default?.chromium;
  if (!chromium) throw new Error(`${name} (${source}) does not export chromium`);
  return { source, name, chromium, module: mod };
}

// For test/browser files only. Fails with a readable message if Chromium cannot launch
// (the README documents "npx playwright install chromium").
export async function launchChromium(options = {}, resolver = resolvePlaywright) {
  const { chromium } = await resolver();
  try {
    return await chromium.launch(options);
  } catch (err) {
    throw new Error(`Chromium could not be launched (${err && err.message ? err.message.split('\n')[0] : err}). Run "npx playwright install chromium" once.`);
  }
}
