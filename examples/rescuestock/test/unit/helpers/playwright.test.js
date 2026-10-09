// NFR1 / NFR3: playwright.js only resolves the library (local devDependency first, global second).
// No browser is launched here: npm test must not start one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { globalModuleDirs, launchChromium, resolvePlaywright } from '../../helpers/playwright.js';

const fakeLib = { chromium: { launch: async () => ({ fake: true }) } };

test('NFR3: the local @playwright/test is used first', async () => {
  const asked = [];
  const found = await resolvePlaywright({
    importLocal: async (name) => {
      asked.push(name);
      return fakeLib;
    },
    dirs: ['/nonexistent'],
  });
  assert.deepEqual(asked, ['@playwright/test']);
  assert.equal(found.source, 'local');
  assert.equal(found.chromium, fakeLib.chromium);
});

test('NFR3: a missing local package falls back to a global install', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rs-pw-'));
  try {
    const pkgDir = join(root, 'playwright');
    mkdirSync(pkgDir, { recursive: true });
    writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ name: 'playwright', version: '0.0.0', main: 'index.js' }));
    writeFileSync(join(pkgDir, 'index.js'), 'exports.chromium = { launch() {} };\n');
    const found = await resolvePlaywright({
      importLocal: async () => {
        throw Object.assign(new Error('Cannot find package'), { code: 'ERR_MODULE_NOT_FOUND' });
      },
      dirs: ['/nonexistent', root],
    });
    assert.equal(found.source, 'global');
    assert.equal(found.name, 'playwright');
    assert.equal(typeof found.chromium.launch, 'function');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('NFR3: when neither place has it, the error says how to install and what was tried', async () => {
  await assert.rejects(
    () =>
      resolvePlaywright({
        importLocal: async () => {
          throw Object.assign(new Error('nope'), { code: 'ERR_MODULE_NOT_FOUND' });
        },
        dirs: ['/nonexistent'],
      }),
    (err) => /npm install/.test(err.message) && /local @playwright\/test: ERR_MODULE_NOT_FOUND/.test(err.message),
  );
});

test('NFR3: globalModuleDirs lists the configured directories and the node prefix, without duplicates', () => {
  const dirs = globalModuleDirs({ env: { RS_GLOBAL_NODE_MODULES: '/a:/b', NODE_PATH: '/b:/c' }, execPath: '/opt/node22/bin/node' });
  assert.deepEqual(dirs, ['/a', '/b', '/c', '/opt/node22/lib/node_modules']);
});

test('NFR3: launchChromium turns a launch failure into a message with the install hint (launch is stubbed)', async () => {
  const stub = async () => ({
    chromium: {
      launch: async () => {
        throw new Error("Executable doesn't exist at /x\nmore detail");
      },
    },
  });
  await assert.rejects(
    () => launchChromium({}, stub),
    (err) => /npx playwright install chromium/.test(err.message) && !/more detail/.test(err.message),
  );
  assert.deepEqual(await launchChromium({}, async () => fakeLib), { fake: true });
});

test('NFR3: the real library can be resolved on this machine (library load only; skipped when it is not installed)', async (t) => {
  let found;
  try {
    found = await resolvePlaywright();
  } catch (err) {
    t.skip(`Playwright is not installed here: ${err.message.split('.')[0]}`);
    return;
  }
  assert.equal(typeof found.chromium.launch, 'function');
  assert.match(found.source, /^(local|global)$/);
});
