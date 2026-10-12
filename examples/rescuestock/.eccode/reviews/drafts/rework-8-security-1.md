# phase:rework-8: security review, iteration 1 (FINAL)

**Verdict (security): APPROVE.**
- **SEC-G-1 and SEC-G-2 are resolved** against my phase G resolution conditions, re-proved with my own unchanged probes and mutants on the final tree.
- **SEC-G-I1 and SEC-G-I4 are resolved.** The clean-checkout change is acceptable as documented.
- **One new minor finding, SEC-R8-1:** three further T20 bypasses in the allow-listed files. It does not block: the code is safe today, and the fix is three pins (or one sentence in the verification report).
- Three info items.

Reviewer: security-reviewer, run run-mv4hmybm-01fe6bb4. Gate: `phase:rework-8`. Submission: `sub-mv4hmffg-01c74aff`.
- **Handoff:** ho-mv4h8mfw-01b601a9, commit `e299d01`.
- **Read:**
  - `.eccode/artifacts/rework-8/submission.md`;
  - the diffs of `test/scan/secrets.test.js`, `test/scan/sql.test.js`, `test/scan/live-refusal.test.js` and `scripts/clean-checkout.sh`;
  - README and `project-description.md`.
- **Who records:** the technical-reviewer records the gate after this FINAL. I did not run `gate review`.

## Evidence (security-reviewer, gate phase:rework-8, all after sub-mv4hmffg-01c74aff)

**Tree.** Every run carries tree digest `00d2d372…`, the submission's.
- HEAD `e12f430` adds records only: no diff of src/test/public/scripts/docs/README/.env.example/package*.json after `e299d01`.
- All 9 artifacts match their recorded sha256 (ev:ev-mv4i6aao-01a7bec9).

**Safety.**
- Loopback only. No live variable; no edit; no commit.
- The suites ran inside `flock /tmp/rescuestock-suite.lock`.
- Each mutant ran in a fresh `sec-r8/mut-<name>/`, with its diff kept. The phase G diffs are used unchanged from `sec-g/`; the new ones are `sec-r8/mr-*.diff` and `sec-r8/se-1-stale-excuse.diff`.

**Probes.** They live in `/tmp/claude-0/-home-user-ECCode/f72396f5-b89f-576d-a680-29d481cd71c9/scratchpad/sec-r8/` (and `../sec-g/`). The mutant runners always exit 0, so they show as "passed"; the verdict is in each row's output.

| ev id | what | result |
|---|---|---|
| ev:ev-mv4ht0lj-01ce9683 | **P-PLANT-R8** (`run-plant-r8.sh`, `plant-r8.mjs`): my phase G plants P01-P17, unchanged, plus 10 new plants P18-P27 aimed at the exemptions and shape rules, in a fresh copy; the copy's own `secrets.test.js` | **P01-P17: 17 of 17 caught** (were 7). P18, P19, P22, P23 caught. P20, P21 missed (whole-file exemptions; SEC-R8-I2). P24-P27 missed (unknown shapes, as disclosed). |
| ev:ev-mv4hswof-014ae660 | secrets mutant **se-1-stale-excuse** (an excuse for an existing file whose fragment matches nothing) | **killed** by "excuses that match nothing any more must be removed" |
| ev:ev-mv4hqzwu-017f608e | phase G **ms-1-name-reuse**, unchanged diff | **killed** ("expects 3 use(s) of where … finds 4"; "statements that assign or declare where … changed") |
| ev:ev-mv4hr0kg-012aeaa3 | phase G **ms-2-exec-variable-route** | **killed** ("non-literal as SQL text: sql") |
| ev:ev-mv4hr192-01d73f12 | phase G **ms-3-space-before-paren** | **killed** ("interpolates ${name}") |
| ev:ev-mv4hr1wd-01a5feb1 | phase G **ms-4-bound-alias** | **killed** ("refers to .prepare without calling it") |
| ev:ev-mv4hr2j2-01f8d009 | phase G **ms-5-control-inline** | killed |
| ev:ev-mv4hrd2h-0199bf02 | new **mr-1-push-into-pinned-builder** | **SURVIVED** (SEC-R8-1) |
| ev:ev-mv4hre1u-015b9d40 | new **mr-2-for-of-source** | **SURVIVED** (SEC-R8-1) |
| ev:ev-mv4hrf2f-01224bc9 | new **mr-3-helper-template** | **SURVIVED** (SEC-R8-1) |
| ev:ev-mv4hrg7m-01883c40 | new **mr-4-computed-member** | **SURVIVED** (SEC-R8-I1) |
| ev:ev-mv4hrh78-010ad328 | new **mr-5-regexp-name-shadow** | **SURVIVED** (SEC-R8-I1) |
| ev:ev-mv4hriak-01040dc4 | new **mr-6-control-inline** (control) | killed |
| ev:ev-mv4htfr9-013562a4 | the four reworked scan tests (secrets, sql, evidence-table, live-refusal) | 58/58 |
| ev:ev-mv4i0ued-0111881c | `flock … npm test` | **2406 tests, 2398 pass, 0 fail, 8 skipped**; NFR5 p95 58.4 ms |
| ev:ev-mv4i5v9k-01508f9e | `flock … npm run test:browser` | 28/28 |
| ev:ev-mv4i6ojh-0198830e | phase G **CC-PROBE**, unchanged, against the new `clean-checkout.sh` (stub npm, scratch git work tree) | keep=1 keeps the copy; WARNING names `my-notes.txt`; `.env` not copied; nothing secret printed; user tree unchanged |
| ev:ev-mv4i6aao-01a7bec9 | The 9 artifacts still have their sha256 | 9/9 |

