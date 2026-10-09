#!/usr/bin/env bash
# The chained-alias bypass of the beb7fbb narrowing, and the same command's decision on 9c4d5aa.
set -u
WT=/tmp/claude-0/-home-user-ECCode/f72396f5-b89f-576d-a680-29d481cd71c9/scratchpad/guardfix
S=/tmp/claude-0/-home-user-ECCode/f72396f5-b89f-576d-a680-29d481cd71c9/scratchpad
CLI="$WT/bin/eccode.js"
decide() { # decide <guardfile> <cwd> <command>
  local p out; p=$(node -e 'process.stdout.write(JSON.stringify({cwd:process.argv[1],tool_name:"Bash",tool_input:{command:process.argv[2]}}))' "$2" "$3")
  out=$(printf '%s' "$p" | env CLAUDE_PROJECT_DIR= ECCODE_ACTOR= node "$1" 2>&1)
  if [ -z "$out" ]; then echo allow; else printf '%s' "$out" | node -e 'let s="";process.stdin.on("data",c=>c&&(s+=c)).on("end",()=>{try{console.log(JSON.parse(s).hookSpecificOutput.permissionDecision)}catch(e){console.log("ERR")}})'; fi
}
for gh in 1fcda26 beb7fbb 9c4d5aa; do
  (cd "$WT" && git show "$gh:scripts/hooks/guard.js") > "$S/g-$gh.js"
  mkdir -p "$S/wrap-$gh/scripts/hooks"; cp "$S/g-$gh.js" "$S/wrap-$gh/scripts/hooks/guard.js"; ln -sfn "$WT/lib" "$S/wrap-$gh/lib"
  G="$S/wrap-$gh/scripts/hooks/guard.js"; R="$S/r4-$gh"
  rm -rf "$R"; mkdir -p "$R"; (cd "$R" && git init -q); node "$CLI" init --name x --idea y --root "$R" >/dev/null
  ln -s "$R/.eccode" "$R/a"   # step 1 (a prior turn): allowed on both (single target)
  BEFORE=$(wc -c < "$R/.eccode/state.json")
  d=$(decide "$G" "$R" 'ln -s a b && echo FORGED > b/state.json')
  echo "$gh: step-1 'ln -s .eccode a' alone => $(decide "$G" "$R" 'ln -s "$PWD/.eccode" a2') ; step-2 chained-alias write => $d"
  if [ "$d" = allow ]; then bash -c "cd '$R' && ln -s a b && echo FORGED > b/state.json" 2>/dev/null; AFTER=$(wc -c < "$R/.eccode/state.json"); echo "    bash clobbered real state.json: $([ "$(head -1 "$R/.eccode/state.json")" = FORGED ] && echo "YES ($BEFORE -> $AFTER bytes)" || echo no)"; fi
done
