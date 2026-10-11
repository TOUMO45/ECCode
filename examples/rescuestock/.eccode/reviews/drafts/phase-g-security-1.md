# phase:g-release: security review, iteration 1 (FINAL)

**Verdict (security): APPROVE, with two minor findings to route before delivery.**
- **SEC-G-1** is the scope of the RS-29 secrets scan.
- **SEC-G-2** is gaps in the T20 SQL scan. The T20 deviation is **accepted on that condition**.
- Neither is a present defect. No secret is in the tree today, no SQL injection exists in the code today, and both scans catch the cases they were built for.
- Each finding has a reproduction and a resolution condition. Following the severity rule used on every gate so far (minors are routed and fixed or narrowed before delivery), they do not hold this gate.
- Labelling (RS-34), the live-suite refusals (NFR3/FU-37), the clean-checkout script and the documents passed my own probes.

Reviewer: security-reviewer, run run-mv4erf3l-01c5397d. Gate: `phase:g-release`. Submission: `sub-mv4eqme2-01a6e8e9`.
- **Handoffs:** g1 ho-mv48fejc-0156303e, g2 ho-mv48w355-01947d26, g3 ho-mv4e9r0t-01a6813c.
- **Read:**
  - `.eccode/artifacts/phase-g/submission.md`;
  - followups "Added after phase G";
  - `test/scan/{secrets,sql,live-refusal}.test.js`;
  - `scripts/clean-checkout.sh`;
  - README, `.env.example`, `docs/runbooks/*`, `docs/submission/*`;
  - `test/browser/labelling.test.js`;
  - the live runners.
- **Who records:** the technical-reviewer records the gate after this FINAL. I did not run `gate review`.

## Evidence (security-reviewer, gate phase:g-release, all after sub-mv4eqme2-01a6e8e9)

**Tree.** Every run carries tree digest `7c898c91…`, the submission's.
- HEAD `4ed2e43` adds records only: no diff of src/test/public/scripts/docs/README/.env.example/package*.json after `f4f5f9b`.
- All 42 artifacts match their recorded sha256 (ev:ev-mv4fanp4-013653d0, run last).

**Safety.**
- Loopback only. No live variable was ever set; the live probes unset them.
- No edit to the real tree, and no commit. The scratch git work tree of the clean-checkout probe was only `git add`ed, never committed.
- Both suites ran inside `flock /tmp/rescuestock-suite.lock`.
- Mutants: each in a fresh `sec-g/mut-<name>/`, with the diff kept as `sec-g/<name>.diff`.
- **Not run by me:** the last step of g3's plan command, `sh scripts/clean-checkout.sh`. It runs `npm install` against the npm registry, which is outside my loopback-only rule. I probed the script instead with a stub `npm` (CC-PROBE). The delivery lead's ev:ev-mv4ejk73-01c85373 covers the real run.

**Probes.** They live in `/tmp/claude-0/-home-user-ECCode/f72396f5-b89f-576d-a680-29d481cd71c9/scratchpad/sec-g/`.

