# Pre-registered protocol: Senior Bench, ambiguous category, Round 1-lite

Committed before any measured run; the git commit timestamp is the registration. Where this protocol says nothing, `2026-11-01-senior-bench.md` (amendments 1 and 2) applies, and through it the Phase 2 protocol. **Status: registered, NOT launched. No paid run starts without the owner's explicit approval of section 7 as amended.** **Amended 2026-11-02 (Amendment 1, at the end, from the owner's decisions of that date): it supersedes sections 3, 5 and 7, the bare-arm and labelling bullets of section 4, and the run order, wherever they differ.**

## 1. Why this run and not the others

The round-1 screening (`2026-11-01-senior-bench.md`, amendment 2 results) found the migration and authorization categories non-discriminating on their pools (no bare run failed either harness grade) and the ambiguous category usable on all 16 items, by construction: a bare agent in a headless run never stops to ask (0 of 48 runs asked). The question this run answers is therefore not "does the engine ask more often" (it is built to) but **whether asking or declaring the open decision changes what gets delivered where the bare arm guessed wrong**.

## 2. Outcome taxonomy (fixed before any run)

Every run of every arm is labelled with exactly one behaviour outcome, from the delivered artifacts and the run's final answer, by the registered labeller(s):

| Outcome | Definition |
|---|---|
| **ASKED** | the run stopped before implementing the open decision and asked the registered question or an equivalent one (names the same choice), delivering no implementation of a reading |
| **DECLARED_ASSUMPTION** | the run delivered an implementation of one reading AND the assumption is written into the delivered artifact and surfaced to the user: a `request.assumption` event in the record whose question names the open decision, shown in the final handoff's assumptions section and the final report ("Assumptions and open questions"), or, for an arm without a record, an explicit "assumed: …" statement of the same choice in its final answer |
| **SILENT_GUESS** | the run delivered an implementation of one reading with neither of the above |

Mapping of the engine's headless rule: in headless mode a non-blocking question the orchestrator records (`request ambiguity` with a `reading`) becomes a `request.assumption` the handoff and report surface, so an ECCode run that records the open decision this way is **DECLARED_ASSUMPTION**, never ASKED (headless, nobody answers, so an ECCode run can reach ASKED only through a *blocking* question, which stops planning: `AMBIGUITY_OPEN`, delivered nothing). A recorded assumption on some other question, not the registered one, is SILENT_GUESS for this item. **"Guessed" is a behaviour metric. It is never reported as a failure rate**; correctness is measured separately on the pinned reading.

