# S4 candidate projects (draft, not chosen)

## A. "Spendly" — multi-tenant expense approval SaaS
Master prompt (verbatim, 9 lines):
```
I want a web app where small companies manage employee expenses.
Each company has its own space; nobody should ever see another company's data.
People can be owner, admin, approver or employee. Employees submit expenses with a receipt file,
approvers approve or reject, admins manage people and categories, owners see everything and billing info.
There should be spending limits per category and per person, and an audit trail of who did what.
Every night it should send reminders for expenses waiting too long and build a monthly CSV export.
Add a simple dashboard with totals per month and per category.
It must run with one docker compose command. Keep it secure, this is money.
Use whatever stack you think is best.
```
- Expected size: ~35-45 HTTP endpoints, 8-10 tables, 4 roles x tenant isolation, 1 worker (reminders + export), web frontend (~8 screens), compose with app + db + worker (+ optional redis). Roughly 6-12K LOC incl. tests.
- Why it stresses one session: tenant x role authorization matrix (~160 cells) must stay consistent across 40 endpoints; worker shares models and tenancy; the frontend must match the API; compose wiring. Context pressure arrives mid-build, not at start.
- What could make it unmeasurable: (1) stack freedom ("whatever stack") lets arms diverge so a fixed HTTP hidden suite needs an API contract — mitigated by black-box tests through a thin adapter on documented paths, which itself is a requirements-quality signal; (2) receipt file upload + "billing info" are vague enough that scoring becomes a judgement call; (3) "every night" requires the suite to trigger the worker on demand — the suite must accept a documented trigger or treat its absence as a requirements defect.

## B. "Meterline" — data pipeline plus dashboard
Master prompt (verbatim, 9 lines):
```
We manage about 50 buildings and get electricity meter readings as CSV files dropped in a folder,
sometimes late, sometimes duplicated, sometimes with broken rows.
I want a system that picks up the files, cleans them, stores the readings and computes daily usage per building.
Flag anything strange: sudden spikes, meters that stop reporting, readings that go backwards.
Building managers should log in and see only their buildings; we (the operators) see everything.
Give them a dashboard with charts, the list of alerts, and a way to mark an alert as handled.
There should be a simple API so our billing system can pull the daily numbers.
It must run with docker compose and survive restarts without losing or double-counting data.
Use whatever stack you think is best.
```
- Expected size: ~20-28 endpoints, ingestion worker, idempotent loader, anomaly rules, 2 roles with per-building scoping, dashboard with charts. Roughly 5-9K LOC.
- Why it stresses one session: correctness lives in data semantics (dedupe, late data, backwards readings, restart idempotency), which is exactly where a vague prompt hides requirements; long-running ingestion makes "it works" hard to observe without fixtures.
- What could make it unmeasurable: (1) "strange" and "spike" are undefined, so the hidden suite must test only properties the prompt fixes (duplicates not double-counted, backwards readings flagged, restart safety, scoping) and score anomaly thresholds via the rubric, not pass/fail; (2) fixtures (CSV corpora with known answers) must be authored before any run and their answer key must be hidden; (3) chart quality is not machine-checkable.

## C. "Fieldbook" — product sized to exceed one context window by design
Master prompt (verbatim, 10 lines):
```
Build an internal tool for a 200-person services company, replacing spreadsheets.
Teams track clients, projects, tasks, time entries and invoices; managers approve time, finance issues invoices.
Each department is separate but managers can see across their departments; finance sees all money, not all notes.
Everything needs search, comments with @mentions, file attachments, notifications (in-app and email), and a full audit log.
People sign in with email and password, with 2FA for finance and admins; admins can create API tokens for integrations.
Import existing data from our CSV exports, and export any list to CSV.
Background jobs: reminders for missing timesheets every Friday, overdue invoice chasing, nightly backups.
Web frontend plus a public REST API with documentation. Must run with docker compose.
We expect to keep adding features after launch, so keep it maintainable.
Use whatever stack you think is best.
```
- Expected size: ~80-110 endpoints, 18-25 tables, 5+ roles with department hierarchy and field-level visibility, 3-4 job types, 2FA, API tokens, search, import/export, frontend ~20 screens. Roughly 20-35K LOC. S3's task tracker (24 criteria) was far smaller; the bare S3 build used ~78K peak context for a small app, so C is expected to need several context windows for either arm.
- Why it stresses one session: by construction it cannot be held in one window, so the arm must hand off state (plans, specs, tests) across compactions/sessions; this is the scenario ECCode's sealed contracts and record are meant for.
- What could make it unmeasurable: (1) size: a single arm may exhaust the per-arm ceiling before delivery, giving "incomplete" for all arms and no comparison (mitigation: Stage 1 pilot on a cut-down prompt and a partial-credit suite organised by feature area); (2) email + 2FA + backups need stubs/fakes that the suite must specify without dictating design; (3) cost: an arm could plausibly spend 10-40x the S3 bare figure, making n>1 expensive; (4) field-level visibility ("not all notes") is vague enough to dominate rubric disagreement.
