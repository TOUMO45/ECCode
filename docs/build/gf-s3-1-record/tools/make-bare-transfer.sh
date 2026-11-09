#!/bin/bash
# S3.1 secondary measurement (engine-enforcement transfer): a COPY of the comparator's delivered bare tree (read-only
# from origin/claude/modest-wozniak-mwpzbm) + the engine-vendored eccode_runtime configured from the engine's sealed
# contract (engine tree contracts/openapi.json, same PRD) + a 2-line mount (import, app.add_middleware) after the
# FastAPI() call in create_app. No other bare code changed. Not a comparator re-run: no new build. usage: <out-dir>
set -euo pipefail
ROOT=/home/user/ECCode; OUT=${1:?out}; PY=/root/.cache/eccode/phase3-venv/bin/python
SEALED=/tmp/claude-0/-home-user-ECCode/8f000ba3-d139-5e13-a676-896cf34a79f4/scratchpad/engine-tree/contracts/openapi.json
rm -rf "$OUT"; mkdir -p "$OUT"
git -C $ROOT archive origin/claude/modest-wozniak-mwpzbm docs/build/gf-s3-comparator-record/bare-out/bare-tree | tar -x -C "$OUT" --strip-components=5
cp "$SEALED" "$OUT/contracts/openapi.json"
node -e 'const rt=require(process.argv[1]); const r=rt.install(process.argv[2], process.argv[2]+"/contracts/openapi.json"); console.log("installed "+Object.keys(r.files).length+" files");' $ROOT/lib/greenfield/runtime.js "$OUT"
python3 - "$OUT/app/main.py" <<'PY'
import sys,re; p=sys.argv[1]; s=open(p).read()
s=s.replace("from fastapi import", "from eccode_runtime import EccodeGuard\nfrom fastapi import",1)
m=re.search(r"\n(\s+)app = FastAPI\([^\n]*\)\n", s); assert m, "no FastAPI() line"
s=s[:m.end()]+m.group(1)+"app.add_middleware(EccodeGuard)\n"+s[m.end():]
open(p,"w").write(s)
PY
(cd "$OUT" && diff <(git -C $ROOT show origin/claude/modest-wozniak-mwpzbm:docs/build/gf-s3-comparator-record/bare-out/bare-tree/app/main.py) app/main.py || true)
env -u ECCODE_SEED_KEY ECCODE_PYTHON="$PY" node -e 'const rt=require(process.argv[1]); const p=rt.check(process.argv[2],{python:process.env.ECCODE_PYTHON}); console.log(p.length? p.map(x=>x.rule+" "+x.message).join("\n") : "GF-RT-1 check: no problems");' $ROOT/lib/greenfield/runtime.js "$OUT"
