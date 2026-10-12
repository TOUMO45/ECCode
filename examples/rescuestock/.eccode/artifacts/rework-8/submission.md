# phase:rework-8: submission

Author: delivery-lead (run `run-mv4ha8h7-0142a62b`). Gate: `phase:rework-8`. Date: 2026-10-12. Iteration 1. This is the last fix before the verification gate.

## Why this rework exists

- **The decision:** `dec-mv4feq7b-01e42a8f`, "Pre-delivery rework-8 for the phase G review minors". One test-and-docs rework, owner test-engineer, to resolve before the verification gate the minors that both phase G reviewers asked for before delivery.
- **The sources:**
  - the technical review `rev-mv4fdv59-01732f16` (approve; TR-G-1, TR-G-2, TR-G-3, TR-G-5 minor; TR-G-6 info);
  - the security draft `.eccode/reviews/drafts/phase-g-security-1.md` (approve; SEC-G-1, SEC-G-2 minor, the latter merging TR-G-4; SEC-G-I1 and SEC-G-I4 info);
  - FU-60, the README lockfile line, which supersedes the FU-60 part of `dec-mv4eresb-01e74e36` now that the README has an owner again.
- **The decision asks for:** a technical and a security review.

## Scope

- **One task:** `rework-8`, owner test-engineer, claimed once. Handoff **`ho-mv4h8mfw-01b601a9`**, committed in **`e299d01`**.
- **Changed files:** exactly the 8 named. `git diff --stat fac73e6 e299d01` (from the commit that opened rework-8) gives 8 files, +988/-188:

| File | sha256 (12) | Items |
|---|---|---|
| `test/scan/secrets.test.js` | `08c849f49650` | 1 (SEC-G-1) |
| `test/scan/sql.test.js` | `cf8abe157914` | 2 (SEC-G-2 / TR-G-4) |
| `test/scan/evidence-table.test.js` | `d7e474e29a85` | 3-5 (TR-G-1/2/3) |
| `docs/evidence-table.md` | `00567bbd0879` | 3-5 |
| `test/scan/live-refusal.test.js` | `04ad8078ce70` | 6 (SEC-G-I1) |
| `README.md` | `3a6c607c6f72` | 7 (TR-G-5, FU-60) |
| `scripts/clean-checkout.sh` | `4bf7045fc09d` | 8 (TR-G-6) |
| `docs/submission/project-description.md` | `db22d1abebbb` | 7 (the localhost fix), 9 (SEC-G-I4) |

- **No product code changed:** nothing under `src/`, `public/`, `package.json` or `package-lock.json` (`git diff --stat fac73e6 e299d01 -- src public package.json package-lock.json` is empty).
- **HEAD is now `1724ee4`.** The commits after `e299d01` touch only `.eccode` records.
- **Artifacts:** this file and the 8 files.

## Each finding: change, proof, evidence

Each item has a recorded failing run, or a recorded blind probe, before the change, and a recorded killing run after it. Every mutant has its own fresh directory `scratchpad/r8/<name>/` with `mutant.diff` printed first in its log.

**Two kinds of tree in this section:**
- The **AFTER mutant runs** were recorded on the trees of their own step: `edd919d9`, `d6ca8773` and `f9e8e0c1`.
- The **final-bytes runs** are on `00d2d372`, the tree of every run of mine.

