# S4 plan addendum 3: owner decisions Q-1..Q-5 and the Meterline master prompt v2

This addendum records the owner's answers to the five open questions of addendum 2 (section 7) and fixes the master
prompt bytes for every arm. It does **not** edit the plan (`docs/build/gf-s4-plan.md`), addendum 1 or addendum 2. Where
this addendum and any of them disagree, this addendum records what changed and why. Branch: `s4-add3/base`, created from
`fd344d5` (head of `origin/s4-freeze/base`). Documentation only: no engine code, test, arm, comparator or hidden suite
was written, run or designed. Session spend figures are from one session (n=1).

## 1. Owner decisions (final)

| Id | Decision |
|---|---|
| Q-1 | A complete master prompt **v2** is issued as fixed text with a new sha256 (section 2). The frozen prompts (plan 2.1 and 2.2) stay untouched and preserved. v2 is the **explicit replacement for all arms**. The CSV paragraph is inserted as **one new paragraph at the end** of the prompt; nothing else changes. Two v2 files exist: the full version and the reduced Stage 1 version, with the same insertion in both. |
| Q-2 | Exhausting the auto-approval budget **counts as a human intervention**. The plan 6.1 rule "ceiling stop = no intervention" is superseded by this rule (section 3). Reports must show the counts **both ways**. |
| Q-3 | An approver refusal for **any reason other than budget** also **counts as a human intervention**. |
| Q-4 | `init` values for arms b and c: `--name meterline`; `--idea` = the full text of master prompt v2, verbatim, with no operator additions (section 4). |
| Q-5 | "readings that go backwards" stays **undefined on purpose**. It is a requirements-quality probe, like "strange" and "spike". No arm is told what it means. |

## 2. Master prompt v2 (Q-1)

### 2.1 Frozen prompts, as extracted

Extracted byte for byte from `docs/build/gf-s4-plan.md` (file sha256
`b6ce179d0a74b46bed3949ac886853c26b891fee2af684f14cb9d41f42930eea`, unchanged by this session): the lines between the
code fences of each section, fences excluded, each line ending in LF.

| Frozen prompt | Plan lines | Bytes | Lines | sha256 |
|---|---|---|---|---|
| 2.1 Stage 2, full B | 28-36 | 772 | 9 | `d2aa5a9b711313be6525f96fa8e87e80c1c37384ee10830ef7a549108edeace3` |
| 2.2 Stage 1, reduced B | 42-49 | 699 | 8 | `695cf01568eaf9b1b471ee4d4550acb24112d203d4ed9450473fd9bbf78ff60b` |

CSV paragraph: `docs/build/gf-s4-plan-record/meterline/master-prompt-csv-paragraph.md`, 223 bytes, 3 lines, sha256
`b3615f4d7d2cf1610c6f3b03129f44805d43c51ef3b7ba5ee565bcc2411d65a8` (equal to the value in addendum 2 section 4).

### 2.2 The v2 files

Construction, identical for both: frozen text, one blank line (a single LF), the CSV paragraph, trailing newline. The
files hold the prompt bytes only: no title, no fence, no comment.

| v2 file | Replaces | Bytes | Lines | sha256 |
|---|---|---|---|---|
| `docs/build/gf-s4-plan-record/meterline/master-prompt-v2-full.md` | plan 2.1 (Stage 2) | 996 | 13 | `ef8132b239375790c9ef084b4d334e96d54ddd62c74824f33ded0439b99da48c` |
| `docs/build/gf-s4-plan-record/meterline/master-prompt-v2-stage1.md` | plan 2.2 (Stage 1) | 923 | 12 | `22c576e9c486b61e1d92eeb3550d74ab89aff2411af2918f0bb2d4128380b392` |

### 2.3 Proof that the only change is the appended paragraph

`diff <frozen extract> <v2 file>` gives one hunk for each file and nothing else (`9a10,13` for full, `8a9,12` for
stage1):

```
>
> Readings arrive as CSV files. A sample file, sample_readings.csv, is attached; real files
> follow the same columns: building_id, meter_id, timestamp_utc (ISO 8601, UTC),
> reading_kwh (energy used in that 15-minute interval).
```

Byte checks, both files: the first 772 (full) or 699 (stage1) bytes are identical to the frozen extract (`cmp`); the
bytes after one further byte are identical to the CSV paragraph file (`cmp`); 772 + 1 + 223 = 996 and
699 + 1 + 223 = 923, so the separator is exactly one LF. Both files are ASCII, LF only.

Reproduce:

```bash
M=docs/build/gf-s4-plan-record/meterline
diff <(sed -n '28,36p' docs/build/gf-s4-plan.md) $M/master-prompt-v2-full.md
diff <(sed -n '42,49p' docs/build/gf-s4-plan.md) $M/master-prompt-v2-stage1.md
sha256sum $M/master-prompt-v2-full.md $M/master-prompt-v2-stage1.md $M/sample_readings.csv
```

### 2.4 Rule for all arms

