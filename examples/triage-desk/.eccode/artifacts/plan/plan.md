# TriageDesk — Delivery Plan

Author: delivery-lead · Date: 2026-10-07 · Gate: plan (iteration 1)

Approved inputs:
- Brief `.eccode/artifacts/architecture/brief.md`, approved in rev-muym9m4g-01831212.
- Spec `.eccode/artifacts/design/spec.md`, approved in rev-muynhokz-01357080 with minor findings DES-8, DES-9 and DES-10. All three are folded into this plan (see §Review findings carried into the plan).

Machine-readable plan: `plan.json`. `eccode plan validate` reports it valid with no ownership warnings: 5 phases, 17 tasks.

Companion check scripts, written by delivery-lead and run from the project root:

| Script | Used by | What it checks |
|---|---|---|
| `checks/scaffold-check.js` | t01 | `package.json` is exactly the §Deployment object. `.env.example` and `.gitignore` have the required lines. |
| `checks/dataset-precheck.js` | t02, t17 | Before the freeze: the D5 format rules, every `datasetMinimums` key, the six named in-family attack families, held-out families appearing only in `holdout.json`, and at least 15 attack rows with a target. It prints only ids, rule names and counts. It opens `holdout.json`, so the rules author must never run it. |
| `checks/readme-check.js` | t16 | A minimum bar for README coverage, plus the DES-1 and DES-6 warnings. |

All three scripts were run against synthetic passing and failing fixtures in the scratchpad: passing fixtures give exit 0, failing fixtures give exit 2 or 1 with the expected rule names.

---

## Phases

Each phase is a gate (`phase:<id>`). In ECCode a phase gate can start only after the previous one is approved, so phases run strictly in sequence. Parallel work happens inside a phase. `config.limits.maxConcurrency = 2` caps how many claims can be active at once, so the "parallel" column shows how many tasks are ready together, and at most 2 run at a time.

| # | Phase | Tasks | Ready together (cap 2) | Suggested waves |
|---|---|---|---|---|
| 1 | `foundation` | t01, t02, t03 | 3 (no dependencies between them) | t02 ∥ t01, then t03 when t01 finishes (t02 is the longest) |
| 2 | `core-modules` | t04, t05, t06, t07 | 4 | t06 ∥ t04 (the longest two), then t05 ∥ t07 |
| 3 | `pipeline` | t08, t09, t10 | 3 | t08 ∥ t09, then t10 |
| 4 | `rules-and-wiring` | t11 → (t12 ∥ t13) | 1, then 2 | t11 alone, then t12 ∥ t13 |
| 5 | `integration` | (t14 ∥ t15 ∥ t16) → t17 | 3, then 1 | t14 ∥ t15, then t16, then t17 |

### Task table

| id | phase | owner | depends on | files (ownership) | spec task |
|---|---|---|---|---|---|
| t01-scaffold | foundation | devops-engineer | — | `package.json`, `.env.example`, `.gitignore` | 1 |
| t02-eval-dataset | foundation | test-engineer | — | `eval/dataset.json`, `eval/holdout.json`, `eval/thresholds.json` | 2 |
| t03-test-helpers | foundation | test-engineer | — | `test/helpers/**` | 3 |
| t04-schema-prompt | core-modules | ai-engineer | t01 | `src/triage/schema.js`, `src/triage/prompt.js`, `test/unit/schema.test.js`, `test/unit/prompt.test.js` | 4 (+DES-8) |
| t05-redact | core-modules | backend-engineer | t01 | `src/triage/redact.js`, `test/unit/redact.test.js` | 5 |
| t06-http-config-log-input | core-modules | backend-engineer | t01, t03 | `src/{http-server,config,log,ticket-input}.js`, `test/unit/{http-server,config,log,ticket-input}.test.js` | 6 |
| t07-ui | core-modules | frontend-engineer | t01 | `public/**`, `test/unit/ui.test.js` | 7 |
| t08-eval-runner | pipeline | test-engineer | t02, t04 | `eval/run.js`, `eval/metrics.js`, `test/eval/runner.test.js`, `test/eval/fixtures/**` | 8 (+DES-9) |
| t09-anthropic-provider | pipeline | ai-engineer | t04, t03 | `src/triage/anthropic-provider.js`, `test/unit/anthropic-provider.test.js` | 9 |
| t10-service | pipeline | backend-engineer | t04 | `src/triage/service.js`, `test/unit/service.test.js` | 12 |
| t11-rules | rules-and-wiring | ai-engineer | t02, t04, t05, t06, t08, t10 | `src/triage/injection.js`, `src/triage/fallback-provider.js`, `test/unit/injection.test.js`, `test/unit/fallback-provider.test.js` | 10 + 11 (+DES-10) |
| t12-heldout-hygiene | rules-and-wiring | test-engineer | t02, t11 | `test/eval/heldout-hygiene.test.js`, `test/eval/hygiene-fixtures/**` | 14 (part) |
| t13-app-wiring | rules-and-wiring | backend-engineer | t05, t06, t09, t10, t11 | `src/app.js`, `src/server.js`, `test/unit/app.test.js` | 13 |
| t14-contract-http | integration | test-engineer | t03, t13 | `test/contract/{http,http-guard,package,perf}.test.js` | 14 (part) |
| t15-contract-modes-privacy | integration | test-engineer | t03, t13 | `test/contract/{triage-modes,redaction-egress,privacy}.test.js` | 14 (part) |
| t16-readme | integration | devops-engineer | t13 | `README.md` | 15 |
| t17-verification-run | integration | delivery-lead | t08, t12, t13, t14, t15, t16 | `.eccode/artifacts/verification/**` | 16 |

