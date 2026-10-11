// Fixed labels and sentences the spec prescribes word for word (Frontend › Labels, States). They are constants, so
// the scan test can check that each one is present in the shipped assets.

export const EXACT = Object.freeze({
  // RS-34 labels
  BANNER_SIMULATED: 'Simulated payments and/or AI — nothing here is real',
  BANNER_TEST_MODE: 'Test mode — local stubs, nothing is real',
  SANDBOX_BADGE: 'PayPal Sandbox — no real money',
  SIMULATED_BADGE: 'Simulated',
  DEMO_BADGE: 'Demo data',
  PRICE_NOTICE: 'Test prices, not market prices',
  SINGLE_CREDENTIAL: 'All demo suppliers are paid to one Sandbox account',
  // states
  RESERVATION_EXPIRED: 'Reservation expired — no money was taken; re-plan with current stock',
  DEGRADED_EXTRACTION: 'Automatic reading unavailable — please enter the details',
  REPLANNING: 'Finding a new plan with current stock…',
  ORDER_NOT_PAID: 'Cancelled — payment did not complete',
  // recovery sentences (section 7, "If something fails"); the server sends the same words in nextStep.text / message
  REVIEW_NEW_PLAN: 'Review the new plan',
  REPLAN_WITH_CURRENT_STOCK: 'Re-plan with current stock',
  REPLAN_OR_OTHER_ACCOUNT: 'Re-plan or try another PayPal account',
  CONTACT_ORGANISER: 'Contact the organiser',
  ALL_REFUNDED: 'All payments were refunded by the organiser',
  PAYPAL_NOT_CONFIRMED: 'PayPal did not confirm the approval; try again',
  TIMEOUT: 'The server is taking too long.',
  LOADING: 'Loading…',
  // customer screens
  NO_REQUESTS: 'No rescue requests yet',
  START_REQUEST: 'Start a rescue request',
  PHOTO_WORDING: 'Text read from the photo',
  AI_ADDRESSED: 'This request contains text addressed to an AI; it was ignored.',
  NOT_YET_CONFIRMED: 'Not yet confirmed',
  RESERVATION_LIMIT: 'You already hold stock for another request — finish or abandon it first',
});

export const SECTION_TITLES = Object.freeze({
  need: 'What you need',
  why: 'Why this plan',
  rejected: 'What was rejected',
  total: 'Total',
  commitments: 'Supplier commitments',
  failure: 'If something fails',
  actions: 'Actions',
});

export const COLUMN_TITLES = Object.freeze({ catalog: 'Catalog offer', confirmed: 'Supplier confirmed' });

// "Prices changed: review plan v3". The server writes it into rescueStatus.message; this builds the same sentence.
export const pricesChangedText = (version) => `Prices changed: review plan v${version}`;

// nextStep.code -> the sentence, used only when the server sent no text for a code it named.
export const NEXT_STEP_FALLBACK = Object.freeze({
  REVIEW_NEW_PLAN: EXACT.REVIEW_NEW_PLAN,
  REPLAN: EXACT.REPLAN_WITH_CURRENT_STOCK,
  REPLAN_OR_OTHER_ACCOUNT: EXACT.REPLAN_OR_OTHER_ACCOUNT,
  CONTACT_ORGANISER: EXACT.CONTACT_ORGANISER,
  WAIT: 'Please wait: this page updates by itself',
});

// The server's text wins; the table above only fills a gap.
export function nextStepSentence(nextStep) {
  if (typeof nextStep?.text === 'string' && nextStep.text.length > 0) return nextStep.text;
  return Object.hasOwn(NEXT_STEP_FALLBACK, nextStep?.code) ? NEXT_STEP_FALLBACK[nextStep.code] : '';
}
