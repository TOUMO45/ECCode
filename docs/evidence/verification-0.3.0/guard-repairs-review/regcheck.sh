#!/usr/bin/env bash
set -u
WT=/tmp/claude-0/-home-user-ECCode/f72396f5-b89f-576d-a680-29d481cd71c9/scratchpad/guardfix
S=/tmp/claude-0/-home-user-ECCode/f72396f5-b89f-576d-a680-29d481cd71c9/scratchpad
for gh in d0e2a3b a088c6a 3fa6298; do
  (cd "$WT" && git show "$gh:scripts/hooks/guard.js") > "$S/g-$gh.js"
  mkdir -p "$S/wrap-$gh/scripts/hooks"
  cp "$S/g-$gh.js" "$S/wrap-$gh/scripts/hooks/guard.js"
  ln -sfn "$WT/lib" "$S/wrap-$gh/lib"
  G="$S/wrap-$gh/scripts/hooks/guard.js"
  R="$S/rr-$gh"
  rm -rf "$R"; mkdir -p "$R"; (cd "$R" && git init -q)
  node "$WT/bin/eccode.js" init --name x --idea y --root "$R" >/dev/null
  p=$(node -e 'process.stdout.write(JSON.stringify({cwd:process.argv[1],tool_name:"Bash",tool_input:{command:process.argv[2]}}))' "$R" 'ln -s "$PWD/'.eccode'" lk && echo FORGED > lk/state.json')
  out=$(printf '%s' "$p" | env CLAUDE_PROJECT_DIR= ECCODE_ACTOR= node "$G" 2>&1)
  if [ -z "$out" ]; then d=allow; else d=$(printf '%s' "$out" | node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{try{console.log(JSON.parse(s).hookSpecificOutput.permissionDecision)}catch(e){console.log("ERR:"+s.slice(0,60))}})'); fi
  echo "$gh TOCTOU-alias-clobber-state: $d"
done
