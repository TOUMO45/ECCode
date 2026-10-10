// Screenshots go to test/browser/out/<test>-<width>.png (git-ignored).
import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SCREENSHOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'out');

export function screenshotPath(testName, width) {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(testName)) throw new Error(`screenshot name "${testName}" must be lowercase letters, digits and dashes`);
  return join(SCREENSHOT_DIR, `${testName}-${width}.png`);
}

// Full-page screenshot. Returns the path.
export async function takeScreenshot(page, testName, width) {
  const path = screenshotPath(testName, width);
  mkdirSync(SCREENSHOT_DIR, { recursive: true });
  await page.screenshot({ path, fullPage: true });
  return path;
}
