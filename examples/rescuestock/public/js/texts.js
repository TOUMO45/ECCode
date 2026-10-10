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
  TIMEOUT: 'The server is taking too long.',
  LOADING: 'Loading…',
  // customer screens
  NO_REQUESTS: 'No rescue requests yet',
  START_REQUEST: 'Start a rescue request',
  PHOTO_WORDING: 'Text read from the photo',
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
