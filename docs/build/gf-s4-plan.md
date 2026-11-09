# S4 pre-registered plan: Stage 1 pilot (n=1 per arm, 3 arms) then conditional Stage 2 (n=3 per arm): ECCode vs bare Claude Code on a medium data-pipeline product

**One-line conclusion:** this plan can show, for one product shape with n=1 then n=3 per arm, whether ECCode delivers more correct, more faithful, less defective, more deployable and more autonomous builds than bare Claude Code on the same model, and at what cost. It **cannot** prove a general claim about "medium and large projects", cannot give statistical significance, and cannot separate ECCode's effect from its forced stack choice.

Status: PLAN ONLY. No build, arm, probe pack or comparator was run in the session that wrote this plan. Frozen at the commit hash recorded on the last line.

---

## 1. Context (honest, as recorded; nothing re-measured here)

- **Claim under test.** "With ECCode, an agent can build medium and large projects from a short master prompt with almost no human help, better or more reliably than plain Claude Code." This plan is designed so that this claim can fail (section 10).
- **S3 comparator (n=1, reviewer not identical to S3's).** On the same sealed PRD, bare Claude Code matched the engine on the hidden suite (24/24, 220 pass / 0 fail / 1 skip each) and on BOLA/IDOR (clean on both). Bare escaped 9 listed minor defects (4 of R-1..R-5, plus A-1, A-2, B-3, B-7, B-9) and the engine escaped 5 (R-1..R-5). The two lists come from **different reviewers**, and B-7 also reproduces on the engine tree, so the 9-vs-5 difference is an indicator only. The comparator compared build plus verification from an identical PRD written by the engine's own pipeline. It did **not** measure requirements quality.
- **Cost (two-ratio rule, always reported together).** IEQ per accepted criterion: engine 584,063 vs bare 10,819.6, **about 54×** on total S3 spend (86,412,734 all-processed tokens / 14,017,518 IEQ). Against the engine's two builder subagents alone (12,932,152 tokens / 2,308,733 IEQ) it is **about 8.9×**. The S3 total also bought G1 artifacts, sealed contracts, hidden-suite authoring and separation proofs that the bare run did not produce.
- **Model confound in S3.** Bare ran on claude-opus-5-5 throughout. S3 ran mostly on claude-sonnet-5-5 and switched to opus at about 22:10Z. This plan holds the model constant across arms (section 8).
- **S3.1 (head 650df34, `origin/s3-1/enforcement`).** This adds an engine-owned runtime guard (`lib/greenfield/runtime/eccode_runtime/`) and gate GF-RT-1. Enforcement is **opt-in** (`"gf": {"runtime": {"enforce": true}}`) and **off by default**. With the guard mounted, the S3 tree kept 24/24, and probe failures fell from 6 to 5. **R-1, R-2, R-4 and R-5 remain.**
- **Never measured before:** (a) requirements quality, meaning how well a vague prompt becomes a correct product; (b) autonomy, meaning human interventions per project.
- **Facts found while writing this plan that constrain it:**
  - ECCode supports exactly one stack profile, `python-fastapi-sqlalchemy-sqlite` (`lib/greenfield/constants.js:20`).
  - Nothing in `lib/greenfield/` mentions docker, compose or a background worker. The chosen product needs all three, plus a dashboard. ECCode may be **structurally unable** to deliver parts of it on the managed path. This is a real result, not a reason to exclude it (prerequisite P-5, section 11).
  - `docker` and `docker compose` (v5.6.1) and `claude` (2.1.319) are installed in this container. Whether the docker daemon runs was **not** checked (no build in this session).

## 2. Chosen project and master prompts (owner choice: candidate B, "Meterline")

The owner chose B from three candidates. A (multi-tenant expense SaaS) and C (multi-window internal tool) are in `docs/build/gf-s4-plan-record/candidates.md`. B's prompt was drafted in this session and is used **verbatim**. The only proposed addition is the sample-file attachment in 2.3, which is owner decision D-4.

### 2.1 Stage 2 master prompt (full B, verbatim, frozen)
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

### 2.2 Stage 1 pilot master prompt (reduced B, verbatim, frozen)
The pilot drops charts and alert handling and keeps everything that the hidden suite can check mechanically.
```
We manage about 50 buildings and get electricity meter readings as CSV files dropped in a folder,
sometimes late, sometimes duplicated, sometimes with broken rows.
I want a system that picks up the files, cleans them, stores the readings and computes daily usage per building.
Flag readings that go backwards and meters that stop reporting.
Building managers should log in and see only their buildings; we (the operators) see everything.
A simple web page listing daily usage and alerts is enough for now, plus an API so our billing system can pull the daily numbers.
It must run with docker compose and survive restarts without losing or double-counting data.
Use whatever stack you think is best.
```

### 2.3 Attachment given identically to every arm (proposal; owner decision D-4)
File `sample-readings.csv`. Without a fixed file format, no black-box fixture can be fed to three differently designed systems unless an adapter carries business logic, which would contaminate the measurement.
```
meter_id,building_id,timestamp,reading_kwh
M-0101,B-01,2026-10-01T00:00:00Z,15230.4
M-0101,B-01,2026-10-01T01:00:00Z,15232.1
M-0102,B-01,2026-10-01T00:00:00Z,8811.0
M-0102,B-01,2026-10-01T01:00:00Z,8812.6
M-0201,B-02,2026-10-01T00:00:00Z,40001.9
M-0201,B-02,2026-10-01T01:00:00Z,40007.3
```
The prompt deliberately leaves these points unstated: that `reading_kwh` is a cumulative register, the time zone of a "day", the threshold for "stops reporting", and how broken rows look. These are requirements-quality probes (section 6, M2).

## 3. Arms

| Arm | What runs | Config |
|---|---|---|
| **a. bare** | Claude Code CLI, headless (`claude -p`), master prompt plus attachment in an empty workspace | no ECCode, no CLAUDE.md, no skills or plugins, no MCP servers |
| **b. ECCode default** | the same CLI in a workspace holding an ECCode engine export of 650df34 (`git archive 650df34` excluding `docs/`), project created by `init` with defaults | `gf.runtime.enforce` absent (off) |
| **c. ECCode enforce** | as b | `.eccode/config.json` has `"gf": {"runtime": {"enforce": true}}`, set by the operator script before the prompt (this is not an intervention, it is the arm's definition) |

Held equal in every arm:
- **Model:** the same pinned model id, passed with `--model`, for the session and every subagent. The id is fixed by owner decision D-5; proposed `claude-opus-5-5`.
- **CLI version:** `claude --version` is recorded and must be identical.
- **Prompt and files:** the same master prompt bytes (sha256 recorded), the same attachment.
- **Permissions:** the same permission mode (`bypassPermissions`), applied inside the sandbox in 3.1.
- **Ceilings:** the same per-arm token ceiling and wall-clock ceiling (section 9).
- **Operator policy:** the same decision table (section 6, M4).

### 3.1 Isolation (anti-gaming, R11)
- Each arm runs as a separate process tree inside a bubblewrap sandbox (bwrap 0.9.0 was installed in S3.1 I0). The sandbox binds only: the arm's own workspace, the toolchain (node, python, docker socket if D-6 allows), and the network the arm needs for package registries.
- It does **not** bind `/home/user/ECCode`, `/root/.cache/s4-hidden/`, any other arm's workspace, or the operator scratchpad.
- Arms run **sequentially**, in an order fixed by a coin-flip script whose seed is committed before Stage 1. No arm's output exists while another arm runs except the finished ones, and those are outside its sandbox.
- After each run, the S3 contamination-scan approach (`gf-s3-comparator-record/bare-out/contamination-scan.py`, reused unchanged) checks the arm transcript for any path or distinctive phrase from the hidden material. The scan list is frozen with the manifest: the four change-request titles, file names of the suite, the review brief's first line and the rubric item ids. **A hit voids the run.** The arm is re-run once; a second hit aborts the stage.

## 4. Hidden acceptance suite: authoring and freeze (before any run)

1. **Author.** One fresh-context headless agent: `claude -p` in an empty temp dir, same pinned model, no repo, no ECCode. It is given **only** (i) the master prompt from 2.1 or 2.2, (ii) `sample-readings.csv`, (iii) the fixed authoring instruction in Appendix A, and (iv) the driver interface in Appendix B. It writes:
   - `pilot/` and `full/` suites, as pytest files that call only the driver interface;
   - fixture CSV corpora with an answer key (expected daily usage per building and date, and expected alerts);
   - a criteria list, where each criterion is one or more tests and passes only if all its tests pass, as in S3.
2. **Second author for the rubric.** A separate fresh agent, given only the prompt, the attachment and Appendix C, writes the requirements-quality rubric. Keeping it separate means the rubric is not shaped by the suite.
3. **Change-request suites.** The suite author (step 1) also receives the change-request texts (Appendix E) and writes `cr/` tests for them, in the same session and before any run.
4. **Freeze.**
   - Everything is copied to `/root/.cache/s4-hidden/` (mode 0700), outside the repo.
   - `sha256sum` of every file goes to `docs/build/gf-s4-record/hidden-manifest.sha256`, which is committed **before Stage 1 starts**. Its commit hash is the suite freeze point.
   - The hidden files themselves are **not committed** until all Stage 1 runs and scoring are done.
   - Before every scoring run: `sha256sum -c hidden-manifest.sha256`, which must pass 100%.
5. **Who may read it.** The scoring harness and the adapter step (section 5) only, never an arm. Suite edits after the freeze are forbidden. A suite bug found during scoring is logged as a deviation: the test is reported both as written and as "suite defect", and is not silently fixed.
6. **Calibration (before Stage 1, no arm involved).** The suite authors also write a small reference implementation, which is **not** given to any arm. The suite must pass on it. This proves that a passing system can exist and that the fixtures are self-consistent. Tests the reference cannot pass are removed **before** the freeze, and logged.

## 5. Adapters (connecting black-box tests to arm-chosen designs)

Arms choose their own paths, auth schemes and folder locations. Appendix B defines a fixed driver interface of about 12 operations, for example `drop_file(path)`, `login(role, building_ids)`, `daily_usage(building, date)`, `alerts(building)` and `restart()`.

- **Who writes it.** After an arm finishes, a fresh-context **adapter author**, the same for every arm, writes one adapter per arm. It is given only the driver interface, Appendix D (adapter rules), and a copy of the delivered tree with `.eccode/` and `docs/build/` removed, to reduce unblinding. It does not see the suite or the answer key.
- **What an adapter may do.** It may only translate calls (HTTP, file copy, `docker compose` commands). It must contain no arithmetic on business values. This is enforced by a frozen checklist and by a second agent that checks the adapter against Appendix D.
- **Unmapped operations.** An operation the author cannot map from the tree's own docs or code is marked `UNMAPPED`. Every test using it fails, and this counts as a requirements and documentation defect of the arm.
- **Limit.** Arm identity is visible from the stack (ECCode forces FastAPI/SQLAlchemy/SQLite). Full blinding is not possible, and this is disclosed in section 8.

## 6. Metrics (each with an operational definition and its procedure)

All raw outputs go to `docs/build/gf-s4-record/<stage>/<arm>/<run>/`. Every run is reported individually (R6).

| Id | Metric | Definition | Procedure / command |
|---|---|---|---|
| M1 | Hidden-suite pass rate | criteria passed / criteria total. A criterion passes iff all its tests pass. Raw pass/fail/skip counts are also reported. | `sha256sum -c hidden-manifest.sha256 && S4_ADAPTER=<arm adapter> python -m pytest -q -p no:cacheprovider --junitxml=junit.xml /root/.cache/s4-hidden/<stage>/`, then `tools/criteria.py junit.xml criteria.json`. Run **twice**; differing results mark the flaky tests and are reported. |
| M2 | Requirements quality | Score on the frozen rubric (Appendix C): K items (expected 12-20) about the intent of the prompt, for example "duplicates never double-count", "backwards reading flagged, not silently dropped", "the meaning of 'day' is stated and consistent". Each item gets 0 (absent or wrong), 1 (partial or undocumented) or 2 (correct and stated). | Two independent fresh-context scorers per arm. Each gets the rubric, the blinded tree copy (as in 5) and the M1 junit output **with the arm label removed**. Both scores are reported per item. No averaging hides disagreement: the score is reported as a [min, max] pair. |
| M3 | Escaped defects | Uses **one** fixed review brief (Appendix F, verbatim, frozen) and a fresh-context reviewer per arm, on the same model. Every finding is reproduced by a script before it counts. Then **every reproduced finding from every arm is checked on every arm's tree** (the "union matrix", the lesson from B-7). An arm's escaped defects = union findings present in its tree, by severity. | `tools/repro-union.py <findings dir> <tree> → matrix.csv`. Severity uses the brief's fixed definitions. The S3 reviewer-difference problem is removed because the same brief and the same matrix apply to all arms. |
| M4 | Human interventions | Count per arm, by type, using the closed taxonomy below. | Manual log `interventions.jsonl` plus the automatic count from transcripts (P-4). **They must match**; a mismatch is reported and the higher count is used. |
| M5 | Cost | All-processed tokens and IEQ (`input + 0.1·cache_read + 1.25·cache_write + 5·output`), summed over the session and all subagents per arm. Also per criterion passed. | `lib/greenfield/usage.js` via `tools/snap4.js` arithmetic on each arm session id. Report the **two ratios together**: (i) the ECCode arm total vs bare total, per criterion; (ii) ECCode builder subagents only vs bare. No dollar figures (R5). |
| M6 | Wall-clock | (i) elapsed time from the first prompt to the final exit; (ii) active time = (i) minus the operator latency between an arm exit and the resume. | Timestamps from the transcript and `interventions.jsonl`. |
| M7 | Runs deployed | PASS iff all of: fresh copy of the tree; `docker compose up -d --build` exits 0 within 600 s; the health op (via adapter) succeeds within 300 s; smoke: drop `sample-readings.csv`, and within 120 s `daily_usage(B-01, 2026-10-01)` equals the answer-key value; a manager of B-01 cannot read B-02; `docker compose restart`, then the same query returns the same value and the row count is unchanged; `docker compose down -v`. | `tools/deploy-check.sh <tree> <adapter>`, frozen with the manifest. |

### 6.1 Intervention taxonomy (closed, fixed before any run)

**Counted:**
- **approval:** a human approves a gate, slice, plan or permission.
- **clarification-answer:** a human answers a question from the arm.
- **correction:** a human gives technical direction or fixes something. This is forbidden by policy, but if it happens it is counted **and** logged as a deviation.
- **restart:** a human restarts a crashed or stuck process or environment.
- **unblock:** a human resumes an arm that stopped without claiming completion.

**Not counted:**
- the initial master prompt and attachment;
- the arm-definition config in section 3;
- the operator's measurement and scoring work after the arm's final exit;
- automated approvals done by an engine mechanism within a pre-set budget (P-2). These are reported separately as "automated approvals".

Operator decision table (the operator follows it mechanically, and never sends any other text):

| Arm state at exit | Operator action | Logged type |
|---|---|---|
| claims complete | stop; score | none |
| asks a question | resume with exactly: `I have no further information. Use your best judgement and continue.` | clarification-answer |
| stopped, not complete, ceiling not reached | resume with exactly: `Continue until the product is complete.` | unblock |
| ECCode gate waits for owner approval | approve iff the engine's own checks report no problem, else reject with the engine's message verbatim | approval |
| process crash or environment error | restart the same session once | restart |
| 5 resumes reached, or token or wall ceiling reached | stop; score the tree as is | none (recorded as "ceiling stop") |

## 7. Change-request phase (Appendix E texts frozen now)

After delivery and M1-M7 scoring, each arm receives the change requests in order, in the **same workspace**, using the same session resumed with `--resume` and the same operator table. In Stage 1 only **CR-1** is sent (cost; section 9). In Stage 2 all three are sent.

- **Regression** = criteria of the frozen delivery suite that passed at delivery and fail after the CRs. It is reported as a count and a list.
- **CR success** = criteria passed in the frozen `cr/` suite, authored in section 4 step 3.
- M3 (union matrix), M4, M5 and M6 are measured again for the CR phase and reported separately from the delivery phase.

## 8. Confound control

| Confound | Control | If it cannot be controlled: disclosure |
|---|---|---|
| Model | same pinned id via `--model`; every assistant message's `model` field is checked by script after the run | any message on another model (fallback) is listed per arm with its count. More than 5% of messages off-model voids the run |
| Model version / CLI | same `claude --version`; arms run within one 72 h window | version string recorded per run |
| Tool flags | identical command line except the arm definition; recorded verbatim | — |
| Stack | arms choose freely; ECCode is forced to its single profile | **cannot be controlled**: ECCode's effect includes its stack. Disclosed in every conclusion |
| Hidden-suite author | one independent fresh agent, prompt-only input, frozen before any run | same model family as the builders (as in S3); disclosed |
| Reviewer | one frozen brief, one fresh reviewer per arm, union matrix | reviewer instances differ per arm; the matrix removes count bias but not discovery bias; disclosed |
| Rubric scorer | two blind scorers, scores reported as a [min, max] pair | blinding is partial (stack reveals ECCode); disclosed |
| Adapter author | same instruction for all arms, checked by a second agent | it can fail to map a working feature; `UNMAPPED` ops are listed for owner audit |
| Operator behaviour | mechanical decision table, fixed texts | any off-table action is a deviation with timestamp |
| Order and time | randomised arm order (committed seed), sequential runs | API latency and load differ by time; wall-clock is reported, not ranked within 20% |
| Randomness | no seed control exists for the model | n=1 in Stage 1 means variance is unknown; Stage 2 n=3 shows the spread only, not significance |
| Docker / host | same container image and docker version for all arms and for `deploy-check.sh` | recorded |

## 9. Budget and staging

### 9.1 Estimation method (S3 actuals are the only anchor)
- **Anchors:** S3 engine 86,412,734 tokens / 14,017,518 IEQ (24 criteria, small task tracker); bare 668,034 / 259,671.2; reviewers 1.23M (S3) and 3.37M (comparator) tokens.
- **Size factor (assumption, stated):**
  - pilot B vs the S3 task tracker: 1.0-1.5 (more moving parts: ingestion, compose, restart safety; fewer auth endpoints);
  - full B vs pilot: 1.3-2.0.
- **Variance and model factor:** 0.7-1.2. This is unknown run-to-run variance on n=1, plus the S3 engine having run mostly on Sonnet while this plan pins one model.
- **Formula:** forecast = anchor × size factor × variance factor, giving a low-high range. These are not confidence intervals.

| Item (Stage 1) | Low | High |
|---|---|---|
| Arm a (bare) build | 0.5M | 1.2M |
| Arm b (ECCode default) build | 60M | 156M |
| Arm c (ECCode enforce) build | 60M | 164M (+5% guard overhead) |
| CR-1, ×0.2-0.5 of build per arm | 24M | 161M |
| Suite + rubric + CR-suite + reference authoring | 5M | 15M |
| 3 adapters + checks | 3M | 9M |
| 3 reviewers (1.2-3.4M each) | 4M | 10M |
| 6 rubric scorings | 3M | 6M |
| Union-matrix reproduction + operator orchestration | 20M | 40M |
| **Total Stage 1 forecast** | **≈180M** | **≈562M** |

### 9.2 Stage 1 (pilot, prompt 2.2, n=1 per arm)
- **Per-arm ceilings** (equal for every arm): 170M all-processed tokens and 8 h wall-clock for the build phase; 60M and 3 h for CR-1.
- **Stage 1 total ceiling: 500M all-processed tokens. Pause at 400M (80%)** and report to the owner. CR-1 is the first item cut if the pause is reached before it starts.

**Abort criteria (any one, during Stage 1):**
- a contamination hit occurs twice;
- an R4 breach (a secret value in any transcript);
- the 500M total is reached;
- an arm run is voided by the model check twice;
- the hidden-manifest check fails.

**Continuation criteria for Stage 2.** All must hold. They are about **measurement validity, not about which arm looks better**. A poor ECCode result is **not** a reason to stop, and a good one is not a reason to continue.

| # | Criterion | Threshold |
|---|---|---|
| C1 | every arm produced a tree on which M1 and M7 executed | 3/3 |
| C2 | the adapter mapped the driver interface | ≥ 80% of ops on each arm, **or** the unmapped ops are confirmed absent from the tree by owner audit |
| C3 | suite stability | the two M1 runs agree on ≥ 98% of tests per arm |
| C4 | rubric scorer agreement | \|scorer1 − scorer2\| ≤ 20% of max score on every arm |
| C5 | intervention count reproducibility | automatic count = manual log on every arm |
| C6 | Stage 1 spend | ≤ 500M |
| C7 | owner says continue | explicit |

### 9.3 Stage 2 (prompt 2.1, n=3 per arm = 9 runs, all three CRs)
- **Ceiling rule, pre-registered now:** per-arm-run ceiling = 2.0 × (the highest Stage 1 arm build actual) × 1.5, equal for all arms. Stage 2 total ceiling = Σ over runs of (forecast high from Stage 1 actuals × 2.0 size factor) + measurement overhead × 3.
- **Pause at 80%.** The ceiling is computed from Stage 1 actuals and committed before Stage 2 starts.
- **Provisional upper bound** (Stage 1 high-end actuals): 3.0 billion all-processed tokens. This is stated so the owner can judge feasibility now. It is a cap, not a forecast.

## 10. Pre-registered predictions and failure conditions

**Margin rule.** "Better" means beating the other arm by the margin below **in the same direction on every run of the stage**. With n=1 (Stage 1) a result is an *indicator*. With n=3 (Stage 2) it is "3 of 3", "2 of 3" and so on, reported per run. No p-values.

Margins:
- M1: ≥ 2 criteria.
- M2: ≥ 15% of the rubric max, on both scorers' min.
- M3: ≥ 2 fewer union defects (minor or above), or ≥ 1 fewer major or above.
- M4: ≥ 2 fewer interventions.
- M7: PASS vs FAIL.
- Regressions: ≥ 1 fewer.

### 10.1 Predictions (written before any run)

| Metric | a. bare | b. ECCode default | c. ECCode enforce | Basis |
|---|---|---|---|---|
| M1 | 70-90% criteria | 60-90% | 60-90% | S3 parity at 24/24; B has more undefined behaviour; ECCode's SQLite/no-compose profile may cost deploy-related criteria |
| M2 | lower on the stated-assumption items | higher on stated-assumption items (it writes a PRD); prediction: ≥ 15% better | as b | ECCode has a PRD stage; bare had none in S3 (not measured) |
| M3 | more input-handling defects (A-1/A-2/B-3 class) | fewer input-class defects; comparable data-semantics defects | fewest input-class defects | S3/S3.1 record; the union matrix may reveal shared defects as B-7 did |
| M4 | 0-2 (headless, unblocks only) | **higher**: 3-12 approvals unless P-2 exists | as b | ECCode gates require owner approval; no automated approval exists at 650df34 |
| M5 | 0.5-1.2M tokens (forecast) | 30-150× bare (total ratio); 5-20× (builder-only ratio) | as b + ≤ 5% | S3 ratios 54× / 8.9× |
| M6 | < 1 h | 1-6 h | 1-6 h | S3 bare 266 s vs engine build 1 h 01 m, on a smaller product |
| M7 | likely PASS | **at risk**: no compose/worker in the engine's stack profile | at risk | section 1 finding |
| CR regression | 0-3 | 0-2 | 0-2 | sealed contracts may help; untested |

### 10.2 Failure conditions: results that count AGAINST the claim (numeric)
Each is evaluated per run, then for the stage. The claim is "ECCode better or more reliable, with almost no human help".

- **F1 (correctness):** an ECCode arm passes ≤ bare criteria + 1 on M1. Within margin or worse means no correctness benefit.
- **F2 (autonomy, absolute):** an ECCode arm needs > 3 counted interventions to delivery. This contradicts "almost no human help" whatever bare does.
- **F3 (autonomy, relative):** ECCode interventions ≥ bare interventions.
- **F4 (defects):** an ECCode arm's union-matrix escaped defects (minor or above) ≥ bare's − 1, **and** its major-or-above count ≥ bare's.
- **F5 (requirements quality):** ECCode's rubric min score ≤ bare's rubric max score. Scorer spread covers the gap, so there is no demonstrable benefit.
- **F6 (deployability):** ECCode M7 = FAIL while bare M7 = PASS.
- **F7 (maintainability):** ECCode regressions after the CRs ≥ bare regressions, **or** ECCode CR-suite pass ≤ bare CR-suite pass.
- **F8 (cost without benefit):** ECCode IEQ per criterion > 10× bare (on the total ratio) **and** none of M1, M2, M3, M4, M7 is better by its margin.
- **F9 (enforcement adds nothing):** arm c is not better than arm b on M3 by its margin. This counts against the value of `gf.runtime.enforce`, not against ECCode as a whole.

Reading the results: if F1, F3, F4, F5 and F6 all hold in Stage 2 in ≥ 2 of 3 runs, the report must say **"ECCode is not better on this product (n=3)"** in its title.

### 10.3 What each outcome pattern would mean (no direction is chosen here)
- **(i) ECCode better on quality and autonomy** (F1, F2, F4 and F5 all fail to hold). The claim survives for this product shape, at a measured cost multiple. Next questions: a second product shape (A or C) and whether the cost multiple can be cut, for example by trimming orchestration that the builder-only ratio shows is overhead.
- **(ii) Better only on audit and trust properties.** Here M1, M2 and M4 show no benefit, but M3 is better, the record and sealed contracts exist, and possibly c > b. ECCode's value is then verification and accountability, not autonomy or speed. The claim as worded fails. A narrower claim ("safer, auditable builds at k× cost") is what the evidence supports. Product implication: position as a verification and enforcement layer that can wrap bare builds (the S3.1 bare-transfer copy already showed the guard transfers: 26 → 6 probe failures).
- **(iii) No measurable benefit** (F1 and F3-F6 hold, plus F8). The claim fails on this product. Implications: either the pipeline's overhead is not buying quality at this size, or the benefit only appears at sizes beyond one context window (candidate C), which would need its own test. Continuing to claim (i) without new evidence would be inconsistent with the record.

## 11. Prerequisites before Stage 1

| # | Item | Type | Status / options (not decided here) |
|---|---|---|---|
| P-1 | **Default-on for `gf.runtime.enforce`** | **OWNER DECISION** | **Alternatives:** (1) keep opt-in; arm c sets it by config (this plan works as written; b vs c measures the flag). (2) Turn it on in `initProject`: `tests/gf-flow.test.js:38` (`deepStrictEqual(cfg.gf, {enabled, schemaVersion, stackProfile, isolation})`) fails, and that test may not be edited under the S3.1 rules, so this needs the owner to lift that rule or approve a new test version. Arm b then becomes identical to c, and the plan drops to two arms. (3) Turn it on by a separate `init --enforce` default in a wrapper, with no change to `initProject`. The test stays green, but there are two code paths. **Consequences:** (1) means the default product is unprotected and the experiment says so; (2) means a test change and loss of the b/c comparison; (3) adds a path to maintain. |
| P-2 | **Automated slice approval inside a budget** | ENGINEERING (design sketch only) | **Sketch:** a policy file `gf.autoApprove = {maxSlices, maxTokensPerSlice, requireChecksGreen: true, requireIsolationChecked: true}`. When a slice's `gf.battery.recorded` is green, `gf.isolation.checked` passes, and spend is under budget, the engine records `gf.slice.accepted` with `reviewer: "policy"` and the policy hash. Any red check falls back to human approval. The policy hash is part of the event chain, so audit replays it. **Without P-2, F2 is very likely to fire.** Whether to build it before Stage 1 is **OWNER DECISION D-2**: building it first tests "ECCode as it could be"; not building it tests "ECCode as it is". |
| P-3 | R-1, R-2, R-4, R-5 status | OWNER DECISION D-3 | They remain open at 650df34. They are defects of the S3 task tracker tree, not of B, and B's adapter does not exercise them directly. The plan does **not** need them closed. Closing them first changes the engine under test, so the commit used becomes the new base, re-frozen in section 3. R-4 (auth-order) is moved to S4a GF-PIPE-1 by S3.1. **Recommendation is not made; options:** run at 650df34 as is, or close first and re-base. |
| P-4 | Automatic intervention count from the event record | ENGINEERING | **Bare:** count user-role, non-synthetic transcript events after the first (`list_events`-equivalent parse of the session jsonl), plus a tag in the operator wrapper. **ECCode:** the same, plus `gf.review.recorded` / `gf.slice.accepted` events whose reviewer is a human role. Deliverable: `tools/count-interventions.js <session jsonl> [<.eccode/events>] → {type: count}`, tested on the S3 record before Stage 1. |
| P-5 | ECCode stack support for compose, worker and dashboard | **OWNER DECISION D-1** + ENGINEERING | The engine has one profile, `python-fastapi-sqlalchemy-sqlite`, and no compose or worker handling. **Options:** (1) run as is and let ECCode deliver what it can, with work outside the managed path left to the agent; this measures the current product. (2) Add a profile first; this delays Stage 1 and tests a new engine. **Consequence of (1):** M7/F6 failures may reflect profile scope, not pipeline quality, and the report must say so. |
| D-4 | Attach `sample-readings.csv` (2.3) to the prompt | OWNER DECISION | Without it, fixtures need logic-bearing adapters (invalid). With it, the prompt is slightly less vague than drafted. |
| D-5 | Pinned model id for all arms | OWNER DECISION | proposed `claude-opus-5-5` (bare S3 model); the S3 engine anchor was mostly Sonnet, so the estimates carry the 0.7-1.2 factor |
| D-6 | Docker inside the arm sandbox | ENGINEERING + OWNER DECISION | arms need docker to self-test compose. Giving the docker socket weakens the sandbox (a container can mount host paths). **Options:** rootless docker per arm, or no docker for arms (M7 is still run by the operator). Not decided. |
| P-7 | Docker daemon runs in this container | ENGINEERING | not checked in this session (no build allowed) |
| P-8 | Tools: `criteria.py`, `repro-union.py`, `deploy-check.sh`, adapter checklist, coin-flip seed, contamination scan list | ENGINEERING | written and committed before the suite freeze; none written yet |

## 12. Deviations (this planning session)
1. **R1 ordering.** Before snapshot 00, I ran one `cat` of `docs/build/gf-s3-1-record/tools/snap3.js` and an `ls` of `docs/build/` to find the helper. This was not a find or git command, but it was not snapshot 00 either.
2. **Helper adaptation.** The working-tree `snap3.js` was still configured for the S3.1 session (old session id, 40M/32M, required `00-start.json`). I adapted it with `sed` into `docs/build/gf-s4-plan-record/tools/snap4.js`: session id, scratchpad path, CAP/PAUSE = 8M/6M, and a zero baseline when no start file exists. The arithmetic is unchanged.
3. **Prompt delivery.** The master prompt arrived as a system-delivered message, not a typed user turn. The owner's project choice (B) came through AskUserQuestion.
4. **Worker restart.** The session's worker process restarted once after the candidates were drafted. I checked the state (branch `s4-plan/experiment`, the scratchpad candidates file) and continued.
5. **Prompt attachment.** The sample CSV (2.3) is an addition to the chosen prompt. It is proposed, not imposed, and is listed as D-4.

## 13. Limits
- **One product shape.** It does not generalise to "medium and large projects". Candidate C (multi-window) is untested.
- **Small n.** n=1 then n=3 per arm. Variance is shown, not tested.
- **Shared model family.** Builders, suite author, rubric author, reviewers, adapter author and scorers share one model family.
- **Partial blinding.** The stack reveals the ECCode arms.
- **Forced stack.** ECCode's effect cannot be separated from its forced stack.
- **Adapter risk.** The adapter layer can mis-map a working feature. `UNMAPPED` lists are audited, but an adapter error still biases M1 down.
- **Wide forecasts.** Cost forecasts span about 3× (S3 n=1 anchor, size factors assumed).
- **Not measured:** long-term maintainability beyond three CRs, team use, production load.

## 14. Commands that reproduce every number cited here
```bash
cd /home/user/ECCode
# S3 totals, wall time, criteria (86,412,734 / 14,017,518 / 584,063 / 1 h 01 m):
grep -n "86,412,734\|584,063\|1 h 01 m" docs/build/gf-s3-evidence.md
# Comparator: 24/24, bare 668,034 / 259,671.2 / 10,819.6, 54x, 8.9x, builders 12,932,152 / 2,308,733, reviewers:
git show origin/claude/modest-wozniak-mwpzbm:docs/build/gf-s3-comparator-evidence.md | grep -n "668,034\|8.9\|54\|12,932,152\|3,369,270\|1,227,036"
# S3.1: 24/24, 6 -> 5 probe failures, R-1/R-2/R-4/R-5 remain, enforcement opt-in, bare-transfer 26 -> 6:
git show 650df34:docs/build/gf-s3-1-evidence.md | sed -n 1,30p
# Single stack profile; enforcement flag; the test the flag would break:
sed -n 20p lib/greenfield/constants.js; sed -n 203,206p lib/greenfield/runtime.js; sed -n 38p tests/gf-flow.test.js
grep -rln "docker\|compose" lib/greenfield/ || echo "no compose support in lib/greenfield"
# S3 budget registration (model, IEQ formula):
cat docs/build/gf-s3-record/budget-registration.json
# This session's spend:
node docs/build/gf-s4-plan-record/tools/snap4.js '<label>' <out.json>
# Tool versions recorded at plan time:
claude --version; docker compose version
```

## Appendix A: hidden-suite authoring instruction (verbatim, frozen)
```
You are writing an acceptance test suite for a product described only by the owner's request below and the attached sample file.
You will never see the implementation. Several different teams will build it with different stacks.
Write tests ONLY against the driver interface in driver.py (do not assume any URL, framework, database or file layout).
Test only behaviour the request states or that the sample file makes unambiguous. Where the request is vague
(what counts as a day, a spike, "stops reporting"), do NOT test a specific threshold; test only the invariant
(for example: a backwards reading is flagged somewhere and is not added to usage).
Required areas: ingestion of good files; duplicate files and duplicate rows never double-count; late files are
incorporated; broken rows do not stop the rest of the file; daily usage per building from cumulative readings;
backwards readings flagged; a silent meter eventually flagged (use a gap of 48 hours or more); manager scoping
(no read of another building through any operation); operator sees all; the billing pull returns the same numbers
as the web view; restart during and after ingestion loses nothing and double-counts nothing.
Produce: fixtures/*.csv, answer_key.json, tests/test_*.py, criteria.json mapping criterion ids to test ids,
and a minimal reference implementation in reference/ that passes every test (it will not be shown to builders).
Group tests into criteria of 1-10 tests each. Do not write tests that only the reference implementation's design could pass.
```

## Appendix B: driver interface (verbatim, frozen; `driver.py`)
```
health() -> bool
drop_file(local_csv_path) -> None           # place a file where the system picks files up
wait_ingested(timeout_s) -> bool             # True when the system reports the dropped files processed, or the timeout ends
login(role: "operator"|"manager", building_ids: list[str]) -> Session   # create the user if needed, return an authenticated session
daily_usage(session, building_id, date_iso) -> float | None
daily_usage_billing(building_id, date_iso, credentials) -> float | None  # the billing API
alerts(session, building_id=None) -> list[dict(kind_text, meter_id, building_id)]
mark_handled(session, alert) -> bool         # Stage 2 only
web_page(session) -> str                      # HTML/text of the page listing usage and alerts
restart() -> None                             # docker compose restart
reading_count() -> int                        # via any documented admin/operator means; UNMAPPED is allowed
reset() -> None                               # docker compose down -v && up -d
```

## Appendix C: rubric authoring instruction (verbatim, frozen)
```
From the owner's request and sample file only, list 12-20 items that a faithful product must get right in the
owner's intent, including at least: what each assumption the request leaves open was resolved to and whether that
choice is stated to the user (time zone of a day, cumulative vs interval readings, what is a spike, what is
"stops reporting", what happens to broken rows, how duplicates are detected, what "survive restarts" guarantees),
and whether the delivered behaviour matches the stated choice. Score each item 0 (absent or contradicts intent),
1 (partly right or not stated), 2 (right and stated). Give for each item the evidence a scorer must look at.
Do not reward any particular technology.
```

## Appendix D: adapter rules (verbatim, frozen)
```
Implement driver.py for the delivered system using ONLY its own documentation and code.
Allowed: HTTP calls, file copies to the documented drop location, docker compose commands, reading documented env vars.
Forbidden: any arithmetic, filtering, aggregation or conversion of business values; direct database reads unless the
system documents them as an operator interface; editing the delivered system. If an operation cannot be mapped,
raise Unmapped("<reason>"). Output: driver.py and mapping.md (one line per operation: how it was mapped, or why not).
```

## Appendix E: change requests (verbatim, frozen; titles are contamination-scan strings)
```
CR-1 "Interval meters": Some new meters send the energy used in each interval instead of a running total.
Their files have an extra column mode with the value interval. Support both kinds in the same folder and the same totals.

CR-2 "Monthly building report": Operators and managers want to download, for any month, a CSV with one row per day
and per building they can see, with total usage and the number of alerts that day.

CR-3 "Corrected readings": Operators sometimes need to replace a wrong reading. Let them do it, recompute the
affected daily numbers, and keep a record of who changed what, when, and the old value.
```

## Appendix F: independent review brief (verbatim, frozen; the same for every arm)
```
You are reviewing a delivered software system against its owner's request (below) and the sample file. You have the
code, its docs and its own tests in {TREE}. Work only in {WORK}. You do not have and must not look for any other
acceptance suite. Find defects that a real owner would care about, and reproduce each with a runnable script or test
in {WORK}/probes. Cover at least: access control between buildings and roles (including id tricks and enumeration),
authentication and session handling, input handling (malformed CSV, encodings, huge files, path tricks in file names),
data correctness (duplicates, late data, backwards readings, time zones, restart during ingestion), the billing API,
error responses leaking data, the docker compose deployment (secrets, exposed ports, default credentials), and
documentation that contradicts behaviour. For each finding give: id, severity (major: data loss, wrong numbers,
cross-building read, auth bypass, secret exposure; minor: everything else that violates the request or safe practice),
summary, reproduction command, observed vs expected. Do not report style issues. End with a list of what you checked
and found clean.
```

Freeze point: (recorded after commit)