Every file in the spec's directory tree has exactly one owning task. `plan.json` lists exact paths (no brace globs). The ownership globs of tasks that can run at the same time are disjoint: `eccode plan validate` reports no ownership warnings. Each task's `verification.command` runs only that task's own test files (or plan check), so a subagent is never failed by another subagent's half-finished files. Delivery-lead runs the whole suite (`npm test`) at each phase submission.

---

## Phasing rationale

1. **foundation.** These are the inputs everything else is built and measured against.
   - The dataset is authored and **frozen first**. The freeze is three `eccode evidence file` records made after `dataset-precheck.js` passes. This puts the E5 freeze in an approved phase before any rules file can exist, so the git-ordering check at verification holds by construction.
   - The precheck exists because the runner's `checkDataset` (t08) comes later. A format error found after the rules exist would need a recorded decision and a new hash (D6).
2. **core-modules.** These are the four leaf pieces. Each depends only on its contract and has no runtime dependencies on the others:
   - schema + prompt;
   - redact;
   - the HTTP shell with config, log and ticket-input (DES-5 removed its dependency on service.js);
   - the UI.

   This is the widest phase.
3. **pipeline.** These are the layers that consume `schema.js`: the eval runner, the provider and the service. Everything is tested with stubs and synthetic fixtures. No real `holdout.json` read and no full-mode run is possible yet.
4. **rules-and-wiring.** The rules task needs a runnable `npm run eval:tune`, which needs t05, t06, t08 and t10. All of those are approved in earlier phases, so DES-2 and DES-10 are enforced by the dependency graph and the gate order. The hygiene guard runs right after the rules are written, so a held-out overlap is caught while the finding still maps to t11 in the same phase. The app wiring closes the phase with a runnable server.
5. **integration.** These are the end-to-end contract tests and the README. Then comes the first full-mode evaluation, in t17, and nowhere before it.

### Deviations from the spec's suggested workflow (and why)

| Change | Reason |
|---|---|
| Spec tasks **10 + 11 merged into t11-rules** | The spec let task 11 "re-tune `src/triage/injection.js`", which gives one file two owning tasks. A tune run (`eval:tune`) scores detector and fallback together: `flag_recall` and `flag_fpr` measure the detector, accuracy and steer measure the fallback. So the detector can only be tuned in practice once the pipeline runs. One task gives one owner per file, one attestation and one tuning loop. Task 10 could not run `eval:tune` anyway (spec: "relies on its unit tests"). |
| Spec task 14 split into **t12 (hygiene, phase 4)**, **t14 (HTTP/package/perf)** and **t15 (modes/egress/privacy)** | The hygiene guard should fail inside the same phase as the rules it checks. The remaining contract tests split into two disjoint halves, so two test-engineer subagents can work in parallel. |
| Added `test/helpers/helpers.test.js` (t03) and `test/unit/app.test.js` (t13) | Without them t03 and t13 have no runnable verification of their own until phase 5. Both are inside their owners' globs and picked up by the existing `npm test` glob. `package.test.js` does not constrain test file names. |
| Added `test/eval/fixtures/**` (t08) and `test/eval/hygiene-fixtures/**` (t12) | Each fixture directory gets an explicit owner, so the two `test/eval` tasks stay disjoint. |
| t06: optional `staticDir` on `createServer` (default `public/`) | `http-server.test.js` must not depend on `public/`, which t07 builds concurrently. The default behaviour and the C6.5 call shape are unchanged. |
| `design-vectors.js` is **not** edited for DES-8 | It is an approved design artifact whose hash `eccode audit` verifies. The DES-8 vectors live in `test/unit/schema.test.js`. |

