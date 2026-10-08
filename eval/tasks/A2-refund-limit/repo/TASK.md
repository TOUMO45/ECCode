# Bug: valid refunds are rejected and refunded amounts look corrupted

**Reported by:** support (ticket PAY-88)

1. A customer paid `100.00` (payment 1). Support tried to refund `90.00` and got `422 Refund exceeds the refundable amount`. Refunding `10.00` worked.
2. `GET /api/payments/3` shows `"refunded": "020.005.50"`.

Refunds must be allowed up to the refundable amount and no further. Partial refunds add up.

**Acceptance**
- A refund is accepted when it is no more than the remaining refundable amount, exact to the cent, and rejected otherwise. Keep the current error format for rejections.
- `refunded` and `refundable` are correct on the payment endpoint.
- Existing behaviour that is not broken stays as it is (`npm test` passes).