Every arm (a, b and c) receives **master prompt v2 verbatim plus `sample_readings.csv`**, and nothing else from the
operator: Stage 1 uses `master-prompt-v2-stage1.md`, Stage 2 uses `master-prompt-v2-full.md`. The attachment is
`docs/build/gf-s4-plan-record/meterline/sample_readings.csv`, sha256
`5a9a98a6f7f5f8fc4be69f86aea4c3eb17ab9715a9e66da09fcc00a37db6c7f7` (verified unchanged in this session). The operator
script must check all three sha256 values before each arm starts and record them in the run directory. Plan section 3
"Held equal: the same master prompt bytes (sha256 recorded)" now refers to the v2 sha256 values above. The frozen
prompts of plan 2.1 and 2.2 are no longer given to any arm.

## 3. Interventions: plan 6.1 superseded by Q-2 and Q-3

Plan 6.1 as frozen: the last row of the decision table logs "5 resumes reached, or token or wall ceiling reached" as
**none** (recorded as "ceiling stop"), and automated approvals within a pre-set budget are not counted. Addendum 2
turned auto-approval on for arms b and c with the budget `maxSlices` 12, `maxTokens` 170000000,
`maxWallClockMinutes` 480, and named the budget refusal GF-AUTO-2 and the other refusals GF-AUTO-0, -1, -3, -4.

**Now, for M4:**

- **Q-2.** Each stop caused by auto-approval budget exhaustion (a budget refusal, GF-AUTO-2, on any of the three
  limits, including the 12-slice limit) is **one counted intervention**, logged with type `budget-exhaustion`. This
  holds also when a plan 9.2 arm ceiling is reached at the same time.
- **Q-3.** Each approver refusal for a reason other than budget (GF-AUTO-0, -1, -3, -4) is **one counted
  intervention**, logged with type `approver-refusal`.
- Automated approvals that the approver grants within budget stay **not counted** and are still reported separately as
  "automated approvals".
- The rest of the 6.1 taxonomy and the operator decision table are unchanged.

**Both counting methods must appear in every report, per arm and per run:**

| Method | Definition | Use |
|---|---|---|
| **M4-A3** (this addendum, binding) | plan 6.1 counted types (approval, clarification-answer, correction, restart, unblock) + `budget-exhaustion` + `approver-refusal` | The M4 value. F2 and F3 are evaluated on it. |
| **M4-6.1** (plan 6.1 as frozen) | plan 6.1 counted types only; a budget or ceiling stop is "none (ceiling stop)"; a refusal is not counted by itself | Reported next to M4-A3 in the same table, with the per-type breakdown. Not used for F2 or F3. |

**F2 and F3.** Their thresholds are not changed: F2 is still "an ECCode arm needs > 3 counted interventions to
delivery", F3 is still "ECCode interventions ≥ bare interventions". "Counted" now means M4-A3. Each report states F2
and F3 on M4-A3 and also says what each would have been on M4-6.1. The M4 prediction in plan 10.1 is not rewritten.
Arm a has no approver, so its two counts differ only if interpretation I-2 below is decided otherwise.

**Interpretations made while writing this section (not owner decisions; flagged for confirmation):**

- **I-1 (no double count).** When a non-budget refusal makes the gate wait and the operator then acts on it under the
  6.1 row "ECCode gate waits for owner approval", the refusal and that operator action are the **same** intervention:
  M4-A3 counts 1 (type `approver-refusal`), and M4-6.1 counts the operator action as 1 `approval`. The per-type
  breakdown lets a reader recount it as 2.
- **I-2 (operator ceiling without a budget refusal).** Q-2 names auto-approval budget exhaustion. A stop on the
  operator's own ceiling (5 resumes, or the plan 9.2 token or wall ceiling) with no GF-AUTO-2 refusal is the only
  ceiling stop arm a can have. It is recorded here as still "none (ceiling stop)" in both methods, and always listed
  in the report. If the owner means it to count too, M4-A3 adds 1 for each such stop.

## 4. `init` for arms b and c (Q-4)

The switches below are copied from addendum 2 section 3 and are not changed here.

| Switch | Exact text from the code | Value for arms b and c |
|---|---|---|
| auto-approval | `lib/greenfield/approval.js:3`: `.eccode/config.json  "gf": { "approval": { "auto": { "enabled": true, "maxSlices": N, "maxTokens": T, "maxWallClockMinutes": M } } }` | `{"enabled": true, "maxSlices": 12, "maxTokens": 170000000, "maxWallClockMinutes": 480}` |
| stack profile | profile name `lib/greenfield/profiles.js:25`: `const NAME = 'python-fastapi-postgres-worker-compose';` selected at init, usage line `bin/eccode-gf.js:17`: `init --name <n> --idea <text> [--stack python-fastapi-sqlalchemy-sqlite\|python-fastapi-postgres-worker-compose]`, parsed at `bin/eccode-gf.js:98`: `stackProfile: flags.stack === undefined ? undefined : flags.stack` | `--stack python-fastapi-postgres-worker-compose` |
| runtime enforcement | `lib/greenfield/runtime.js:205`: `return Boolean(config && config.gf && config.gf.runtime && config.gf.runtime.enforce === true);` | b: absent. c: `"gf": {"runtime": {"enforce": true}}` (plan section 3, unchanged) |

