#!/bin/bash
# Run the comparator's probe adapter (read from origin/claude/modest-wozniak-mwpzbm, unchanged) on a tree.
# usage: probes-run.sh <tree-dir> <out-dir>
set -u
TREE=${1:?tree}; OUT=${2:?out}; mkdir -p $OUT
A=$(mktemp -d); git -C /home/user/ECCode archive origin/claude/modest-wozniak-mwpzbm docs/build/gf-s3-comparator-record/probe-adapter | tar -x -C $A
cd $A/docs/build/gf-s3-comparator-record/probe-adapter && (sha256sum test_*.py | diff - <(grep test_ probe-files-source.sha256 | awk '{print $1"  "$2}' | sed 's#  .*/#  #') >/dev/null && echo "probe files match source hashes" || echo "probe hash list format differs; see probe-files-source.sha256")
env -u ECCODE_SEED_KEY -u DATABASE_URL -u ADMIN_EMAIL -u TOKEN_TTL_SECONDS PROBE_TARGET_TREE=$TREE PYTHONDONTWRITEBYTECODE=1 \
  /root/.cache/eccode/phase3-venv/bin/python -m pytest -q -p no:cacheprovider -rfs --junitxml=$OUT/junit.xml . > $OUT/pytest.log 2>&1
grep -E "^FAILED" $OUT/pytest.log | sed "s/ - .*//" | cut -c1-110 ; tail -1 $OUT/pytest.log
