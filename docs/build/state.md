# State

**Branch:** `claude/brave-bardeen-6y5ng9` (forked from `claude/keen-allen-5z33eb` at `d2d0c24`)

## Works now
- `npm run check`: 51/51 (Node 22.22, 2026-10-08).
- Headless sessions run: `claude -p` (CLI 2.1.294) works and reports `total_cost_usd`.
- Session isolation: `env -u CLAUDE_CODE_SYNC_PLUGINS -u CLAUDE_CODE_SYNC_SKILLS CLAUDE_CONFIG_DIR=<fresh> claude -p … --plugin-dir <toolkit>` loads only that toolkit plus the harness built-ins. ECCode's SessionStart hook ran live.
- Persistence option: `node:sqlite` is available (experimental warning), so a database needs zero dependencies.
- Baseline toolkit: `affaan-m/ECC` HEAD is reachable and still at `ef648e01…`.

## Blockers
- No direct Anthropic API key (direct API returns 401). Live model calls must go through the `claude` CLI.

## Decisions
- D1: Live AI in this environment goes through a `claude-cli` provider (W2). The direct API path stays and is tested against a fake endpoint.
- D2: R3 is proven by a scripted gate challenge with blind reviewer sessions (W4), separately from the demo's natural rejections.
- D3: The R7 targets are frozen in `eval/suite/targets.json` before any tuning run, and the commit hash is recorded.

## Next action
W1a (`run end` usage), then W1b and W1c, then the W1d bug hunt in parallel with the W6 design.

## Restart steps
1. `cd /home/user/ECCode && git log --oneline -5 && npm run check`
2. Read `docs/build/plan.md` and `docs/build/evidence.md`, then continue from **Next action**.
