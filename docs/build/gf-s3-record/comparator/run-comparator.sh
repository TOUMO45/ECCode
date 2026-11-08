#!/bin/bash
# ILLUSTRATIVE BARE COMPARATOR (protocol B3 item 6; n=1; NOT the comparison, which is G4/S6). Run by the OWNER in a SEPARATE
# FRESH session on this branch. It (1) holds the S3 record (incl. the hidden suite and the engine-built app) OUTSIDE the
# bare run's reach, (2) runs one bare Claude Code headless build in an EMPTY directory with only prd.json + idea.txt,
# (3) scores it with the identical hidden suite and tally, (4) restores the record.   usage: run-comparator.sh
set -u
REPO=$(git rev-parse --show-toplevel); REC=$REPO/docs/build/gf-s3-record; C=$REC/comparator
HELD=/root/.cache/s3-held-$(date +%s); OUT=/root/.cache/s3-bare-out; mkdir -p $OUT
PY=/root/.cache/eccode/phase3-venv/bin/python
[ -x $PY ] || { echo "rebuild the venv first: python3 -m venv /root/.cache/eccode/phase3-venv && /root/.cache/eccode/phase3-venv/bin/pip install --only-binary=:all: -r $REPO/docs/build/gf-s2-4-record/fastapi-reqs.txt"; exit 2; }
(cd $REC/hidden-suite && sha256sum -c ../hidden-suite-manifest.sha256) || { echo "hidden suite manifest mismatch"; exit 3; }
echo "1. HOLD the S3 record outside the bare run: $HELD"; cp -a $REC $HELD; rm -rf $REC; trap 'rm -rf $REC; cp -a $HELD $REC; echo "record restored"' EXIT
echo "2. BARE BUILD in an empty dir"; W=$(mktemp -d /tmp/s3-bare-XXXX); cp $HELD/comparator/prd.json $HELD/comparator/idea.txt $W/; cd $W; git init -q
START=$(date +%s)
PATH=/root/.cache/eccode/phase3-venv/bin:$PATH claude -p "$(cat $HELD/comparator/prompt.txt)" --output-format json \
  --permission-mode bypassPermissions --max-turns 400 > $OUT/bare-result.json 2> $OUT/bare-stderr.log
echo "bare exit=$? wall=$(( $(date +%s) - START ))s workdir=$W"; cp -a $W $OUT/bare-tree
echo "3. SCORE with the identical hidden suite (engine-held copy: $HELD/hidden-suite)"
DB=$(mktemp -d); (cd $W && DATABASE_URL=sqlite:///$DB/h.db ADMIN_EMAIL=admin@example.test PYTHONDONTWRITEBYTECODE=1 $PY -m uvicorn app.main:app --host 127.0.0.1 --port 18081 > $OUT/server.log 2>&1) & SRV=$!
for i in $(seq 1 40); do curl -s -o /dev/null http://127.0.0.1:18081/openapi.json && break; sleep 0.5; done
(cd $OUT && BASE_URL=http://127.0.0.1:18081 ADMIN_EMAIL=admin@example.test PYTHONDONTWRITEBYTECODE=1 $PY -m pytest -q $HELD/hidden-suite -p no:cacheprovider --junitxml=$OUT/junit.xml > $OUT/pytest.log 2>&1); tail -2 $OUT/pytest.log
kill $SRV 2>/dev/null
$PY $HELD/comparator/tally.py $OUT/junit.xml $HELD/hidden-suite/criteria-map.json | tee $OUT/criteria-result.txt
echo "4. METER: total_cost_usd and usage from the headless JSON (runner-reported; the IEQ ratio estimate can be computed from its usage):"
$PY -c "import json;d=json.load(open('$OUT/bare-result.json'));print({k:d.get(k) for k in ('session_id','num_turns','total_cost_usd','usage','duration_ms')})" 2>&1 | cut -c1-600
echo "Report as: illustrative, n=1, hidden-suite criteria passed of 24, beside the engine's 24/24 (docs/build/gf-s3-evidence.md)."
