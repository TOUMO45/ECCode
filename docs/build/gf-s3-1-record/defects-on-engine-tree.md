# S3.1 step 1.3: defects on the engine tree c943799, reproduced in this session (n=1)

Command (scripts read-only from origin/claude/modest-wozniak-mwpzbm, `manual-repro/`):
`env -u ECCODE_SEED_KEY /root/.cache/eccode/phase3-venv/bin/python <cmp>/manual-repro/repro.py <engine-tree>` and the
same with `repro-review.py`. Engine tree = `git clone docs/build/gf-s3-record/s3-tasktracker.bundle` at c943799.
Full output: `baseline-c943799/repro-output.txt`. Probe pack: `baseline-c943799/probes-*` (110 pass / 6 fail / 3 N/A).
Hidden suite: `baseline-c943799/hidden-criteria.txt` (24/24; 220 pass, 0 fail, 1 skip).

| Defect | Present on c943799? | Evidence (output line) |
|---|---|---|
| R-1 huge TTL breaks login | **yes** | `TTL=1000000000000 POST /v1/login -> 500`; same for 99999999999999999999 |
| R-2 4301+-digit id → 422 | **yes** | `GET /v1/tasks/<4301 nines> -> 422 int_parsing_size` (4300 → 404) |
| R-3 docs anonymous | **yes** | `/docs -> 200`, `/redoc -> 200`, `/openapi.json -> 200` |
| R-4 anon malformed JSON → 422 | **yes** | `anonymous POST /v1/tasks body {bad -> 422 json_invalid`; PATCH same |
| R-5 title U+001F accepted | **yes** | `POST /v1/tasks title U+001F -> 201` |
| A-1 422 echoes password | no | `register short password -> 422` body has loc/msg/type only, no `input` |
| A-2 lone surrogate → 500 | no | register email, login password, task title with `\ud800` all → 422 `string_unicode` |
| B-3 deep nesting → 500 | no | anon login/register 5000-deep → 422 (230 bytes) |
| B-7 non-canonical ids resolve | **yes** | owner `GET /v1/tasks/+1`, `/01`, `/1.0`, `/%201` → 200 task 1 |
| B-9 predictable default DB path | no (path randomised); mode 0644 | `default db: tasktracker-523870ae.db mode 0o644` |
| B-10 422 reflects 5 MB input | no | `POST /v1/tasks 5MB title -> 422 len=112` |

Engine-tree tally: 6 present (R-1..R-5, B-7).