| # | Finding | Change (checked against the diff) | Before | After |
|---|---|---|---|---|
| 1 | **SEC-G-1** (minor): the RS-29 secrets scan did not cover everything shipped | **What `secrets.test.js` now reads:**<br>- every file from `git ls-files -co --exclude-standard` (a directory walk without git, as in a clean checkout), plus the browser screenshots;<br>- that includes `.eccode` and its run logs, `src`, `scripts`, `package.json`, the lockfile and every document;<br>- every PNG chunk except pixel data (raw and inflated, plus the bytes after IEND), and other images as bytes.<br>**What it checks:** every canary in any form, and the high-confidence secret shapes.<br>**Exceptions:** by path and exact fragment. Each must still match, or the test fails as stale.<br>**What the widened scan found:** no real credential in about 870 files. Only canaries, sample shapes and fake test values were found; the record quotes the reviewer's earlier output. | the reviewer's planting probe missed **10 of 17** (ev:ev-mv4fmfug-01ed5b11) | **17 of 17 caught** on the final bytes (ev:ev-mv4h81sq-01a3c742, "missed plants: 0 of 17").<br>Mutants, all red: the walk skips `.eccode` (ev:ev-mv4fq84x-012dd823); only PNG text chunks (ev:ev-mv4fqb3u-013d47ed); `src/` exempt (ev:ev-mv4fqe7i-01c4493f). |
| 2 | **SEC-G-2 / TR-G-4** (minor): the T20 SQL scan let name reuse, `.exec(variable)`, whitespace before the paren and bound aliases through | **`sql.test.js`:**<br>- allow-list entries carry an exact use count, plus the sha256 prefix of every statement that assigns the name and of the helpers that build the text;<br>- `.exec(<non-literal>)` is a database call unless its receiver is a RegExp; the migration runner has 2 entries;<br>- a non-call `.prepare`/`.exec` is reported (one entry: the `typeof db.exec` feature test);<br>- calls tolerate whitespace;<br>- `.mjs` and `.cjs` files are scanned. | ms-1 (ev:ev-mv4fwted-018fc219), ms-2, ms-3, ms-4, MS1 (ev:ev-mv4fxdho-011f9021) and a new `.mjs` mutant **survive** the old scan. ms-5 is red. | **All red:** ms-1 ev:ev-mv4fxe43-01321d97, ms-2 ev:ev-mv4fxerz-0116e6cb, ms-3 ev:ev-mv4fxfem-01cfb29c, ms-4 ev:ev-mv4fxg3w-0165cb7e, ms-5 ev:ev-mv4fxgrc-0139bd50, MS1 ev:ev-mv4fxhg4-01ab2a88, `.mjs` ev:ev-mv4fxpep-014fc37d. The real tree is green. |
| 3 | **TR-G-1** (minor): inspection (I) parts not tagged or cited | `docs/evidence-table.md`: RS-29, RS-35, RS-36, NFR3 and NFR4 carry **I** and cite `rev-mv4fdv59-01732f16` with what was inspected. RS-36 cites the FU-62 inspection instead of disclaiming it. | the new checks against the old table fail (ev:ev-mv4fz6fc-013adcba) | mutants red: NFR4 without I (ev:ev-mv4gxiek-01d53c56); RS-36 disclaimer restored (ev:ev-mv4gxj34-01b6ee77) |
| 4 | **TR-G-2** (minor): wrong blockers, and NFR2's tags | **RS-25** says no live file covers a lost capture answer. **RS-13 and RS-15** name LIVE-P2 (RS-32(b)) for a plain void. **NFR2** is tagged **D B**. | same | mutants red: NFR2 without D (ev:ev-mv4gxhs7-01369102); RS-25 pointer restored (ev:ev-mv4gxjp5-01328787); RS-13 pointer restored (ev:ev-mv4gxkb3-01010e3e) |
| 5 | **TR-G-3** (minor): ambiguous title fragments | **`evidence-table.test.js`** (15 tests) asserts:<br>- every cited title occurs in exactly one test file, the one the row names;<br>- the log shows every matching line `ok` and none skipped;<br>- the suite tags agree with the cited tests.<br>The RS-03, RS-22 and RS-27 titles were made unique. | the reviewer's **MT2** stays green on the HEAD table and test (ev:ev-mv4ghzmm-01a47987) | **MT2 red** (ev:ev-mv4gxpt5-018aa93b); ambiguous-title mutant red (ev:ev-mv4gxh6m-01c90aa4) |
| 6 | **SEC-G-I1** (info): the NFR3 test spawned a launcher that `npm run test:live-paypal` does not use | **`live-refusal.test.js`:** the launcher test is retitled. A new block runs the **real** package lines with only node and npm on the PATH, no flag, no credential, and the net guard in every Node process via `NODE_OPTIONS`:<br>- `npm run --silent test:live-model` exits 2 with the fixed message;<br>- `test:live-paypal`: the six live files each print the refusal, exit 1.<br>A positive control proves the guard stops a non-loopback connection in a child. | "test:live-paypal also runs a passing test" is **blind** for the old test (ev:ev-mv4g2jse-01dca1ff, green) | the same mutant is **red** for the new test (ev:ev-mv4g2nd9-0107dca9); "a network call before the model flag gate" is red (ev:ev-mv4g2qpy-0100db38) |
| 7 | **TR-G-5** (minor) and **FU-60** | **README demo:**<br>- open **http://localhost:3000**, with the reason;<br>- enter `90` in "Cup diameter (mm)";<br>- approve the plan, reserve, and approve each payment;<br>- **sign in as `supplier-a` and `supplier-b` to confirm**, then press "Complete purchase".<br>The same localhost fix is in `project-description.md`.<br>**README limits:** a lockfile line, `fsevents` (macOS optional) has no integrity entry (`dec-mv4eaw35-013b929e`). | the README followed literally is refused at confirm for the missing diameter (ev:ev-mv4g9s8g-01fa98cd) | the demo as now written: 18 ok, 0 failed (engineer ev:ev-mv4h88ss-01538080 on port 3100; **mine ev:ev-mv4hka1l-01370497 on the default port 3000**) |
| 8 | **TR-G-6** (info, merges SEC-G-I2): `clean-checkout.sh` keep option dead; copies the working tree | **`RS_KEEP_CLEAN_CHECKOUT`** is read before the `RS_*` unset loop.<br>**The header** states that the **working tree** is copied, including uncommitted edits and untracked, unignored files.<br>**The script** prints a WARNING naming copied untracked files. It only reads the user's tree. | scratch git work tree with a stub npm: not kept, no warning (ev:ev-mv4ggc6d-01c7bc16) | kept, `my-notes.txt` named, `.env` not copied, status unchanged (ev:ev-mv4h8a5k-01309107). The user's `git status` before and after the real run is identical (ev:ev-mv4gyjye-01f0df0f, ev:ev-mv4h6etz-018a707b). |
| 9 | **SEC-G-I4** (info): one wording nit | **`project-description.md` L30:** "The webhook signature check is verified only against the fake provider and the local stub; verification against real PayPal is live-dependent and not yet run." | n/a | the diff |

