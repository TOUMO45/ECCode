# Demo video script (DRAFT, not recorded, not submitted)

Target length 2:30. The length limit (reported as under 3 minutes) and the hosting site (reported as YouTube) are **unverified against the primary source; re-check at https://paypalaihackathon.devpost.com/rules before submitting**. Narration is in my own voice; I edit it before recording.

## Rules for the recording

- **Show PayPal's hosted Sandbox approval page, and I (not an agent) log in with a Sandbox buyer account.** This needs my Sandbox credentials and the run described in `docs/runbooks/live-paypal.md`. If I have not run the Sandbox, I use Version B below and do not show or mention PayPal's own page.
- **Label everything that is simulated, demo or Sandbox**, on screen and in words: "Test prices, not market prices", the demo-data badges, "Simulated payment approval — not PayPal" (fake provider), the Sandbox badge (Sandbox provider).
- No real money, supplier, customer or business is named or implied. No claims about users, savings or confirmations.
- Keep secrets off screen: no credentials, no dashboard pages showing client ids or secrets, no terminal with exported variables, no seed output with passwords (blur or crop it, or record after signing in).
- Prepare: seed a fresh database, start the server with the chosen provider, note the seed passwords privately. For retakes, press "Abandon purchase" between takes, alternate `cafe1` and `cafe2`, or start with `RS_MAX_REQUESTS_PER_CUSTOMER_PER_DAY` set to 100 on a private machine (see the README operator note).
- Browser window about 1280 px wide, zoom so text is readable, a quiet room.

## Version A: with the PayPal Sandbox (only after I have run it)

| Time | On screen | Narration (draft) |
|---|---|---|
| 0:00 to 0:15 | Title card "RescueStock — a demonstration", then the sign-in page showing the demo-data and Sandbox badges | "A cafe runs out of cups or lids in the middle of service. RescueStock is a demonstration of how it could find matching supply fast. All data here is made up, and payments use the PayPal Sandbox, so no real money moves." |
| 0:15 to 0:40 | Signed in as a demo cafe. New request page. Type the request (also show it works in Arabic, if recorded): "I need 200 cups and 200 lids, 250 ml, by 11:00 today. Budget $120, at most 2 pickups." Submit | "I describe the problem in plain language, in English or Arabic. A model reads it, but it only fills a form." |
| 0:40 to 1:05 | The extracted fields with their source labels; a question about anything unclear; click confirm | "Every value shows where it came from. If something is unclear it asks instead of guessing, and I confirm each field." |
| 1:05 to 1:30 | The plan: suppliers A and B, USD 84.00; the rejection list: C incompatible, D too late; the "Test prices, not market prices" notice | "The planner picks the cheapest feasible bundle. It explains why: supplier C's lids do not fit, supplier D is ready too late. These are test prices, not market prices." |
| 1:30 to 1:50 | Approve plan, reserve stock, suppliers confirm (switch to a supplier window briefly, or show the confirmed state) | "I approve, the stock is reserved, and each supplier confirms its own pickup time before any money is captured." |
| 1:50 to 2:15 | Click "Approve with PayPal". **PayPal's hosted Sandbox approval page appears at www.sandbox.paypal.com; I log in with my Sandbox buyer account and approve.** Keep the address bar visible. Repeat quickly for the second supplier | "Payment is authorized at PayPal's own Sandbox page, not ours. This is a Sandbox buyer account; nothing real is charged." |
| 2:15 to 2:35 | Back in the app: the receipt, captured Sandbox payments, ready for pickup. Optionally the "If something fails" panel | "Only after every supplier has confirmed and every authorization holds is the money captured. If something fails, the authorizations are voided and the screen says what happens next." |
| 2:35 to 2:50 | Closing slide: the repository address, "Demonstration only. Built with an AI agent team under the ECCode toolkit, directed by me." | "I directed this build; the code was produced with an AI agent team and independently reviewed. The repository has the tests and the runbooks." |

Do not add the replacement-plan scene (B unavailable, A+E for USD 95.00) to Version A unless the run is quick; it adds about 30 seconds, and the Sandbox version of that path (RS-32(b)) only covers the voiding, not approval of the replacement plan.

## Version B: fake provider only (use this if I have not run the Sandbox)

Same as Version A, with these changes:

- 0:00 to 0:15 narration: "...payments are simulated in this version: nothing leaves my machine, and no real PayPal is involved."
- 1:50 to 2:15: the approval page is the built-in page titled "Simulated payment approval — not PayPal". Say so out loud: "This is a simulated approval page, not PayPal." Do not show or mention PayPal's hosted page, and do not say the Sandbox integration was tested against PayPal.
- Closing: add "The PayPal Sandbox adapter is built and tested against a local stub; I have not yet run it live."

Note that Version B may not satisfy a requirement to show the PayPal integration. That is for me to check against the official rules (item 3 and 6 of the checklist).

## After recording

- Watch it once with the sound off to check every label is readable, and once with the sound only to check every claim.
- Check no credential, personal email or real name appears in any frame.
- Upload where the official rules require (unverified), set the visibility they require, and copy the link into the form myself.