**Not run by me:** g3's command with `clean-checkout.sh`, which needs the npm registry and is outside my loopback rule. The delivery lead's ev:ev-mv4hjjqn-013f05aa covers it.

## SEC-G-1: resolved

**Resolution condition 1 met.** The scan now reads:
- every git-tracked or untracked-unignored file, or a directory walk without git;
- the screenshots;
- every PNG chunk except pixel data (raw and inflated), and the bytes after IEND.

**The exceptions are exact by path and fragment**, with a stale-entry failure:
- An excuse covers only matches whose text contains its fragment, in its own path. A canary (P18) and a real-looking key (P19) planted in excused files **outside** their fragments are caught.
- A stale excuse fails the real-tree test (se-1).
- **The two broader exemptions are by path, which my condition allowed:**
  - the canary holders (`secrets.test.js`, `provider-stubs.js`) are exempt from the *canary* check only;
  - the shape-sample file (`secrets.test.js`) is exempt from the *shape* checks.

  See SEC-R8-I2.
- No exception is broad enough to hide a real value elsewhere. Each `has` fragment is a fake (`user:pw@`, `sk-live-should-not-leak`, `WH-STUB-DEFAULT`, …), and the 16 record entries quote earlier scan output.

## SEC-G-2: resolved; the pin-and-hash design judged

**My conditions (a)-(d) are met:**
- exact use counts;
- non-literal `.exec(` refused unless the receiver is a RegExp (the migration runner is the one entry);
- whitespace tolerated, and non-call `.prepare`/`.exec` references reported;
- `.mjs`/`.cjs` scanned.

**ms-1 to ms-4 are red, each for the intended reason**, and the real tree is green.

**The design.** Pinning by hash the statements that *assign* an allow-listed name, plus named helpers (`also`, `fns`), is a sound way to stop the trust in a name being reused. A reviewed change re-pins with the printed hash, so changes stay visible. Its blind spot is any write into the data **other than an assignment of the pinned name**, and the **callers of a helper whose parameter is the SQL**. That is SEC-R8-1.

### SEC-R8-1 (minor): three T20 bypasses remain in the allow-listed files

**Reproduction.** Each mutant is in a fresh copy and parses, and only `sql.test.js` was run. All three survive:
- **mr-1** (ev:ev-mv4hrd2h-0199bf02). In `src/services/admin.js` `buildTimeline`: ``parts.push(`(entity_type = '${query.entityType}')`)``. `parts` is joined into `where` by the pinned `where += …` statement, but `parts.push` is not an assignment, and `parts` is not pinned. **This is query input in the SQL text.**
- **mr-2** (ev:ev-mv4hre1u-015b9d40). In `src/services/webhooks.js` `findOperations`: `for (const [column, key] of (event.lookup ?? spec.lookup))`. `column` has `sites: []` and only `WEBHOOK_EVENTS` is pinned, not the for-of source. **These are column names taken from an event body.**
- **mr-3** (ev:ev-mv4hrf2f-01224bc9). In `src/services/admin.js` `requestScope`: ``ids(`SELECT … LIKE '%${requestId}%'`)``. The entry `arg:sql` pins the one `prepare(sql)` inside the helper `ids` (`sites: []`), not its callers. This is the coordinator's "template-literal concatenation through a helper".

**Impact.** Plausible accidental changes in the very files that carry allow-list entries would enter the SQL text without a red scan. **No such code exists today**: I read the current `buildTimeline`, `requestScope` and `findOperations` in phase G. Disclosure 4 ("trusts what it pins") covers the principle, but not these three paths.

