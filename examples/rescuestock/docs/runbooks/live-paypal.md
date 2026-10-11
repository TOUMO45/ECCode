# Runbook: live PayPal Sandbox run (LIVE-P1, LIVE-P2, OQ-D5)

**Status: NOT VERIFIED.** The PayPal Sandbox adapter has only ever talked to a local loopback stub and to the built-in fake. Nothing in this build has contacted PayPal. Real PayPal response shapes, status sets and signature checks are unconfirmed (the open facts are listed under "What the live run settles"). This runbook is how you, the project owner, run the opt-in live checks. It needs your Sandbox credentials, a network allow-list and, for some checks, a person approving at PayPal's page.

**Sandbox only, no real money.** The application accepts only `https://api-m.sandbox.paypal.com`. Use Sandbox credentials and a Sandbox buyer account. Real PayPal credentials must never be used here. Before you type a password on any PayPal page, check that the address bar says `www.sandbox.paypal.com`.

## 1. Prepare the PayPal Sandbox

In the PayPal developer dashboard, in Sandbox mode (the dashboard's wording may differ from this list; use PayPal's own documentation to confirm each step):

1. Create or reuse a **Sandbox business account** for the merchant. For a per-supplier setup, create one per demo supplier, A to E. One is enough for single-credential mode.
2. Create a **Sandbox REST app** under each business account and note its client id and client secret.
3. Create a **Sandbox personal (buyer) account**. This is the account a person logs in with at PayPal's approval page.
4. Create a **webhook** for each app and note its webhook id. The live launcher requires a webhook id with every credential set. PayPal asks for a URL when you create a webhook; the live checks do not need PayPal to reach your machine, except for the optional RS-23 check (section 5).
5. Subscribe the webhook to **the seven mapped event types only**: `PAYMENT.AUTHORIZATION.CREATED`, `PAYMENT.AUTHORIZATION.VOIDED`, `PAYMENT.CAPTURE.COMPLETED`, `PAYMENT.CAPTURE.PENDING`, `PAYMENT.CAPTURE.DENIED`, `PAYMENT.CAPTURE.REFUNDED` and `CHECKOUT.ORDER.APPROVED`. The webhook route answers any other event type with 400 (`EVENT_TYPE_NOT_MAPPED`) and stores it as an invalid row, so subscribing to more only creates noise. These event names come from secondary sources and are themselves unverified (OQ-D5).

## 2. Network allow-list

Allow outbound HTTPS (443) to exactly these two hosts, and nothing else for this purpose:

- `api-m.sandbox.paypal.com` (the REST API)
- `www.sandbox.paypal.com` (the buyer approval page, for the browser journeys)

In this build's cloud session, those hosts were blocked by the organisation's egress policy; the run cannot happen from there until you add them.

## 3. Provide the credentials as environment secrets

Merchant modes:

- **Single-credential mode.** One set under the name `DEFAULT`: `RS_PAYPAL_DEFAULT_CLIENT_ID`, `RS_PAYPAL_DEFAULT_CLIENT_SECRET`, `RS_PAYPAL_DEFAULT_WEBHOOK_ID`. Every demo supplier is paid to that one Sandbox account, and the interface says so ("All demo suppliers are paid to one Sandbox account"). Evidence from this mode is weaker for RS-19, RS-20, RS-23 and RS-24, because a wrong-merchant mix-up cannot show (RISK-18).
- **Per-supplier mode.** The same three variables for each of the suppliers A, B, C, D and E (`RS_PAYPAL_A_CLIENT_ID` and so on). It is chosen only if all five sets are complete; otherwise a complete `DEFAULT` set is used. A client id and secret must be set together.

How to set them:

- **Preferred:** your platform's environment secrets (the hosted session's secret store), which inject the variables into the process without showing them.
- **In your own terminal:** use a hidden prompt, for each variable:

  ```sh
  printf 'Sandbox client id: '; stty -echo; read RS_PAYPAL_DEFAULT_CLIENT_ID; stty echo; printf '\n'
  printf 'Sandbox client secret: '; stty -echo; read RS_PAYPAL_DEFAULT_CLIENT_SECRET; stty echo; printf '\n'
  printf 'Sandbox webhook id: '; stty -echo; read RS_PAYPAL_DEFAULT_WEBHOOK_ID; stty echo; printf '\n'
  export RS_PAYPAL_DEFAULT_CLIENT_ID RS_PAYPAL_DEFAULT_CLIENT_SECRET RS_PAYPAL_DEFAULT_WEBHOOK_ID
  ```

