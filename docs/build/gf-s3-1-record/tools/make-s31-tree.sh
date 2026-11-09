#!/bin/bash
# Build the S3.1 engine tree: the pristine S3 engine tree (c943799, without .git) + the engine-vendored eccode_runtime
# (lib/greenfield/runtime.js install, configured from the tree's contracts/openapi.json) + the mount in the app
# factory (s31-mount.patch: one import line, one app.add_middleware line). Builder code is not otherwise changed.
# Prints the vendored manifest and the engine's runtime check (GF-RT-1) on the result. usage: make-s31-tree.sh <out-dir>
set -euo pipefail
ROOT=/home/user/ECCode
R=$ROOT/docs/build/gf-s3-1-record
SRC=/tmp/claude-0/-home-user-ECCode/8f000ba3-d139-5e13-a676-896cf34a79f4/scratchpad/engine-tree
PY=${ECCODE_PYTHON:-/root/.cache/eccode/phase3-venv/bin/python}
OUT=${1:?usage: make-s31-tree.sh <out-dir>}
rm -rf "$OUT"; mkdir -p "$OUT"
(cd "$SRC" && tar --exclude=./.git --exclude=__pycache__ -cf - .) | tar -xf - -C "$OUT"
node -e 'const rt = require(process.argv[1]); const r = rt.install(process.argv[2], process.argv[2] + "/contracts/openapi.json"); console.log("installed " + Object.keys(r.files).length + " files into " + r.dir);' "$ROOT/lib/greenfield/runtime.js" "$OUT"
(cd "$OUT" && patch -p1 --no-backup-if-mismatch < "$R/s31-mount.patch")
echo "=== vendored manifest ($OUT/eccode_runtime/MANIFEST.sha256) ==="; cat "$OUT/eccode_runtime/MANIFEST.sha256"
echo "=== engine runtime check (GF-RT-1) ==="
env -u ECCODE_SEED_KEY ECCODE_PYTHON="$PY" node -e 'const rt = require(process.argv[1]); const p = rt.check(process.argv[2], { python: process.env.ECCODE_PYTHON }); console.log(p.length ? p.map((x) => x.rule + " " + x.message).join("\n") : "GF-RT-1 check: no problems (files match the engine, canary passed)"); process.exitCode = p.length ? 1 : 0;' "$ROOT/lib/greenfield/runtime.js" "$OUT"
