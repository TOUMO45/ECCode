# Project description (DRAFT, not submitted)

Written in my voice for me to edit. Nothing here has been submitted. Hackathon facts are unverified against the primary source; re-check at https://paypalaihackathon.devpost.com/rules before submitting (see [checklist.md](checklist.md)). Lines marked **Update after live runs** must be revised once I have run the live runbooks, and until then they stay as written.

## Title

RescueStock

## One-line pitch

A cafe runs out of cups or lids mid-service; RescueStock finds the cheapest matching supply across nearby suppliers, explains its choice, and only takes payment once every supplier has confirmed.

## The problem

A small cafe can lose an order or a day's trade because cups or lids run out, or a supplier cancels. The owner needs cups and lids that actually match (a 95 mm lid is no use on a 90 mm cup), within a budget, before a deadline, from pickup points they can reach. Today that means phone calls and guesses.

## What it does

- The cafe types the problem in English or Arabic, optionally with a photo of a package label.
- RescueStock turns it into structured requirements, shows where each value came from, and asks about anything unclear instead of guessing. The cafe confirms the fields.
- A planner computes the cheapest feasible purchase across the participating (demonstration) suppliers, and explains why it chose them and why it rejected the others (for example, "lids do not fit" or "ready after the deadline").
- The cafe approves the plan; the stock is reserved; each supplier confirms; payment is authorized at every supplier and captured only when every condition holds.
- If part of it fails, authorizations are voided or refunded and the screen says what happens next. If a supplier drops out, the cafe reviews and approves a replacement plan.

On the seeded test fixture (200 cups and 200 lids, 250 ml, deadline 11:00, budget USD 120, at most two pickup locations) it plans suppliers A and B for USD 84.00, rejects C as incompatible and D as too late, and when B becomes unavailable it proposes A and E for USD 95.00. These are test prices, not market prices.

## How PayPal is used

- PayPal Sandbox only, no real money. Authorize at approval time and capture after all conditions hold (delayed capture), using PayPal's hosted approval page so no client id reaches the browser. One Sandbox merchant credential set per demonstration supplier when supplied, or one set for all (and the interface says so).
- Idempotent calls, recorded before they are sent, a reconciler that reads PayPal state after a lost response, void and refund compensation, and signature-verified webhooks (polling is the primary path).
- **Update after live runs: what is verified.** At the time of writing, the Sandbox adapter has been exercised only against a local stub and the built-in fake PayPal. I have not yet run the live Sandbox checks, so I make no claim that it works against PayPal. [Replace this paragraph with the exact result of the live reports once I have run `docs/runbooks/live-paypal.md`.]

## How AI is used

- A model reads the cafe's request and optional label photo and returns structured fields under a strict schema. Every value is grounded in the request text or the photo; unknown values stay unknown and become questions; the buyer confirms each field.
- The model never decides permissions, amounts, suppliers or plans. The planner and explanations are deterministic code.
- Text in photos, requests or catalog entries is treated as data, not instructions; the tests include injection cases.
- **Update after live runs: what is verified.** At the time of writing, every extraction in the automated tests comes from a deterministic fake reader. I have not yet run the live model evaluation, so I make no claim about real-model accuracy. [Replace with the report's numbers once I have run `docs/runbooks/live-model.md`.]

## How it was built, and my part in it

I directed this build: I wrote the brief with the goal, the scope and the credibility rules (label everything simulated, never invent results, keep secrets out of the repository), and I own the open decisions the agents flagged for me, such as the live runs, the spend ceiling and the Node version floor. Smaller product defaults were recorded by the orchestrating agent on my behalf; they are listed in the project record for me to review. [Edit this to say exactly which decisions I actually made myself.] The code, tests and documents were produced with an AI agent team working under the ECCode delivery toolkit, which assigns tasks, requires evidence for each claim and has separate agents review the work against a written specification. I did not write the application by hand. The independent reviews found real defects that were fixed, and the project record under `.eccode/` keeps the tasks, findings and decisions.

## Honest limits

- A demonstration: fake data, five demonstration suppliers, one city (Amman), USD, pickup only, English interface.
- Verified only against the fake provider and a local PayPal stub; the PayPal Sandbox live runs and the live model run are not yet done (see above).
- No users, no real suppliers, no savings or confirmation claims of any kind.
- Image text cannot be fully verified server-side; Node 22.13 or newer is required; only Linux was used.

## Built with

Node.js 22 (built-in `node:http`, `node:sqlite`, `node:test`), SQLite, vanilla JavaScript front end, PayPal Sandbox REST APIs (Orders v2, Payments v2, Webhooks), Claude (through the `claude` command-line tool or the Anthropic API) for request reading, Playwright for browser tests. No runtime npm dependencies.

## Try it

- Repository: `<public repository URL, to be filled in by me>`
- Run it locally in one command (fake payments, simulated reader): `npm install && npm run seed && RS_MODEL_PROVIDER=fake npm start`, then open http://127.0.0.1:3000 and sign in as `cafe1` with the password the seed prints.
- Demo video: `<video URL, to be filled in by me>`

## What's next

Run the live Sandbox and model checks and publish their results as they are; add real supplier onboarding only if there is real demand, which I have not established.
