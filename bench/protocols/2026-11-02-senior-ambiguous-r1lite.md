# Pre-registered protocol: Senior Bench, ambiguous category, Round 1-lite

Committed before any measured run; the git commit timestamp is the registration. Where this protocol says nothing, `2026-11-01-senior-bench.md` (amendments 1 and 2) applies, and through it the Phase 2 protocol. **Status: registered, NOT launched. No paid run starts without the owner's explicit approval of section 7.**

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
