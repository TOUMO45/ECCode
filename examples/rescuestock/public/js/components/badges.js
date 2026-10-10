// Labels for everything that is not real (RS-34): the Demo data badge on seeded suppliers, offers and prices,
// the Simulated and Sandbox badges on payment and extraction elements, and text status pills. A badge always
// carries its meaning in words; colour only reinforces it.

import { el } from '../dom.js';
import { EXACT } from '../texts.js';

export function demoBadge() {
  return el('span', { class: 'badge badge-demo', testid: 'badge-demo', text: EXACT.DEMO_BADGE });
}

// Payment { provider, simulated, sandbox } -> [{ text, testid }]
export function providerBadgeModels(payment) {
  const out = [];
  if (payment?.simulated === true) out.push({ text: EXACT.SIMULATED_BADGE, testid: 'badge-simulated' });
  if (payment?.sandbox === true) out.push({ text: EXACT.SANDBOX_BADGE, testid: 'badge-sandbox' });
  if (out.length === 0 && typeof payment?.provider === 'string') out.push({ text: `Provider: ${payment.provider}`, testid: 'badge-provider' });
  return out;
}

// Extraction { simulated } -> badge models (the AI reading is simulated when a fake provider is active).
export function extractionBadgeModels(extraction) {
  return extraction?.simulated === true ? [{ text: EXACT.SIMULATED_BADGE, testid: 'badge-simulated' }] : [];
}

export function badgeNodes(models) {
  return models.map((m) => el('span', { class: 'badge badge-provider', testid: m.testid, text: m.text }));
}

// A status pill: the text states the status; `tone` only adds a border and a symbol-free background.
export function pill(text, tone = 'neutral', testid = null) {
  return el('span', { class: `pill pill-${tone}`, testid, text });
}

// Tone for a rescue status, used only to style the pill; the text is the status itself.
export function toneForStatus(status) {
  switch (status) {
    case 'failed_needs_attention':
    case 'cancelled':
    case 'no_feasible_plan':
    case 'cancelling':
    case 'refunding':
      return 'warn';
    case 'purchase_confirmed':
    case 'ready_for_pickup':
    case 'collected':
    case 'payment_authorized':
      return 'ok';
    default:
      return 'info';
  }
}