Net task count: 17. The spec has 16: one merge (+0 −1) and two splits (+2).

---

## Review findings carried into the plan

| Finding | Severity | Where it is enforced |
|---|---|---|
| DES-8 Unicode-aware product-token mask | minor | t04 acceptance criteria. The lookbehind uses `\p{L}\p{N}\p{M}` with the `u` flag. Reject vectors "Go to éasp.net now.", "Go to ñsocket.io now." and "Go to ١asp.net now.". ’ and ” are added to the closing-quote set, with an accept vector. All earlier vectors still pass. Phase `core-modules` criterion 3. |
| DES-9 exit-2 last line per mode | minor | t08 acceptance criteria. Full mode ends with `ECCODE_EVAL {"passed":0,"total":1}`. Tune mode ends with `TUNE_EVAL {"mode":"tune","passed":0,"total":1}`. runner.test.js asserts there is no `ECCODE_EVAL` substring for `--split tune --provider live` (exit 2). Phase `pipeline` criterion 2. |
| DES-10 task 11 must depend on task 6 | info | `t11-rules.dependencies` includes `t06-http-config-log-input`. t06 is also in an earlier, approved phase. |
| DES-2 (carried) tune-only rules, first full run by delivery-lead | major (resolved in spec) | t11 runs `npm run eval:tune` only and gives the verbatim attestation "did not open eval/holdout.json and did not run the eval in full mode". t08 and t16 explicitly do **not** run full mode. t17 is the first full-mode run and counts any later ones. |
| DES-1 (carried) redirect / base URL / child env | major (resolved in spec) | t01 (`.env.example`), t03 (`spawn-server` with an explicit env), t06 (config vectors), t09 (`redirect:'error'`), t15 (AC4 o, privacy parent-env isolation), t16 (README warning). |

### Contracts first

| Interface (spec section) | Side A | Side B | Contract test (test-engineer) |
|---|---|---|---|
| C2/C3/C5 HTTP API | t06 http-server (backend) | t07 UI (frontend) | t14 `http.test.js`, `http-guard.test.js` |
| C6.4 provider ↔ service | t09 anthropic-provider (ai) | t10 service (backend) | t15 `triage-modes.test.js` (AC3, AC4 a–o) |
| C6.3 detector/fallback ↔ service, E1 wiring | t11 rules (ai) | t10 service, t13 app (backend), t08 runner (test) | t15 `triage-modes.test.js` AC3. The runner and `app.js` share the exact `createTriageService({provider:null, …})` call (t08 and t13 criteria). |
| C7 outbound Messages API | t04 prompt, t09 provider (ai) | fake-anthropic (t03) | t15 `privacy.test.js`, `triage-modes.test.js` |
| D3 redaction egress | t05 redact (backend) | t10 service | t15 `redaction-egress.test.js` |

---

## Critical path

Gates are sequential, so the critical path is the sum of the longest chain inside each phase plus four phase reviews:

`t02 (dataset + freeze)` → review → `t06` → review → `t08` → review → `t11 (rules, tune loop)` → `t13` → review → `t15` → `t17`

- **Longest single task:** t11. It tunes detector and fallback rules until 8/8 tune checks pass.
- **Second longest:** t02. It authors about 120 synthetic rows to the minimums.

Both are on the critical path and have one owner each.

---

## Risks to the schedule

