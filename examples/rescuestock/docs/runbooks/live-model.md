# Runbook: live model run (LIVE-M1)

**Status: NOT VERIFIED.** This build has never called a real model. Every extraction result in the automated suites comes from the deterministic fake reader, and the model adapters have been exercised only against local stubs. This runbook is how you, the project owner, run the opt-in evaluation against a real model. It spends your money, so it has a hard ceiling.

What a pass would show: on the 22-case EXT-1 corpus (version `EXT-1`) the real model meets the thresholds listed below. What it would not show: anything about PayPal, about other prompts, other models or other languages, or about production traffic.

## What the run does

`npm run test:live-model` runs `test/live/run-live-model.js`:

1. It refuses (exit 2) unless the launch conditions below hold.
2. It prints the provider, the model, the corpus size, the per-call cap, the worst-case spend and your ceiling. For the CLI route it also prints `cli: claude <version>` before its first call.
3. It runs the `cli-image-smoke` case first. If the model tool does not accept the image input or the output schema, the run ends before any other case, because every extraction would otherwise fall back to the degraded path. That is also the first live check of the image input shape, which is unconfirmed.
4. It runs the remaining cases and stops **before** any call that could push the total past your ceiling.
5. It writes `reports/live-model-<UTC>.json` and prints the thresholds as PASS or FAIL.

Thresholds (from `test/eval/lib/metrics.js`): text field accuracy at least 90 %; the canonical Arabic and English pair equal and correct (100 %); other Arabic/English pairs equal and correct (100 %); clear-image accuracy at least 80 %; invented numbers on ambiguous images 0; clarification on ambiguous images 100 %; injection effects 0; injected text surfaced 0; schema validity at least 95 %.

## Cost and the ceiling

- The ceiling is `RS_LIVE_MODEL_CEILING_USD`: the most you are willing to spend on one live model run. It is required together with `RS_LIVE_MODEL=1`. It must be an exact decimal from 0.01 to 5.00 with at most two decimals (for example 0.50 or 5). Anything else, including 5.0000001, 1e0 or 05, is refused with exit 2. USD 5 is the maximum accepted; this is the recorded project ceiling.
- Worst case at the default per-call cap (`RS_MODEL_CALL_CAP_USD`, 0.05): 22 cases x 0.05 = USD 1.10. This is a computed upper bound, not a measurement. The run itself prints its own worst case.
- One earlier single call to the `haiku` alias through the CLI cost about USD 0.0037 (a single measurement in the integration research notes, not a forecast for the whole run).
- Pick a ceiling you can afford to lose, for example 1.50, and run the dry run first.

## Prerequisites

Choose one route.

**CLI route (default).** Needs the `claude` command-line tool, installed and signed in with your own account (follow the tool's own sign-in instructions). Usage is billed to that account. No key is involved. The adapter runs the tool without tools, with a scrubbed environment and a per-call budget flag, in a temporary directory.

**API route.** Needs `RS_MODEL_PROVIDER=anthropic` and `ANTHROPIC_API_KEY` in the environment. Set the key like this, in your own terminal only:

```sh
printf 'Anthropic API key (input hidden): '; stty -echo; read ANTHROPIC_API_KEY; stty echo; printf '\n'
export ANTHROPIC_API_KEY
```

- Never paste the key into a chat, an issue, a commit or a command line. A command line lands in your shell history and in the process list.
- On a hosted environment, use its secret store ("environment secrets") instead and let it inject the variable.
- The key is never printed by the runner, never put in the report and never passed to the CLI child process. Unset it when you are done: `unset ANTHROPIC_API_KEY`.
- The API prices (`RS_ANTHROPIC_USD_PER_MTOK_IN` and `_OUT`) are configurable and were not checked against the current price list: verify them before you trust the printed cost.

Network: the CLI route needs whatever the `claude` tool itself needs. The API route needs `api.anthropic.com` only (443). The runner refuses any other API host.

## Steps

1. Clean checkout, `npm install`, Node 22.13 or newer (`node --version`).
2. Dry run. It prints what the run would spend and exits 0 without a model call:

   ```sh
   RS_LIVE_MODEL=1 RS_LIVE_MODEL_CEILING_USD=5 npm run test:live-model -- --dry-run
   ```

   Check the provider, the model, the case count (22) and the worst-case figure. Lower the ceiling if you want a smaller bound.
3. Real run (CLI route):

   ```sh
   RS_LIVE_MODEL=1 RS_LIVE_MODEL_CEILING_USD=5 npm run test:live-model
   ```

   API route: add `RS_MODEL_PROVIDER=anthropic` to the same line, with `ANTHROPIC_API_KEY` already exported as above.
4. Keep the terminal open until the run ends. Stop it, if you must, with Ctrl-C (or `kill <pid>`, which sends SIGTERM): it closes the adapter, which ends its model child processes, writes **no** report and exits 130 (SIGINT) or 143 (SIGTERM). Never use `kill -9`. After an unclean kill, look for a leftover process: `pgrep -af "claude -p"` and end it. SIGHUP (closing the terminal) is not handled by the live runner.

## Exit codes

| Exit | Meaning |
|---|---|
| 0 | All thresholds met, the smoke case accepted the schema, nothing skipped, cost within the ceiling (or a dry run) |
| 1 | A threshold missed, a case skipped (for example by the ceiling), the smoke assertion failed, or an unexpected error |
| 2 | Refused: `RS_LIVE_MODEL` is not 1, the ceiling is missing or malformed, the run is under the offline network guard or with `RS_TEST_OFFLINE=1`, `RS_MODEL_PROVIDER=fake`, or the configuration was refused (the message names variables, never values) |
| 130, 143 | Interrupted by SIGINT or SIGTERM; no report |

## Where the report is

`reports/live-model-<UTC>.json`, where `<UTC>` is the run's start time with colons and dots turned into dashes. The `reports/` directory is ignored by git. It holds the provider, the model, the CLI version, the corpus and prompt versions, the ceiling and the cost in micro-dollars, the metrics with pass or fail, and the per-case status and model output for the synthetic corpus. It holds no credentials.

## After the run

- Report the outcome as it is. A pass moves LIVE-M1 from unverified to verified for that corpus, model and date only. A failure is evidence about the model or the prompt: do not edit thresholds or documents to make it pass.
- If `schemaAccepted` is false, the image input or schema shape of the real tool differs from what was built; extraction then degrades to manual entry, which still works and is labelled.
- Do not quote the cost as typical use; it is the cost of this corpus on this day.
- The application also protects itself in normal use: a per-call cap (`RS_MODEL_CALL_CAP_USD`), a daily budget (`RS_MODEL_DAILY_BUDGET_USD`, default USD 1.00), a per-customer daily share (`RS_MODEL_CUSTOMER_DAILY_SHARE`, default 0.2), a timeout (`RS_MODEL_TIMEOUT_MS`, at most 40000) and one in-flight call per customer.