**Resolution condition.** Either:
- pin the enclosing builder function text with `fns`:
  - `buildTimeline` for the `admin.js` entries `where` and `a.sql`;
  - `requestScope` for `admin.js` `arg:sql`;
  - `findOperations` for `webhooks.js` `column`;

  so that mr-1 to mr-3 turn red; or
- the verification report states these three paths as a known limit of the T20 scan.

Owner: orchestrator. It does not block this gate.

## SEC-G-I1: resolved

**The new test is sound.** The "NFR3: the real package scripts …" block runs the real `npm run --silent test:live-model` and `test:live-paypal`:
- PATH holds only node and npm;
- no flag and no credential;
- npm's own registry housekeeping is off;
- the net guard is in every Node process via `NODE_OPTIONS`.

**What it asserts:**
- model exits 2 with the fixed message;
- paypal exits 1, with six refusals, `# pass 0`, `# fail 6`, and no `ok` line;
- no `NETWORK_BLOCKED`;
- `reports/` unchanged.

**The positive control works.** The guard stops `net.connect(80, 'example.invalid')` in a child under the same environment.
- I confirmed the guard writes `NETWORK_BLOCKED …` to stderr on **every** blocked attempt (`net-guard.js` L54), so even a swallowed attempt would be seen.
- The launcher test is retitled truthfully.
- My phase G real-runner probe found the same behaviour (ev:ev-mv4ewm10-01f01459).

## SEC-G-I4: resolved

`project-description.md` L30 now reads: "The webhook signature check is verified only against the fake provider and the local stub; verification against real PayPal is live-dependent and not yet run." That is accurate.

## clean-checkout.sh (TR-G-6 / SEC-G-I2): accepted as documented

Re-running my phase G probe unchanged (ev:ev-mv4i6ojh-0198830e):
- `RS_KEEP_CLEAN_CHECKOUT=1` now keeps the copy (read before the `RS_*` unset loop).
- A **WARNING names the copied untracked file**.
- The ignored `.env` is not copied, and no secret is printed.
- The user's tree and its `git status` are unchanged; the script only reads them.

Keeping the working-tree copy, rather than copying `--cached` only, is acceptable from security: the copy stays in a `mktemp` directory and never leaves the machine. The verification report states the behaviour (disclosure 5).

## Info

**SEC-R8-I1. mr-4 and mr-5: adversarial-only bypasses; record them as scan limits, no fix asked.**
- mr-4: `db[m](…)` with a computed member name (ev:ev-mv4hrg7m-01883c40).
- mr-5: a parameter that shadows the file's RegExp constant `ISSUE`, so `ISSUE.exec(sql)` is taken for a RegExp (ev:ev-mv4hrh78-010ad328).

Both need deliberate obfuscation, which a source scan cannot be expected to defeat.

**SEC-R8-I2. Two whole-file exemptions remain in the secrets scan.**
- **The shape-sample file** `test/scan/secrets.test.js` skips *every* shape and long-token check. A real-looking key pasted there is missed (P21).
- **The canary holders** skip the canary check for the whole file (P20). This is harmless, because canaries are fakes.
- **Suggestion:** move the shape samples into fragment-level excuses, so that `secrets.test.js` is shape-checked like any other file.
- **Not caught, consistent with disclosure 4:** a base64 secret with `+` and `/` (P24), an 80-character credential with more than three hyphens (P25), a JSON-escaped bearer (P26), and UTF-16 text (P27). The scan reads known shapes only.

**SEC-R8-I3. Wording.** README L77 still says "`npm start` # starts the server on http://127.0.0.1:3000", while L13 now tells the user to open `localhost`. It is not a security issue: the default bind is 127.0.0.1 (`src/config.js` L243), so the demo stays local. It sits with the delivery lead's own runbook nit (submission disclosure 2) for the verification report.

## Criteria (security view, for the technical-reviewer's record)

| Criterion id | Met | Proving section |
|---|---|---|
| task:rework-8 | yes | `artifact:.eccode/artifacts/rework-8/submission.md#Each finding: change, proof, evidence`; ev:ev-mv4ht0lj-01ce9683, ev:ev-mv4hqzwu-017f608e, ev:ev-mv4hr0kg-012aeaa3, ev:ev-mv4hr192-01d73f12, ev:ev-mv4hr1wd-01a5feb1, ev:ev-mv4htfr9-013562a4 |
| phase:rework-8 | yes | `artifact:.eccode/artifacts/rework-8/submission.md#Acceptance criteria`; ev:ev-mv4i0ued-0111881c, ev:ev-mv4i5v9k-01508f9e |
| security | yes; SEC-R8-1 (minor) routed to a pin or the verification report | this draft |