- **Never** paste them into a chat, an issue, a commit, a screenshot or a command line. A command line lands in your shell history and in the process list. Do not commit a `.env` that holds them (`.env` is git-ignored; keep it that way).
- The suite reads them from the environment, hands them to the server child process and to the Sandbox calls, and never prints, logs or reports them. Unset them when you are done: `unset RS_PAYPAL_DEFAULT_CLIENT_ID RS_PAYPAL_DEFAULT_CLIENT_SECRET RS_PAYPAL_DEFAULT_WEBHOOK_ID`.
- If a secret was ever exposed, rotate it in the PayPal dashboard.

## 4. Run the automated live checks

Prerequisites: `npm install`, Node 22.13 or newer, the credentials exported, the allow-list in place.

```sh
RS_LIVE_PAYPAL=1 npm run test:live-paypal
```

Each file starts its own application on a free local port with a fresh database and the Sandbox provider. What each does:

| File | Check | Human step |
|---|---|---|
| `rs18-cancel-abandon.test.js` | RS-18: a cancelled approval leaves the order approvable, "Try approval again" gives the same link and no second order, "Abandon purchase" ends the plan with no authorization | none |
| `rs19-amount.test.js` | RS-19: the amount at PayPal equals the server's order total, in USD, with the expected reference and invoice ids | none |
| `rs20-double-capture.test.js` | RS-20: three concurrent returns give one authorization per order; five concurrent execute calls capture once; a second capture with a different request id is refused by PayPal | **You approve both orders** at the printed links with the Sandbox buyer account, within 10 minutes |
| `rs23-webhook-duplicate.test.js` | RS-23: a genuine signed delivery replayed twice is applied once | Needs a sample (section 5); otherwise reported **skipped**, never passed |
| `rs24-webhook-signature.test.js` | RS-24: a forged signature is refused by asking PayPal's verify endpoint, 400 `WEBHOOK_SIGNATURE_INVALID`; an event without headers is refused before any PayPal call | none |
| `journey-sandbox.test.js` | RS-31(b) and RS-32(b), see section 6 | **You approve at PayPal** |

Exit codes. Each live file refuses by itself with exit 2 and a named message on stderr when the conditions are not met (no `RS_LIVE_PAYPAL=1`, missing credentials, offline test mode); the npm script as a whole then exits 1, because `node --test` reports a failed child as 1. For one clean exit code 2 on a refusal, use the optional launcher, which runs the same files one at a time:

```sh
RS_LIVE_PAYPAL=1 node test/live/paypal/run-live-paypal.js
```

(Pass a file path as an argument to run only that file.) Reports are written to `reports/live-paypal-<suite>-<UTC>.json` with the suite, the provider (`paypal-sandbox`), the merchant mode and each check as passed, failed or skipped with its reason. They contain no credentials.

## 5. Optional: a genuine webhook delivery (RS-23)

The Sandbox simulator's events do not verify, so RS-23 needs one real delivery signed by PayPal.

1. Make PayPal deliver one event of a subscribed type to a URL you can read (for example look at the delivery log in the developer dashboard, or a tunnel to a scratch endpoint you control).
2. Save its five `paypal-*` headers and the exact body text as a JSON file: `{"merchantKey":"DEFAULT","headers":{"paypal-transmission-id":"...","paypal-transmission-time":"...","paypal-transmission-sig":"...","paypal-cert-url":"...","paypal-auth-algo":"..."},"body":"<raw text>"}`. Use the merchant key that matches the app (`DEFAULT`, or `A` to `E`).
3. Within 15 minutes of the delivery (the application refuses an older transmission time), run:

   ```sh
   RS_LIVE_PAYPAL=1 RS_LIVE_PAYPAL_WEBHOOK_SAMPLE=/path/to/sample.json npm run test:live-paypal
   ```

