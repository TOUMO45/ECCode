# Groundwork delivery plan

## Phasing
foundation (package/config/DB/migrations, parser+verifier, provider adapter) -> core-backend (http/auth/RBAC/audit, then domain routes+publish) -> eval (datasets, harness, eval tests) -> ui (frontend, Playwright) -> release (live CLI tests, tuning, holdout, then docs). Five phases keep the number of phase reviews low; task ownership and D1-D10 coverage are unchanged.
13 tasks, owners mapped from spec roles: qa-engineer = test-engineer, docs = devops-engineer.

## Parallelism
After foundation-be: verifier-notes, backend-auth-http, datasets-tune-verifier and frontend run in parallel (disjoint globs). ai-providers follows verifier-notes. backend-domain joins auth, verifier and providers. src/routes/index.js (auto-registration) is owned by backend-auth-http so domain routes add files only.

## Critical path
foundation-be -> verifier-notes -> ai-providers -> backend-domain -> browser-e2e -> live-eval -> docs-devops (docs-devops depends on live-eval so README quotes final results and the clean-checkout npm test follows the last tuning edit).

## Risks
- Live CLI flakiness and spend (see budget; provider cap 8 USD, per-run cap 1.5 USD, at most 3 tune runs, one holdout run per provider; the second harness slot is reserved for a disclosed harness defect).
- Verifier false flags blocking M1 (tuning on tune set only, logged).
- node:sqlite experimental; Playwright/Chromium must exist globally.
- Holdout leakage: eval/holdout read-restricted for BE and AI.
- Spec DQ-1..DQ-4 await orchestrator acceptance.

## Release checklist draft
README install/run verified from clean copy; config and secrets documented (no key needed); rollback = restore data/groundwork.db backup, migrations forward-only; monitoring = JSON logs with request ids; open risks listed; all gates approved.

## Agent-spend budget (harness budget 60 USD; spent so far about 4.4; remaining about 55.6)
Estimates are unmeasured. The design's 40 USD live-eval cap is an upper bound; this plan tightens it.

| Phase | Planned agent spend (USD) |
|---|---|
| foundation (incl. providers) | 5 |
| core-backend | 7 |
| eval | 4 |
| ui (frontend + browser tests) | 6.5 |
| reviews and gates before live-eval (5 phase reviews share) | 4 |
| pre-live subtotal | 26.5 |
| live-eval agent work (excl. provider runs) | 2.5 |
| live-eval provider runs (cap) | 8 |
| docs | 1.5 |
| reviews, verification gate and delivery after live-eval | 3 |
| Planned total from now | 41.5 |
| Reserve (unplanned, 55.6 minus planned, shown to remain untouched) | about 14 |

Planned total plus already spent (4.4) is about 46 USD of 60, leaving at least 10 USD reserve even if the whole plan lands as estimated.

Stop rule (USD of cumulative harness spend, base stated explicitly): the pre-live cumulative plan is 26.5 + 4.4 = about 31 USD. If cumulative spend exceeds 36 USD (31 plus about 15%) before the first live run, the delivery-lead stops and reports to the orchestrator. Hard stop at 51 USD (85% of the 60 USD budget): no new dispatches, report. Normal execution (planned total about 46) does not trigger either rule.

Live-eval rules (mirrored in the live-eval acceptance criteria): provider spend <= 8 USD, <= 3 tune runs, 1.5 USD per run, one holdout run per provider.
