#!/bin/sh
# run-matrix.sh <bwrap|landlock> <0|1000>: set up the prototype, run the evasions inside the sandbox, report the real state.
M=$1; U=$2; B=/tmp/gfspike; P=$B/proto; WT=$P/wt-backend
sh $B/proto-setup.sh $P > /dev/null 2>&1
mkdir -p $P/tmp $WT/app $WT/tests
export GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=safe.directory GIT_CONFIG_VALUE_0='*'
INNER="sh $B/evasions.sh $P/repo $WT $P/wt-frontend"
case $M in
  bwrap) CMD="bwrap --ro-bind / / --dev /dev --proc /proc --bind $P/tmp $P/tmp --bind $WT/app $WT/app --bind $WT/tests $WT/tests --unshare-all --die-with-parent --setenv TMPDIR $P/tmp --setenv HOME $P/tmp --chdir $WT $INNER";;
  landlock) CMD="env TMPDIR=$P/tmp HOME=$P/tmp python3 $B/landlock-run.py --rw $WT/app --rw $WT/tests --rw $P/tmp --rw /dev -- $INNER";;
esac
if [ "$U" = 1000 ]; then chown -R 1000:1000 $P; cd $WT && setpriv --reuid=1000 --regid=1000 --clear-groups $CMD; else cd $WT && $CMD; fi
echo "--- outside, real state after the run:"
echo "  repo web/index.html='$(cat $P/repo/web/index.html)'  wt-backend web/index.html='$(cat $WT/web/index.html 2>&1 | head -c 60)'  wt-frontend web/index.html='$(cat $P/wt-frontend/web/index.html)'"
echo "  HEAD repo=$(git -C $P/repo rev-parse --short HEAD) wt-backend=$(git -C $WT rev-parse --short HEAD)  exclude lines=$(wc -l < $P/repo/.git/info/exclude)  assume-unchanged: $(git -C $WT ls-files -v web/index.html)"
echo "  landed outside own paths: $(ls $P/repo/web/seeded.json $P/repo/.venv/marker $P/repo/.venv/seed-marker $P/repo/.eccode/drafts/frontend/note.md $P/tmp/spike-escape 2>/dev/null | sed "s#$P/##" | tr '\n' ' ')"
echo "  guards.json='$(cat $P/repo/.eccode/guards.json)'  own path: $(ls $WT/app | tr '\n' ' ')"