| ev id | what | result |
|---|---|---|
| ev:ev-mv4f145z-013eb970 | **P-PLANT** (`run-plant.sh`, `plant-secrets.mjs`): canaries planted in 17 places of a scratch copy; which do the copy's own `secrets`/`frontend`/`docs` scans report? | **7 caught, 10 missed** (SEC-G-1) |
| ev:ev-mv4f14wy-01f20ab0 | **P-SCOPE** (`p-scope.mjs`): the scan's own shapes (copied verbatim) over all 817 tracked/unignored files, all PNG chunks | no real credential anywhere (every hit is a canary, a test placeholder, hyphenated prose, or my own phase B probe's fake `sk-live-REALSECRET…`); shows what lies outside the scope |
| ev:ev-mv4eyjwl-0119e42f | T20 mutant **ms-1-name-reuse** | **SURVIVED** (SEC-G-2) |
| ev:ev-mv4eykls-01fcaa00 | T20 mutant **ms-2-exec-variable-route** | **SURVIVED** |
| ev:ev-mv4eylav-010d5ea8 | T20 mutant **ms-3-space-before-paren** | **SURVIVED** |
| ev:ev-mv4eylz3-0130066c | T20 mutant **ms-4-bound-alias** | **SURVIVED** |
| ev:ev-mv4eymp2-01040eeb | T20 mutant **ms-5-control-inline** (control) | killed |
| ev:ev-mv4ewm10-01f01459 | **LIVE-REAL-RUNNER**: the real `npm run test:live-model` and `npm run test:live-paypal`, no flag, no credentials, net guard injected into every Node process | refusals; no network attempt; no `reports/` written |
| ev:ev-mv4ex31x-0112ab69 | **P-GATES**: the live gates' pure functions with near-miss flags, ceilings and partial credentials | ALL EXPECTATIONS MET |
| ev:ev-mv4f119i-01b75fe7 | **P-LABELS**: RS-34 in Chromium at 360/1280 against the real server (the README demo: fake, no test mode) and the Sandbox-without-test-mode label set | ALL EXPECTATIONS MET |
| ev:ev-mv4f23u2-0180cb1e | **CC-PROBE**: `scripts/clean-checkout.sh` on a scratch git work tree, stub `npm` | user tree unchanged; see SEC-G-I2 |
| ev:ev-mv4f2qpx-01be15d6 | g1 plan command, verbatim | 242/242 |
| ev:ev-mv4f2r7x-0132436f | g2 plan command, verbatim | 27/27 |
| ev:ev-mv4f7x80-016be1c4 | g3 plan command **without** its final `sh scripts/clean-checkout.sh`, in the lock | exit 0; browser 28/28 |
| ev:ev-mv4fa3k7-01623b24 | `flock … npm test` (counts) | **2393 tests, 2385 pass, 0 fail, 8 skipped**; NFR5 p95 56.6 ms, suite 100.8 s |
| ev:ev-mv4fa647-01b534d3 | `test/scan/secrets.test.js` alone after my browser run (screenshots present) | 15/15, 0 skipped |
| ev:ev-mv4fanp4-013653d0 | The 42 artifacts still have their sha256 | 42/42 |

**How to read the mutant and probe rows.** The runner scripts always exit 0, so they show "passed" as evidence status; the verdict is in each row's output.

## Findings

### SEC-G-1 (minor): the RS-29 secrets scan does not cover everything the repository ships

**What the scan covers** (`test/scan/secrets.test.js` L382-L529):
- `public/**` (as UTF-8 text);
- `test/fixtures/**/*.json`;
- `README.md`, `.env.example` and `docs/**/*.md`;
- the **tEXt/zTXt/iTXt** chunks of `test/browser/out/*.png`;
- the logs of servers it drives itself;
- configuration errors.

**What it does not cover:**
- **`.eccode/`**, which is tracked in git and ships with the repository: 38 artifacts, 115 drafts, 72 handoffs and **72 run logs (`.eccode/evidence`, 92 MB)**. This is where a live run recorded with `eccode evidence run` would land.
- `src/`, `scripts/`, `package.json`, and test sources.
- Non-`.md` documents.
- PNGs outside `test/browser/out` (`docs/`, the fixture images).
- PNG chunks other than the three text types: `eXIf`, private chunks.

**Reproduction** (P-PLANT, ev:ev-mv4f145z-013eb970). The suite's own canary `CANARY.clientSecret` was planted in a scratch copy, then the copy's `secrets.test.js`, `frontend.test.js` and `docs.test.js` were run.
- **Caught (7):**
  - README;
  - `.env.example`;
  - `docs/runbooks/*.md`;
  - `public/js`;
  - a fixture JSON;
  - a screenshot tEXt chunk;
  - a PNG under `public/img`. This last one is caught only *incidentally*, by the invisible-character check that fails any binary file under `public/`, not by the secret scan.
- **Missed (10):**
  - a screenshot `eXIf` chunk;
  - a screenshot private chunk;
  - `docs/submission/*.txt`;
  - a `docs/*.png` zTXt;
  - `src/*.js`;
  - `scripts/*.sh`;
  - `.eccode/artifacts/*.md`;
  - **`.eccode/evidence/*.log`**;
  - a fixture image tEXt;
  - a `package.json` field.

**Present state.** P-SCOPE (ev:ev-mv4f14wy-01f20ab0) applied the scan's own shapes to all 817 tracked/unignored files and every PNG chunk. It found **no real credential**: every hit is a test canary, a test placeholder, hyphenated prose matched by the token shape, or a deliberately fake value in an earlier security probe.

**Impact.**
- RS-29's row reads `verified` for "no client id or secret in assets, recorded responses, logs, screenshots or submission files". The disclosed limits mention shapes, and screenshots by text chunk, but not this **scope**.
- The realistic future leak path is a live run's output, or a live webhook sample (`docs/runbooks/live-paypal.md` §5 rightly calls it sensitive), saved into the tracked `.eccode/`. The scan would not see it, and the checklist's `git grep` only matches *assignment-shaped* secrets, not a raw 80-character credential.
- The runbooks themselves are good: hidden prompts, secret stores, unset afterwards, rotate if exposed.

