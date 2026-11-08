#!/bin/bash
# orchestrator checkpoint: checkpoint.sh <label>  (runs a passing evidence command, then records the plan checkpoint)
SP=/tmp/claude-0/-home-user-ECCode/66578369-ac2a-5898-b348-1bfebbc536c0/scratchpad
source $SP/s3env.sh; cd $P
out=$($ECC evidence run --actor orchestrator --label "cp-$1" --json -- ruff check --no-cache --select E,F --line-length 100 app 2>&1); echo "$out" | head -c 400; echo
ev=$(echo "$out" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{const j=JSON.parse(s.slice(s.indexOf('{')));console.log(j.id||j.evidence||j.evidenceId||'')}catch(e){console.log('')}})")
echo "evidence id: $ev"
[ -n "$ev" ] && $ECC plan checkpoint --evidence "$ev" --actor orchestrator 2>&1 | head -5
