// GET /api/config: labels and provider names. Contains no secret, client id or merchant id.
import { buildLabels } from '../config.js';

export function register(router, { config }) {
  router.add(
    'GET',
    '/api/config',
    () => ({
      status: 200,
      body: {
        labels: buildLabels(config),
        extractionProvider: config.extractionProvider,
        paymentProvider: config.paymentProvider,
        signupEnabled: config.allowSignup,
        reservationTtlMin: config.reservationTtlMin,
      },
    }),
    { policy: 'public' },
  );
}