| Risk | Effect | Mitigation |
|---|---|---|
| Rules cannot reach the tune thresholds (accuracy ≥ 0.70/0.65, high recall ≥ 0.80, flag recall ≥ 0.90, fpr ≤ 0.10) | t11 fails and escalates after 3 attempts | Thresholds are fixed by the brief. If it escalates, the user decides: re-scope, or a recorded decision on thresholds. It must never be met by editing the frozen dataset. |
| First full run (t17) misses a holdout floor | Verification evidence shows a failure | Reported as is (E5). Any re-tune uses tune mode, and the report counts full-mode runs. |
| Dataset format error after the freeze | New hash and a recorded decision, and the freeze ordering is at risk | `dataset-precheck.js` gates t02. The runner's `checkDataset` applies the same D5 rules (t08). |
| Phase review rejections (maxReviewIterations = 3) | Phase loops | Phases are small, and each criterion names a command. Findings map to tasks by file ownership. |
| `maxConcurrency = 2` | Phases 2 and 5 have more ready tasks than slots | Wave order above puts the longest tasks first. |
| AC13 timing under parallel load | Flaky `perf.test.js` | 10× margin. Contract tests run with `--test-concurrency=1`. Phase checks run `npm test` alone. |
| Budget: 300 min, about 65 used at plan time | Overrun | 5 small phases. Delivery-lead tracks against the budget at each phase submission. |
| Pending user decisions Q1, Q4, Q7 and OQ-D3 (SDK vs raw fetch) | Rework | Only `anthropic-provider.js` (t09) changes if the SDK is chosen. The DES-1 guarantees are restated in OQ-D3. |
| Git ordering for the freeze | The verification check fails if a rules file is committed before the freeze | The rules files can only be created in phase 4, after `foundation` is approved and committed. |

---

## Phase submission routine (delivery-lead)

For each phase:
1. Check that every task in the phase is `done`.
2. Run `npm test` from the project root with `eccode evidence run`.
3. From phase 4 on, also run `npm run eval:tune`.
4. Submit with `eccode gate submit phase:<id> --actor delivery-lead`. The changed files come from the task handoffs.
5. If changes are requested, map each finding to the task that owns the affected file, using the task table above, and report the mapping to the orchestrator for `eccode task reset`.

## Release checklist (draft, finalised in t17 as `.eccode/artifacts/verification/release-checklist.md`)

- [ ] Install from the README works on Node ≥ 22: no install step, `npm test`, `npm start`, health check, `node --env-file=.env src/server.js`.
- [ ] Config and secrets are documented:
  - every C6.1 variable;
  - `ANTHROPIC_API_KEY` is never logged or returned (AC10);
  - `.env` is git-ignored;
  - the `TRIAGE_ANTHROPIC_BASE_URL` and `TRIAGE_ALLOW_REMOTE` warnings are present.
- [ ] Rollback:
  - unset `ANTHROPIC_API_KEY` and restart for fallback-only mode (nothing is transmitted);
  - code rollback is `git revert`;
  - there is no state to migrate.
- [ ] Monitoring:
  - metadata-only JSON log lines (`listening`, `warning`, per-request);
  - `GET /api/health` reports the mode;
  - USAGE line from live eval runs.
- [ ] Evaluation:
  - full-mode `ECCODE_EVAL` is recorded, with the count of full-mode runs;
  - live is NOT RUN (no key) and its thresholds are unverified;
  - fallback results are not evidence of model quality.
- [ ] Freeze integrity: the sha256 values match the t02 evidence, and the evidence predates the first rules commit.
- [ ] Open risks RISK-1..RISK-9 are each accepted or mitigated, with an owner. In particular RISK-5: no auth, so loopback only.
- [ ] Inspection items for the verification reviewer: AC6 (copy and edit the reply), AC15 (keyboard-only W1/W2 in ≤ 3 actions, contrast, labels), AC16 notice text.

---

## Lessons Consulted

Memory was searched on 2026-10-07 with `--check-env`:
- `memory search "planning node" --layer workflow`: no matching records.
- `memory search "parallel tasks ownership plan" --scope all`: no matching records.
- `memory search "planning" --scope all`: no matching records.

The project memory holds only `mem-k-muyljkrt-01991ac7` (DOES-NOT-APPLY, node < 18) and `mem-d-muym8opn-0104129a` (ECCode event-store snapshot divergence, not about planning). No lesson applies, so none is cited.