**Resolution condition.** Either:
1. Extend the scan to every git-tracked or untracked-unignored file, including `.eccode/`, and to **every** PNG ancillary chunk. Allow-list only, by path, the test sources that hold canaries or fake credentials by design. P-PLANT's ten misses must then be reported. Or:
2. Narrow RS-29's evidence-table row and the verification report to the scanned scope, and add to `docs/submission/checklist.md` B a pre-publication check of `.eccode/evidence` for raw credential values.

Owner: orchestrator (g3's file; release checklist).

### SEC-G-2 (minor): the T20 SQL scan lets four kinds of unsafe SQL through; the deviation is accepted on condition

**The decision asked for.** The per-file allow-list keeps the property T20 protects for the code as it is.
- I checked the risky allow-listed sites:
  - `webhooks.js` `column` comes from a constant lookup table;
  - `view.js` `ph`, `runColumns` and `versionColumns` are placeholder lists and string literals;
  - `admin.js` `where`/`a.sql`/`afterClause` use literal columns and `?`;
  - `calls.js` `assignments` is checked against `OPERATION_COLUMNS`;
  - `general-limit.js`/`connection.js` use range-checked integers.
- It is **stronger** than the spec's literal ban in one respect: `prepare(variable)` fails unless listed.
- It is **weaker** in one respect: name reuse (ms-1, below).

**Reproduction** (each mutant parses and is in a fresh copy; only `test/scan/sql.test.js` was run):

| Mutant | What it adds | Scan |
|---|---|---|
| ms-1-name-reuse (ev:ev-mv4eyjwl-0119e42f) | in `src/services/calls.js`: ``const where = `status = '${filter}'`; db.prepare(`SELECT … WHERE ${where}`)``. `where` is allow-listed for that file. | **survives**. The stale-entry check only catches *unused* entries. |
| ms-2-exec-variable-route (ev:ev-mv4eykls-01fcaa00) | in `src/routes/health.js`: `ctx.db.exec(ctx.query.sql)` | **survives**. `.exec(<non-literal>)` is skipped as "probably RegExp" (L228), even in the route layer with its **empty** allow-list. |
| ms-3-space-before-paren (ev:ev-mv4eylav-010d5ea8) | ``db.prepare (`… '${name}'`)`` | **survives** (`/\.(prepare\|exec)\(/`) |
| ms-4-bound-alias (ev:ev-mv4eylz3-0130066c) | `const run = db.prepare.bind(db); run(`` `… ${name}` ``)` | **survives** |
| ms-5-control-inline (ev:ev-mv4eymp2-01040eeb) | ``db.prepare(`… '${name}'`)`` | killed (the designed case) |

Only `.js` files are scanned, so a new `src/*.mjs` is unscanned too.

**Impact.** A future change could add an injectable statement without a red scan, in the very layers the scan says are literal-only (ms-2). No such code exists today.

**Resolution condition.**
- (a) Allow-list entries carry an **exact occurrence count**, or are keyed by site, so that a second use of `where` in `calls.js` fails.
- (b) `.exec(` with a non-literal argument is reported unless its receiver is a RegExp or it is allow-listed. Only the migration runner should need an entry.
- (c) The call pattern tolerates whitespace (`\.\s*(prepare|exec)\s*\(`), and a reference to `.prepare` that is not a call (`.bind`, `['prepare']`) is reported.
- (d) `.mjs`/`.cjs` files are scanned.
- ms-1 to ms-4 must then be red.

Owner: orchestrator (`test/scan/sql.test.js`, g3's file). Verification report item 23 should record this acceptance and its condition.

### Info

**SEC-G-I1. The NFR3 scan tests a launcher that `npm run test:live-paypal` does not use.**
- `test/scan/live-refusal.test.js` › "the launcher (npm run test:live-paypal) refuses the same way" spawns `run-live-paypal.js`. That launcher's own header says it is "NOT wired into package.json". The evidence table cites this test for NFR3.
- **The real script refuses correctly** (ev:ev-mv4ewm10-01f01459):
  - `npm run test:live-paypal` with no flag runs the six files under `node --test`; each refuses with the fixed message; the run exits 1 (as `docs/runbooks/live-paypal.md` L68 states);
  - `npm run test:live-model` exits 2 with its message;
  - the net guard was injected into every process and saw no network attempt;
  - no `reports/` was written.
- Near-miss flags (`" 1"`, `"01"`, `"true"`, Arabic-Indic one, …), ceilings (`5.001`, `1e1`, `Infinity`, `" 5"`, …) and half credential sets all refuse, by name, without echoing a value. Under the net guard, even the exact flags refuse (ev:ev-mv4ex31x-0112ab69).
- **Suggestion:** retitle the test, and add one that runs the real `test:live-paypal` command line under the guard.

**SEC-G-I2. `scripts/clean-checkout.sh`: safe for the user's tree, but not git-clean, and its keep option is dead.** CC-PROBE (ev:ev-mv4f23u2-0180cb1e) ran it on a scratch git work tree, with a stub `npm` that records the copy:
- **Safe:**
  - the user's tree is byte-identical and its `git status` unchanged;
  - `.eccode/`, `data/` and the ignored `.env` are not copied;
  - nothing secret is printed, although a secret was exported in the environment;
  - the temp directory is removed.
- **(a) Untracked files are copied.** The copy takes **untracked, unignored** files too (`git ls-files --others --exclude-standard`). A `my-notes.txt` holding a canary was copied into the "clean" checkout. It stays in a `mktemp` directory and is deleted, so it does not leave the machine, but the check can pass on files that are not committed.
- **(b) `RS_KEEP_CLEAN_CHECKOUT=1` never works.** The script's own `RS_*` unset loop clears it before `cleanup` reads it.
- **Suggestion:** copy `--cached` only (or warn about untracked files), and exempt the keep variable from the loop.

**SEC-G-I3. RS-34 labels: honest in the two combinations g3 did not render** (ev:ev-mv4f119i-01b75fe7).
- **The README's demo start** (`node src/index.js`, fake payments, fake model, **no** `RS_TEST_OFFLINE`), at 360 and 1280:
  - `/api/config` reads `simulatedPayments: true, sandbox: false, testMode: false`;
  - the page shows "Simulated payments and/or AI — nothing here is real";
  - there is no test-mode banner and no "PayPal Sandbox" anywhere;
  - nothing reads as live money.
- **The Sandbox label set without test mode** (fed to the real frontend through a routed `/api/config`, no network): the single-credential banner and no test-mode banner, and nothing reads as live money.
- Chromium made no request outside 127.0.0.1.
- A real Sandbox deployment shows "PayPal Sandbox — no real money" on payment elements, not as a banner. That is what the spec requires (Frontend labels L1253).
- "Never success after a failure" was probed in phases F and rework-7 (P-MONEY M4/M4b, browser bdi); `public/` has had no relevant change since.

**SEC-G-I4. Documents.**
- The README, runbooks and submission drafts claim no live result, compliance, users or savings. Every live-dependent sentence carries "not yet run" and a placeholder to replace after the user's run.
- Every hackathon fact is marked unverified, with the official URL to re-check.
- The secret-handling instructions are sound: hidden prompts, secret stores, never on a command line, unset afterwards, rotate if exposed. `.env`, `data/` and `reports/` are git-ignored, and `.env.example` holds names and empty values only.
- One wording nit: `project-description.md` L30 lists "signature-verified webhooks" among the PayPal features. The verification exists but has only met the fake HMAC and the stub. The next bullet disclaims it, but qualifying it inline would be safer for a judge who skims.

## Criteria (security view, for the technical-reviewer's record)

| Criterion id | Met | Proving section |
|---|---|---|
| task:g1-frontend-a11y-labels | yes | `artifact:.eccode/artifacts/phase-g/submission.md#What the phase delivers`; ev:ev-mv4f2qpx-01be15d6, ev:ev-mv4f119i-01b75fe7 |
| task:g2-docs-submission | yes | `artifact:.eccode/artifacts/phase-g/submission.md#What the phase delivers`; ev:ev-mv4f2r7x-0132436f; SEC-G-I4 |
| task:g3-final-scans-browser | yes, with SEC-G-1 and SEC-G-2 routed | `artifact:.eccode/artifacts/phase-g/submission.md#Criteria → tests → evidence`; ev:ev-mv4f7x80-016be1c4, ev:ev-mv4fa3k7-01623b24 |
| phase:g-release | yes | `artifact:.eccode/artifacts/phase-g/submission.md#Disclosures for the reviewers` |
| security | yes, with SEC-G-1 and SEC-G-2 routed before delivery | this draft |

## What I did not test

- The real `clean-checkout.sh` run (it needs the npm registry).
- Pixels of screenshots (OCR).
- Browsers other than Chromium.
- The `fsevents` lockfile entry on macOS (decided, `dec-mv4eaw35-013b929e`).
- The RS-36 inspection (FU-62; a person's task).
