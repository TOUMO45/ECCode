// Browser harness for test/browser/*.test.js (npm run test:browser).
//
// Every test file calls startBrowserHarness() once, in before(), and close() in after():
//   - a new server process through test/helpers/server-proc.js on a new temp database seeded with RS-FIX-1,
//     never shared with another file (spec: Testing Strategy, F-TR-15);
//   - RS_PUBLIC_URL=http://localhost:<port> (the app origin), RS_TEST_OFFLINE=1, and the three limits the spec pins:
//     RS_REGISTER_PER_IP_PER_HOUR=1000, RS_MAX_REQUESTS_PER_CUSTOMER_PER_DAY=1000, RS_MAX_LIVE_RESERVATIONS_PER_CUSTOMER=1;
//   - Chromium through test/helpers/playwright.js (local @playwright/test first, then the global install). When
//     Chromium cannot launch, startBrowserHarness() throws, so the file FAILS; nothing here skips.
// Each journey gets its own context and page (newJourney) and signs up its own customer (signup.js).
import { openReadOnlyDb } from './db.js';
import { launchChromium } from '../../helpers/playwright.js';
import { startServer, upcomingDemoDate } from '../../helpers/server-proc.js';

export const BROWSER_ENV = Object.freeze({
  RS_TEST_OFFLINE: '1',
  RS_REGISTER_PER_IP_PER_HOUR: '1000',
  RS_MAX_REQUESTS_PER_CUSTOMER_PER_DAY: '1000',
  RS_MAX_LIVE_RESERVATIONS_PER_CUSTOMER: '1',
});

export const VIEWPORTS = Object.freeze([
  Object.freeze({ width: 360, height: 800 }),
  Object.freeze({ width: 1280, height: 800 }),
]);

// Chromium refuses to start as root without --no-sandbox (containers); a normal user keeps the sandbox.
function launchArgs() {
  return typeof process.getuid === 'function' && process.getuid() === 0 ? ['--no-sandbox'] : [];
}

export async function startBrowserHarness({ env = {} } = {}) {
  const demoDate = upcomingDemoDate();
  const server = await startServer({
    seed: true,
    publicUrlOnLocalhost: true,
    env: { ...BROWSER_ENV, RS_DEMO_DATE: demoDate, ...env },
  });
  let browser;
  try {
    browser = await launchChromium({ args: launchArgs() });
  } catch (err) {
    await server.cleanup();
    throw err;
  }
  const publicUrl = server.env.RS_PUBLIC_URL;
  const contexts = [];

  return {
    server,
    browser,
    publicUrl,
    demoDate,
    browserVersion: browser.version(),
    // A new context and page at the given viewport, with the browser problems of the journey collected:
    // console errors (CSP violations included), uncaught page errors and failed requests to the app origin.
    async newJourney({ width, height }) {
      const context = await browser.newContext({ viewport: { width, height }, baseURL: publicUrl });
      contexts.push(context);
      const page = await context.newPage();
      const problems = [];
      page.on('console', (message) => {
        if (message.type() === 'error' || /Content Security Policy/i.test(message.text())) problems.push(`console ${message.type()}: ${message.text()}`);
      });
      page.on('pageerror', (err) => problems.push(`page error: ${err.message}`));
      page.on('response', (response) => {
        if (response.status() >= 400) problems.push(`HTTP ${response.status()}: ${response.request().method()} ${response.url()}`);
      });
      page.on('requestfailed',(request) => problems.push(`request failed: ${request.url()} ${request.failure()?.errorText ?? ''}`));
      return { context, page, width, height, problems };
    },
    // A read-only connection to the server's database file, closed by the caller.
    openDb: () => openReadOnlyDb(server.dbPath),
    async close() {
      for (const context of contexts) {
        try {
          await context.close();
        } catch {
          // Already closed with the browser.
        }
      }
      try {
        await browser.close();
      } finally {
        await server.cleanup();
      }
    },
  };
}
