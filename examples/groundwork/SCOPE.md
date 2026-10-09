# Demonstration app: agreed scope (R4)

**Source of scope:** the user's goal, criterion 4 ("Working application"). This file turns each item into an acceptance criterion **before building**. The ECCode team receives it as the idea for `/eccode:start`. The architecture brief must carry every criterion below. Removing or weakening one needs a recorded user decision.

## Product: Groundwork, incident postmortems the AI cannot make up

- **Users:** on-call responders, incident leads and stakeholders in an engineering org with several teams.
- **Problem:** writing a postmortem after an incident takes hours. AI drafts are fast, but they invent timestamps, causes and owners, so teams don't trust them.
- **Product:**
  1. A responder imports the incident's raw notes: chat or timeline lines with time, author and text.
  2. The AI drafts a structured postmortem: summary, impact, timeline, contributing factors and action items.
  3. **Every statement in the draft cites the source lines it is based on.**
  4. The server verifies each citation deterministically: the cited lines exist, and the timestamps, numbers and names a statement asserts appear in those lines.
  5. Statements that fail verification are flagged in the UI and **block publishing** until a human edits or removes them.
  6. The lead reviews and publishes. Stakeholders read published postmortems.
- **Memorable moment:** clicking a citation highlights the exact source line. An ungrounded sentence is visibly flagged, and Publish stays disabled until it is fixed.

## Acceptance criteria (each must pass; evidence in the final acceptance report)

| ID | Criterion |
|---|---|
| D1 | **Responsive frontend.** A browser UI covers sign in, incidents, notes import, draft review with citation highlighting, and publish. It is usable from 360 px to 1440 px, keyboard-operable with visible focus, and has loading, empty, error and success states. It is verified in real Chromium at 360 and 1280 px. |
| D2 | **Backend API.** JSON HTTP API with one consistent error envelope. Node ≥ 22. Dependencies are kept to what the design justifies (zero is preferred). |
| D3 | **Persistent database.** SQLite through the built-in `node:sqlite` (or an equivalent embedded DB), with versioned migrations. Data survives a server restart; a test proves it. |
| D4 | **Meaningful AI feature.** The draft is generated through a narrow provider adapter with validated structured output and deterministic grounding verification. Retrieved notes are data, never instructions (prompt-injection resistance). Providers: (a) the Anthropic API when `ANTHROPIC_API_KEY` is set; (b) a **Claude Code CLI provider** (`claude -p`, no tools, fixed system prompt, JSON output). This environment has no API key, so (b) is the live path that must be verified here. (c) A deterministic fallback extractor, clearly labelled as fallback in the API and UI. |
| D5 | **Validation and error handling.** Every input is validated (size limits, types, required fields). Provider timeouts, malformed model output and outages are handled: no crash, and a clear state or fallback. Internal errors are never leaked. |
| D6 | **Access controls.** Local accounts with salted password hashing (scrypt or argon2). Sessions use HttpOnly SameSite cookies, with CSRF protection on state-changing requests. Team-scoped data with roles `viewer`, `responder` and `lead`: responders create incidents and drafts, only leads publish, and viewers read published postmortems of their own team only. No cross-team access, proven by IDOR tests. Login attempts are rate-limited. Sensitive actions write an audit log. |
| D7 | **Tests.** Critical journey (sign in → create incident → import notes → generate draft → fix a flagged statement → publish → viewer reads) as API integration tests **and** a real-browser test. Integration tests cover the DB, the provider adapter (fake provider plus the live CLI provider when available), access control and persistence. |
| D8 | **AI evaluations with thresholds fixed before implementation.** The architecture brief defines the metrics and numeric thresholds: grounding validity, timeline recall, action-item recall, injection resistance and fallback quality. There is a labelled tune set and a holdout set that is never tuned on. The live CLI provider and the fallback are evaluated separately. |
| D9 | **Setup and reproducible run.** A README gives setup, configuration, seed data, run, test and eval commands. A clean-checkout run is verified by an independent reviewer. |
| D10 | **No known blocking defects** at delivery. Every open risk is listed. |

## Constraints for the team

- **Model access:** live model calls here go only through the Claude Code CLI (`claude -p`); there is no API key. Design the adapter so the API path works with a key, and test it against a local fake.
- **Spend:** the user authorizes up to **$150** of recorded agent spend and **900** minutes of recorded agent runtime for this delivery (`limits.maxCostUsd`, `limits.maxRuntimeMinutes`). Live eval runs through the CLI provider must use a small model and print their usage.
- **Out of scope:** SSO, email, multi-region deployment, a hosted SaaS deployment. A verified local run satisfies D9.