If PayPal's auth algorithm is not `SHA256withRSA`, the route rejects it by default; add it to the comma-separated allow-list `RS_PAYPAL_WEBHOOK_ALGOS` for the run. Treat the sample file as sensitive: it is real event data.

To receive webhooks in the running application (rather than the file replay), the webhook URL is `https://<your-public-host>/api/webhooks/paypal/<KEY>`, with KEY one of `A` to `E` or `DEFAULT`. A public HTTPS URL is optional: polling is the primary path and works without one.

## 6. The two Sandbox browser journeys (RS-31(b) and RS-32(b))

Both need a person at PayPal's approval page. Run them on your own machine, not in a hosted session without a display.

- **RS-31(b), the full journey in a visible browser.** Once per machine: `npx playwright install chromium`. Then:

  ```sh
  RS_LIVE_PAYPAL=1 RS_LIVE_PAYPAL_HEADED=1 node test/live/paypal/run-live-paypal.js test/live/paypal/journey-sandbox.test.js
  ```

  The test signs up a fresh customer, makes a request, approves the plan and reserves the stock; the suppliers confirm through the API; then it clicks "Approve with PayPal" for supplier A and for supplier B. At each, **you log in at PayPal Sandbox with the Sandbox buyer account and approve** (10 minutes each). The test then checks that the browser returned to the application with the session, and that the purchase completed with captured Sandbox payments. Without `RS_LIVE_PAYPAL_HEADED=1` this check is reported as skipped, never as passed.
- **RS-32(b), the replacement path.** It runs in the same file. It prints the approval links of both orders; you approve both with the buyer account. The test then triggers the organiser's stock-depletion fault for supplier B, and checks that PayPal shows both authorizations VOIDED and the old plan non-executable. It does **not** exercise approval of the replacement plan in the browser (the build's browser test covers that against the fake only).
- **For a demo video.** The video must show PayPal's hosted Sandbox approval page, run by you. Run the application yourself against the Sandbox (below), approve with the buyer account, and label the video as a Sandbox demonstration.

### Running the application itself against the Sandbox

With the credentials exported as in section 3, in a shell where `RS_ADMIN_PASSWORD` is also set through a hidden prompt:

```sh
npm run seed
RS_PAYMENT_PROVIDER=paypal-sandbox npm start
```

The seed prints the demo passwords once (or set `RS_DEMO_PASSWORD` for a private single-operator demo). Open http://127.0.0.1:3000 or http://localhost:3000 (`RS_PUBLIC_URL` defaults to `http://localhost:<PORT>`, which is what PayPal's return redirect uses; use that address in the browser). The page badges say the provider is the PayPal Sandbox. Read the retake advice in the README before recording: one live reservation per account at a time, "Abandon purchase" between takes.

## What the live run settles, and what it does not

LIVE-P1 (the automated files above) and LIVE-P2 (the browser journeys) would settle these open facts (OQ-D5), which today rest on the fake's and the stub's model of PayPal: the approval link relation; the authorization status set including EXPIRED; `final_capture` refusing a second capture; `PayPal-Request-Id` replay semantics and retention; capture and refund ids being findable through `GET /v2/checkout/orders/{id}`; and the webhook event names.

**Not covered by any live file, still unverified after a clean LIVE-P1/P2 run:**

- authorization DENIED or PENDING (RS-21);
- a void after a capture (F-TR-6);
- `PayPal-Request-Id` retention across a process takeover;
- capture PENDING or DECLINED;
- refund PENDING or FAILED;
- the EXPIRED read after a refused void;
- RS-22 (partial capture failure with compensation) and RS-25/RS-26 on the Sandbox: they rest on the fake's model of PayPal;
- cross-merchant signature rejection: whether a webhook signed for one merchant is refused when delivered under another merchant key. The fake's signing string does not include the merchant key, so the automated suites cannot show it; RS-24's live check uses one forged signature only.

If a live check fails, report it exactly as it printed. A failure is a finding about the integration, not a reason to loosen the check.

## Cleaning up after a run

Sandbox orders and authorizations stay in the Sandbox until they expire or are voided. After a forced demo reset, finish any payments the reset lists as stranded in the PayPal Sandbox dashboard by hand. The live suites use a throwaway database and need no cleanup of ours; delete `reports/` files you no longer want.
