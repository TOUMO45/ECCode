# S2 closure record (archive)

This is S2's Greenfield-Senior closure record, copied out of the session's scratch checkout so it outlives the container. It is evidence, not configuration: nothing in the repository reads it. `docs/build/gf-s2-evidence.md` cites its ids (`ev-…`, `rev-…`, `disp-…`, `res-…`, `bat-…`).

| File | What it is |
|---|---|
| `events.jsonl` | the record's hash-chained log: 394 events, from `eccode-gf init` (16:22Z) to the round-5 reproductions (22:16Z) |
| `config.json` | the record's configuration (the reviewer roles the closure rule reads) |
| `evidence-logs.tar.gz` | the output logs of every recorded command (`.eccode/evidence/*.log`, 198 files) |
| `paired-runs-*.tsv` | finding id to evidence id: each documentation finding's reproduction and passing run (rounds 1 to 4), and the round-5 reproductions (`paired-runs-r5-repro.tsv`) |
| `s2-usage-*.json`, `r5-usage-*.json` | the harness usage snapshots of section 9 of the evidence (S2, and round 5) |
| `r5-skips.txt` | the 14 skipped tests of the round-5 full suite, each with its reason |
| `round5-repro/` | the round-5 findings: the comprehension findings as recorded; `f2-repro.test.js`, the three engine defects (F2-1, F2-2 and the readiness no-go's R3-1) as tests that fail on `c79800b` (run from the repository root, as its header says); the critic's and the readiness reviewer's own probes |
| `round4-repro/` | the open round-4 findings: the comprehension findings as recorded, and the critique's eight reproductions with its findings. Also the readiness reviewer's probes, which its evidence commands ran |

To re-audit the chain and the S2 rules: check out `21ef6eb` in a scratch directory, copy `events.jsonl` and `config.json` into its `.eccode/`, and extract the logs there (`tar -C .eccode -xzf evidence-logs.tar.gz`; the base audit checks that every evidence log exists, and reports one error per missing log without them). Then run `node bin/eccode.js audit --root .` and `node bin/eccode-gf.js audit --root .`. Done that way on 2026-11-07 in a fresh clone, the first reported `ok` for 309 events (after round 4; 394 after round 5) with 0 errors, and the second `ok` with 0 errors and the three text-level regime warnings of a checkout that is not an installed project. `node bin/eccode-gf.js close status --root . --scope S2` listed the 22 then unresolved round-4 findings and nothing else; after round 5 it lists 20 problems (the 17 open round-5 findings, the standing no-go twice, and the equivalent battery survivor).

To run the critique's reproductions: copy `round4-repro/` to a scratch directory and clone this repository at `21ef6eb` into a sibling directory named `copy`. Then, from inside the copied `round4-repro/`, run `TMPDIR=<absolute scratch tmp> GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=commit.gpgsign GIT_CONFIG_VALUE_0=false node --test critique/<file>.test.js`. On `21ef6eb` every finding's test fails (E2-1 to E2-8), and the control row passes. They live outside `tests/`, so `npm test` does not run them.