## Delivery-lead runs on `e299d01` (tree `00d2d372…`)

This is the same tree as the engineer's final-bytes runs.

| Evidence | Command | Result |
|---|---|---|
| **ev:ev-mv4hbi1w-01d9f0d8** | the four scan tests: `node --disable-warning=ExperimentalWarning --import ./test/helpers/net-guard.js --test test/scan/secrets.test.js test/scan/sql.test.js test/scan/evidence-table.test.js test/scan/live-refusal.test.js` | **passed: 58 tests, 58 pass, 0 fail, 0 skipped; 4.9 s.** This matches the engineer's ev:ev-mv4h8dzv-01be3ac5. |
| **ev:ev-mv4hjjqn-013f05aa** | **g3's verification command, verbatim from the plan, as one shell argument:** `ls … docs/evidence-table.md >/dev/null && npm test && npm run test:browser && sh scripts/clean-checkout.sh`. `flock /tmp/rescuestock-suite.lock` was held around the **whole** evidence run (`--timeout 2400`). | **passed (exit 0, 366.5 s):**<br>- `npm test`: 2406 tests, 2398 pass, 0 fail, 8 skipped; NFR5 p95 65.5 ms, suite 114.5 s.<br>- `npm run test:browser`: 28 tests, 28 pass.<br>- clean checkout: 448 files copied, **no untracked-file WARNING**, `npm install` from the registry. In the copy, `npm test` gives 2406 tests, 2396 pass, 0 fail, 10 skipped, and `GET /api/health` answers 200. |
| **ev:ev-mv4hka1l-01370497** | the README demo: `sh scratchpad/r8/run-demo.sh dl-demo with-diameter` (the engineer's `readme-demo.mjs`, in a fresh copy `r8/dl-demo` with its own `data/` removed, so the database is a scratch one), under the lock | **passed: 18 ok, 0 failed, on 127.0.0.1:3000.** It signs in as cafe1 and fills the sample text; the diameter and material are empty. It enters 90 and the plan is A+B for USD 84.00, with C incompatible and D too late. It reserves and approves both simulated payments; "Complete purchase" is unusable until the suppliers confirm. It confirms as supplier-a and supplier-b, then completes the purchase: "Purchase confirmed". Chromium made no request outside 127.0.0.1/localhost. |

**Notes on these runs:**
- **The copy's 10 skips:** the usual 8 fake-harness and provider cases, plus the evidence table's cited-run check (no `.eccode` in a clean checkout) and the screenshot scan (no `test/browser/out`). Both print their reasons.
- **No leftover processes:** before my runs, no application server was running and ports 3000 and 3100 were free. After the demo, port 3000 was free again and no server or Chromium process was left.
- **Network:** apart from `npm install` inside `clean-checkout.sh`, which reaches the npm registry by design (part of g3's command), every run was loopback-only.

## Disclosures and open limits (for both reviewers)

1. **Demo findings the reviewers had not named.** The engineer found two defects in the documented journey while running it, and the README now covers both. My run confirms the corrected text.
   - **The address must be `localhost`.** Without `RS_PUBLIC_URL`, the simulated approval returns the browser to `http://localhost:<port>`. A user who opened `http://127.0.0.1:3000` lands signed out on a different host name. The README and `project-description.md` now say localhost and why.
   - **Each supplier must confirm before purchase.** "Complete purchase" stays unusable until supplier-a and supplier-b have confirmed their orders. The README now has that step.
2. **Runbook nit, no rework.** `docs/runbooks/live-paypal.md` L115 says "Open http://127.0.0.1:3000 or http://localhost:3000", listing 127.0.0.1 first, and then says to use the `RS_PUBLIC_URL` address, which is localhost.
   - The file is outside this rework.
   - It stays an **info item for the verification report**, with no rework.
3. **Leftover demo servers.** During the engineer's run, two `node src/index.js` servers from earlier agents were running. One held 127.0.0.1:3000 and its working directory, a deleted review scratch copy, was gone. The other ran in the project directory.
   - The orchestrator stopped both after checking their working directories.
   - The engineer's demo therefore ran on `PORT=3100`, and **the default port 3000 was not exercised by that run**. My demo run (ev:ev-mv4hka1l-01370497) found the port free and ran on **3000**.
4. **Scan limits.**
   - **The SQL scan trusts what it pins:** the reviewed constants, the range checks behind `PRAGMA busy_timeout`, and allow-listed helpers only as far as their pinned text goes. **Any reviewed edit to a pinned statement or helper needs a re-pin**; the failure prints the new hash and the statement. It reads source, not behaviour.
   - **The secrets scan matches known shapes and reads files, not git history.** A live credential of an unknown shape in a recorded log would pass. The record's exceptions are by exact fragment, so a future record quoting another fake shape will need an entry. The e-mail and 32-character token rules stay with the narrower scans (hashes, slugs and reviewer addresses would match them).
   - **`clean-checkout.sh` has no repository test of its own.** No test file of this task's globs fits one. Its keep option and warning are proven by the scratch-tree probe `scratchpad/r8/cc-probe.sh` (ev:ev-mv4ggc6d-01c7bc16 before, ev:ev-mv4h8a5k-01309107 after) and by the recorded runs.
5. **TR-G-6 was resolved by documenting, not by changing the copy.**
   - The reviewer's optional maintenance change was to copy `--cached` only, or to refuse a dirty tree. The engineer kept the working-tree copy, documented it in the header and added the WARNING.
   - The script still does not run `npm run seed`.
   - The verification report must state the working-tree behaviour and the row-12 `draft` extension (TR-G-6's own resolution text).
6. **The inspection tags are for bytes already read.** They are the technical review's inspections, for the bytes it read; the table says a later edit voids them. NFR1 keeps its I tag. NFR6's real cost report is LIVE-M1.
7. **Engineer runs on earlier bytes.** These were on the tree before the last edit of `docs/evidence-table.md` (its mutation section and ids):
   - the engineer's three locked `npm test` runs;
   - the browser run;
   - the locked **+30-day** run (ev:ev-mv4gur0s-01e75119, 2406/2398/0/8, with the committed `test/helpers/shift-clock.mjs`);
   - the AFTER runs of items 1, 7 and 8.

   The handoff names them but does not cite them as final. The final bytes are covered by the engineer's re-runs (ev:ev-mv4h81sq, ev:ev-mv4h88ss, ev:ev-mv4h8a5k, ev:ev-mv4h8dzv, ev:ev-mv4h652v) and by my three runs. **No +30-day run exists on the final bytes.** The last edit was a document that only `evidence-table.test.js` reads, and that test passed in my runs.
8. **SEC-G-I4's owner was the user** (release checklist, FU-61). The decision brought it into this rework, so the user's submission text `docs/submission/project-description.md` now carries the qualified sentence and the localhost fix. The user should see both before publishing.

## Acceptance criteria

| Criterion | Met | Evidence |
|---|---|---|
| `task:rework-8`: SEC-G-1 (every shipped file and PNG chunk scanned; 17 of 17 plants caught; findings reported) | yes | item 1; ev:ev-mv4fmfug-01ed5b11, then ev:ev-mv4h81sq-01a3c742 |
| `task:rework-8`: SEC-G-2 / TR-G-4 (ms-1 to ms-4 and MS1 red, ms-5 still red, the real tree green) | yes | item 2; mine ev:ev-mv4hbi1w-01d9f0d8 |
| `task:rework-8`: TR-G-1, TR-G-2, TR-G-3 (I tags and citations, pointers, title binding; MT2 red) | yes | items 3-5 |
| `task:rework-8`: SEC-G-I1 (retitled; the real npm script lines run without flags) | yes | item 6 |
| `task:rework-8`: TR-G-5, FU-60 (the README demo run as written and recorded; the lockfile line) | yes | item 7; ev:ev-mv4h88ss-01538080, ev:ev-mv4hka1l-01370497 |
| `task:rework-8`: TR-G-6 (the keep option works; the copy documented and warned; the user's status unchanged) | yes, documented rather than changed (disclosure 5) | item 8 |
| `task:rework-8`: SEC-G-I4 (the webhook claim qualified) | yes | item 9 |
| `phase:rework-8`: the g3 verification command passes on the final tree under the suite lock, with the clean checkout | yes | engineer ev:ev-mv4h652v-011147bf; **mine ev:ev-mv4hjjqn-013f05aa** |
| No product code changed | yes | no `src`, `public`, `package.json` or lockfile diff |

## Lessons

- **`mem-sd-mv1audrd-013b7102`** (root resolution of a tool-call guard): the engineer recorded it as **not-applicable**, because this task builds no hook or guard that maps file writes to a record. I agree.
- `memory search` for this change (scans, allow-lists, evidence table, README demo, shell script) returns no other verified lesson.

## Review

**A technical review and a security review are both needed**, as the decision asks. This rework changes the release's security scans (secrets, SQL), the live-suite refusal test, a shell script that copies the user's tree and runs `npm install`, and the user-facing documents.

- **Technical reviewer:**
  - items 3-5 and 7 against `rev-mv4fdv59-01732f16`;
  - MT2 and the table mutants;
  - the README demo log.
- **Security reviewer:**
  - SEC-G-1 and SEC-G-2 against the draft's resolution text;
  - the exception lists;
  - the planting probe;
  - the `clean-checkout.sh` change;
  - disclosures 4 and 5.

## Live suites and network

- **No live suite was run.** `RS_LIVE_MODEL` and `RS_LIVE_PAYPAL` were never set; my commands ran under `env -u`. The live-refusal test runs the live scripts **without** flags, and they refuse.
- **Network:** 127.0.0.1 and localhost only, except `npm install` inside `scripts/clean-checkout.sh`, which g3's verification command runs against the npm registry through the configured proxy.
- **No commits by me.** The only file I wrote is this one.
