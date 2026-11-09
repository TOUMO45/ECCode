#!/bin/bash
# S3.1 copy of docs/build/gf-s3-record/hidden-run.sh. Changes: paths only (suite = sealed copy in the S3 record,
# checked against the S3 manifest; tree = any directory, copied clean), and readiness polls /v1/tasks (any HTTP code)
# instead of /openapi.json, since S3.1 closes /openapi.json by default. Suite, tally and pytest line unchanged.
# usage: hidden-run.sh <tree-dir> <out-dir>
set -u
ROOT=/home/user/ECCode
H=$ROOT/docs/build/gf-s3-record/hidden-suite
PY=/root/.cache/eccode/phase3-venv/bin/python
TREE=${1:?tree}; OUT=${2:?out}
rm -rf $OUT; mkdir -p $OUT
echo "=== 1. suite integrity ==="; (cd $H && sha256sum -c $ROOT/docs/build/gf-s3-record/hidden-suite-manifest.sha256) || { echo "MANIFEST MISMATCH: stop"; exit 3; }
CLEAN=$OUT/clean; mkdir -p $CLEAN; (cd $TREE && tar --exclude=.git --exclude=__pycache__ -cf - .) | tar -xf - -C $CLEAN
DBDIR=$(mktemp -d); export ADMIN_EMAIL=admin@example.test
(cd $CLEAN && env -u ECCODE_SEED_KEY DATABASE_URL=sqlite:///$DBDIR/hidden.db ADMIN_EMAIL=$ADMIN_EMAIL PYTHONDONTWRITEBYTECODE=1 \
  $PY -m uvicorn app.main:app --host 127.0.0.1 --port 18080 > $OUT/server.log 2>&1) &
SRV=$!
for i in $(seq 1 40); do curl -s -o /dev/null http://127.0.0.1:18080/v1/tasks && break; sleep 0.5; done
(cd $OUT && env -u ECCODE_SEED_KEY BASE_URL=http://127.0.0.1:18080 ADMIN_EMAIL=$ADMIN_EMAIL PYTHONDONTWRITEBYTECODE=1 \
  $PY -m pytest -q $H -p no:cacheprovider -rfE --junitxml=$OUT/junit.xml > $OUT/pytest.log 2>&1); RC=$?
echo "pytest exit=$RC"; tail -1 $OUT/pytest.log
kill $SRV 2>/dev/null; wait $SRV 2>/dev/null; pkill -f "uvicorn app.main:app --host 127.0.0.1 --port 18080" 2>/dev/null
echo "=== 5. per-criterion tally ==="
$PY - "$OUT/junit.xml" "$H/criteria-map.json" <<'EOF' | tee $OUT/criteria-result.txt
import json, sys, re, xml.etree.ElementTree as ET
junit, cmap = sys.argv[1], json.load(open(sys.argv[2]))
res = {}
for tc in ET.parse(junit).getroot().iter('testcase'):
    name = re.sub(r'\[.*\]$', '', tc.get('name'))
    st = 'fail' if (tc.find('failure') is not None or tc.find('error') is not None) else ('skip' if tc.find('skipped') is not None else 'pass')
    res.setdefault(name, []).append(st)
passed, rows = 0, []
for ac in sorted(cmap, key=lambda k: int(k.split('-')[1])):
    tests = cmap[ac]; sts = [s for t in tests for s in res.get(t, ['missing'])]
    ok = bool(sts) and all(s == 'pass' for s in sts)
    passed += ok
    bad = [t for t in tests if any(s != 'pass' for s in res.get(t, ['missing']))]
    rows.append(f"{ac}: {'PASS' if ok else 'FAIL'} ({sts.count('pass')}/{len(sts)} cases)" + ('' if ok else f"  failing: {', '.join(bad)}"))
cases = [s for v in res.values() for s in v]
print('\n'.join(rows))
print(f"CRITERIA PASSED: {passed} of {len(cmap)} | cases: {cases.count('pass')} pass, {cases.count('fail')} fail, {cases.count('skip')} skip, total {len(cases)}")
EOF
echo "server log tail:"; tail -3 $OUT/server.log | cut -c1-200