Command lines (Stage 1; `$V2` is the path of `master-prompt-v2-stage1.md` in the record, read from outside the arm
workspace because the engine export excludes `docs/`; Stage 2 uses `master-prompt-v2-full.md`). They were **not run**
in this session.

Arm b:

```bash
IDEA="$(cat "$V2"; printf x)"; IDEA="${IDEA%x}"
node bin/eccode-gf.js init --name meterline --idea "$IDEA" --stack python-fastapi-postgres-worker-compose
# then the operator script writes into .eccode/config.json, under "gf":
#   "approval": {"auto": {"enabled": true, "maxSlices": 12, "maxTokens": 170000000, "maxWallClockMinutes": 480}}
# gf.runtime.enforce: absent
```

Arm c:

```bash
IDEA="$(cat "$V2"; printf x)"; IDEA="${IDEA%x}"
node bin/eccode-gf.js init --name meterline --idea "$IDEA" --stack python-fastapi-postgres-worker-compose
# then the operator script writes into .eccode/config.json, under "gf":
#   "approval": {"auto": {"enabled": true, "maxSlices": 12, "maxTokens": 170000000, "maxWallClockMinutes": 480}}
#   "runtime": {"enforce": true}
```

The two `init` lines are identical; the arms differ only in `gf.runtime.enforce`. The `printf x` / `${IDEA%x}` form
keeps the file's trailing newline, which plain `$(cat ...)` would strip, so `--idea` is byte-identical to the v2 file.
The operator script sets all of this (addendum 2, O-3); the arm does not. Arm a has no `init`: it gets the same v2
bytes as its first prompt.

## 5. Plan and addendum items these decisions change (no earlier text is edited)

| Location | Says | Now |
|---|---|---|
| Plan 2.1, 2.2 | frozen master prompt texts | Preserved, not given to any arm. Replaced for all arms by the v2 files (section 2). |
| Plan 3, "Held equal" | the same master prompt bytes (sha256 recorded) | The v2 sha256 values of section 2.2. |
| Plan 6 M4, 6.1 | ceiling stop logged as none | Superseded for budget exhaustion and approver refusals (section 3). Two counts reported. |
| Plan 10.2 F2, F3 | "counted interventions" | Counted by M4-A3; M4-6.1 shown beside it. Thresholds unchanged. |
| Plan 6 M2 | probes include "backwards reading flagged" | The meaning of "go backwards" stays undefined for the arms (Q-5). |
| Addendum 2 section 6 | "The final master prompt bytes … and their sha256 (Q-1)" open | Closed by section 2. |
| Addendum 2 section 7 | Q-1..Q-5 open | Closed by section 1. |

## 6. Open items still before Stage 1 (list only; none started here)

- Hidden acceptance suite authoring and its manifest.
- Rubric.
- Review brief.
- Operator scripts.
- Docker decision.

## 7. Deviations and environment (this session)

- **DV-1.** The master prompt requires usage snapshot 00 as the first action. This was a new session with no record of
  the snapshot method, and the S3/S4 record was not in the local checkout (`claude/keen-allen-5z33eb`, no
  `docs/build/`). Before snapshot 00, the session therefore ran read-only lookups and `git fetch origin s4-freeze/base`
  (step 0.3, done early) and read the previous helper and snapshot record. Snapshot 00 was taken at the 6th message and
  includes that cost. Nothing was written to the repository before it.
- **DV-2.** The committed helper (`docs/build/gf-s4-freeze-record/tools/snap6.js`) has a hard-coded session id and
  paths and could not be called blindly. All snapshots of this session use inline arithmetic over this session's
  transcript, with the same IEQ formula (`input + 0.1·cache_read + 1.25·cache_write + 5·output`):
  `docs/build/gf-s4-add3-record/tools/snap-inline.py`. Records: `docs/build/gf-s4-add3-record/snaps/`.
- **DV-3.** The session harness named a different working branch (`claude/optimistic-einstein-j6gxoe`). The owner's
  prompt names `s4-add3/base`; that was used. Nothing was pushed to any branch.
- **DV-4.** The first S3 hidden-suite manifest check was run from the wrong directory and reported missing files. Run
  again from `docs/build/gf-s3-record/hidden-suite/`: 4/4 OK. No file was touched.
- **DV-5.** `xxd` is not installed. The one-LF separator was checked by byte arithmetic and `cmp` (section 2.3).
- Gates: `fd344d5` is on `origin/s4-freeze/base` (`git ls-remote`, `git merge-base --is-ancestor`); the working tree
  was clean before the branch was created; sample CSV sha256 verified; `ECCODE_SEED_KEY`: set.
- Not modified: the frozen plan, addendum 1, addendum 2, any hidden suite or manifest, any predictions file, any test,
  the v0.16.0 commit, the sample CSV. No Meterline hidden test or answer key was written, read or designed. No dollar
  figure appears; IEQ is a relative ratio estimate.

