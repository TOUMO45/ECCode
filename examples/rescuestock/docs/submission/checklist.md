# Submission checklist (you complete this; nothing has been submitted)

**Status: DRAFT materials only.** Nothing in this repository has been submitted anywhere. Every item below is for you to confirm and tick yourself. The hackathon facts below were gathered on 2026-10-09 only through web search, because the Devpost pages were blocked from the build environment. A later attempt through the Devpost connector failed because it needs you to sign in again. So:

> **Every hackathon fact in this file and in the other submission drafts is unverified against the primary source. Re-check at https://paypalaihackathon.devpost.com/rules before submitting.**

## A. Hackathon facts to re-check (all unverified against the primary source)

Open https://paypalaihackathon.devpost.com/ and its rules page, and for each line below write down what the official page says. If it differs, the official page wins and the drafts must change.

| # | Fact as reported by search results (unverified) | What the official page says | Done |
|---|---|---|---|
| 1 | Event name: PayPal AI Hackathon. Address: https://paypalaihackathon.devpost.com/ | | [ ] |
| 2 | Submission period reported as 1 Oct 2026 09:15 PT to 12 Nov 2026 12:00 PT. One secondary source says 14:00 PT. Use the official page, and mind the time zone | | [ ] |
| 3 | Must integrate the PayPal developer platform using the free Sandbox, plus an AI tool or model | | [ ] |
| 4 | Public repository with an open-source licence and run instructions | | [ ] |
| 5 | A working demo that judges can try | | [ ] |
| 6 | A demo video under 3 minutes (secondary sources say it must be hosted on YouTube) | | [ ] |
| 7 | A text description of the project | | [ ] |
| 8 | Judging criteria reported as: technical implementation, design, potential impact, innovation, presentation | | [ ] |
| 9 | Eligibility, team size, prizes, third-party content and AI-generated-code rules, and any required form fields: **not checked at all**; read them in full | | [ ] |

Nothing here is a claim that RescueStock complies with the rules. Compliance is for you to establish from the official page.

## B. Before you publish the repository

- [ ] Decide where the public repository lives. RescueStock currently sits at `examples/rescuestock/` inside the ECCode repository (assumption A1, decision recorded in the project file). If the rules require a dedicated repository or a specific licence, move it first. The licence file is MIT with copyright "RescueStock contributors": confirm you want that holder name.
- [ ] Run `npm test` (inside `flock` if you run anything else at the same time) and `npm run test:browser` on your machine, and keep the output. Do not quote counts you have not seen.
- [ ] Scan for secrets before the first push: `git grep -nIE "(client_secret|api[_-]?key|BEGIN [A-Z ]*PRIVATE KEY)"` and check `git status` for `.env`, `data/` and `reports/` (all must be untracked). `test/scan/docs.test.js` also scans the README, the runbooks and these drafts for secret-looking values.
- [ ] Confirm no credential, token, webhook id, buyer email or personal data appears in any screenshot, video frame, description or log you publish.
- [ ] Confirm the README's run instructions work from a clean checkout on your machine (`scripts/clean-checkout.sh` does that).

## C. Live runs (not done; decide what you will claim)

- [ ] PayPal Sandbox live checks (LIVE-P1) and browser journeys (LIVE-P2): run [../runbooks/live-paypal.md](../runbooks/live-paypal.md). **Not run in this build.** Until you have run them, the description must say the Sandbox integration is built and tested against a local stub and the fake, not that it works against PayPal.
- [ ] Live model run (LIVE-M1): run [../runbooks/live-model.md](../runbooks/live-model.md). **Not run in this build.** Until then the description must not claim anything about real-model accuracy.
- [ ] After a live run, update `project-description.md` (sections marked "Update after live runs") with exactly what the reports show, and nothing more.

## D. Demo video

- [ ] Length under the limit on the official page (reported as 3 minutes; unverified). Aim for 2:30.
- [ ] Hosting site and visibility as the official page requires (reported as YouTube; unverified).
- [ ] The video shows **PayPal's hosted Sandbox approval page**, with you (not an agent) logging in with a Sandbox buyer account. If you did not run the Sandbox, the video must not show or imply PayPal; use the simulated approval page and say so.
- [ ] Everything simulated, demo or Sandbox is labelled on screen and in the narration: "Simulated payment approval — not PayPal", "Test prices, not market prices", demo accounts, the Sandbox badge.
- [ ] No real money, no real supplier, no real customer is named or implied.
- [ ] Script: [demo-video-script.md](demo-video-script.md).

## E. Text description and form

- [ ] Read [project-description.md](project-description.md) aloud and delete or soften any sentence you cannot stand behind.
- [ ] The description states your contribution truthfully: you directed the build; the code was produced with an AI agent team under the ECCode toolkit, with independent reviews. Check the form for any AI-assistance disclosure requirement (item A9).
- [ ] Fill every field of the Devpost form yourself. Do not paste secrets into it.
- [ ] Submit it yourself, before the deadline in the official time zone. Keep proof of submission.

## F. After submission

- [ ] Keep the repository public and unchanged enough for judging, or note what changed.
- [ ] Rotate or delete the Sandbox credentials you used for the live runs if they were exposed anywhere.
