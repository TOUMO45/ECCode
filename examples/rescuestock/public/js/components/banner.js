// The persistent banner (#banner): states what is not real, from GET /api/config labels (RS-34).
//   fake adapter active      -> "Simulated payments and/or AI — nothing here is real"
//   labels.testMode          -> "Test mode — local stubs, nothing is real" (in addition, SEC-3)
//   single-credential mode   -> "All demo suppliers are paid to one Sandbox account"

import { el, replaceContent } from '../dom.js';
import { EXACT } from '../texts.js';

export function bannerModel(config, { configFailed = false } = {}) {
  const items = [];
  const labels = config?.labels;
  if (!labels) {
    if (configFailed) {
      items.push({ testid: 'banner-config-error', tone: 'warn', text: 'The demo labels could not be loaded. Reload the page before you trust any figure on it.' });
    }
    return items;
  }
  if (labels.simulatedPayments === true || labels.simulatedExtraction === true) {
    items.push({ testid: 'banner-simulated', tone: 'warn', text: EXACT.BANNER_SIMULATED });
  }
  if (labels.testMode === true) items.push({ testid: 'banner-test-mode', tone: 'warn', text: EXACT.BANNER_TEST_MODE });
  if (labels.merchantMode === 'single-credential') items.push({ testid: 'banner-single-credential', tone: 'info', text: EXACT.SINGLE_CREDENTIAL });
  return items;
}

export function renderBanner(container, model) {
  replaceContent(container, model.map((m) => el('p', { class: `banner-item banner-${m.tone}`, testid: m.testid, text: m.text })));
}
