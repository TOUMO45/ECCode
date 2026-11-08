#!/bin/bash
# G1 gate sequencing for the S3 project. usage: g1-drive.sh <stage>
#   validate-all | arch-submit | arch-review | design-submit | design-review | plan-submit | plan-review | status
# Every refusal is appended to refusals.log (the engine logs none: B3.4 is the operator's record).
SP=/tmp/claude-0/-home-user-ECCode/66578369-ac2a-5898-b348-1bfebbc536c0/scratchpad
source $SP/s3env.sh
cd $P || exit 9
A=.eccode/artifacts
REV=$SP/reviews        # review JSON files written by the reviewer agent
LOG=$SP/refusals.log
run() { # run <label> <command...> : echo + log nonzero as a refusal (rule text kept)
  local label="$1"; shift
  local out; out=$("$@" 2>&1); local rc=$?
  echo "--- [$label] exit=$rc"; echo "$out" | head -${LINES_MAX:-14} | cut -c1-400
  if [ $rc -ne 0 ]; then echo "$(date -u +%FT%TZ) | $label | exit=$rc | $(echo "$out" | head -4 | tr '\n' ' ' | cut -c1-600)" >> $LOG; fi
  return $rc
}
ARCH="--artifact $A/brief.md --artifact $A/prd.json --artifact $A/architecture.json"
DESIGN="--artifact contracts/openapi.json --artifact contracts/db-schema.json --artifact contracts/migrations-plan.json --artifact contracts/access-matrix.json --artifact contracts/fixtures.json --artifact $A/spec.md --artifact $A/threat-model.json"
PLAN="--artifact $A/plan.json --artifact $A/breakdown.json --artifact $A/estimates.json"
case "$1" in
  validate-all)  run "validate architecture" $GF validate architecture $ARCH; run "validate design" $GF validate design $DESIGN; run "validate plan" $GF validate plan $PLAN ;;
  arch-submit)   run "gate start architecture" $GF gate start architecture --actor orchestrator && run "gate submit architecture" $GF gate submit architecture --actor product-architect $ARCH ;;
  arch-review)   run "gate review architecture" $GF gate review architecture --actor architecture-reviewer --file $REV/architecture-review.json ;;
  design-submit) run "gate start design" $GF gate start design --actor orchestrator --reviewers technical-reviewer,security-reviewer && run "gate submit design" $GF gate submit design --actor technical-designer $DESIGN ;;
  design-review) run "gate review design (technical)" $GF gate review design --actor technical-reviewer --file $REV/design-technical-review.json; run "gate review design (security)" $GF gate review design --actor security-reviewer --file $REV/design-security-review.json ;;
  plan-submit)   run "gate start plan" $GF gate start plan --actor orchestrator && run "gate submit plan" $GF gate submit plan --actor delivery-lead $PLAN ;;
  plan-review)   run "gate review plan" $GF gate review plan --actor technical-reviewer --file $REV/plan-review.json ;;
  status)        $GF status; ;;
  *) echo "unknown stage $1"; exit 1 ;;
esac