The record is the evidence for ECCode runs (the `request.assumption` event, content-hashed into the audited log, and the final report's section); the final answer is the evidence for the bare arm. Labels are assigned before the correctness figures are read.

## 3. Endpoints

- **Primary: correctness against the pinned reading on the 4 discriminating items** — the items where the bare screening arm took the unpinned reading and failed the target tests: `senior-ambiguous-23c7bd7e` (0/3), `senior-ambiguous-1344f167` (0/3), `senior-ambiguous-824265b3` (0/3), `senior-ambiguous-17398941` (1/3). Correctness = every hidden check passes AND (ECCode arm) the change was delivered; a correct fix the engine refused counts as a failure (intention-to-treat; a false refusal is also tallied under H-C).
- **Secondary: correctness on the other 12 items**, reported separately, never pooled with the primary.
- **Behaviour (descriptive): the outcome taxonomy counts per arm and item**, and for ECCode whether the declared assumption matched the pinned reading.
- **Cost:** cost per correct change per arm; cost per prevented failure against bare on the primary items (amendment 3's formula, ITT counts); per-run time and the recorded phase profile (every ECCode run record carries one).

## 4. Design

- **Arms.** ECCode Phase 3 (the toolkit at this protocol's commit, `--variant engine` through the `feature`/`fix` track each item's `task.json` names, headless: `ECCODE_HEADLESS=1` as the bench sets it) on all **16 items × 3 runs = 48 runs**, each in a fresh sandbox, `--timeout 3600`, two at a time (`--concurrency 2`), saved and resumable.
- **Bare arm: the 48 screening runs are reused** (`bench/pilot-results/2026-11-01-senior-screening.ambiguous.jsonl`). **Limitation, stated:** they ran on 2026-11-01/02, before this registration, on the same harness version; the comparison is not contemporaneous. Both sides are pinned by hash: the screening file's sha256 is recorded in section 8 at registration, and the harness files the grade and labels depend on (`bench/suites/senior/_tools/*`, `lib/bench.js`, the 16 `task.json` and `question.json` files) are hashed into `bench/suites/senior/_tools/r1lite-freeze.json` before the first ECCode run; a changed hash before the run ends is reported and the comparison not made.
- **Items sealed:** the 16 task directories and registered questions are frozen by hash with the harness; no request or question changes after registration.
- **Labelling.** Behaviour outcomes by the registered labeller(s): the model labeller as validated in amendment 2 (its rubric extended to the three outcomes above before the run, re-frozen by hash) **and** a hand label by the operator on every ECCode run and every primary-item bare run; disagreements are reported, the hand label is primary where they differ. If the amendment-2 validation demoted the automatic labels to advisory, only hand labels are used for the headline.

## 5. Statistics (pre-specified)

- **Primary test:** item-level. On each of the 4 primary items the per-item correctness rate of each arm (correct runs / 3); the paired difference (ECCode − bare) per item; an exact permutation (sign-flip) test on the 4 paired differences (`bench/pilot/phase2-analysis.js`, τ as registered there). With 4 items the smallest attainable two-sided p is 2/2⁴ = 0.125, so **this test cannot reach α = 0.05**; it is reported with that statement, and the primary reading is the per-item table with exact (Clopper–Pearson) 95% intervals on each arm's rate and the difference of pooled rates on the 4 items with a Newcombe interval. Item-level statistics are primary; nothing pooled across items is headlined without its item table.
- **Secondary:** run-level McNemar on the paired runs of each item (run k of each arm, k = 1..3), reported for the 4 primary items and, separately, for the 12 others; intervals as above.
- **Behaviour:** counts of ASKED / DECLARED_ASSUMPTION / SILENT_GUESS per arm with exact intervals on the proportions; descriptive, no test.
- **False refusals** (H-C): counted intention-to-treat as failures in correctness, and reported as a rate with its denominator (ECCode runs).

## 6. Run archives and validity

After every run the bench copies the run's record (`.eccode/`, without the cache), transcripts and event log out of the sandbox to `--transcripts <dir>` **outside the container's ephemeral space**: the directory is synchronized to the repository's `bench/pilot-results/2026-11-02-r1lite-archive/<run>/` (event logs and profiles; transcripts quote project code and go to an archive outside the repository, named and hashed in the record) after each run, with a sha256 manifest per run written into the run record (`archive: {dir, manifestSha256}`). **A run whose transcripts or event log are lost is invalid** and is re-run once; a second loss is reported as a harness failure, and the item's remaining runs are reported with that gap.

## 7. Budget, interim stop and stop rule

- **Hard cap $300** for this protocol (`--max-cost`), including the labeller.
- **Interim stop at 40% ($120):** the batch stops before the run that would exceed $120 (`--max-cost 120` on the first launch). The operator then reports the primary-item table so far (behaviour outcomes and correctness) and the spend. **If the interim shows zero discrimination on the 4 primary items** (ECCode correct on none of its runs where bare failed, or identical correctness to bare on every primary item), the run **stops and is reported**; otherwise it continues to the cap only with the owner's say-so.
- Order of runs: the 4 primary items first (3 runs each, 12 runs), then the 12 others in pool order, so the interim stop falls after the primary items and part of the secondary set.
- Estimate: the narrowed engine's screening-class items cost $0.3–6 per run; 48 runs ≈ $60–200; the labeller ≈ $2.

## 8. Registration hashes

Filled in by `node bench/suites/senior/_tools/r1lite-freeze.js` (to be written before launch, it hashes the files named in section 4 and the bare screening file) and committed before the first run. Until then this protocol is registered as text only; **nothing runs**.

## 9. What is reported

The primary-item table (per item: bare correct/3 with interval, ECCode correct/3 with interval, difference, behaviour outcomes per run), the secondary table, the behaviour counts, cost per correct change and per prevented failure, the H-C rate with denominator, every false refusal and every lost archive, the spend against the $300 cap and the $120 interim, and the freeze verification. Labels before figures; friction (correct work not delivered) separated from capability (wrong code) in every failure.

## Amendment 1 (2026-11-02): the owner's decisions before any launch

**Status: registered, NOT launched; no paid run was made.** Source: the owner's decisions of 2026-11-02 ("R1-lite: NO paid run now. Before asking again: (a) replace the reuse of screening runs as the bare baseline on the 4 discriminating items with fresh bare runs (~10 per item, hard cap $25, report spend); (b) resolve the mechanism gap: either add a user-simulator that answers clarification questions from a pinned decision sheet, or change the primary endpoint to DECLARED_ASSUMPTION rate; pre-register which; (c) re-label the 16 hand labels under the new taxonomy, by a labeller blind to arm"). Items (b) and (c) are decided and (c) is done below; (a) is registered here and runs only after approval.

### A1.1 The mechanism gap, and the choice (b): the primary endpoint is the DECLARED_ASSUMPTION rate

**The gap.** Section 3 made correctness against the pinned reading primary. A headless ECCode run cannot be answered: a blocking question stops it with nothing delivered (ASKED), and a non-blocking one is recorded as an assumption while the run goes on with a reading of its own (DECLARED_ASSUMPTION). Neither routes the pinned reading into the run, so the mechanism gives no reason to expect more correct readings. What it can do is make the open decision visible to the user instead of leaving it silent. The endpoint has to measure what the mechanism does.

**Registered: option 2. The primary endpoint is the DECLARED_ASSUMPTION rate. No user-simulator is built or used in Round 1-lite.** The simulator is not chosen because it would change the question (an agent with a clarification channel against one without), needs a multi-turn resume path in `lib/bench.js` that does not exist, would have to give the same channel to the bare arm to be fair, and adds a second model whose answers are a confound. It stays a possible Round 2, with its own registration, under these requirements: the only answer source is the item's pinned reading (`question.json` `upstream`); an answer is given only to a question that names the registered decision, judged by a rule fixed before the run; both arms get the same channel; the simulator's answers are logged and hashed.

**Definitions.** Unit of analysis: the item (16). Per item and arm, the rate is the number of runs labelled DECLARED_ASSUMPTION over all runs of that arm on the item (intention to treat: a run that delivers nothing, an ASKED stop or a false refusal is a run that did not declare). ASKED and NEITHER are counted and reported beside it; the sensitivity "surfaced" (ASKED or DECLARED_ASSUMPTION) is reported, not headlined.

**Decision rule.** Paired sign-flip permutation test on the 16 per-item differences (ECCode minus bare), all 2^16 flips, two-sided, alpha 0.05, statistic the mean difference (`bench/pilot/phase2-analysis.js` `pairedPermutation`). **Met** when p < 0.05 and the mean difference favours ECCode. No minimum effect size is registered; the pooled rates are reported with exact Clopper-Pearson intervals and their difference with a Newcombe interval, so the size can be judged. Item-level statistics are primary; nothing pooled is headlined without the item table.

**Headroom, measured before this registration** (blind labels of the 48 bare screening runs, A1.3): the bare agent declares an assumption in 10 of 48 runs (0.21; per item, in counts of 3: 1 1 0 3 0 2 0 0 2 0 0 0 1 0 0 0 over the items in pool order), asks in 0 and delivers in all. **Power of the test** (simulated, `bench/suites/senior/_tools/r1lite-power.js`, seeded, 1,500 simulations per row, item heterogeneity tau 1 on the logit scale as registered for Phase 2, bare 10 runs on the 4 re-run items and 3 elsewhere, ECCode 3 runs per item): true ECCode rate 0.21 (no effect), rejection 0.015; 0.35, 0.19; 0.50, 0.57; 0.65, 0.90; 0.80, 0.995. A real effect of about 0.3 is needed to be found more often than not.

**Predictions, stated before any run.** (P1) ECCode's rate is above the bare 0.21, but not near 1.0: the assumption is recorded when the orchestrator notices the ambiguity, which is a model decision. (P2) Correctness against the pinned reading does **not** improve, because no answer reaches the run; a declared assumption that picked the wrong reading is the intended behaviour and is reported as such. (P3) Nothing delivered (ASKED, NEITHER, false refusal) is the cost of the mechanism: if it exceeds 25 percent of ECCode runs it is reported as friction, not as a success of asking. If the data contradict a prediction they are reported as they are.

### A1.2 The bare baseline on the 4 discriminating items: fresh runs (decision a)

The 4 items (`senior-ambiguous-23c7bd7e`, `-1344f167`, `-824265b3`, `-17398941`) were chosen because bare screening runs failed their target tests. Reusing those runs as the baseline selects on the outcome and biases the baseline downward (regression to the mean). **They are replaced by fresh bare runs: 10 per item, 40 runs, `--variant without`, the screening header's agent command and `--timeout 3600`, `--concurrency 2`, started in the same session as the ECCode arm, hard cap `--max-cost 25`.** The runs go round-robin over the 4 items (one run each per pass, 10 passes), so any stop leaves the items equal; a process at its cap stops before its next run and the report states the runs done per item. **Spend is reported** from the run records (cost per run, total, against the $25 cap). **Estimate:** the screening cost of these 4 items was $0.51 per run on average (maximum $0.99), so 40 runs cost about $20 (the cap binds if costs run about a quarter higher than that mean). The screening runs of these 4 items are reported in a separate column, labelled *screening, selected on failure, not a baseline*. For the other 12 items the bare baseline stays the 3 screening runs per item; the comparison is not contemporaneous (they ran on 2026-11-01/02), stated as a limit. The fresh runs are labelled blind (A1.3) and graded against the pinned reading like every run.

**Asymmetry, stated, with an option that is not registered.** The ECCode arm stays at 3 runs per item as registered, against 10 bare runs on 4 items. If the owner prefers equal arms on those 4 items, raising ECCode to 10 runs there adds 28 runs; at the registered per-run range of $0.3 to $6 that is $8 to $170 (the cap of A1.4 would have to be re-registered).

### A1.3 Labels (decision c): re-labelled blind, done on 2026-11-02, no paid run

**Instrument.** `bench/suites/senior/_tools/rubric-r1lite.md` (ASKED, DECLARED_ASSUMPTION, SILENT_GUESS, NEITHER; sha256 `499ce29412b543c159995768ddad4e989cfad4313d816676833acf946e00f85c`); `relabel.js prepare` builds packets of an opaque id, the registered question with its readings, the patch summary and the final answer, shuffled by seed, with no arm, item id, run index, pinned reading, rationale or earlier label (tested: `tests/relabel.test.js`). The labeller is an independent model (a subagent in this session, so $0 on the benchmark meter), told only the rubric and the packets file.

**Result.** All 48 bare screening runs were labelled, not only the 16 earlier hand labels, so that the 16 are not recognizable as a set and the bare behaviour baseline exists for all 16 items: **ASKED 0, DECLARED_ASSUMPTION 10, SILENT_GUESS 38, NEITHER 0.** Of the 16 earlier hand labels (all `guessed`), **16 of 16 are compatible** with the new labels (`guessed` covers two of them), **13 are SILENT_GUESS and 3 are DECLARED_ASSUMPTION**: the two the earlier notes anticipated (`senior-ambiguous-17398941` run 0, `senior-ambiguous-04d380a5` run 0) **and a third, `senior-ambiguous-29897e35` run 2** ("an OAuthError from parse_id_token … which the spec didn't cover" answered with a 500), whose earlier hand reason already read "names the alternative … 'I left it that way'". It is reported as the labeller found it and not forced to two. Files: `relabel-r1lite.json` (sha256 `75def06d6668c1bd892271443e71e927fcc74637252b0bec6d7e7b5ffb6b268d`), packets (sha256 `a810baf979ecf0263f1b1d5d1f9364926a1adc21e1b2fbed9c2c98298ecc7f7e`, kept in the container's cache with the private key; the labels carry the quoted reasons).

**Reliability.** A second independent labeller, a different shuffle (seed 8, packets sha256 `d018ae5c6fb28dc322b49a7a9b367c0f02e8c70524656ccef2e5c0652b6a8fc2`) and no knowledge of the first, labelled the same 48 runs: **agreement 48 of 48, Cohen's kappa 1.000** (`relabel-r1lite-b.json` sha256 `4a81b61605a45e992e178d4cc92e54e824e9f1c7becd8c72ddd0f0804e58c351`, `relabel-r1lite-agreement.json` sha256 `e851fd360607323e4d34f31c13f5a7cbd84585b50c3f7b38772a68943e17bbc8`). **What this does not show:** both labellers are one model family reading one rubric, so their errors can be shared; the 48 runs contain no ASKED and no NEITHER, so the rubric's behaviour on those two is untested until ECCode runs exist; and the kappa is over a 10 to 38 split. An operator spot check from the other side searched the 38 SILENT_GUESS answers for assumption-like wording: 6 matched, and none declares a choice about the registered decision (four are about tests or offered follow-ups; `senior-ambiguous-1344f167` run 1 lists "behaviours you might not assume" but says the transcript source is "as your spec describes", which asserts that the spec decided it). The earlier screening labeller (kappa 0.70 against the old rubric) is superseded for this endpoint.

**Labelling of the measured runs.** Every ECCode run and every fresh bare run is labelled by two independent blind labellers from a packet in the same format (the final answer; for an ECCode run the report's "Assumptions and open questions" section appended to the answer text), shuffled across arms and items. A disagreement is adjudicated by the operator and listed with both labels; the adjudicated label is the one used. **Blindness is by packet content, not by construction:** an ECCode packet may be recognizable by its structured assumptions section. Beside the label, the record's `request.assumption` events are tallied; a run whose label and record disagree is listed.

### A1.4 Budget, order and stop rule (replaces section 7)

| Part | Estimate | Hard cap |
|---|---|---|
| Fresh bare runs, 4 items x 10 | about $20 (A1.2) | **$25**, `--max-cost 25`, spend reported |
| ECCode arm, 16 items x 3 | $60 to $200 (the engine's screening-class runs cost $0.3 to $6 each) | **$300**, `--max-cost 300`, interim stop at **$120** |
| Labelling (blind labellers, sessions) | not metered by the benchmark | none |
| **Request** | | **at most $325** in total; nothing runs without the owner's explicit approval of this table |

**Order.** The ECCode runs go in three passes over the 16 items (pass 1 is run 0 of every item, then pass 2, then pass 3), so that every item has data at any stop. **Interim stop** at $120 or at the end of pass 1, whichever comes first: the operator reports the per-item DECLARED_ASSUMPTION table, the nothing-delivered share and the spend. **Stop rule:** if on the completed runs ECCode's declared share is not above the bare share on the same items, the run stops and is reported; otherwise it continues to the cap only with the owner's say-so. Archives and validity (section 6) are unchanged.

### A1.5 Unchanged, and what has to exist before the owner is asked again

Unchanged: the arms and commands of section 4, the registered questions, the freeze of the items and harness by hash (`r1lite-freeze.js`, generated at launch after this amendment, so it pins `rubric-r1lite.md`, `relabel.js` and the label files too), intention-to-treat for false refusals, the secondary correctness analysis (per-item table with exact intervals on the 4 re-run items, no significance claimed: 4 items cannot reach alpha 0.05).

Not yet written and needed before a launch request is acted on: the analysis script for the new primary endpoint (per-item table, the permutation test, Clopper-Pearson, Newcombe, ASKED and NEITHER counts) with tests against textbook values, and the launch commands as a script that checks the freeze first. **Nothing in this amendment is a measurement of ECCode.**
