#!/bin/bash
# After each S3.1 item: hidden suite + probe pack (incl. BOLA) on the given tree. usage: item-check.sh <label> <tree>
set -u
R=/home/user/ECCode/docs/build/gf-s3-1-record; L=${1:?label}; T=${2:?tree}
S=/tmp/claude-0/-home-user-ECCode/8f000ba3-d139-5e13-a676-896cf34a79f4/scratchpad/m/$L
$R/tools/hidden-run.sh $T $S/hidden > /dev/null 2>&1; $R/tools/probes-run.sh $T $S/probes > /dev/null 2>&1
mkdir -p $R/items/$L; cp $S/hidden/criteria-result.txt $R/items/$L/hidden-criteria.txt
grep -E "^FAILED" $S/probes/pytest.log | sed "s/ - .*//" | cut -c1-110 > $R/items/$L/probes-failed.txt; tail -1 $S/probes/pytest.log > $R/items/$L/probes-summary.txt
echo "$L hidden: $(grep CRITERIA $R/items/$L/hidden-criteria.txt)"; echo "$L probes: $(cat $R/items/$L/probes-summary.txt)"
echo "$L bola failures: $(grep -c test_bola $R/items/$L/probes-failed.txt) (expected 1 = R-2)"; cat $R/items/$L/probes-failed.txt
