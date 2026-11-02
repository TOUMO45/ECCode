# Goal

**Master goal (user, 2026-11-02):** "do it yourself, you have all permission, and if necessary create a new one; work deeply and professionally until you prove that ECCode codes and works as a senior engineer with 12 years of experience; also improve or upgrade the capability of Claude Code and vibe coding."

**Reading (stated assumption, source: the preceding turn).** The H-B measurement (task 0.D) was blocked: `ECCODE_SEED_KEY` in the environment was a public hash, not the AES key (register row 171). "Create a new one" is read as: author a new, independent seed set and key, because a new key cannot open the old sealed set. "Prove ECCode works like a senior engineer" is the Senior Bench programme (`bench/protocols/2026-11-01-senior-bench.md`, `2026-11-02-senior-ambiguous-r1lite.md`).

**Boundaries kept from the earlier brief.** No fabricated numbers; labels before figures; every limit into `docs/limits.md`; no gate weakened; the key never printed, logged, written or committed; no tuning of detector, probes, config or seeds after any result; frozen v1 files unchanged. **Spend:** "all permission" is not the explicit approval of a budget that `2026-11-02-senior-ambiguous-r1lite.md` section 7 requires, so no paid benchmark run starts without it (ask at that boundary only).

## Non-goals
- Re-opening or guessing the original sealed set.
- Tuning anything toward a seed after the v2 freeze.
- Claiming ECCode equals a human senior engineer: the claim is limited to what the registered measurements show.

## Requirements (observable acceptance)

| ID | Requirement | Acceptance |
|---|---|---|
| R1 | The behavior diff probes routes declared under `APIRouter(prefix=…)`, `include_router` chains and class-based controllers, and routes reached through importing (dependent) files | A fixture app with a prefixed, nested router: a change in the route file and in a service it imports each yield executed probes reaching the right full-path operations, `coverage: ok`. Written test-first (fails on the v1 code) |
| R2 | The same on Mealie | A harmless, non-seed edit to a route file and to a service module (applied locally, reverted) gives `coverage: ok` and probes on the affected operations; v1 gives `insufficient-coverage` on the same edits |
| R3 | v1 stays reproducible | `phase2-seeds.js check` in the worktree at `4fbb80e`: 33/33; a test pins the v1 detector bytes (from git) to the v1 freeze |
| R4 | v2 pipeline frozen and registered before any new seed exists | `phase2-freeze-v2.json` hashes + protocol amendment, committed before the seeding agent starts |
| R5 | New seed set, independent and valid | Written by a separate agent that did not read `lib/`, `scripts/`, `tests/`; each seed applies alone and the full Mealie suite stays green (the validator, as registered); sealed under a fresh key; hashes registered |
| R6 | H-B measured honestly | v1 and v2 run on the same set; per class: detections, misses, false positives with Clopper-Pearson 95% intervals; intended-seed false-positive rate separately; every miss labelled capability or configuration; nothing tuned after a result |
| R7 | No regression | `npm run check` green; limits register updated; no existing test weakened |
| R8 | Senior-engineer proof is prepared, not faked | Round 1-lite freeze script written and tested; the budget approval requested; nothing launched without it |

## Backlog (not in scope until R1–R8 are met)
Function-probe support for Mealie's dependency-injected route functions; response-model-aware probes; other frameworks.
