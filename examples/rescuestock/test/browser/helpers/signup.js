// Signs up a fresh customer through the UI (#/register), the way a journey starts (F-TR-15: a fresh customer per
// journey, so the per-customer limits cannot be used up by earlier journeys).
import { randomBytes } from 'node:crypto';

// Not a secret: a throw-away password for a customer of a temp test database.
export const JOURNEY_PASSWORD = 'journey-test-password-1';

export function freshUsername(prefix = 'journey') {
  return `${prefix}-${randomBytes(4).toString('hex')}`;
}

// Returns { username, password, displayName }. Resolves when the signed-in session shows in the header.
export async function signUpFreshCustomer(page, publicUrl, { prefix = 'journey', displayName = 'Journey Cafe' } = {}) {
  const username = freshUsername(prefix);
  await page.goto(`${publicUrl}/#/register`);
  await page.waitForSelector('[data-testid="register-form"]');
  await page.fill('#register-username', username);
  await page.fill('#register-display-name', displayName);
  await page.fill('#register-password', JOURNEY_PASSWORD);
  await page.click('[data-testid="register-submit"]');
  await page.waitForSelector('[data-testid="session-user"]');
  return { username, password: JOURNEY_PASSWORD, displayName };
}
