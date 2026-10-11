// The persistent banner (#banner): states what is not real, from GET /api/config labels (RS-34).
//   fake adapter active      -> "Simulated payments and/or AI — nothing here is real"
//   labels.testMode          -> "Test mode — local stubs, nothing is real" (in addition, SEC-3)
//   single-credential mode   -> "All demo suppliers are paid to one Sandbox account"
// labelsModel is the one place that turns the labels into view-models: the banner lines, which adapter is active
// (screens word their advice by it) and the badge of the payment adapter.

import { el, replaceContent } from '../dom.js';
import { EXACT } from '../texts.js';
import { adapterBadgeModels } from './badges.js';

// 'fake'          the simulated payment adapter
// 'sandbox'       the PayPal Sandbox adapter talking to PayPal's Sandbox
// 'sandbox-stub'  the Sandbox adapter in test mode: it talks to a local stub, so there is no dashboard behind it
// 'unknown'       no labels, or labels that name neither adapter: nothing is guessed
export function adapterOf(config) {
  const labels = config?.labels;
  if (!labels) return 'unknown';
  if (labels.sandbox === true) return labels.testMode === true ? 'sandbox-stub' : 'sandbox';
  if (labels.simulatedPayments === true) return 'fake';
  return 'unknown';
}

function bannerLines(config, configFailed) {
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

export function bannerModel(config, { configFailed = false } = {}) {
  return bannerLines(config, configFailed);
}

export function labelsModel(config, { configFailed = false } = {}) {
  const labels = config?.labels ?? null;
  return {
    banner: bannerLines(config, configFailed),
    adapter: adapterOf(config),
    paymentBadges: adapterBadgeModels(labels),
    testMode: labels?.testMode === true,
    singleCredential: labels?.merchantMode === 'single-credential',
    demoData: labels?.demoData === true,
    priceNotice: EXACT.PRICE_NOTICE,
  };
}

export function renderBanner(container, model) {
  replaceContent(container, model.map((m) => el('p', { class: `banner-item banner-${m.tone}`, testid: m.testid, text: m.text })));
}
